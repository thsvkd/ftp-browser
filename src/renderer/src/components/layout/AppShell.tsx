import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { Toolbar } from './Toolbar'
import { StatusBar } from './StatusBar'
import { Sidebar } from './Sidebar'
import { TabStrip } from './TabStrip'
import { RightRail } from './RightRail'
import { Explorer } from '@renderer/components/explorer/Explorer'
import { useDnd } from '@renderer/components/explorer/dnd'
import { ConflictSheet } from '@renderer/components/activity/ConflictSheet'
import { ShelfDock } from '@renderer/components/shelf/ShelfDock'
import { SettingsDialog } from '@renderer/components/settings/SettingsDialog'
import { useThumbnailListener } from '@renderer/hooks/useThumbnailListener'
import { useLocalThumbnailListener } from '@renderer/hooks/useLocalThumbnailListener'
import { useUpdateListener } from '@renderer/hooks/useUpdateListener'
import { useAgentSync } from '@renderer/hooks/useAgentSync'
import { dropShelf, reloadActiveTab } from '@renderer/lib/sendItems'
import { useSettingsStore } from '@renderer/stores/useSettingsStore'
import { focusedPane, useTabsStore } from '@renderer/stores/useTabsStore'
import type { IpcResult } from '@shared/types/ipc'

/**
 * F6 순서. 지역마다 앞의 것부터 처음 맞는 요소에 포커스를 준다(랩 V2). 패널이 둘이면
 * 탭·목록 지역은 지금 포커스가 있는 패널의 요소를 먼저 찾는다(함정 G — 셋째 지역이
 * `[id^="explorer-list-"]` 첫 일치만 잡으면 첫 패널에 갇힌다).
 */
const regions = (paneId: string): string[][] => [
  ['[data-region="sidebar"] [aria-current]', '[data-region="sidebar"] button'],
  [
    `[data-region="tabs-${paneId}"] [role="tab"][aria-selected="true"]`,
    '[data-region="tabs"] [role="tab"][aria-selected="true"]'
  ],
  [
    `[data-region="content-${paneId}"] [id^="explorer-list-"]`,
    '[data-region="content"] [id^="explorer-list-"]'
  ],
  ['[data-region="shelf-dock"] li[tabindex]', '[data-region="shelf-dock"] button']
]

const isTyping = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))

export function AppShell(): React.JSX.Element {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const openSettings = useCallback(() => setSettingsOpen(true), [])
  const rootRef = useRef<HTMLDivElement>(null)
  // 화면 설정(S3). F6 지역 목록(regions)은 CSS 쿼리를 필터링하므로 요소가 없어도 안전하다(함정 A).
  const showSidebar = useSettingsStore((s) => s.showSidebar)
  const showRail = useSettingsStore((s) => s.showRail)
  // 패널(1~2개, M10)마다 하나의 콘텐츠 영역을 그린다.
  const panes = useTabsStore((s) => s.panes)

  useThumbnailListener()
  useLocalThumbnailListener()
  useUpdateListener()
  useAgentSync()

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
      const pane = focusedPane(useTabsStore.getState())
      const els = regions(pane?.id ?? '')
        .map((qs) => qs.map((q) => root.querySelector<HTMLElement>(q)).find(Boolean))
        .filter((el): el is HTMLElement => !!el)
      const cur = els.findIndex((el) =>
        el.closest('[data-region]')?.contains(document.activeElement)
      )
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
      let run: (() => void) | null = null
      if (e.key === 'F6') run = () => cycleRegion(e.shiftKey ? -1 : 1)
      else if (typing) return
      else if (ctrl && e.key === 'Enter') run = () => tab && void dropShelf(tab.loc)
      else if (e.key === 'F5' || (ctrl && key === 'r')) run = reloadActiveTab
      else if (e.altKey && e.shiftKey && key === 'p')
        run = () => {
          const s = useSettingsStore.getState()
          s.setShowRail(!s.showRail)
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
      <div className="flex min-h-0 flex-1">
        {showSidebar && <Sidebar />}
        <main className="relative flex min-w-0 flex-1 flex-row">
          {panes.map((pane, i) => (
            <Fragment key={pane.id}>
              {i > 0 && <div className="w-px shrink-0 bg-[var(--bd)]" aria-hidden />}
              {/* 패널마다 자기 TabStrip·Explorer를 가진다(M11). 클릭한 패널이 포커스 패널이 된다. */}
              <section
                data-region={`content-${pane.id}`}
                onPointerDown={() => useTabsStore.getState().activatePane(pane.id)}
                className="relative flex min-w-0 flex-1 flex-col"
              >
                <TabStrip paneId={pane.id} />
                <Explorer paneId={pane.id} />
              </section>
            </Fragment>
          ))}
        </main>
        {showRail && <RightRail />}
      </div>
      <StatusBar />
      <ConflictSheet />
      <ShelfDock />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  )
}
