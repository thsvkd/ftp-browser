/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, within } from '@testing-library/react'
import { en } from '@renderer/i18n/locales/en'
import { generateCacheKeyRenderer } from '@renderer/lib/cacheKey'
import { PAD } from '@renderer/lib/explorerLayout'
import { fromFtpEntry } from '@renderer/lib/explorerEntry'
import { gridLayout } from '@renderer/lib/gridGeometry'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import { useListingStore } from '@renderer/stores/useListingStore'
import { useSettingsStore } from '@renderer/stores/useSettingsStore'
import { useThumbnailStore } from '@renderer/stores/useThumbnailStore'
import { useTabsStore } from '@renderer/stores/useTabsStore'
import { invokeCalls } from '@renderer/test/rendererTestUtils'
import {
  HOST,
  MODIFIED_AT,
  PORT,
  flush,
  ftp,
  listbox,
  local,
  localLoc,
  option,
  remoteLoc,
  renderExplorer,
  selectedNames,
  server,
  setupExplorer,
  type ExplorerHarness
} from './explorerTestHarness'
import { ZOOM_STEP } from './FileGrid'

let h: ExplorerHarness

afterEach(() => {
  cleanup()
  h.restore()
})

// ---------- 이전(§7): 보이는 행 ± 한 화면의 썸네일 배치 ----------
// stubGridLayout(1200×800), 타일 160: 열 수·행 높이는 gridLayout이 정한다. 행 r은 PAD + r×행 높이에서 시작한다.
describe('FileGrid — viewport thumbnail batches (migrated)', () => {
  const COUNT = 600
  const { cols, rowHeight } = gridLayout(1200, 160)
  const rows = Math.ceil(COUNT / cols)
  const VIEW = 800
  /** [top, top+VIEW]에 걸친 행 */
  const visibleRows = (top: number): number[] =>
    Array.from({ length: rows }, (_, r) => r).filter(
      (r) => PAD + r * rowHeight < top + VIEW && PAD + (r + 1) * rowHeight > top
    )
  const BOTTOM = PAD * 2 + rows * rowHeight - VIEW

  interface Item {
    remotePath: string
    fileName: string
    fileSize: number
    modifiedAt: string
    priority: number
  }
  const name = (i: number): string => `img${String(i).padStart(3, '0')}.jpg`
  const key = (i: number): string =>
    generateCacheKeyRenderer(HOST, PORT, `/${name(i)}`, 1000, MODIFIED_AT)
  const lastBatch = (): Item[] => {
    const batches = invokeCalls(h.invoke, 'thumbnail:requestBatch')
    if (!batches.length) throw new Error('no thumbnail:requestBatch')
    return batches[batches.length - 1][0] as Item[]
  }
  const indexOf = (n: string): number => Number(n.slice(3, 6))
  const scrollTo = async (top: number): Promise<void> => {
    await act(async () => {
      listbox().scrollTop = top
      listbox().dispatchEvent(new Event('scroll'))
    })
  }
  /** `store`는 준비(스토어 초기화) 뒤, 그리기 전에 썸네일 스토어에 넣는다. */
  async function images(
    store: Partial<ReturnType<typeof useThumbnailStore.getState>> = {}
  ): Promise<void> {
    h = setupExplorer({
      remote: { '/': Array.from({ length: COUNT }, (_, i) => ftp(name(i), { size: 1000 })) }
    })
    useThumbnailStore.setState(store)
    await renderExplorer(remoteLoc('/'))
  }

  it('requests the visible rows first and one screen of margin rows after them', async () => {
    // covers: Test-273
    await images()
    const visible = visibleRows(0)
    const margin = visible.length
    const batch = lastBatch()
    expect(batch.map((r) => r.fileName)).toEqual(
      Array.from({ length: (visible.length + margin) * cols }, (_, i) => name(i))
    )
    expect(batch.map((r) => r.priority)).toEqual([
      ...Array<number>(visible.length * cols).fill(0),
      ...Array.from({ length: margin }, (_, d) => Array<number>(cols).fill(d + 1)).flat()
    ])
    expect(batch[0]).toEqual({
      remotePath: '/img000.jpg',
      fileName: 'img000.jpg',
      fileSize: 1000,
      modifiedAt: MODIFIED_AT,
      priority: 0
    })
    // 타일이 스스로 요청하지 않는다.
    expect(invokeCalls(h.invoke, 'thumbnail:request')).toEqual([])
  })

  it('replaces the batch with the newly visible rows after a jump to the bottom', async () => {
    // covers: Test-274
    await images()
    await scrollTo(BOTTOM)
    const visible = visibleRows(BOTTOM)
    const batch = lastBatch()
    expect(batch.filter((r) => r.priority === 0).map((r) => r.fileName)).toEqual(
      visible
        .flatMap((r) => Array.from({ length: cols }, (_, c) => r * cols + c))
        .filter((i) => i < COUNT)
        .map(name)
    )
    expect(batch.filter((r) => indexOf(r.fileName) < 400)).toEqual([])
  })

  it('leaves out entries whose thumbnail or error is already in the store', async () => {
    // covers: Test-275
    await images({
      thumbnails: { [key(0)]: { dataUrl: 'data:image/jpeg;base64,AA==', width: 1, height: 1 } },
      errors: { [key(1)]: 'Download timeout' }
    })
    const names = lastBatch().map((r) => r.fileName)
    expect(names).not.toContain(name(0))
    expect(names).not.toContain(name(1))
    expect(names[0]).toBe(name(2))
  })

  it('clears a failed item’s error once it leaves the window so it is requested on return', async () => {
    // covers: Test-276
    await images({ errors: { [key(1)]: 'Download timeout' } })
    expect(useThumbnailStore.getState().errors[key(1)]).toBe('Download timeout')
    expect(lastBatch().map((r) => r.fileName)).not.toContain(name(1))

    await scrollTo(BOTTOM)
    expect(useThumbnailStore.getState().errors[key(1)]).toBeUndefined()
    await scrollTo(0)
    expect(lastBatch().find((r) => r.fileName === name(1))).toMatchObject({ priority: 0 })
  })

  it('retries a failed tile immediately on click', async () => {
    // covers: Test-277
    await images({ errors: { [key(1)]: 'Download timeout' } })
    fireEvent.click(
      within(option(name(1))).getByRole('button', {
        name: en['thumbnail.retry'].replace('{{reason}}', 'Download timeout')
      })
    )
    expect(invokeCalls(h.invoke, 'thumbnail:request')).toEqual([
      [
        {
          remotePath: '/img001.jpg',
          fileName: 'img001.jpg',
          fileSize: 1000,
          modifiedAt: MODIFIED_AT,
          priority: 0
        },
        server()
      ]
    ])
    expect(useThumbnailStore.getState().errors[key(1)]).toBeUndefined()
  })

  it('sends the new folder’s batch after the location change cancels the old work', async () => {
    // covers: Test-278
    await images()
    h.remote['/sub'] = [ftp('new000.jpg', { size: 1000 })]
    // 이미 읽어 둔 폴더로 가면 목록이 로딩 없이 같은 커밋에서 바뀐다. 그리드의 배치 effect(자식)가
    // 탐색기의 cancelAll(부모)보다 먼저 돌면 새 폴더의 배치가 곧바로 지워진다.
    useListingStore
      .getState()
      .put(remoteLoc('/sub'), [fromFtpEntry(h.remote['/sub'][0], '/sub', server())])
    // 다시 읽기는 끝나지 않게 둔다: 그 결과의 두 번째 배치가 순서 문제를 가리지 않게 한다.
    h.handlers['ftp:list'] = () => new Promise(() => undefined)
    act(() => useTabsStore.getState().navigate(remoteLoc('/sub')))
    await flush()

    const channels = h.invoke.mock.calls.map((call) => call[0])
    const lastCancel = channels.lastIndexOf('thumbnail:cancelAll')
    expect(lastCancel).toBeGreaterThanOrEqual(0)
    const after = h.invoke.mock.calls.slice(lastCancel + 1)
    const batches = after.filter((call) => call[0] === 'thumbnail:requestBatch')
    expect(batches.map((call) => (call[1] as Item[]).map((r) => r.remotePath))).toContainEqual([
      '/sub/new000.jpg'
    ])
  })
})

