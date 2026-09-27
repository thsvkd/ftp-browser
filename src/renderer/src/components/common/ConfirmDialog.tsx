import { useEffect, useRef } from 'react'
import { useConfirmStore } from '@renderer/stores/useConfirmStore'
import { useT } from '@renderer/i18n'

export function ConfirmDialog(): React.JSX.Element | null {
  const request = useConfirmStore((s) => s.request)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const t = useT()

  // 닫히면 연 쪽(탐색기 패널 등)으로 포커스를 돌려줘야 Delete·Enter 흐름이 이어진다.
  useEffect(() => {
    if (!request) return
    const previous = document.activeElement as HTMLElement | null
    confirmRef.current?.focus()
    return () => previous?.focus()
  }, [request])

  if (!request) return null

  const settle = (confirmed: boolean): void => {
    useConfirmStore.setState({ request: null })
    request.resolve(confirmed)
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40"
      onClick={() => settle(false)}
      // 오버레이도 그리드 컨테이너 위에 뜨므로, 막지 않으면 마퀴 선택 핸들러가 함께 돈다.
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div
        role="alertdialog"
        // 글자 부분을 눌러도 포커스가 패널 안에 남아야 Tab 가두기와 Escape가 동작한다.
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        className="w-[380px] rounded-lg bg-white p-5 shadow-xl outline-none"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape') settle(false)
          // 포커스가 뒤의 패널로 빠져나가 확인 대기 중에 다른 작업을 하지 않도록 두 버튼 사이에 가둔다.
          if (e.key === 'Tab') {
            e.preventDefault()
            const next =
              document.activeElement === confirmRef.current ? cancelRef.current : confirmRef.current
            next?.focus()
          }
        }}
      >
        <h2 id="confirm-dialog-title" className="break-words text-sm font-semibold text-gray-900">
          {request.title}
        </h2>
        {request.message && <p className="mt-2 text-sm text-gray-600">{request.message}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelRef}
            onClick={() => settle(false)}
            className="rounded-md border border-gray-300 px-4 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            {t('common.cancel')}
          </button>
          <button
            ref={confirmRef}
            onClick={() => settle(true)}
            className={`rounded-md px-4 py-1.5 text-sm font-medium text-white focus:outline-none focus:ring-2 focus:ring-offset-1 ${
              request.destructive
                ? 'bg-red-600 hover:bg-red-700 focus:ring-red-400'
                : 'bg-blue-600 hover:bg-blue-700 focus:ring-blue-400'
            }`}
          >
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
