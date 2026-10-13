import { useEffect, useState } from 'react'
import { useT } from '@renderer/i18n'
import { clampRatio } from '@renderer/lib/splitLayout'
import { useTabsStore } from '@renderer/stores/useTabsStore'

/**
 * 분할 구분선(split-view P8·F12): 끌면 왼쪽 패널 비율, 더블클릭 50:50. 겉모습은 사이드 패널 핸들의
 * 토큰(`.pane-handle`)을 쓰고 동작은 비율 하나라 그 훅을 쓰지 않는다. 기준 폭은 분할 루트의 rect다.
 */
export function SplitDivider({
  ratio,
  rootRef,
  order
}: {
  /** 그려지는(자른) 왼쪽 비율 */
  ratio: number
  rootRef: React.RefObject<HTMLElement | null>
  order: number
}): React.JSX.Element {
  const t = useT()
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    if (!dragging) return
    const onMove = (e: PointerEvent): void => {
      const rect = rootRef.current?.getBoundingClientRect()
      if (!rect || rect.width <= 0) return
      const { setSplitRatio } = useTabsStore.getState()
      setSplitRatio(clampRatio((e.clientX - rect.left) / rect.width, rect.width))
    }
    const onUp = (): void => setDragging(false)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [dragging, rootRef])

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t('split.divider')}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(ratio * 100)}
      className="split-divider"
      data-dragging={dragging ? 'true' : undefined}
      style={{ order }}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.currentTarget.setPointerCapture?.(e.pointerId)
        setDragging(true)
      }}
      onDoubleClick={() => useTabsStore.getState().setSplitRatio(0.5)}
    />
  )
}
