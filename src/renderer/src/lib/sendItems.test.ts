/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { toast } from 'sonner'
import { en } from '@renderer/i18n/locales/en'
import { useShelfStore } from '@renderer/stores/useShelfStore'
import { makeApiMock, invokeCalls, type ApiMock } from '@renderer/test/rendererTestUtils'
import type { LocalFileEntry } from '@shared/types/local'
import { fromLocalEntry } from './explorerEntry'
import { shelveOsFiles } from './sendItems'

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
  Toaster: () => null
}))

const MODIFIED_AT = '2024-05-01T10:20:30.000Z'

const entry = (path: string, type: 'file' | 'directory' = 'file'): LocalFileEntry => {
  const name = path.slice(path.lastIndexOf('\\') + 1)
  return {
    name,
    path,
    type,
    size: type === 'file' ? 100 : 0,
    modifiedAt: MODIFIED_AT,
    isImage: type === 'file' && /\.jpe?g$/i.test(name)
  }
}

const ok = (data: LocalFileEntry[]): { success: true; data: LocalFileEntry[] } => ({
  success: true,
  data
})

let api: ApiMock
let invoke: Mock
/** 파일 이름 -> 경로. 없으면 빈 문자열(가상 파일) */
let paths: Record<string, string>

const file = (name: string): File => new File(['x'], name)
const shelfNames = (): string[] => useShelfStore.getState().items.map((i) => i.entry.name)
const skipped = (count: number): string =>
  count === 1 ? "1 dropped item couldn't be read" : `${count} dropped items couldn't be read`

