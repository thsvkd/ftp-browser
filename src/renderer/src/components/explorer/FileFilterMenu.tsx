import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, ListFilter, X } from 'lucide-react'
import { useLocale, useT } from '@renderer/i18n'
import { useAllCategories, useCategories, useCategoryName } from '@renderer/hooks/useFileFilter'
import type { ExplorerEntry } from '@renderer/lib/explorerEntry'
import {
  EMPTY_FILTER,
  activeCount,
  countByCategory,
  extensionCounts,
  filterLabel,
  orphanExtensions,
  parseExtensionInput,
  type TabFilter
} from '@renderer/lib/fileCategories'
import { clampMenuPosition, type MenuPlacement } from '@renderer/lib/menuPosition'
import { cn } from '@renderer/lib/utils'
import { useTabsStore, type Tab } from '@renderer/stores/useTabsStore'

const POPOVER_WIDTH = 288

const rowCls =
  'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-[13px] text-[var(--tx)] hover:bg-[var(--hv)] data-[empty=true]:opacity-50'

function CheckRow({
  label,
  checked,
  empty,
  onChange
}: {
  label: string
  checked: boolean
  empty?: boolean
  onChange: () => void
}): React.JSX.Element {
  return (
    <label className={rowCls} data-empty={empty ? 'true' : undefined}>
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="h-4 w-4 shrink-0 accent-[var(--ac)]"
      />
      <span className="min-w-0 truncate">{label}</span>
    </label>
  )
}

function ExtensionInput({
  filter,
  commit
}: {
  filter: TabFilter
  commit: (f: TabFilter) => void
}): React.JSX.Element {
  const t = useT()
  const [text, setText] = useState('')
  const [invalid, setInvalid] = useState(false)

  const add = (source: string): void => {
    const { valid, invalid: bad } = parseExtensionInput(source)
    const extensions = [...filter.extensions]
    for (const ext of valid) if (!extensions.includes(ext)) extensions.push(ext)
    if (extensions.length !== filter.extensions.length) commit({ ...filter, extensions })
    setText(bad.join(' '))
    setInvalid(bad.length > 0)
  }

  return (
    <input
      value={text}
      aria-label={t('filter.extensionInput')}
      aria-invalid={invalid}
      title={invalid ? t('filter.extensionInvalid') : undefined}
      placeholder={t('filter.extensionInput')}
      spellCheck={false}
      onChange={(e) => {
        setText(e.target.value)
        setInvalid(false)
      }}
      onPaste={(e) => {
        e.preventDefault()
        add(`${text} ${e.clipboardData.getData('text')}`)
      }}
      onKeyDown={(e) => {
        // Esc는 닫기로 이어지게 둔다. 나머지 키는 목록의 type-ahead·Delete로 새지 않게 막는다.
        if (e.key === 'Escape') return
        e.stopPropagation()
        // 한글 조합 중에는 확정하지 않는다. 조합이 쪼개져 "ㅌ" 같은 조각이 태그가 된다.
        if (e.nativeEvent.isComposing || e.keyCode === 229) return
        if (e.key === 'Enter' || e.key === ',' || e.key === ';' || e.key === ' ') {
          e.preventDefault()
          add(text)
        }
      }}
      className={cn(
        'h-7 min-w-[7rem] flex-1 rounded-md border bg-[var(--bg)] px-2 text-[12.5px] text-[var(--tx)] outline-none placeholder:text-[var(--mu)] focus:border-[var(--ac)]',
        invalid ? 'border-[var(--dg)]' : 'border-[var(--bd)]'
      )}
    />
  )
}

