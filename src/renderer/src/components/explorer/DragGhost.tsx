import { useT } from '@renderer/i18n'
import { formatBytes } from '@renderer/lib/utils'
import { GHOST_ID, useDnd } from './dnd'

/**
 * 끄는 동안 커서 옆에 붙는 고스트: 화면 속 썸네일 최대 3장을 겹치고 개수·크기를 보인다.
 * 화면 밖에 그려 두면 `startDrag`가 `setDragImage`로 찍어 간다. 폴더 크기는 합산하지 않으므로
 * 폴더가 섞이면 "+ folder contents"를 붙인다.
 */
export function DragGhost(): React.JSX.Element | null {
  const items = useDnd((s) => s.items)
  const thumbs = useDnd((s) => s.thumbs)
  const t = useT()
  if (!items?.length) return null
  const size = formatBytes(items.reduce((sum, i) => sum + (i.type === 'file' ? i.size : 0), 0))
  const one = items.length === 1
  const sub = [one && size, items.some((i) => i.type === 'directory') && t('send.folderContents')]
    .filter(Boolean)
    .join(' · ')
  return (
    <div
      id={GHOST_ID}
      aria-hidden
      className="fixed left-[-1000px] top-[-1000px] z-[9999] flex items-center gap-2.5 rounded-xl border border-[var(--bd)] bg-[var(--sf)] py-2 pl-2 pr-3 text-[12px] font-semibold text-[var(--tx)] shadow-[var(--shadow)]"
    >
      <span className="relative h-9 w-11 shrink-0">
        {thumbs.map((src, i) => (
          <span
            key={i}
            className="absolute inset-0 rounded-md border-2 border-[var(--sf)] bg-[var(--tile)] bg-cover bg-center shadow-sm"
            style={{
              backgroundImage: src ? `url("${src}")` : undefined,
              transform: `rotate(${[-7, 5, 0][i]}deg)`
            }}
          />
        ))}
      </span>
      <span className="max-w-[220px] overflow-hidden">
        <span className="block truncate">
          {one ? items[0].name : t('dnd.ghost', { count: items.length, size })}
        </span>
        {sub && (
          <span className="block truncate text-[11px] font-medium text-[var(--mu)]">{sub}</span>
        )}
      </span>
    </div>
  )
}
