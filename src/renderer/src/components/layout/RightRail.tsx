import { Info, Package } from 'lucide-react'
import { useT } from '@renderer/i18n'
import { cn } from '@renderer/lib/utils'
import { useShelfStore } from '@renderer/stores/useShelfStore'
import { useDropTarget } from '@renderer/components/explorer/dnd'
import { InfoPanel } from '@renderer/components/shelf/InfoPanel'
import { Shelf } from '@renderer/components/shelf/Shelf'

const segmentCls =
  'flex flex-1 items-center justify-center gap-1.5 rounded-full text-[12.5px] font-semibold transition-colors'

/** "선반" 세그먼트. 정보를 보는 동안에는 이 세그먼트가 선반의 놓기 대상이다(Test-808). */
function ShelfSegment({ active, count }: { active: boolean; count: number }): React.JSX.Element {
  const t = useT()
  const drop = useDropTarget('shelf-tab', active ? null : 'shelf')
  return (
    <button
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      onClick={() => useShelfStore.getState().setRailTab('shelf')}
      {...(active ? {} : { 'data-shelf-target': true })}
      {...drop.handlers}
      className={cn(
        segmentCls,
        active
          ? 'bg-[var(--sf)] text-[var(--tx)] shadow-sm'
          : 'text-[var(--mu)] hover:text-[var(--tx)]',
        drop.over && 'bg-[var(--sh)] text-[var(--shink)]'
      )}
    >
      <Package className="h-4 w-4" aria-hidden /> {t('shelf.title')}
      {count > 0 && (
        <span className="mono flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--sh)] px-1 text-[11px] font-bold text-[var(--shink)]">
          {count}
        </span>
      )}
    </button>
  )
}

/** 오른쪽 레일: 선반과 정보가 한 자리를 나눠 쓴다. Alt+Shift+P(AppShell)로 바꾼다. */
export function RightRail(): React.JSX.Element {
  const t = useT()
  const railTab = useShelfStore((s) => s.railTab)
  const count = useShelfStore((s) => s.items.length)
  const shelf = railTab === 'shelf'
  return (
    <aside
      role="region"
      aria-label={t(shelf ? 'shelf.title' : 'rail.info')}
      data-region="shelf"
      className="flex w-full shrink-0 flex-col border-l border-[var(--bd)] bg-[var(--sb)]"
    >
      <div className="flex h-12 shrink-0 items-center border-b border-[var(--bd)] px-3">
        <div
          role="tablist"
          aria-label={t('rail.label')}
          className="flex h-9 flex-1 rounded-full bg-[var(--bg)] p-1"
          onKeyDown={(e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
            e.preventDefault()
            const next = shelf ? 'info' : 'shelf'
            useShelfStore.getState().setRailTab(next)
            const tabs = e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')
            tabs[next === 'shelf' ? 0 : 1]?.focus()
          }}
        >
          <ShelfSegment active={shelf} count={count} />
          <button
            role="tab"
            aria-selected={!shelf}
            tabIndex={shelf ? -1 : 0}
            onClick={() => useShelfStore.getState().setRailTab('info')}
            className={cn(
              segmentCls,
              !shelf
                ? 'bg-[var(--sf)] text-[var(--tx)] shadow-sm'
                : 'text-[var(--mu)] hover:text-[var(--tx)]'
            )}
          >
            <Info className="h-4 w-4" aria-hidden /> {t('rail.info')}
          </button>
        </div>
      </div>
      <div key={railTab} className="slide flex min-h-0 flex-1 flex-col">
        {shelf ? <Shelf /> : <InfoPanel />}
      </div>
    </aside>
  )
}
