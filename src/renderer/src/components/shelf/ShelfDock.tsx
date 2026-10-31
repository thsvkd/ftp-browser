import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { ChevronUp, Package, PackageOpen } from 'lucide-react'
import { useT } from '@renderer/i18n'
import { locKey, type ExplorerEntry } from '@renderer/lib/explorerEntry'
import { reducedMotion } from '@renderer/lib/flyTo'
import { cn, formatBytes } from '@renderer/lib/utils'
import { useShelfStore } from '@renderer/stores/useShelfStore'
import { useDnd, useDropTarget } from '@renderer/components/explorer/dnd'
import { EntryThumb } from '@renderer/components/thumbnail/EntryThumb'
import { Shelf, ShelfSendButton } from './Shelf'

const fileBytes = (sum: number, e: ExplorerEntry): number => sum + (e.type === 'file' ? e.size : 0)

/** 섬의 모양: 빈 선반에 끄는 중 안내 · 접힌 캡슐 · 펼친 패널 */
type Mode = 'guide' | 'row' | 'open'

const MORPH: KeyframeAnimationOptions = {
  duration: 360,
  easing: 'cubic-bezier(0.2, 0.85, 0.25, 1)'
}

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
    const leave = (e: DragEvent): void => {
      depth = Math.max(0, depth - 1)
      // 진입했던 요소가 끄는 도중 사라지면 짝이 되는 dragleave가 오지 않아 깊이가 걸린다.
      // relatedTarget이 없고 포인터가 창 밖이면 나간 것이니 세지 않고 끝낸다. 창 안에서도
      // relatedTarget이 비어 올 수 있어 좌표로 가린다(F20).
      const outside =
        e.clientX <= 0 ||
        e.clientY <= 0 ||
        e.clientX >= window.innerWidth ||
        e.clientY >= window.innerHeight
      if (!depth || (!e.relatedTarget && outside)) {
        depth = 0
        setOsDrag(false)
      }
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

/**
 * 크기 전환(I3, FLIP). 렌더 직후 새 크기를 재고, 직전 크기(또는 돌던 전환의 지금 크기)에서 새 크기로
 * width·height를 잇는다 — `auto ↔ px`은 CSS로 보간되지 않는다. 같은 모양 안의 크기 변화(담겨서
 * 캡슐이 넓어짐)는 짧게 잇고 내용은 다시 페이드하지 않는다. jsdom에는 Web Animations가 없다(함정 B).
 */
function useMorph(ref: RefObject<HTMLDivElement | null>, mode: Mode | null): void {
  const last = useRef<{ mode: Mode; w: number; h: number } | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !mode) {
      last.current = null
      return
    }
    const prev = last.current
    // 전환 도중 다시 바뀌면 돌던 애니메이션이 아직 걸려 있는 지금 크기에서 이어 간다
    const running =
      typeof el.getAnimations === 'function'
        ? el.getAnimations().find((a) => a.id === 'shelf-morph')
        : undefined
    const from = running ? { w: el.offsetWidth, h: el.offsetHeight } : prev
    running?.cancel()
    const to = { mode, w: el.offsetWidth, h: el.offsetHeight }
    last.current = to
    if (!from || reducedMotion() || typeof el.animate !== 'function') return
    if (from.w === to.w && from.h === to.h) return
    const same = prev?.mode === mode
    const anim = el.animate(
      [
        { width: `${from.w}px`, height: `${from.h}px` },
        { width: `${to.w}px`, height: `${to.h}px` }
      ],
      same ? { ...MORPH, duration: 240 } : MORPH
    )
    anim.id = 'shelf-morph'
    // 내용은 아래 기준이라 상자가 자라는 동안 보내기 줄부터 드러난다. 늦게 켜면 빈 상자만 커져 보인다.
    const content = el.firstElementChild
    if (!same && content && typeof content.animate === 'function')
      content.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: 220,
        delay: 30,
        easing: 'ease-out',
        fill: 'backwards'
      })
  })
}

/** 빈 선반에 끄는 중: "여기로 끌어와 선반에 담기" 캡슐(I4) */
function Guide({ over }: { over: boolean }): React.JSX.Element {
  const t = useT()
  return (
    <div className="flex h-[52px] min-w-[272px] items-center gap-2.5 pl-2 pr-5 text-[13px] font-bold">
      <span
        className={cn(
          'flex h-[38px] w-[38px] items-center justify-center rounded-full',
          over ? 'bg-[var(--sh)] text-[var(--shink)]' : 'bg-[var(--shw)] text-[var(--shx)]'
        )}
      >
        {over ? (
          <PackageOpen className="h-5 w-5" aria-hidden />
        ) : (
          <Package className="h-5 w-5" aria-hidden />
        )}
      </span>
      {over ? t('shelf.dropHere') : t('shelf.dockHint')}
    </div>
  )
}

/**
 * 접힌 캡슐(I1): 겹친 썸네일(최대 3 + `+N`, 내려놓기 더미 — I9) · 개수 · 용량 → 펼침 · 활성 탭으로
 * 보내기 · 펼치기. 새로 담기면 썸네일이 튄다(I8).
 */
