import { useEffect, useState } from 'react'
import { Package, X } from 'lucide-react'
import { useT } from '@renderer/i18n'
import type { ExplorerEntry } from '@renderer/lib/explorerEntry'
import { cn, formatBytes } from '@renderer/lib/utils'
import { useShelfStore } from '@renderer/stores/useShelfStore'
import { useDnd, useDropTarget } from '@renderer/components/explorer/dnd'
import { Shelf } from './Shelf'

const fileBytes = (sum: number, e: ExplorerEntry): number => sum + (e.type === 'file' ? e.size : 0)

/**
 * OS에서 끌어온 파일 드래그가 앱 안에 있는 동안 true. F4의 개정: 선반의 OS 드롭 대상(원 레일의
 * 세그먼트)이 도크로 옮겼으므로, 띠가 OS 드래그 중에도 떠 있어야 그 대상이 살아 있다(shelf-os-drop
 * 보존). dragenter/dragleave 쌍을 세고, drop·dragend는 캡처 단계에서 끝낸다(놓기 대상이 전파를
 * 멈춰도 리셋이 되게 — 함정 F와 무관하게 문서까지 도달하는 유일한 경로다).
 */
function useOsDrag(): boolean {
  const [osDrag, setOsDrag] = useState(false)
  useEffect(() => {
    const isFiles = (e: DragEvent): boolean =>
      !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')
    let depth = 0
    const enter = (e: DragEvent): void => {
      if (!isFiles(e)) return
      depth += 1
      setOsDrag(true)
    }
    const leave = (): void => {
      depth = Math.max(0, depth - 1)
      if (!depth) setOsDrag(false)
    }
    const end = (): void => {
      depth = 0
      setOsDrag(false)
    }
    document.addEventListener('dragenter', enter)
    document.addEventListener('dragleave', leave)
    document.addEventListener('drop', end, true)
    document.addEventListener('dragend', end, true)
    return () => {
      document.removeEventListener('dragenter', enter)
      document.removeEventListener('dragleave', leave)
      document.removeEventListener('drop', end, true)
      document.removeEventListener('dragend', end, true)
    }
  }, [])
  return osDrag
}

/** 접힘 pill 겸 펼침 버튼(F2): 개수와 총 용량. 펼친 카드가 떠 있는 동안에도 여기로 다시 접는다. */
function DockPill({ open }: { open: boolean }): React.JSX.Element {
  const t = useT()
  const items = useShelfStore((s) => s.items)
  const total = items.reduce((sum, i) => sum + fileBytes(0, i.entry), 0)
  return (
    <button
      data-region="shelf-dock"
      aria-expanded={open}
      title={open ? t('shelf.collapse') : t('shelf.expand')}
      onClick={() => useShelfStore.getState().toggleDock()}
      className="flex h-10 items-center gap-2 rounded-full border border-[var(--bd)] bg-[var(--sf)] px-3.5 text-[12.5px] font-semibold shadow-lg"
    >
      <Package className="h-4 w-4 text-[var(--shx)]" aria-hidden />
      <span>{t('common.itemCount', { count: items.length })}</span>
      <span className="mono text-[var(--mu)]">{formatBytes(total)}</span>
    </button>
  )
}

/**
 * 하단 플로팅 리모컨 카드(F1·F2). 몸통은 기존 `Shelf`를 그대로 쓴다. 접혀 있어도 몸통은 DOM에
 * 남는데, 내려놓기 더미가 `[data-shelf-stack] [data-card]`를 찾으므로 `hidden`이 아니라
 * `opacity`·`pointer-events`·`aria-hidden`으로만 감춘다(함정 D).
 */
function ShelfRemoteCard({ open }: { open: boolean }): React.JSX.Element {
  const t = useT()
  return (
    <div className="relative flex flex-col items-center">
      <div
        role="region"
        aria-label={t('shelf.title')}
        aria-hidden={!open}
        {...(open ? { 'data-region': 'shelf-dock' } : {})}
        className={cn(
          'absolute bottom-12 left-1/2 flex h-[420px] w-[320px] -translate-x-1/2 flex-col overflow-hidden rounded-2xl border border-[var(--bd)] bg-[var(--sb)] shadow-xl',
          open ? 'opacity-100' : 'pointer-events-none opacity-0'
        )}
      >
        <div className="flex h-8 shrink-0 items-center justify-between border-b border-[var(--bd)] px-3">
          <span className="text-[12.5px] font-bold">{t('shelf.title')}</span>
          <button
            aria-label={t('shelf.collapse')}
            onClick={() => useShelfStore.getState().setDockOpen(false)}
            className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--mu)] hover:bg-[var(--hv)] hover:text-[var(--tx)]"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
        <Shelf />
      </div>
      <DockPill open={open} />
    </div>
  )
}

/**
 * 하단 리모컨 도크(6번 스펙). 선반이 비어 있고 끄는 중이 아니면 아무것도 그리지 않고(F3),
 * 끄는 동안에만 전폭 담기 띠를 띄운다(F4 — 앱 안 항목·OS 파일 드래그 모두, §9-3). 띠의 놓기
 * 대상 키는 기존 `'shelf'`를 그대로 쓴다(F5).
 */
export function ShelfDock(): React.JSX.Element | null {
  const t = useT()
  const items = useShelfStore((s) => s.items)
  const open = useShelfStore((s) => s.dockOpen)
  const dragging = useDnd((s) => s.items !== null)
  const osDrag = useOsDrag()
  const drop = useDropTarget('shelf', 'shelf')
  if (!items.length && !dragging && !osDrag) return null
  return (
    <>
      {/* F4·함정 F: 띠는 끄는 동안에만 보이고, 그 아래를 가리지 않도록 그럴 때만 그려진다 */}
      {(dragging || osDrag) && (
        <div
          data-region="shelf-dock"
          data-shelf-target
          {...drop.handlers}
          className={cn(
            'fixed inset-x-0 bottom-8 z-30 flex h-14 items-center justify-center gap-2 rounded-t-xl border-b-2 text-[13px] font-semibold shadow-lg transition-colors',
            drop.over
              ? 'border-[var(--sh)] bg-[var(--shw)] text-[var(--shx)]'
              : 'border-[var(--sh)] bg-[var(--sf)] text-[var(--tx)]'
          )}
        >
          <Package className="h-4 w-4 text-[var(--shx)]" aria-hidden />
          {drop.over ? t('shelf.dropHere') : t('shelf.dockHint')}
        </div>
      )}
      {/* 카드는 띠 위로만 뜬다(함정 B). 띠에 호버하면 점등·확장(F2) */}
      {items.length > 0 && (
        <div className="pointer-events-none fixed inset-x-0 bottom-24 z-30 flex justify-center">
          <div className="pointer-events-auto">
            <ShelfRemoteCard open={open || (dragging && drop.over)} />
          </div>
        </div>
      )}
    </>
  )
}
