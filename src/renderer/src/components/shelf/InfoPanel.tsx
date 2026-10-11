import { useMemo } from 'react'
import { PackageMinus, PackagePlus } from 'lucide-react'
import { useT } from '@renderer/i18n'
import { useTabEntries } from '@renderer/hooks/useTabEntries'
import { locKey, type EntryCategory, type ExplorerEntry } from '@renderer/lib/explorerEntry'
import { locLabel, sourceLabel } from '@renderer/lib/sendItems'
import { cn, formatBytes } from '@renderer/lib/utils'
import { useShelfStore } from '@renderer/stores/useShelfStore'
import { useActiveTab } from '@renderer/stores/useTabsStore'
import { SourceBadge } from '@renderer/components/common/SourceBadge'
import { EntryFacts } from '@renderer/components/explorer/EntryFacts'
import { EntryThumb } from '@renderer/components/thumbnail/EntryThumb'

/** 분류별 막대 색. 밝고 어두운 바탕 모두에서 구별된다. */
const CAT_HEX: Record<EntryCategory, string> = {
  image: '#0EA5E9',
  raw: '#06B6D4',
  video: '#8B5CF6',
  audio: '#EC4899',
  doc: '#3B82F6',
  archive: '#F97316',
  code: '#10B981',
  other: '#94A3B8'
}

const SHELF_BTN =
  'inline-flex items-center justify-center gap-2 rounded-[10px] bg-[var(--sh)] px-3 text-[12.5px] font-semibold text-[var(--shink)] transition hover:brightness-105'

const fileBytes = (sum: number, e: ExplorerEntry): number => sum + (e.type === 'file' ? e.size : 0)

