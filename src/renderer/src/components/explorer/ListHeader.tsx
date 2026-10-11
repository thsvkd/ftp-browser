import { ArrowUp } from 'lucide-react'
import { useT, type MessageKey } from '@renderer/i18n'
import type { SortKey } from '@renderer/lib/entryList'
import { HEAD, LIST_COLS } from '@renderer/lib/explorerLayout'
import { cn } from '@renderer/lib/utils'
import { useTabsStore, type Tab } from '@renderer/stores/useTabsStore'

const COLS: Array<{ key: SortKey; label: MessageKey; right?: boolean }> = [
  { key: 'name', label: 'file.name' },
  { key: 'size', label: 'file.size', right: true },
  { key: 'modified', label: 'file.modified' },
  { key: 'type', label: 'file.type' }
]

/** 리스트 열 머리. 누르면 그 열로 정렬하고, 같은 열을 다시 누르면 방향을 바꾼다(탭에 남는다). */
export function ListHeader({ tab }: { tab: Tab }): React.JSX.Element {
  const t = useT()
  return (
    <div
      role="table"
      aria-label={t('sort.label')}
      className="shrink-0 overflow-hidden border-b border-[var(--bd)] [scrollbar-gutter:stable]"
    >
      <div
        role="row"
        className={cn(
          'mx-2 grid items-center gap-3 px-2.5 text-[12px] font-semibold text-[var(--mu)]',
          LIST_COLS
        )}
        style={{ height: HEAD }}
      >
        {COLS.map((c) => {
          const active = tab.sort.key === c.key
          return (
            <div
              key={c.key}
              role="columnheader"
              aria-sort={active ? (tab.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
              className={cn('flex', c.right && 'justify-end')}
            >
              <button
                onClick={() =>
                  useTabsStore.getState().patchTab(tab.id, {
                    sort: {
                      ...tab.sort,
                      key: c.key,
                      dir: active && tab.sort.dir === 'asc' ? 'desc' : 'asc'
                    }
                  })
                }
                className={cn(
                  'flex h-7 items-center gap-1 rounded-md px-1 hover:text-[var(--tx)]',
                  active && 'text-[var(--tx)]'
                )}
              >
                {t(c.label)}
                {active && (
                  <ArrowUp
                    aria-hidden
                    className={cn(
                      'h-3.5 w-3.5 transition-transform',
                      tab.sort.dir === 'desc' && 'rotate-180'
                    )}
                  />
                )}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
