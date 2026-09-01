import { EventEmitter } from 'events'
import { describe, expect, it, vi } from 'vitest'
import { UpdateManager, isAutomaticUpdateSupported } from './UpdateManager'

class FakeUpdater extends EventEmitter {
  autoDownload = true
  autoInstallOnAppQuit = true
  checkForUpdates = vi.fn(async () => null)
  downloadUpdate = vi.fn(async () => [])
  quitAndInstall = vi.fn()
}

describe('isAutomaticUpdateSupported', () => {
  it('supports only packaged Windows installer builds outside smoke tests', () => {
    // covers: Test-198
    expect(
      isAutomaticUpdateSupported({
        isPackaged: true,
        platform: 'win32',
        isPortable: false,
        isSmokeTest: false
      })
    ).toBe(true)

    expect(
      isAutomaticUpdateSupported({
        isPackaged: false,
        platform: 'win32',
        isPortable: false,
        isSmokeTest: false
      })
    ).toBe(false)
    expect(
      isAutomaticUpdateSupported({
        isPackaged: true,
        platform: 'linux',
        isPortable: false,
        isSmokeTest: false
      })
    ).toBe(false)
    expect(
      isAutomaticUpdateSupported({
        isPackaged: true,
        platform: 'win32',
        isPortable: true,
        isSmokeTest: false
      })
    ).toBe(false)
    expect(
      isAutomaticUpdateSupported({
        isPackaged: true,
        platform: 'win32',
        isPortable: false,
        isSmokeTest: true
      })
    ).toBe(false)
  })
})

describe('UpdateManager', () => {
  it('checks without downloading and reports an available version', async () => {
    // covers: Test-199
    const updater = new FakeUpdater()
    const states: string[] = []
    const manager = new UpdateManager('1.0.5', updater, (state) => states.push(state.status))

    const check = manager.check()
    expect(manager.getState().status).toBe('checking')
    updater.emit('update-available', { version: '1.0.6' })
    await check

    expect(updater.autoDownload).toBe(false)
    expect(updater.autoInstallOnAppQuit).toBe(false)
    expect(manager.getState()).toMatchObject({
      status: 'available',
      currentVersion: '1.0.5',
      availableVersion: '1.0.6'
    })
    expect(states).toContain('checking')
    expect(states).toContain('available')
  })

  it('reports that the current version is up to date', async () => {
    // covers: Test-200
    const updater = new FakeUpdater()
    const manager = new UpdateManager('1.0.5', updater, vi.fn())

    const check = manager.check()
    updater.emit('update-not-available', { version: '1.0.5' })
    await check

    expect(manager.getState()).toMatchObject({ status: 'up-to-date', currentVersion: '1.0.5' })
  })

  it('reports download progress and waits for explicit installation', async () => {
    // covers: Test-201
    const updater = new FakeUpdater()
    const manager = new UpdateManager('1.0.5', updater, vi.fn())
    updater.emit('update-available', { version: '1.0.6' })

    const download = manager.download()
    updater.emit('download-progress', { percent: 42.4 })
    expect(manager.getState()).toMatchObject({ status: 'downloading', progressPercent: 42.4 })
    updater.emit('update-downloaded', { version: '1.0.6' })
    await download

    expect(manager.getState()).toMatchObject({
      status: 'ready',
      availableVersion: '1.0.6',
      progressPercent: 100
    })
    expect(updater.quitAndInstall).not.toHaveBeenCalled()

    manager.install()
    // isForceRunAfter=true라야 설치 후 앱이 다시 뜬다. 인자를 세지 않으면 (true, false)로
    // 바꿔 설치만 하고 앱이 안 돌아오는 구현이 그대로 통과한다.
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  it('reports an unsupported build and refuses every command', async () => {
    // covers: Test-213
    // 자동 업데이트가 없는 빌드(개발·포터블·macOS·Linux)에서 UpdateManager는 updater 없이
    // 만들어진다. 이 경로가 깨지면 해당 빌드에서 IPC 호출이 그대로 터진다.
    const emitState = vi.fn()
    const manager = new UpdateManager('1.0.5', null, emitState)

    expect(manager.getState()).toEqual({
      status: 'unsupported',
      currentVersion: '1.0.5',
      message: 'Automatic updates are available in the installed Windows version.'
    })
    await expect(manager.check()).resolves.toMatchObject({ status: 'unsupported' })
    await expect(manager.download()).resolves.toMatchObject({ status: 'unsupported' })
    manager.install()
    expect(emitState).not.toHaveBeenCalled()
  })

  it('surfaces updater errors raised as events, not only as rejections', async () => {
    // covers: Test-214
    // electron-updater는 실패 대부분을 promise rejection이 아니라 'error' 이벤트로 알린다.
    // Test-202(rejection)만으로는 이 경로가 통째로 비어 있어도 통과한다.
    const updater = new FakeUpdater()
    const states: string[] = []
    const manager = new UpdateManager('1.0.5', updater, (state) => states.push(state.status))

    const check = manager.check()
    updater.emit('error', new Error('ENOTFOUND github.com'))
    await check

    expect(manager.getState()).toMatchObject({
      status: 'error',
      currentVersion: '1.0.5',
      message: 'ENOTFOUND github.com'
    })
    expect(states).toContain('error')
  })

  it('surfaces a failed download without leaving the state mid-download', async () => {
    // covers: Test-215
    const updater = new FakeUpdater()
    updater.downloadUpdate.mockRejectedValueOnce(new Error('disk full'))
    const manager = new UpdateManager('1.0.5', updater, vi.fn())
    updater.emit('update-available', { version: '1.0.6' })

    await expect(manager.download()).resolves.toMatchObject({
      status: 'error',
      message: 'disk full'
    })
  })

  it('keeps a downloaded update instead of checking again', async () => {
    // covers: Test-211
    // ready에서 다시 확인하면 update-available이 상태를 available로 되돌려, 이미 받아 둔
    // 업데이트를 사용자가 처음부터 다시 받게 된다.
    const updater = new FakeUpdater()
    const manager = new UpdateManager('1.0.5', updater, vi.fn())
    updater.emit('update-available', { version: '1.0.6' })
    const download = manager.download()
    updater.emit('update-downloaded', { version: '1.0.6' })
    await download

    await expect(manager.check()).resolves.toMatchObject({ status: 'ready' })
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('does not download unless an update is actually available', async () => {
    // covers: Test-216
    const updater = new FakeUpdater()
    const manager = new UpdateManager('1.0.5', updater, vi.fn())

    await expect(manager.download()).resolves.toMatchObject({ status: 'idle' })
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
  })

  it('does not restart before the update has finished downloading', async () => {
    // covers: Test-217
    // 이 가드가 없으면 다운로드 중에 install이 들어와 받다 만 업데이트로 앱을 재시작한다.
    const updater = new FakeUpdater()
    const manager = new UpdateManager('1.0.5', updater, vi.fn())
    updater.emit('update-available', { version: '1.0.6' })

    manager.install()

    expect(updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('surfaces updater failures without throwing them across IPC', async () => {
    // covers: Test-202
    const updater = new FakeUpdater()
    updater.checkForUpdates.mockRejectedValueOnce(new Error('network unavailable'))
    const manager = new UpdateManager('1.0.5', updater, vi.fn())

    await expect(manager.check()).resolves.toMatchObject({
      status: 'error',
      message: 'network unavailable'
    })
  })
})
