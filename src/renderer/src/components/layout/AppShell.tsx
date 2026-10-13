import { useCallback, useEffect, useRef, useState } from 'react'
import { Toolbar } from './Toolbar'
import { StatusBar } from './StatusBar'
import { Sidebar } from './Sidebar'
import { TabStrip } from './TabStrip'
import { RightRail } from './RightRail'
import { SidePane } from './SidePane'
import { Explorer } from '@renderer/components/explorer/Explorer'
import { useDnd } from '@renderer/components/explorer/dnd'
import { ConflictSheet } from '@renderer/components/activity/ConflictSheet'
import { SettingsDialog } from '@renderer/components/settings/SettingsDialog'
import { useThumbnailListener } from '@renderer/hooks/useThumbnailListener'
import { useLocalThumbnailListener } from '@renderer/hooks/useLocalThumbnailListener'
import { useUpdateListener } from '@renderer/hooks/useUpdateListener'
import { useElementWidth } from '@renderer/hooks/useElementWidth'
import { useAgentSync } from '@renderer/hooks/useAgentSync'
import { useConnectionStatus } from '@renderer/hooks/useConnectionStatus'
import { dropShelf, reloadActiveTab } from '@renderer/lib/sendItems'
import { useShelfStore } from '@renderer/stores/useShelfStore'
import { useTabsStore } from '@renderer/stores/useTabsStore'
import { useLayoutStore } from '@renderer/stores/useLayoutStore'
import { currentPlatform } from '@renderer/lib/platform'
import { matchPaneShortcut } from '@renderer/lib/sidebarLayout'
import type { IpcResult } from '@shared/types/ipc'

/**
 * F6 순서. 지역마다 앞의 것부터 처음 맞는 요소에 포커스를 준다(랩 V2). 콘텐츠는 패널마다 한 지역이다:
 * 왼쪽 목록 → 오른쪽 목록(P11). 단일 보기는 오른쪽 패널이 없어 건너뛴다.
 */
const REGIONS = [
  ['[data-region="sidebar"] [aria-current]', '[data-region="sidebar"] button'],
  ['[data-region="tabs"] [role="tab"][aria-selected="true"]'],
  ['[data-region="content"] [data-pane="left"] [id^="explorer-list-"]'],
  ['[data-region="content"] [data-pane="right"] [id^="explorer-list-"]'],
  [
    '[data-region="shelf"] li[tabindex]',
    '[data-region="shelf"] [role="tab"][aria-selected="true"]',
    '[data-region="shelf"] button'
  ]
]

const isTyping = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))

export function AppShell(): React.JSX.Element {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const openSettings = useCallback(() => setSettingsOpen(true), [])
  const rootRef = useRef<HTMLDivElement>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  const rowWidth = useElementWidth(rowRef)

  useThumbnailListener()
  useLocalThumbnailListener()
  useUpdateListener()
  useAgentSync()
  useConnectionStatus()

  // 시작 화면은 홈 폴더의 로컬 탭 하나다(D23).
  useEffect(() => {
    if (useTabsStore.getState().tabs.length) return
    void window.api
      .invoke<IpcResult<string>>('local:getHome')
      .then((r) => {
        if (r.success && !useTabsStore.getState().tabs.length)
          useTabsStore.getState().openTab({ side: 'local', path: r.data })
      })
      .catch(() => undefined)
  }, [])

  // 창 어디서나 되는 단축키. 목록이 먼저 처리한 키(stopPropagation)는 여기 오지 않는다.
  useEffect(() => {
    const cycleRegion = (delta: number): void => {
      const root = rootRef.current
      if (!root) return
      const els = REGIONS.map((qs) =>
        qs.map((q) => root.querySelector<HTMLElement>(q)).find(Boolean)
      ).filter((el): el is HTMLElement => !!el && !el.closest('[inert]')) // 접힌 패널은 건너뛴다(.focus()가 조용히 실패한다)
      // 포커스가 있는 지역: 패널이 있으면 그 패널, 없으면 data-region. 패널 밖 본문(구분선)이면 지역으로 찾는다.
      const at = document.activeElement
      let cur = els.findIndex((el) =>
        (el.closest('[data-pane]') ?? el.closest('[data-region]'))?.contains(at)
      )
      if (cur < 0) cur = els.findIndex((el) => el.closest('[data-region]')?.contains(at))
      els[cur < 0 && delta < 0 ? els.length - 1 : (cur + delta + els.length) % els.length]?.focus()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return
      const ctrl = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()
      const s = useTabsStore.getState()
      const tab = s.tabs.find((x) => x.id === s.activeId)
      // 이름 바꾸기·경로·주소 칸 같은 입력에서는 지역 이동만 한다.
      const typing = isTyping(e.target)
      // 사이드 패널 토글은 입력 칸에서도 된다. 키는 code로 본다(macOS ⌥B의 key는 ∫).
      const pane = matchPaneShortcut(
        {
          code: e.code,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
          altKey: e.altKey,
          shiftKey: e.shiftKey,
          altGraph: e.getModifierState('AltGraph')
        },
        currentPlatform()
      )
      let run: (() => void) | null = null
      if (e.key === 'F6') run = () => cycleRegion(e.shiftKey ? -1 : 1)
      else if (pane) run = () => useLayoutStore.getState().toggle(pane)
      else if (typing) return
      // macOS 한국어 자판의 그 키는 '₩'라 code도 본다(P5)
      else if (ctrl && (e.key === '\\' || e.code === 'Backslash'))
        run = () => useTabsStore.getState().toggleSplit()
      else if (ctrl && e.key === 'Enter') run = () => tab && void dropShelf(tab.loc)
      else if (e.key === 'F5' || (ctrl && key === 'r')) run = reloadActiveTab
      else if (e.altKey && e.shiftKey && key === 'p')
        run = () => {
          const shelf = useShelfStore.getState()
          shelf.setRailTab(shelf.railTab === 'info' ? 'shelf' : 'info')
        }
      else if (ctrl && (key === 'l' || key === 'f') && tab) {
        // 목록이 가진 동작(경로 입력, 찾기 칸)을 목록에 넘긴다.
        const list = document.getElementById(`explorer-list-${tab.id}`)
        if (list && !list.contains(e.target as Node))
          run = () =>
            list.dispatchEvent(
              new KeyboardEvent('keydown', { key: e.key, ctrlKey: true, bubbles: true })
            )
      }
      if (!run) return
      e.preventDefault()
      run()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div
      ref={rootRef}
      className="relative flex h-full flex-col overflow-hidden bg-[var(--bg)] text-[var(--tx)]"
      // 놓기 대상은 dragover에서 전파를 멈춘다. 루트까지 왔으면 "아무 대상 위도 아님"이다(함정 6).
      onDragOver={() => useDnd.getState().over && useDnd.setState({ over: null })}
      onDragLeave={(e) =>
        !e.currentTarget.contains(e.relatedTarget as Node | null) && useDnd.setState({ over: null })
      }
    >
      <Toolbar onSettingsClick={openSettings} />
      <div ref={rowRef} className="flex min-h-0 flex-1">
        <SidePane side="left" id="sidebar-pane" containerWidth={rowWidth}>
          <Sidebar />
        </SidePane>
        <main data-region="content" className="relative flex min-w-0 flex-1 flex-col">
          <TabStrip />
          <Explorer />
        </main>
        <SidePane side="right" id="rail-pane" containerWidth={rowWidth}>
          <RightRail />
        </SidePane>
      </div>
      <StatusBar />
      <ConflictSheet />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  )
}