beforeEach(() => {
  vi.clearAllMocks()
  invoke = vi.fn()
  api = makeApiMock(invoke)
  paths = {}
  api.getPathForFile.mockImplementation((f: File) => paths[f.name] ?? '')
  vi.stubGlobal('api', api)
  useShelfStore.setState({ items: [], railTab: 'info' })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('shelveOsFiles', () => {
  it('reads paths synchronously, stats them once in drop order and shelves a folder as one item', async () => {
    // covers: Test-874
    paths = { 'a.jpg': 'C:\\in\\a.jpg', docs: 'C:\\in\\docs' }
    invoke.mockResolvedValue(ok([entry('C:\\in\\a.jpg'), entry('C:\\in\\docs', 'directory')]))

    const pending = shelveOsFiles([file('a.jpg'), file('docs')])
    // await 전에 경로를 모두 읽는다(DataTransfer는 이벤트 안에서만 믿을 수 있다)
    expect(api.getPathForFile).toHaveBeenCalledTimes(2)
    const added = await pending

    expect(added).toBe(2)
    expect(invokeCalls(invoke, 'local:stat')).toEqual([[['C:\\in\\a.jpg', 'C:\\in\\docs']]])
    expect(invokeCalls(invoke, 'local:list')).toEqual([])
    expect(invokeCalls(invoke, 'local:expandForUpload')).toEqual([])
    expect(useShelfStore.getState().items.map((i) => i.entry)).toEqual([
      fromLocalEntry(entry('C:\\in\\a.jpg')),
      fromLocalEntry(entry('C:\\in\\docs', 'directory'))
    ])
    expect(useShelfStore.getState().items[1].entry.type).toBe('directory')
    expect(useShelfStore.getState().railTab).toBe('shelf')

    invoke.mockClear()
    expect(await shelveOsFiles([])).toBe(0)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('drops duplicates by locKey and only toasts when everything was already shelved', async () => {
    // covers: Test-875
    paths = { 'a.jpg': 'C:\\in\\a.jpg', 'b.jpg': 'C:\\in\\b.jpg', 'c.jpg': 'C:\\in\\c.jpg' }
    useShelfStore.getState().add([fromLocalEntry(entry('C:\\in\\a.jpg'))])
    useShelfStore.setState({ railTab: 'info' })

    // 전부 중복: 이미 있는 것 + 같은 드롭 안의 같은 경로 둘
    invoke.mockResolvedValue(ok([entry('C:\\in\\a.jpg'), entry('C:\\in\\a.jpg')]))
    expect(await shelveOsFiles([file('a.jpg'), file('a.jpg')])).toBe(0)
    expect(shelfNames()).toEqual(['a.jpg'])
    expect(toast).toHaveBeenCalledTimes(1)
    expect(toast).toHaveBeenCalledWith(en['toast.alreadyOnShelf'])
    expect(useShelfStore.getState().railTab).toBe('info')

    // 일부만 중복: 새것만 담고 토스트는 없다. 같은 드롭 안의 같은 경로 둘은 하나만
    vi.mocked(toast).mockClear()
    invoke.mockResolvedValue(
      ok([entry('C:\\in\\a.jpg'), entry('C:\\in\\b.jpg'), entry('C:\\in\\b.jpg')])
    )
    expect(await shelveOsFiles([file('a.jpg'), file('b.jpg'), file('b.jpg')])).toBe(1)
    expect(shelfNames()).toEqual(['a.jpg', 'b.jpg'])
    expect(toast).not.toHaveBeenCalled()
    expect(useShelfStore.getState().railTab).toBe('shelf')
  })

  it('reports what could not be read without throwing', async () => {
    // covers: Test-876
    paths = { 'a.jpg': 'C:\\in\\a.jpg', 'b.jpg': 'C:\\in\\b.jpg', 'c.jpg': 'C:\\in\\c.jpg' }

    // (a) 경로가 빈 문자열인 파일은 건너뛴다. 모두 빈 문자열이면 local:stat을 부르지 않는다
    invoke.mockResolvedValue(ok([entry('C:\\in\\a.jpg')]))
    expect(await shelveOsFiles([file('a.jpg'), file('virtual.txt')])).toBe(1)
    expect(invokeCalls(invoke, 'local:stat')).toEqual([[['C:\\in\\a.jpg']]])
    invoke.mockClear()
    useShelfStore.setState({ items: [], railTab: 'info' })
    vi.mocked(toast).mockClear()
    expect(await shelveOsFiles([file('v1'), file('v2')])).toBe(0)
    expect(invoke).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledTimes(1)
    expect(toast).toHaveBeenCalledWith(skipped(2))
    expect(toast.error).not.toHaveBeenCalled()
    expect(shelfNames()).toEqual([])

    // (b) 결과가 요청보다 적으면 읽은 것은 담고 빠진 수를 기본 toast로 알린다
    vi.mocked(toast).mockClear()
    invoke.mockResolvedValue(ok([entry('C:\\in\\a.jpg'), entry('C:\\in\\c.jpg')]))
    expect(await shelveOsFiles([file('a.jpg'), file('b.jpg'), file('c.jpg')])).toBe(2)
    expect(shelfNames()).toEqual(['a.jpg', 'c.jpg'])
    expect(toast).toHaveBeenCalledTimes(1)
    expect(toast).toHaveBeenCalledWith(skipped(1))
    expect(toast.error).not.toHaveBeenCalled()

    // (c) success:false는 아무것도 담지 않고 toast.error
    useShelfStore.setState({ items: [], railTab: 'info' })
    vi.mocked(toast).mockClear()
    invoke.mockResolvedValue({ success: false, error: 'boom' })
    expect(await shelveOsFiles([file('a.jpg'), file('b.jpg')])).toBe(0)
    expect(shelfNames()).toEqual([])
    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(toast.error).toHaveBeenCalledWith(skipped(2), { description: 'boom' })
    expect(toast).not.toHaveBeenCalled()

    // (d) invoke가 reject해도 던지지 않는다
    vi.mocked(toast.error).mockClear()
    invoke.mockRejectedValue(new Error('ipc down'))
    expect(await shelveOsFiles([file('a.jpg')])).toBe(0)
    expect(toast.error).toHaveBeenCalledWith(skipped(1), { description: 'ipc down' })
    vi.mocked(toast.error).mockClear()
    invoke.mockRejectedValue('x')
    expect(await shelveOsFiles([file('a.jpg')])).toBe(0)
    expect(toast.error).toHaveBeenCalledWith(skipped(1), { description: 'x' })
    expect(shelfNames()).toEqual([])

    // (e) 읽지 못한 것이 있고 읽은 것이 모두 이미 선반에 있으면 두 토스트가 순서대로 모두 뜬다
    useShelfStore
      .getState()
      .add([fromLocalEntry(entry('C:\\in\\a.jpg')), fromLocalEntry(entry('C:\\in\\c.jpg'))])
    vi.mocked(toast).mockClear()
    invoke.mockResolvedValue(ok([entry('C:\\in\\a.jpg'), entry('C:\\in\\c.jpg')]))
    expect(await shelveOsFiles([file('a.jpg'), file('b.jpg'), file('c.jpg')])).toBe(0)
    expect(vi.mocked(toast).mock.calls).toEqual([[skipped(1)], [en['toast.alreadyOnShelf']]])
  })
})
