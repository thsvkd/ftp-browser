import { create } from 'zustand'
import {
  fromFtpEntry,
  fromLocalEntry,
  locKey,
  type ExplorerEntry,
  type Loc,
  type Side
} from '@renderer/lib/explorerEntry'
import { currentConn } from './useFtpStore'
import type { ErrorCodeType, IpcResult } from '@shared/types/ipc'
import type { FtpListResult } from '@shared/types/ftp'
import type { LocalListResult } from '@shared/types/local'

export interface Listing {
  entries: ExplorerEntry[]
  status: 'loading' | 'ready' | 'error'
  /** 지난 목록을 보이는 채로 다시 읽는 중 */
  refreshing: boolean
  error?: string
  code?: ErrorCodeType
}

interface ListingStore {
  /** `locKey(폴더)` → 목록 */
  byKey: Record<string, Listing>
  /** 폴더를 (다시) 읽는다. 지난 목록이 있으면 유지하고 `refreshing`만 켠다. */
  load: (loc: Loc) => Promise<void>
  /** 이미 읽은 폴더를 받은 목록으로 채운다(연결 직후 시작 폴더, D3). */
  put: (loc: Loc, entries: ExplorerEntry[]) => void
  /** 그 폴더를 읽은 적이 있으면 다시 읽는다. */
  invalidate: (side: Side, server: string | undefined, dir: string) => void
}

/** 키별 세대 번호. 늦게 온 이전 요청의 결과를 버린다. */
const generations = new Map<string, number>()

/** 폴더를 읽어 항목으로 바꾼다(캐시에 넣지 않는다). */
export async function fetchEntries(loc: Loc): Promise<IpcResult<ExplorerEntry[]>> {
  try {
    if (loc.side === 'remote') {
      const r = await window.api.invoke<IpcResult<FtpListResult>>(
        'ftp:list',
        currentConn(),
        loc.path
      )
      return r.success
        ? {
            success: true,
            data: r.data.entries.map((e) => fromFtpEntry(e, loc.path, loc.server ?? ''))
          }
        : r
    }
    const r = await window.api.invoke<IpcResult<LocalListResult>>('local:list', loc.path)
    return r.success ? { success: true, data: r.data.entries.map(fromLocalEntry) } : r
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export const useListingStore = create<ListingStore>((set, get) => {
  const patch = (key: string, next: Listing): void =>
    set((s) => ({ byKey: { ...s.byKey, [key]: next } }))

  return {
    byKey: {},

    load: async (loc) => {
      const key = locKey(loc)
      const gen = (generations.get(key) ?? 0) + 1
      generations.set(key, gen)
      const prev = get().byKey[key]
      patch(
        key,
        prev ? { ...prev, refreshing: true } : { entries: [], status: 'loading', refreshing: false }
      )
      const result = await fetchEntries(loc)
      if (generations.get(key) !== gen) return
      if (result.success) {
        patch(key, { entries: result.data, status: 'ready', refreshing: false })
      } else {
        patch(key, {
          entries: get().byKey[key]?.entries ?? [],
          status: 'error',
          refreshing: false,
          error: result.error,
          ...(result.code ? { code: result.code } : {})
        })
      }
    },

    put: (loc, entries) => {
      const key = locKey(loc)
      generations.set(key, (generations.get(key) ?? 0) + 1)
      patch(key, { entries, status: 'ready', refreshing: false })
    },

    invalidate: (side, server, dir) => {
      const loc: Loc = { side, path: dir, ...(server ? { server } : {}) }
      if (get().byKey[locKey(loc)]) void get().load(loc)
    }
  }
})