function Capsule(): React.JSX.Element {
  const t = useT()
  const items = useShelfStore((s) => s.items)
  const n = items.length
  const faces = items.slice(-3).reverse()
  const stack = useRef<HTMLSpanElement>(null)
  const seen = useRef(n)
  useLayoutEffect(() => {
    const el = stack.current
    const added = n > seen.current
    seen.current = n
    if (added && el && !reducedMotion() && typeof el.animate === 'function')
      el.animate(
        [
          { transform: 'scale(1)' },
          { transform: 'scale(1.14)', offset: 0.35 },
          { transform: 'scale(0.97)', offset: 0.7 },
          { transform: 'scale(1)' }
        ],
        { duration: 420, easing: 'cubic-bezier(0.3, 1.5, 0.5, 1)' }
      )
  }, [n])
  const expand = (): void => useShelfStore.getState().setDockOpen(true)
  return (
    <div className="flex h-[52px] min-w-0 max-w-[calc(100cqw-26px)] items-center gap-1 px-1.5">
      <button
        aria-expanded={false}
        title={t('shelf.expand')}
        onClick={expand}
        className="flex h-10 min-w-0 items-center gap-2.5 overflow-hidden rounded-full pl-1 pr-3 hover:bg-[var(--hv)]"
      >
        <span ref={stack} data-shelf-stack aria-hidden className="flex shrink-0">
          {faces.map((it) => (
            <span
              key={locKey(it.entry)}
              data-card
              className="relative -ml-[11px] h-8 w-8 overflow-hidden rounded-full border-2 border-[var(--sf)] bg-[var(--tile)] shadow-sm first:ml-0"
            >
              <EntryThumb entry={it.entry} glyph="h-4 w-4" request showSlow={false} ext={false} />
            </span>
          ))}
          {n > 3 && (
            <span className="mono -ml-[11px] flex h-8 min-w-8 items-center justify-center rounded-full border-2 border-[var(--sf)] bg-[var(--sh)] px-1 text-[11px] font-extrabold text-[var(--shink)]">
              +{n - 3}
            </span>
          )}
        </span>
        <span className="whitespace-nowrap text-[13px] font-bold leading-4">
          {t('common.itemCount', { count: n })}
        </span>
        <span className="shelf-narrow-hide mono whitespace-nowrap text-[11.5px] leading-4 text-[var(--mu)]">
          {formatBytes(items.reduce((sum, i) => fileBytes(sum, i.entry), 0))}
        </span>
      </button>
      <span aria-hidden className="mx-1 h-6 w-px shrink-0 bg-[var(--bd)]" />
      <ShelfSendButton compact />
      <button
        aria-label={t('shelf.expand')}
        aria-expanded={false}
        onClick={expand}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[var(--mu)] hover:bg-[var(--hv)] hover:text-[var(--tx)]"
      >
        <ChevronUp className="h-4 w-4" aria-hidden />
      </button>
    </div>
  )
}

/**
 * 탐색 영역(`main`) 하단 가운데의 "알약 섬"(shelf-island). 선반이 비어 있고 끄는 중이 아니면 그리지 않는다(F3).
 * 끄는 동안(앱 항목·OS 파일)에는 모양을 바꾸지 않고 섬 루트가 놓기 대상이 된다(I4). 대상 키는
 * 기존 `'shelf'`(F5)이고, 선반에서 끈 항목은 놓기는 받되 대상으로 보이지 않는다(I5).
 */
export function ShelfDock(): React.JSX.Element | null {
  const t = useT()
  const items = useShelfStore((s) => s.items)
  const open = useShelfStore((s) => s.dockOpen)
  const dragged = useDnd((s) => s.items)
  const fromShelf = useDnd((s) => s.fromShelf)
  const osDrag = useOsDrag()
  const drop = useDropTarget('shelf', 'shelf')
  const box = useRef<HTMLDivElement>(null)
  const refocus = useRef(false)
  const dragging = !!dragged || osDrag
  const mode: Mode | null = items.length ? (open ? 'open' : 'row') : dragging ? 'guide' : null
  useMorph(box, mode)
  // 펼치기·접기 버튼은 모양이 바뀌면 사라진다. 포커스가 body로 떨어지지 않게 새 모양의 토글로 옮긴다.
  useLayoutEffect(() => {
    if (!refocus.current) return
    refocus.current = false
    box.current?.querySelector<HTMLElement>('button[aria-expanded]')?.focus()
  }, [mode])
  if (!mode) return null
  const target = osDrag || (!!dragged && !fromShelf)
  return (
    <div className="shelf-dock-area pointer-events-none absolute inset-x-0 bottom-3 z-30 flex justify-center px-3">
      <div className="relative flex max-w-full justify-center">
        {target && mode !== 'guide' && (
          <div className="absolute inset-x-0 bottom-[calc(100%+12px)] flex justify-center">
            <span className="pop flex items-center gap-1.5 whitespace-nowrap rounded-full bg-[var(--sh)] px-3 py-1.5 text-[12px] font-bold text-[var(--shink)] shadow-lg">
              {drop.over ? (
                <PackageOpen className="h-3.5 w-3.5" aria-hidden />
              ) : (
                <Package className="h-3.5 w-3.5" aria-hidden />
              )}
              {drop.over ? t('shelf.dropHere') : t('shelf.dockHint')}
            </span>
          </div>
        )}
        <div
          ref={box}
          role="region"
          aria-label={t('shelf.title')}
          data-region="shelf-dock"
          data-shelf-island
          data-mode={mode}
          data-target={target}
          data-over={target && drop.over}
          {...(dragging ? { 'data-shelf-target': '', ...drop.handlers } : {})}
          onClickCapture={(e) => {
            if ((e.target as Element).closest('button[aria-expanded]')) refocus.current = true
          }}
          className="shelf-island pop pointer-events-auto"
        >
          {mode === 'guide' ? (
            <Guide over={drop.over} />
          ) : mode === 'open' ? (
            <div className="w-[min(700px,calc(100cqw-26px))]">
              <Shelf />
            </div>
          ) : (
            <Capsule />
          )}
        </div>
      </div>
    </div>
  )
}
