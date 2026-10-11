import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronRight, type LucideIcon } from 'lucide-react'
import { clampMenuPosition, type MenuPlacement } from '@renderer/lib/menuPosition'
import { cn } from '@renderer/lib/utils'

export type MenuItem =
  | 'sep'
  | {
      label: string
      icon?: LucideIcon
      /** 오른쪽에 보이는 단축키 문구(이름에는 들어가지 않는다) */
      shortcut?: string
      danger?: boolean
      disabled?: boolean
      onSelect?: () => void
      submenu?: MenuItem[]
      /** 보조 문구(막힌 사유 등). 툴팁과 둘째 줄로 보인다 */
      hint?: string
    }

type Entry = Exclude<MenuItem, 'sep'>

const enabled = (items: readonly MenuItem[]): number[] =>
  items.flatMap((it, i) => (it !== 'sep' && !it.disabled ? [i] : []))

function MenuList({
  items,
  label,
  placement,
  active,
  setActive,
  openSub,
  rootRef,
  onKeyDown,
  onRun
}: {
  items: readonly MenuItem[]
  label: string
  placement: MenuPlacement | null
  active: number
  setActive: (i: number) => void
  openSub: number | null
  rootRef: React.RefObject<HTMLDivElement | null>
  onKeyDown: (e: React.KeyboardEvent) => void
  onRun: (it: Entry, i: number) => void
}): React.JSX.Element {
  return (
    <div
      ref={rootRef}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      data-nomarquee
      className="pop fixed z-[60] min-w-[232px] max-w-[360px] rounded-xl border border-[var(--bd)] bg-[var(--sf)] p-1.5 text-[13px] text-[var(--tx)] shadow-[var(--shadow)] outline-none"
      style={{
        left: placement?.left ?? 0,
        top: placement?.top ?? 0,
        visibility: placement ? 'visible' : 'hidden'
      }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={onKeyDown}
    >
      {items.map((it, i) =>
        it === 'sep' ? (
          <div key={i} role="separator" className="mx-2 my-1 h-px bg-[var(--bd)]" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            data-index={i}
            aria-haspopup={it.submenu ? 'menu' : undefined}
            aria-expanded={it.submenu ? openSub === i : undefined}
            aria-keyshortcuts={it.shortcut}
            aria-description={it.hint}
            disabled={it.disabled}
            tabIndex={-1}
            title={it.hint}
            onMouseEnter={() => setActive(i)}
            onClick={() => onRun(it, i)}
            className={cn(
              'flex min-h-8 w-full items-center gap-2.5 rounded-lg px-2.5 py-1 text-left outline-none disabled:opacity-40',
              active === i && (it.danger ? 'bg-[var(--dgw)]' : 'bg-[var(--acw)]'),
              it.danger && 'text-[var(--dg)]'
            )}
          >
            {it.icon ? (
              <it.icon className="h-4 w-4 shrink-0 opacity-80" strokeWidth={1.75} aria-hidden />
            ) : (
              <span className="w-4 shrink-0" />
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate">{it.label}</span>
              {it.hint && (
                <span aria-hidden className="block truncate text-[11px] text-[var(--mu)]">
                  {it.hint}
                </span>
              )}
            </span>
            {it.shortcut && (
              <span aria-hidden className="mono shrink-0 pl-3 text-[11px] text-[var(--mu)]">
                {it.shortcut}
              </span>
            )}
            {it.submenu && (
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--mu)]" aria-hidden />
            )}
          </button>
        )
      )}
    </div>
  )
}

/** 화살표·Home/End로 고르고 Enter·Space로 실행. `onBack`(←)이 있으면 하위 메뉴다. */
function menuKeys(
  items: readonly MenuItem[],
  active: number,
  setActive: (i: number) => void,
  run: (it: Entry, i: number) => void,
  close: () => void,
  onBack?: () => void
): (e: React.KeyboardEvent) => void {
  return (e) => {
    e.stopPropagation()
    const order = enabled(items)
    const at = order.indexOf(active)
    const move = (i: number | undefined): void => {
      e.preventDefault()
      if (i !== undefined) setActive(i)
    }
    if (e.key === 'ArrowDown') move(order[(at + 1) % order.length])
    else if (e.key === 'ArrowUp') move(order[(at - 1 + order.length) % order.length])
    else if (e.key === 'Home') move(order[0])
    else if (e.key === 'End') move(order[order.length - 1])
    else if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight') {
      e.preventDefault()
      const it = items[active]
      if (it && it !== 'sep' && !it.disabled && (e.key !== 'ArrowRight' || it.submenu))
        run(it, active)
    } else if (e.key === 'ArrowLeft' && onBack) {
      e.preventDefault()
      onBack()
    } else if (e.key === 'Escape' || e.key === 'ArrowLeft' || e.key === 'Tab') {
      e.preventDefault()
      close()
    }
  }
}

/**
 * 탐색기의 메뉴(항목·빈 곳·정렬·숨은 경로). 열린 자리를 화면 안으로 보정하고(menuPosition),
 * 바깥 좌·우클릭, Esc, 창 포커스 잃음, 바깥 스크롤에 닫힌다(D20). "보내기 ▸" 같은 하위 메뉴는
 * 항목 옆에 따로 뜬다(메뉴 안에는 menuitem과 separator만 있다).
 */
