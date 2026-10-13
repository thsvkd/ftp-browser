/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { toast } from 'sonner'
import { t } from '@renderer/i18n'
import { en } from '@renderer/i18n/locales/en'
import { useFtpStore, type ConnInfo } from '@renderer/stores/useFtpStore'
import { useListingStore } from '@renderer/stores/useListingStore'
import { useShelfStore } from '@renderer/stores/useShelfStore'
import { useTabsStore } from '@renderer/stores/useTabsStore'
import { makeApiMock, invokeCalls, type ApiMock } from '@renderer/test/rendererTestUtils'
import type { LocalFileEntry } from '@shared/types/local'
import { fromLocalEntry, type Loc } from './explorerEntry'
import { locLabel, reloadActiveTab, shelveOsFiles, sourceLabel } from './sendItems'

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
    expect(toast).not.toHaveBeenCalled()
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

describe('reloadActiveTab', () => {
  const A = 'alice@a.example.com:21'
  const B = 'bob@b.example.com:2121'
  const info = (status: ConnInfo['status'], host: string): ConnInfo => ({
    status,
    host,
    port: 21,
    user: 'u',
    error: null
  })
  const openOnly = (loc: Loc): void => {
    useTabsStore.setState({ tabs: [], activeId: '', recent: [] })
    useTabsStore.getState().openTab(loc)
  }
  const reload = (): void => {
    invoke.mockClear()
    useListingStore.setState({ byKey: {} })
    reloadActiveTab()
  }

  beforeEach(() => {
    invoke.mockResolvedValue({ success: true, data: { path: '/', entries: [] } })
  })

  it("reads the active tab only when that tab's own server is connected", () => {
    // covers: Test-1035
    openOnly({ side: 'remote', path: '/photos', server: B })
    useFtpStore.setState({
      connections: { [A]: info('disconnected', 'a'), [B]: info('connected', 'b') }
    })
    reload()
    expect(invokeCalls(invoke, 'ftp:list')).toEqual([[B, '/photos']])

    for (const status of ['disconnected', 'connecting', 'error'] as const) {
      useFtpStore.setState({ connections: { [A]: info('connected', 'a'), [B]: info(status, 'b') } })
      reload()
      expect(invokeCalls(invoke, 'ftp:list')).toEqual([])
    }
    useFtpStore.setState({ connections: { [A]: info('connected', 'a') } })
    reload()
    expect(invokeCalls(invoke, 'ftp:list')).toEqual([])

    // 로컬 탭은 연결이 없어도 읽는다
    useFtpStore.setState({ connections: {} })
    openOnly({ side: 'local', path: 'C:\\in' })
    reload()
    expect(invokeCalls(invoke, 'local:list')).toEqual([['C:\\in']])

    // 탭이 없으면 아무것도 부르지 않는다
    useTabsStore.setState({ tabs: [], activeId: '', recent: [] })
    reload()
    expect(invoke).not.toHaveBeenCalled()
  })
})

describe('sourceLabel', () => {
  it('names a remote source by its connection label so two users on one host differ', () => {
    // covers: Test-1141
    const RA = 'ra@127.0.0.1:2121'
    const RB2 = 'rb2@127.0.0.1:2121'
    expect(sourceLabel({ side: 'remote', server: RA })).toBe(RA)
    expect(sourceLabel({ side: 'remote', server: RB2 })).toBe(RB2)
    expect(sourceLabel({ side: 'remote', server: 'anonymous@example.org:21' })).toBe(
      'example.org:21'
    )
    expect(sourceLabel({ side: 'remote' })).toBe(t('explorer.remote'))
    expect(sourceLabel({ side: 'local' })).toBe(t('sidebar.thisPc'))

    const rootA = locLabel({ side: 'remote', path: '/', server: RA })
    const rootB = locLabel({ side: 'remote', path: '/', server: RB2 })
    expect(rootA).not.toBe(rootB)
    expect(rootA).toBe(t('place.root', { source: RA }))
    expect(rootB).toBe(t('place.root', { source: RB2 }))
    expect(locLabel({ side: 'remote', path: '/photos', server: RA })).toBe('photos')
    expect(locLabel({ side: 'remote', path: '/photos', server: RB2 })).toBe('photos')
  })
})
