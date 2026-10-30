import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { useT } from '@renderer/i18n'
import { cn } from '@renderer/lib/utils'

/**
 * 타일·행 안의 이름 입력(D21). 확장자 앞까지 골라 둔다. Enter·바깥 클릭은 제출, Esc는 취소(null).
 * 키·마우스 이벤트는 목록까지 올라가지 않는다(입력해서 고르기·마퀴·끌기와 겹치지 않게).
 * `taken`이 참인 이름은 입력하는 즉시 경고하고, Enter는 제출하지 않으며 바깥 클릭은 취소다(rename-name-taken N1·N3·N4).
 * 창 전환으로 생긴 blur는 무시한다: 창으로 돌아오면 입력에 포커스가 돌아와 이어 쓴다(N9).
 */
export function InlineRename({
  initial,
  taken,
  onDone
}: {
  initial: string
  taken: (name: string) => boolean
  onDone: (name: string | null) => void
}): React.JSX.Element {
  const t = useT()
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  // 편집 중에 목록이 바뀌어도 경고와 Enter·blur 판정이 같은 값을 보도록 렌더마다 다시 잰다
  const [value, setValue] = useState(initial)
  const dup = taken(value)
  const warnId = useId()
  const warnRef = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    const dot = initial.lastIndexOf('.')
    el.setSelectionRange(0, dot > 0 ? dot : initial.length)
  }, [initial])
  // 맨 아래 항목에서도 경고 문구가 스크롤 영역 밖에 숨지 않게 한다. 나타날 때 한 번, 그리기 전에.
  useLayoutEffect(() => {
    if (dup) warnRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [dup])
  const finish = (name: string | null): void => {
    if (done.current) return
    done.current = true
    onDone(name)
  }
  const stop = (e: React.SyntheticEvent): void => e.stopPropagation()
  return (
    <span className="relative block w-full min-w-0">
      <input
        ref={ref}
        defaultValue={initial}
        aria-label={t('menu.newName')}
        aria-invalid={dup}
        aria-describedby={dup ? warnId : undefined}
        spellCheck={false}
        onChange={(e) => setValue(e.currentTarget.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter' && !dup) finish(e.currentTarget.value)
          if (e.key === 'Escape') finish(null)
        }}
        onBlur={(e) => {
          if (!document.hasFocus()) return
          finish(dup ? null : e.currentTarget.value)
        }}
        onClick={stop}
        onDoubleClick={stop}
        onMouseDown={stop}
        onPointerDown={stop}
        onContextMenu={stop}
        className={cn(
          'h-6 w-full min-w-0 rounded-md border border-[var(--ac)] bg-[var(--sf)] px-1.5 text-[13px] text-[var(--tx)] shadow-[0_0_0_3px_var(--acw)] outline-none',
          dup && 'border-[var(--dg)] shadow-[0_0_0_3px_var(--dgw)]'
        )}
      />
      {dup && (
        <span
          ref={warnRef}
          id={warnId}
          role="alert"
          className="pointer-events-none absolute inset-x-0 top-full z-20 mt-1 min-w-[5rem] break-keep rounded-md [overflow-wrap:anywhere] bg-[var(--dg)] px-2 py-1 text-[11px] font-semibold leading-4 text-white shadow-md"
        >
          {t('name.taken')}
        </span>
      )}
    </span>
  )
}