// ---------- 이전: 플랫폼별 선택 수정자·확대 ----------

async function grid(side: 'remote' | 'local', selected: string[]): Promise<void> {
  if (side === 'remote') {
    h = setupExplorer({ remote: { '/d': [ftp('a.txt'), ftp('b.txt')] } })
    await renderExplorer(remoteLoc('/d'), { sel: selected.map((n) => `/d/${n}`) })
  } else {
    h = setupExplorer({ local: { 'C:\\d': [local('C:\\d', 'a.txt'), local('C:\\d', 'b.txt')] } })
    await renderExplorer(localLoc('C:\\d'), { sel: selected.map((n) => `C:\\d\\${n}`) })
  }
  h.api.platform = 'darwin'
}

describe('FileGrid — platform-aware selection modifiers (migrated)', () => {
  it('single-selects a remote tile on Ctrl+click on macOS', async () => {
    // covers: Test-153
    await grid('remote', ['b.txt'])
    fireEvent.click(option('a.txt'), { ctrlKey: true })
    expect(selectedNames()).toEqual(['a.txt'])
  })

  it('toggles a remote tile on Cmd+click on macOS', async () => {
    // covers: Test-154
    await grid('remote', ['b.txt'])
    fireEvent.click(option('a.txt'), { metaKey: true })
    expect(selectedNames()).toEqual(['a.txt', 'b.txt'])
    fireEvent.click(option('a.txt'), { metaKey: true })
    expect(selectedNames()).toEqual(['b.txt'])
  })

  it('single-selects a local tile on Ctrl+click on macOS', async () => {
    // covers: Test-149
    await grid('local', ['b.txt'])
    fireEvent.click(option('a.txt'), { ctrlKey: true })
    expect(selectedNames()).toEqual(['a.txt'])
  })

  it('toggles a local tile on Cmd+click on macOS', async () => {
    // covers: Test-150
    await grid('local', ['b.txt'])
    fireEvent.click(option('a.txt'), { metaKey: true })
    expect(selectedNames()).toEqual(['a.txt', 'b.txt'])
    fireEvent.click(option('a.txt'), { metaKey: true })
    expect(selectedNames()).toEqual(['b.txt'])
  })
})

