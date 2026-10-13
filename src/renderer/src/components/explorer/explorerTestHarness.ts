/**
 * 탐색기 컴포넌트 테스트의 공용 준비: 스토어 초기화, 경로별 목록을 돌려주는 `window.api` 목,
 * 그리드 레이아웃 스텁(1200×800). 테스트가 아닌 모듈이라 vitest가 따로 돌리지 않는다.
 */
import { createElement } from 'react'
import { act, render, screen, type RenderResult } from '@testing-library/react'
import { vi, type Mock } from 'vitest'
import { connectedServer } from '@renderer/lib/sendItems'
import type { Loc } from '@renderer/lib/explorerEntry'
import { EMPTY_OVERRIDES } from '@renderer/lib/fileCategories'
import { useConfirmStore } from '@renderer/stores/useConfirmStore'
import { useFileCategoryStore } from '@renderer/stores/useFileCategoryStore'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import { useGalleryStore } from '@renderer/stores/useGalleryStore'
import { useListingStore } from '@renderer/stores/useListingStore'
import { useLocalThumbnailStore } from '@renderer/stores/useLocalThumbnailStore'
import { useSettingsStore } from '@renderer/stores/useSettingsStore'
import { useShelfStore } from '@renderer/stores/useShelfStore'
import { useTabsStore, type Tab } from '@renderer/stores/useTabsStore'
import { useThumbnailStore } from '@renderer/stores/useThumbnailStore'
import { useTransferStore } from '@renderer/stores/useTransferStore'
import { makeApiMock, stubGridLayout, type ApiMock } from '@renderer/test/rendererTestUtils'
import type { FtpFileEntry } from '@shared/types/ftp'
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

/** 연결된 서버의 탭 키(`useFtpStore`가 만든다). 사용자 이름 필드가 생겨도 그대로 맞는다. */
export const server = (): string => connectedServer(useFtpStore.getState()) ?? ''

/** 테스트 하나의 준비. `afterEach`에서 `restore()`를 부른다. */
export function setupExplorer(
  opts: {
    remote?: Record<string, FtpFileEntry[]>
    local?: Record<string, LocalFileEntry[]>
    connected?: boolean
  } = {}
): ExplorerHarness {
  const layout = stubGridLayout()
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
      const entries = h.remote[args[0] as string]
      return entries
        ? ok({ path: args[0], entries })
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

  useFtpStore.setState({
    connectionStatus: opts.connected === false ? 'disconnected' : 'connected',
    host: HOST,
    port: PORT,
    error: null
  })
  useTabsStore.setState({ tabs: [], activeId: '', recent: [] })
  useFileCategoryStore.setState({ overrides: EMPTY_OVERRIDES })
  useListingStore.setState({ byKey: {} })
  useShelfStore.setState({ items: [], railTab: 'shelf' })
  useSettingsStore.setState({
    viewMode: 'grid',
    tileSize: 160,
    showHidden: false,
    confirmBeforeDelete: false
  })
  useThumbnailStore.setState({ thumbnails: {}, errors: {} })
  useLocalThumbnailStore.setState({ thumbnails: {}, errors: {} })
  useGalleryStore.setState({ remoteFolderPreviews: {}, localFolderPreviews: {} })
  useTransferStore.setState({ jobs: [], batchMeta: {}, pendingSends: [], conflictQueue: [] })
  useConfirmStore.setState({ request: null })
  useDnd.setState({ items: null, over: null, thumbs: [] })
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
