import { useEffect, useRef } from 'react'

// 열린 모달의 Esc 처리기. 겹쳐 열리면 나중에 열린(맨 위) 것만 반응한다.
// 캡처 단계에서 듣는다. 모달 안의 React 핸들러가 stopPropagation으로 키가 뒤의 패널에 닿지 않게
// 막아 두었기 때문에, 버블 단계의 window 리스너에는 Esc가 도달하지 않는다.
const stack: Array<{ current: () => void }> = []

function onKeyDown(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || e.isComposing || stack.length === 0) return
  e.preventDefault()
  e.stopPropagation()
  stack[stack.length - 1].current()
}

/**
 * Close a modal with Esc wherever focus is. Nested modals stack: only the top one handles Esc,
 * so Esc in a confirm dialog over Settings closes just the confirm dialog.
 */
export function useEscapeKey(onEscape: () => void, active = true): void {
  const handler = useRef(onEscape)
  useEffect(() => {
    handler.current = onEscape
  })

  useEffect(() => {
    if (!active) return
    const entry = { current: () => handler.current() }
    if (stack.length === 0) window.addEventListener('keydown', onKeyDown, true)
    stack.push(entry)
    return () => {
      stack.splice(stack.indexOf(entry), 1)
      if (stack.length === 0) window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [active])
}