function Popover({
  id,
  tab,
  entries,
  placement,
  rootRef,
  onMeasure
}: {
  id: string
  tab: Tab
  entries: readonly ExplorerEntry[]
  placement: MenuPlacement | null
  rootRef: React.RefObject<HTMLDivElement | null>
  onMeasure: () => void
}): React.JSX.Element {
  const t = useT()
  const locale = useLocale()
  const categories = useCategories()
  const nameOf = useCategoryName()
  const filter = tab.filter
  const commit = (f: TabFilter): void => useTabsStore.getState().patchTab(tab.id, { filter: f })
  const hasExtensionConditions = filter.extensions.length > 0 || filter.noExtension
  const [advanced, setAdvanced] = useState(hasExtensionConditions)
  const number = useMemo(() => new Intl.NumberFormat(locale), [locale])

  // 열린 동안에만 센다. 닫혀 있을 때는 이 컴포넌트가 없으므로 비용이 없다.
  const counts = useMemo(() => countByCategory(entries, categories), [entries, categories])
  const folderExts = useMemo(() => extensionCounts(entries), [entries])
  const orphans = orphanExtensions(
    filter.extensions,
    folderExts.exts.map((e) => e.ext)
  )

  // 펼치면 높이가 달라지므로 다시 재서 화면 아래로 넘치지 않게 한다.
  useLayoutEffect(() => {
    onMeasure()
  }, [advanced, onMeasure])
  // 자리를 잡아 보이게 된 뒤 첫 컨트롤에 포커스를 준다(보이지 않는 동안의 focus()는 무시된다).
  useLayoutEffect(() => {
    if (placement)
      rootRef.current
        ?.querySelector<HTMLElement>('button:not([disabled]), input:not([disabled])')
        ?.focus()
    // 처음 자리를 잡을 때만
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placement === null])

  const toggle = (list: string[], value: string): string[] =>
    list.includes(value) ? list.filter((x) => x !== value) : [...list, value]
  const active = filter.categories.length > 0 || hasExtensionConditions

  return (
    <div
      ref={rootRef}
      id={id}
      role="dialog"
      aria-label={t('filter.menuLabel')}
      style={{
        position: 'fixed',
        left: placement?.left ?? 0,
        top: placement?.top ?? 0,
        width: POPOVER_WIDTH,
        maxHeight: 'min(70vh, 480px)',
        visibility: placement ? 'visible' : 'hidden'
      }}
      className="z-[60] flex flex-col overflow-y-auto rounded-xl border border-[var(--bd)] bg-[var(--sf)] p-1.5 shadow-lg"
    >
      <button
        disabled={!active}
        onClick={() => commit(EMPTY_FILTER)}
        className="mb-1 h-8 rounded-lg px-2 text-left text-[13px] font-semibold text-[var(--ac)] hover:bg-[var(--hv)] disabled:text-[var(--mu)] disabled:opacity-60 disabled:hover:bg-transparent"
      >
        {t('explorer.showAll')}
      </button>
      {categories.map((c) => (
        <CheckRow
          key={c.id}
          label={`${nameOf(c)} (${number.format(counts[c.id] ?? 0)})`}
          checked={filter.categories.includes(c.id)}
          empty={!counts[c.id]}
          onChange={() => commit({ ...filter, categories: toggle(filter.categories, c.id) })}
        />
      ))}
      <div className="my-1.5 border-t border-[var(--bd)]" />
      <button
        aria-expanded={advanced}
        onClick={() => setAdvanced(!advanced)}
        className="flex h-8 items-center gap-1 rounded-lg px-2 text-[13px] text-[var(--mu)] hover:bg-[var(--hv)] hover:text-[var(--tx)]"
      >
        {advanced ? (
          <ChevronDown className="h-3.5 w-3.5" aria-hidden />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" aria-hidden />
        )}
        {t('filter.advanced')}
      </button>
      {advanced && (
        <div role="group" aria-label={t('filter.advancedHeading')} className="flex flex-col">
          {folderExts.exts.map(({ ext, count }) => (
            <CheckRow
              key={ext}
              label={`.${ext} (${number.format(count)})`}
              checked={filter.extensions.includes(ext)}
              onChange={() => commit({ ...filter, extensions: toggle(filter.extensions, ext) })}
            />
          ))}
          {(folderExts.noExtension > 0 || filter.noExtension) && (
            <CheckRow
              label={`${t('filter.noExtension')} (${number.format(folderExts.noExtension)})`}
              checked={filter.noExtension}
              empty={folderExts.noExtension === 0}
              onChange={() => commit({ ...filter, noExtension: !filter.noExtension })}
            />
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-1 px-1 pb-1">
            {orphans.map((ext) => (
              <span
                key={ext}
                className="flex h-6 items-center gap-1 rounded-full bg-[var(--acw)] pl-2 pr-1 text-[12px] text-[var(--ac)]"
              >
                .{ext}
                <button
                  aria-label={t('filter.removeExtension', { ext })}
                  onClick={() =>
                    commit({ ...filter, extensions: filter.extensions.filter((x) => x !== ext) })
                  }
                  className="flex h-4 w-4 items-center justify-center rounded-full hover:bg-[var(--hv)]"
                >
                  <X className="h-3 w-3" aria-hidden />
                </button>
              </span>
            ))}
            <ExtensionInput filter={filter} commit={commit} />
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * 경로 막대의 파일 종류 필터(E23): 트리거 버튼 + 팝오버. 카테고리를 여러 개 체크하고(현재 폴더 기준 개수),
 * "고급…"에서 이 폴더의 확장자와 직접 입력한 확장자로 거른다. 카테고리와 확장자는 OR이다.
 * `ItemMenu`는 버튼 행만 표현하므로 쓰지 않는다. `entries`는 숨김 파일 설정을 반영한 현재 폴더 목록이다.
 */
export function FileFilterMenu({
  tab,
  entries,
  hiddenCount,
  compact
}: {
  tab: Tab
  entries: readonly ExplorerEntry[]
  /** 찾기를 통과했지만 이 필터로 빠진 수 */
  hiddenCount: number
  compact: boolean
}): React.JSX.Element {
  const t = useT()
  const all = useAllCategories()
  const nameOf = useCategoryName()
  const [open, setOpen] = useState(false)
  const [placement, setPlacement] = useState<MenuPlacement | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const id = `filter-menu-${tab.id}`
  const count = activeCount(tab.filter, all)

  const measure = useMemo(
    () => (): void => {
      const trigger = triggerRef.current
      const root = rootRef.current
      if (!trigger || !root) return
      const anchor = trigger.getBoundingClientRect()
      const size = root.getBoundingClientRect()
      setPlacement(
        clampMenuPosition(
          { x: anchor.right - POPOVER_WIDTH, y: anchor.bottom + 4 },
          { width: size.width, height: size.height },
          { width: window.innerWidth, height: window.innerHeight }
        )
      )
    },
    []
  )

  useEffect(() => {
    if (!open) return
    const close = (): void => setOpen(false)
    // click이 아니라 pointerdown으로 바깥을 판정한다. 열려는 클릭이 자신을 닫지 않게 트리거는 안쪽으로 친다.
    const onPointerDown = (e: Event): void => {
      const target = e.target
      if (
        target instanceof Node &&
        (rootRef.current?.contains(target) || triggerRef.current?.contains(target))
      )
        return
      close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      close()
      triggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKey)
    window.addEventListener('blur', close)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', close)
    }
  }, [open])

  const title =
    count > 0
      ? t('filter.activeTooltip', {
          what: filterLabel(tab.filter, all, nameOf, t('filter.noExtension')),
          n: hiddenCount
        })
      : t('filter.buttonTooltip')

  return (
    <>
      <button
        ref={triggerRef}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={id}
        aria-label={t('filter.button')}
        title={title}
        data-active={count > 0 ? 'true' : undefined}
        onClick={() => {
          setPlacement(null)
          setOpen(!open)
        }}
        className={cn(
          'flex h-9 shrink-0 items-center gap-1.5 rounded-full border text-[12.5px] font-semibold',
          compact ? 'px-2.5' : 'px-3',
          count > 0
            ? 'border-transparent bg-[var(--acw)] text-[var(--ac)]'
            : 'border-[var(--bd)] text-[var(--mu)] hover:bg-[var(--hv)]'
        )}
      >
        <ListFilter className="h-4 w-4" aria-hidden />
        {!compact && <span aria-hidden>{t('filter.button')}</span>}
        {count > 0 && (
          <span aria-hidden className="mono rounded-full bg-[var(--sf)] px-1.5 text-[10.5px]">
            {count}
          </span>
        )}
      </button>
      {open && (
        <Popover
          id={id}
          tab={tab}
          entries={entries}
          placement={placement}
          rootRef={rootRef}
          onMeasure={measure}
        />
      )}
    </>
  )
}
