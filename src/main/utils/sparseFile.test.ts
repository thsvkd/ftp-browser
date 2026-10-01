import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { FileHandle } from 'fs/promises'

// koffi는 실제 Windows API를 부르므로 함수 정의 문자열별로 가짜 함수를 돌려준다.
// 진짜 호출은 segmentedDownload.integration.test.ts의 Windows 전용 테스트가 본다.
const { koffi, getOsfHandle, deviceIoControl } = vi.hoisted(() => {
  const getOsfHandle = vi.fn<(fd: number) => number>()
  const deviceIoControl = vi.fn<(...args: unknown[]) => boolean>()
  const koffi = {
    load: vi.fn((path: string) => ({
      func: (definition: string) => {
        if (definition.includes('uv_get_osfhandle')) return getOsfHandle
        if (definition.includes('DeviceIoControl')) return deviceIoControl
        throw new Error(`unexpected ${definition} in ${path}`)
      }
    }))
  }
  return { koffi, getOsfHandle, deviceIoControl }
})
vi.mock('koffi', () => ({ ...koffi, default: koffi }))

const FSCTL_SET_SPARSE = 0x000900c4
const file = { fd: 7 } as FileHandle
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { ...platform, value })
}

/** 한 번만 경고하는지 보려고 모듈 상태(로더 캐시·경고 여부)를 테스트마다 새로 만든다. */
async function load(): Promise<typeof import('./sparseFile')> {
  vi.resetModules()
  return import('./sparseFile')
}

describe('markSparse', () => {
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    getOsfHandle.mockReturnValue(1234)
    deviceIoControl.mockReturnValue(true)
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', platform)
    warn.mockRestore()
  })

  it.each(['darwin', 'linux'] as const)(
    'should do nothing and never load koffi on %s',
    async (os) => {
      setPlatform(os)
      const { markSparse } = await load()

      await expect(markSparse(file)).resolves.toBe(false)
      expect(koffi.load).not.toHaveBeenCalled()
    }
  )

  it('should set the sparse flag on the OS handle behind the fd on Windows', async () => {
    setPlatform('win32')
    const { markSparse } = await load()

    await expect(markSparse(file)).resolves.toBe(true)
    // fd는 실행 파일에 정적 링크된 CRT의 것이라 그 안의 libuv로 HANDLE을 얻는다
    expect(koffi.load).toHaveBeenCalledWith(process.execPath)
    expect(koffi.load).toHaveBeenCalledWith('kernel32.dll')
    expect(getOsfHandle).toHaveBeenCalledWith(7)
    expect(deviceIoControl).toHaveBeenCalledWith(
      1234,
      FSCTL_SET_SPARSE,
      null,
      0,
      null,
      0,
      expect.any(Array),
      null
    )
    expect(warn).not.toHaveBeenCalled()
  })

  it('should load the Windows functions once for every file', async () => {
    setPlatform('win32')
    const { markSparse } = await load()

    await markSparse(file)
    await markSparse({ fd: 8 } as FileHandle)

    expect(koffi.load).toHaveBeenCalledTimes(2)
    expect(getOsfHandle.mock.calls).toEqual([[7], [8]])
  })

  it('should return false and warn once when the volume refuses the flag', async () => {
    // FAT32·exFAT 등 희소 파일이 없는 볼륨은 FSCTL_SET_SPARSE를 거부한다
    setPlatform('win32')
    deviceIoControl.mockReturnValue(false)
    const { markSparse } = await load()

    await expect(markSparse(file)).resolves.toBe(false)
    await expect(markSparse(file)).resolves.toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('should not call DeviceIoControl when the fd has no OS handle', async () => {
    setPlatform('win32')
    getOsfHandle.mockReturnValue(-1)
    const { markSparse } = await load()

    await expect(markSparse(file)).resolves.toBe(false)
    expect(deviceIoControl).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('should return false, warn once and not retry loading when koffi fails to load', async () => {
    setPlatform('win32')
    koffi.load.mockImplementationOnce(() => {
      throw new Error('Cannot find the native Koffi module')
    })
    const { markSparse } = await load()

    await expect(markSparse(file)).resolves.toBe(false)
    await expect(markSparse(file)).resolves.toBe(false)
    expect(koffi.load).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('should return false and warn once when a call throws', async () => {
    setPlatform('win32')
    deviceIoControl.mockImplementation(() => {
      throw new TypeError('bad argument')
    })
    const { markSparse } = await load()

    await expect(markSparse(file)).resolves.toBe(false)
    await expect(markSparse(file)).resolves.toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
