/**
 * 탐색기 컴포넌트 테스트의 공용 준비: 스토어 초기화, 경로별 목록을 돌려주는 `window.api` 목,
 * 그리드 레이아웃 스텁(1200×800). 테스트가 아닌 모듈이라 vitest가 따로 돌리지 않는다.
 */
import { createElement } from 'react'
import { act, render, screen, type RenderResult } from '@testing-library/react'
import { vi, type Mock } from 'vitest'
import type { Loc } from '@renderer/lib/explorerEntry'
import { EMPTY_OVERRIDES } from '@renderer/lib/fileCategories'
import { useConfirmStore } from '@renderer/stores/useConfirmStore'
import { useFileCategoryStore } from '@renderer/stores/useFileCategoryStore'
import { useFtpStore, type ConnInfo } from '@renderer/stores/useFtpStore'
import { useGalleryStore } from '@renderer/stores/useGalleryStore'
import { useListingStore } from '@renderer/stores/useListingStore'
import { useLocalThumbnailStore } from '@renderer/stores/useLocalThumbnailStore'
import { useSettingsStore } from '@renderer/stores/useSettingsStore'
import { useShelfStore } from '@renderer/stores/useShelfStore'
import { useTabsStore, type PaneId, type Tab } from '@renderer/stores/useTabsStore'
import { useThumbnailStore } from '@renderer/stores/useThumbnailStore'
import { useTransferStore } from '@renderer/stores/useTransferStore'
import { makeApiMock, stubGridLayout, type ApiMock } from '@renderer/test/rendererTestUtils'
import { connKey, parseConnKey, type ConnKey } from '@shared/connKey'
import type { ConnectionStatus, FtpFileEntry } from '@shared/types/ftp'
import type { LocalFileEntry } from '@shared/types/local'
import type { IpcResult } from '@shared/types/ipc'
import { useDnd } from './dnd'
import { Explorer } from './Explorer'

export const MODIFIED_AT = '2024-05-01T10:20:30.000Z'
export const HOST = 'example.org'
export const PORT = 21

export function ftp(
  name: string,
  opts: Partial<FtpFileEntry> & { dir?: boolean } = {}
): FtpFileEntry {
  const { dir, ...rest } = opts
  return {
    name,
    type: dir ? 'directory' : 'file',
    size: dir ? 0 : 1024,
    modifiedAt: MODIFIED_AT,
    rawModifiedAt: MODIFIED_AT,
    isImage: /\.(jpe?g|png)$/i.test(name),
    ...rest
  }
}

/** Windows 로컬 항목. 경로는 `dir\\name`. */
export function local(
  dir: string,
  name: string,
  opts: Partial<LocalFileEntry> & { dir?: boolean } = {}
): LocalFileEntry {
  const { dir: isDir, ...rest } = opts
  return {
    name,
    path: `${dir}\\${name}`,
    type: isDir ? 'directory' : 'file',
    size: isDir ? 0 : 1024,
    modifiedAt: MODIFIED_AT,
    isImage: /\.(jpe?g|png)$/i.test(name),
    ...rest
  }
}

type Handler = (...args: unknown[]) => unknown

export interface ExplorerHarness {
  api: ApiMock
  invoke: Mock
  /** 원격 폴더 → 목록. 테스트가 바꾸면 다음 `ftp:list`부터 반영된다. */
  remote: Record<string, FtpFileEntry[]>
  local: Record<string, LocalFileEntry[]>
  /** 채널별 응답을 바꾼다(목록 채널도 덮어쓸 수 있다). */
  handlers: Record<string, Handler>
  restore: () => void
}

/** 기본 연결(익명 `HOST:PORT`)의 키. 원격 탭의 `loc.server`다. */
export const server = (): ConnKey => connKey(HOST, PORT, '')

/** `useFtpStore.connections`의 한 항목을 둔다(다른 키는 그대로). 호스트·포트·사용자는 키에서. */
export function setConnection(
  key: ConnKey,
  status: ConnectionStatus,
  extra: Partial<ConnInfo> = {}
): void {
  const parsed = parseConnKey(key)
  useFtpStore.setState((s) => ({
    connections: {
      ...s.connections,
      [key]: {
        status,
        host: parsed?.host ?? '',
        port: parsed?.port ?? 21,
        user: parsed?.user ?? '',
        error: null,
        ...extra
      }
    }
  }))
}

