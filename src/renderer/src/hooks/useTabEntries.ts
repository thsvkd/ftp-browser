import { useMemo } from 'react'
import { filterEntries } from '@renderer/lib/entryList'
import { locKey, type ExplorerEntry } from '@renderer/lib/explorerEntry'
import { EMPTY_FILTER } from '@renderer/lib/fileCategories'
import { connectedServer } from '@renderer/lib/sendItems'
import { useTabMatcher } from './useFileFilter'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import { useListingStore } from '@renderer/stores/useListingStore'
import { useSettingsStore } from '@renderer/stores/useSettingsStore'
import type { Tab } from '@renderer/stores/useTabsStore'

const NONE: ExplorerEntry[] = []

export interface TabEntries {
  /** 그 폴더의 목록 전체(숨김 포함) */
  all: ExplorerEntry[]
  /** 탭의 찾기·파일 종류 필터와 숨김 설정을 거친 항목 */
  visible: ExplorerEntry[]
  /** 보이는 항목 중 탭이 고른 것 */
  selected: ExplorerEntry[]
}

/**
 * 탭이 보는 폴더의 항목. 상태 표시줄과 정보 레일이 탐색기와 같은 걸러내기로 센다. 탐색기가 목록 대신
 * 패널을 보이는 원격 탭(연결 없음·다른 서버, D2)은 비어 있다. 연결이 끊긴 탭은 지난 목록을 센다.
 */
export function useTabEntries(tab: Tab | undefined): TabEntries {
  const listed = useFtpStore((s) => {
    if (!tab || tab.loc.side === 'local' || s.connectionStatus === 'error') return true
    const server = connectedServer(s)
    return !!server && (!tab.loc.server || tab.loc.server === server)
  })
  const cached = useListingStore((s) => (tab ? s.byKey[locKey(tab.loc)]?.entries : undefined))
  const all = (listed && cached) || NONE
  const showHidden = useSettingsStore((s) => s.showHidden)
  const query = tab?.query ?? ''
  const matcher = useTabMatcher(tab?.filter ?? EMPTY_FILTER)
  const sel = tab?.sel
  const visible = useMemo(
    () => filterEntries(all, { query, matcher, showHidden }).visible,
    [all, query, matcher, showHidden]
  )
  const selected = useMemo(() => {
    const set = new Set(sel)
    return set.size ? visible.filter((e) => set.has(e.path)) : NONE
  }, [visible, sel])
  return { all, visible, selected }
}