describe('FileGrid — zoom modifiers (migrated)', () => {
  it('resizes remote tiles on Cmd+wheel on macOS', async () => {
    // covers: Test-161
    await grid('remote', [])
    fireEvent.wheel(listbox(), { deltaY: -100, metaKey: true })
    expect(useSettingsStore.getState().tileSize).toBe(160 + ZOOM_STEP)
  })

  it('resizes local tiles on Cmd+wheel on macOS', async () => {
    // covers: Test-160
    await grid('local', [])
    fireEvent.wheel(listbox(), { deltaY: 100, metaKey: true })
    expect(useSettingsStore.getState().tileSize).toBe(160 - ZOOM_STEP)
  })
})

// ---------- Phase A′5: 썸네일 캐시 키는 탭 자신의 세션 host·port ----------

describe('FileGrid — session-scoped thumbnail cache keys', () => {
  it('keys a non-primary tab’s thumbnails by that session’s host/port, not the primary projection', async () => {
    // covers: Test-935
    const OTHER = 'me@other.example.org:2121'
    h = setupExplorer({
      remote: {
        '/': [
          ftp('img000.jpg', { size: 1000 }),
          ftp('img001.jpg', { size: 1000 }),
          ftp('img002.jpg', { size: 1000 })
        ]
      }
    })
    // primary 투영(HOST:PORT)은 그대로 두고, 다른 host·port의 두 번째 세션만 연결돼 있다고 친다.
    useFtpStore.setState({
      sessions: {
        [OTHER]: {
          status: 'connected',
          host: 'other.example.org',
          port: 2121,
          username: 'me',
          server: OTHER
        }
      }
    })
    const sessionKey = (name: string): string =>
      generateCacheKeyRenderer('other.example.org', 2121, `/${name}`, 1000, MODIFIED_AT)
    const primaryKey = (name: string): string =>
      generateCacheKeyRenderer(HOST, PORT, `/${name}`, 1000, MODIFIED_AT)
    useThumbnailStore.setState({
      thumbnails: {
        [sessionKey('img000.jpg')]: { dataUrl: 'data:image/jpeg;base64,AA==', width: 1, height: 1 }
      },
      errors: {
        [sessionKey('img001.jpg')]: 'Download timeout',
        [primaryKey('img002.jpg')]: 'Download timeout'
      }
    })
    await renderExplorer({ side: 'remote', path: '/', server: OTHER })

    const batches = invokeCalls(h.invoke, 'thumbnail:requestBatch')
    if (!batches.length) throw new Error('no thumbnail:requestBatch')
    const names = (batches[batches.length - 1][0] as Array<{ fileName: string }>).map(
      (r) => r.fileName
    )
    // 그 탭의 세션 키에 이미 있는 항목은 건너뛴다 — 키가 그 세션의 host·port로 만들어졌다는 증거다.
    expect(names).not.toContain('img000.jpg')
    expect(names).not.toContain('img001.jpg')
    // primary 투영 키는 무시한다: 같은 항목은 그대로 요청된다.
    expect(names).toContain('img002.jpg')
    // 타일도 그 세션 키로 스토어를 읽어 이미지를 그대로 보여준다(ThumbnailImage의 키도 같다).
    expect(option('img000.jpg').querySelector('img')).toBeTruthy()
  })
})
