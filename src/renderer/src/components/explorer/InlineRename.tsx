import { useEffect, useRef } from 'react'
import { useT } from '@renderer/i18n'

/**
 * 타일·행 안의 이름 입력(D21). 확장자 앞까지 골라 둔다. Enter·바깥 클릭은 제출, Esc는 취소(null).
 * 키·마우스 이벤트는 목록까지 올라가지 않는다(입력해서 고르기·마퀴·끌기와 겹치지 않게).
 */
export function InlineRename({
  initial,
  onDone
}: {
  initial: string
  onDone: (name: string | null) => void
}): React.JSX.Element {
  const t = useT()
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    const dot = initial.lastIndexOf('.')
    el.setSelectionRange(0, dot > 0 ? dot : initial.length)
  }, [initial])
  const finish = (value: string | null): void => {
    if (done.current) return
    done.current = true
    onDone(value)
  }
  const stop = (e: React.SyntheticEvent): void => e.stopPropagation()
  return (
    <input
      ref={ref}
      defaultValue={initial}
      aria-label={t('menu.newName')}
      spellCheck={false}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') finish(e.currentTarget.value)
        if (e.key === 'Escape') finish(null)
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
      onClick={stop}
      onDoubleClick={stop}
      onMouseDown={stop}
      onPointerDown={stop}
      onContextMenu={stop}
      className="h-6 w-full min-w-0 rounded-md border border-[var(--ac)] bg-[var(--sf)] px-1.5 text-[13px] text-[var(--tx)] shadow-[0_0_0_3px_var(--acw)] outline-none"
    />
  )
}