/** 파일의 분류별 수·크기: 막대 하나와 목록. */
function Breakdown({ entries }: { entries: ExplorerEntry[] }): React.JSX.Element | null {
  const t = useT()
  const groups = new Map<EntryCategory, { n: number; size: number }>()
  for (const e of entries) {
    if (e.type !== 'file') continue
    const g = groups.get(e.category) ?? { n: 0, size: 0 }
    g.n++
    g.size += e.size
    groups.set(e.category, g)
  }
  if (!groups.size) return null
  const rows = [...groups].sort((a, b) => b[1].n - a[1].n)
  const total = rows.reduce((s, [, g]) => s + g.n, 0)
  return (
    <div className="mt-5">
      <div className="flex h-2 overflow-hidden rounded-full bg-[var(--bg)]" aria-hidden>
        {rows.map(([c, g]) => (
          <span key={c} style={{ width: `${(g.n / total) * 100}%`, background: CAT_HEX[c] }} />
        ))}
      </div>
      <ul className="mt-3 space-y-1.5 text-[12.5px]">
        {rows.map(([c, g]) => (
          <li key={c} className="flex items-center gap-2">
            <span
              className="h-2.5 w-2.5 rounded-sm"
              style={{ background: CAT_HEX[c] }}
              aria-hidden
            />
            <span className="flex-1">{t(`category.${c}`)}</span>
            <span className="mono text-[11.5px] text-[var(--mu)]">
              {g.n.toLocaleString()} · {formatBytes(g.size)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** 정보 레일(Test-835): 선택 없음은 폴더 요약, 1개는 미리보기와 사실, 여러 개는 수·크기·분류. */
export function InfoPanel(): React.JSX.Element {
  const t = useT()
  const tab = useActiveTab()
  const { all, selected } = useTabEntries(tab)
  const shelfKeys = useShelfStore((s) => s.items.map((i) => locKey(i.entry)).join('\n'))
  const shelved = useMemo(() => new Set(shelfKeys.split('\n')), [shelfKeys])
  const { add, remove } = useShelfStore.getState()

  if (selected.length === 1) {
    const e = selected[0]
    const onShelf = shelved.has(locKey(e))
    return (
      <div className="scroll flex-1 overflow-y-auto p-4">
        <div className="aspect-[4/3] overflow-hidden rounded-[12px] bg-[var(--tile)]">
          <EntryThumb entry={e} glyph="h-12 w-12" folderPreview request size={256} />
        </div>
        <h3 className="mt-3 break-words text-[15px] font-bold leading-snug">{e.name}</h3>
        <button
          onClick={() => (onShelf ? remove([locKey(e)]) : add([e]))}
          className={cn(SHELF_BTN, 'mt-3 h-8 w-full')}
        >
          {onShelf ? (
            <PackageMinus className="h-4 w-4" aria-hidden />
          ) : (
            <PackagePlus className="h-4 w-4" aria-hidden />
          )}
          {t(onShelf ? 'menu.removeFromShelf' : 'menu.addToShelf')}
        </button>
        <div className="mt-4 border-t border-[var(--bd)] pt-2">
          <EntryFacts entry={e} />
        </div>
      </div>
    )
  }

  if (selected.length > 1) {
    const unshelved = selected.filter((e) => !shelved.has(locKey(e)))
    return (
      <div className="scroll flex-1 overflow-y-auto p-4">
        <div className="relative mx-auto mb-4 mt-2 h-[120px] w-[180px]" aria-hidden>
          {selected.slice(0, 3).map((e, i) => (
            <div
              key={e.path}
              className="absolute inset-0 overflow-hidden rounded-[12px] border-[3px] border-[var(--sf)] bg-[var(--tile)] shadow-md"
              style={{ transform: `rotate(${[-7, 5, 0][i]}deg)` }}
            >
              <EntryThumb entry={e} glyph="h-8 w-8" request showSlow={false} ext={false} />
            </div>
          ))}
        </div>
        <h3 className="text-center text-[17px] font-bold">
          {t('rail.selected', { count: selected.length })}
        </h3>
        <p className="mono mt-0.5 text-center text-[12px] text-[var(--mu)]">
          {formatBytes(selected.reduce(fileBytes, 0))}
          {selected.some((e) => e.type === 'directory') && ` · ${t('send.folderContents')}`}
        </p>
        <button
          onClick={() =>
            unshelved.length ? add(unshelved) : remove(selected.map((e) => locKey(e)))
          }
          className={cn(SHELF_BTN, 'mt-4 h-9 w-full')}
        >
          {unshelved.length ? (
            <PackagePlus className="h-4 w-4" aria-hidden />
          ) : (
            <PackageMinus className="h-4 w-4" aria-hidden />
          )}
          {unshelved.length
            ? t('menu.addManyToShelf', { number: unshelved.length })
            : t('menu.removeFromShelf')}
        </button>
        <Breakdown entries={selected} />
      </div>
    )
  }

  const dirs = all.filter((e) => e.type === 'directory').length
  return (
    <div className="scroll flex-1 overflow-y-auto p-4">
      <div className="flex aspect-[4/3] items-center justify-center rounded-[12px] bg-[var(--tile)]">
        {tab && <SourceBadge side={tab.loc.side} size={56} />}
      </div>
      {tab && (
        <>
          <h3 className="mt-3 break-words text-[15px] font-bold">{locLabel(tab.loc)}</h3>
          <p className="mono mt-0.5 break-all text-[11.5px] text-[var(--mu)]">
            {sourceLabel(tab.loc)} · {tab.loc.path}
          </p>
        </>
      )}
      <div className="mt-4 grid grid-cols-3 gap-2 text-center">
        {[
          t('status.folderCount', { count: dirs }),
          t('status.fileCount', { count: all.length - dirs }),
          formatBytes(all.reduce(fileBytes, 0))
        ].map((v, i) => (
          <div
            key={i}
            className="mono rounded-[10px] bg-[var(--sf)] px-1.5 py-2.5 text-[12px] font-bold"
          >
            {v}
          </div>
        ))}
      </div>
      <Breakdown entries={all} />
    </div>
  )
}