export function ItemMenu({
  x,
  y,
  label,
  items,
  onClose
}: {
  x: number
  y: number
  label: string
  items: MenuItem[]
  onClose: () => void
}): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const subRef = useRef<HTMLDivElement>(null)
  const [placement, setPlacement] = useState<MenuPlacement | null>(null)
  const [subPlacement, setSubPlacement] = useState<MenuPlacement | null>(null)
  const [active, setActive] = useState(-1)
  const [sub, setSub] = useState<number | null>(null)
  const [subActive, setSubActive] = useState(-1)
  const closeRef = useRef(onClose)
  useEffect(() => {
    closeRef.current = onClose
  })

  // 열릴 때(앵커가 바뀔 때만) 실제 크기를 재서 보정한다. 내용만 바뀌는 재렌더에서는 다시 재지 않는다.
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const rect = root.getBoundingClientRect()
    setPlacement(
      clampMenuPosition(
        { x, y },
        { width: rect.width, height: rect.height },
        { width: window.innerWidth, height: window.innerHeight }
      )
    )
  }, [x, y])

  useLayoutEffect(() => {
    const parent = sub === null ? null : rootRef.current?.querySelector(`[data-index="${sub}"]`)
    const menu = subRef.current
    if (!parent || !menu) return
    const p = parent.getBoundingClientRect()
    const m = menu.getBoundingClientRect()
    setSubPlacement(
      clampMenuPosition(
        { x: p.right + 4, y: p.top - 6 },
        { width: m.width, height: m.height },
        { width: window.innerWidth, height: window.innerHeight }
      )
    )
  }, [sub])

  // 자리를 잡아 보이게 된 뒤에 포커스를 준다. visibility:hidden인 동안의 focus()는 브라우저가 무시한다.
  useLayoutEffect(() => {
    if (placement) rootRef.current?.focus()
  }, [placement])
  useLayoutEffect(() => {
    if (subPlacement) subRef.current?.focus()
  }, [subPlacement])

  // 고른 항목에 실제 포커스를 준다(화면 낭독기가 따라 읽는다).
  useEffect(() => {
    if (active >= 0)
      rootRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.focus()
  }, [active])
  useEffect(() => {
    if (subActive >= 0)
      subRef.current?.querySelector<HTMLElement>(`[data-index="${subActive}"]`)?.focus()
  }, [subActive])

  useEffect(() => {
    const inside = (target: EventTarget | null): boolean =>
      target instanceof Node &&
      (!!rootRef.current?.contains(target) || !!subRef.current?.contains(target))
    const close = (): void => closeRef.current()
    const onClick = (e: Event): void => {
      if (!inside(e.target)) close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    // 메뉴를 연 우클릭의 네이티브 이벤트는 이 리스너가 붙을 때도 아직 전파 중이다. 그 이벤트는
    // window의 capture 단계를 이미 지났으므로, capture에서 본 이벤트만 닫기로 친다(자기 충돌 방지).
    let captured: Event | null = null
    const mark = (e: Event): void => {
      captured = e
    }
    const onContext = (e: Event): void => {
      if (captured === e && !inside(e.target)) close()
    }
    const onScroll = (e: Event): void => {
      if (!inside(e.target)) close()
    }
    document.addEventListener('click', onClick)
    document.addEventListener('keydown', onKey)
    window.addEventListener('contextmenu', mark, true)
    document.addEventListener('contextmenu', onContext)
    window.addEventListener('blur', close)
    // 안쪽 스크롤 컨테이너의 scroll은 버블링되지 않으므로 capture로 듣는다.
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('click', onClick)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('contextmenu', mark, true)
      document.removeEventListener('contextmenu', onContext)
      window.removeEventListener('blur', close)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [])

  const run = (it: Entry, i: number): void => {
    if (it.submenu) {
      setSub(i)
      setSubActive(enabled(it.submenu)[0] ?? -1)
      return
    }
    onClose()
    it.onSelect?.()
  }
  const subItems = sub === null ? null : (items[sub] as Entry).submenu
  const backFromSub = (): void => {
    setSub(null)
    setSubActive(-1)
    rootRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.focus()
  }

  return (
    <>
      <MenuList
        items={items}
        label={label}
        placement={placement}
        active={active}
        setActive={(i) => {
          setActive(i)
          const it = items[i]
          if (it !== 'sep' && it?.submenu && sub !== i) run(it, i)
          else if (sub !== i) setSub(null)
        }}
        openSub={sub}
        rootRef={rootRef}
        onKeyDown={(e) => menuKeys(items, active, setActive, run, onClose)(e)}
        onRun={run}
      />
      {subItems && sub !== null && (
        <MenuList
          items={subItems}
          label={(items[sub] as Entry).label}
          placement={subPlacement}
          active={subActive}
          setActive={setSubActive}
          openSub={null}
          rootRef={subRef}
          onKeyDown={(e) =>
            menuKeys(
              subItems,
              subActive,
              setSubActive,
              (it) => {
                onClose()
                it.onSelect?.()
              },
              onClose,
              backFromSub
            )(e)
          }
          onRun={(it) => {
            onClose()
            it.onSelect?.()
          }}
        />
      )}
    </>
  )
}