/** 테스트 하나의 준비. `afterEach`에서 `restore()`를 부른다. */
export function setupExplorer(
  opts: {
    remote?: Record<string, FtpFileEntry[]>
    local?: Record<string, LocalFileEntry[]>
    connected?: boolean
  } = {}
): ExplorerHarness {
  const layout = stubGridLayout()
  // 경로 막대의 도구 측정 줄(`[data-path-measure]`) 안은 40px, 나머지는 스텁 그대로 1200px다. 그러지
  // 않으면 도구 하나하나가 막대만큼 넓어 모두 ⋯로 접힌다(explorer-ux-polish §4 함정 1). 막대 폭은
  // 테스트가 `HTMLElement.prototype.clientWidth`로 정한다. `layout.restore()`가 되돌린다.
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement): number {
      return this.closest('[data-path-measure]') ? 40 : 1200
    }
  })
  const h: ExplorerHarness = {
    api: makeApiMock(vi.fn()),
    invoke: vi.fn(),
    remote: opts.remote ?? {},
    local: opts.local ?? {},
    handlers: {},
    restore: () => {
      layout.restore()
      vi.unstubAllGlobals()
    }
  }
  const ok = <T>(data: T): IpcResult<T> => ({ success: true, data })
  h.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    const custom = h.handlers[channel]
    if (custom) return custom(...args)
    if (channel === 'ftp:list') {
      // ftp:list(conn, path)
      const entries = h.remote[args[1] as string]
      return entries
        ? ok({ path: args[1], entries })
        : { success: false, error: 'No such directory', code: 'FTP_NOT_FOUND' }
    }
    if (channel === 'local:list') {
      const entries = h.local[args[0] as string]
      return entries
        ? ok({ path: args[0], entries })
        : { success: false, error: 'ENOENT', code: 'FS_NOT_FOUND' }
    }
    if (channel === 'local:getPlaces')
      return ok({
        home: 'C:\\Users\\me',
        desktop: null,
        downloads: 'C:\\Users\\me\\Downloads',
        documents: null,
        pictures: null,
        music: null,
        videos: null,
        roots: ['C:\\']
      })
    if (channel === 'ftp:getRecentServers' || channel === 'ftp:getRecentPaths') return ok([])
    return ok(undefined)
  })
  h.api.invoke = h.invoke
  vi.stubGlobal('api', h.api)
  // 폴더 미리보기가 IntersectionObserver를 쓴다. jsdom에는 없다(보이지 않으니 요청도 없다).
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe = (): void => undefined
      disconnect = (): void => undefined
    }
  )

  useFtpStore.setState({ connections: {} })
  if (opts.connected !== false) setConnection(server(), 'connected')
  useTabsStore.setState({ tabs: [], activeId: '', recent: [], split: null })
  useFileCategoryStore.setState({ overrides: EMPTY_OVERRIDES })
  useListingStore.setState({ byKey: {} })
  useShelfStore.setState({ items: [], dockOpen: false })
  useSettingsStore.setState({
    viewMode: 'grid',
    tileSize: 160,
    showHidden: false,
    confirmBeforeDelete: false
  })
  useThumbnailStore.setState({ thumbnails: {}, errors: {} })
  useLocalThumbnailStore.setState({ thumbnails: {}, errors: {} })
  useGalleryStore.setState({ remoteFolderPreviews: {}, localFolderPreviews: {} })
  useTransferStore.setState({
    jobs: [],
    batchMeta: {},
    pendingSends: [],
    conflictQueue: [],
    panel: { open: false, collapsed: false, rows: [] },
    panelMuted: [],
    panelHeld: [],
    panelSending: 0
  })
  useConfirmStore.setState({ request: null })
  useDnd.setState({ items: null, server: null, over: null, thumbs: [], fromShelf: false })
  return h
}

export const remoteLoc = (path: string): Loc => ({ side: 'remote', path, server: server() })
export const localLoc = (path: string): Loc => ({ side: 'local', path })

/** 탭 하나를 열고(`patch`로 보기 등을 바꿔) 탐색기를 그린 뒤 첫 목록을 기다린다. */
export async function renderExplorer(loc: Loc, patch: Partial<Tab> = {}): Promise<RenderResult> {
  const id = useTabsStore.getState().openTab(loc)
  useTabsStore.getState().patchTab(id, patch)
  const result = render(createElement(Explorer))
  await flush()
  return result
}

export async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

export const activeTab = (): Tab => {
  const s = useTabsStore.getState()
  const tab = s.tabs.find((x) => x.id === s.activeId)
  if (!tab) throw new Error('no active tab')
  return tab
}

export const listbox = (): HTMLElement => screen.getByRole('listbox')

const baseName = (p: string): string =>
  p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1)

/** 이름으로 찾은 항목(타일·행). 이름 칸이 입력으로 바뀌어도 `data-path`로 찾는다. */
export function option(name: string): HTMLElement {
  const el = screen
    .queryAllByRole('option')
    .find((o) => baseName(o.getAttribute('data-path') ?? '') === name)
  if (!el) throw new Error(`no option "${name}"`)
  return el
}

export const selectedNames = (): string[] =>
  activeTab()
    .sel.map((p) => p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1))
    .sort()

/** 분할 보기의 그 패널(`section[data-pane]`). */
export function paneEl(pane: PaneId): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-pane="${pane}"]`)
  if (!el) throw new Error(`no pane "${pane}"`)
  return el
}

/**
 * 요소 하나의 `getBoundingClientRect`·`clientWidth`·`clientHeight`를 인스턴스 속성으로 고정한다.
 * `stubGridLayout`은 모든 요소를 0,0~1200×800으로 두므로 탭줄·분할 루트·타일을 구별할 때 쓴다.
 */
export function stubRect(
  el: Element,
  rect: { left: number; top: number; width: number; height: number }
): void {
  const { left, top, width, height } = rect
  const box = {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({})
  }
  Object.defineProperty(el, 'getBoundingClientRect', { configurable: true, value: () => box })
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: width })
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: height })
}
