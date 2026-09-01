import { EventEmitter } from 'events'
import { describe, expect, it, vi } from 'vitest'
import { UpdateManager, isAutomaticUpdateSupported } from './UpdateManager'

class FakeUpdater extends EventEmitter {
  autoDownload = true
  autoInstallOnAppQuit = true
  previousBlockmapBaseUrlOverride: string | null = null
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
    expect(updater.previousBlockmapBaseUrlOverride).toBe(
      'https://github.com/thsvkd/ftp-browser/releases/download/v1.0.5'
    )
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
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1)
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
