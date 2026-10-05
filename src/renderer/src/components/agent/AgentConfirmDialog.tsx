import { useEffect, useRef } from 'react'
import { File, Folder } from 'lucide-react'
import {
  answerAgentConfirm,
  dropAgentConfirm,
  enqueueAgentConfirm,
  useAgentConfirmStore
} from '@renderer/stores/useAgentConfirmStore'
import { useT } from '@renderer/i18n'
import { useEscapeKey } from '@renderer/hooks/useEscapeKey'
import { formatBytes } from '@renderer/lib/utils'
import { plainText, toolTitle } from '@renderer/lib/agentText'
import type { AgentConfirmRequest } from '@shared/types/agent'
import { TierBadge } from './TierBadge'

/**
 * main이 20개까지 보내지만, 더 와도 대화상자가 화면을 넘지 않게 여기서도 자른다. 나머지 개수는 따로
 * 보이지 않는다: 삭제의 items는 최상위 대상이고 totalItems는 폴더 안까지 센 수라, 둘의 차가 "N개 더"가
 * 아니다. 대신 전체 개수(합계 줄)를 보인다.
 */
const MAX_ITEMS = 20

/**
 * 에이전트 도구 호출의 확인 대화상자(handoff agent-operations P3–P6). 사용자의 ConfirmDialog와
 * 슬롯이 따로라 서로 취소하지 않는다. 기본 포커스와 Esc·바깥 클릭은 모두 거부다.
 * 원격 이름과 클라이언트 이름은 믿을 수 없는 문자열이므로 텍스트로만, 제어 문자는 보이게 그린다.
 */
export function AgentConfirmDialog(): React.JSX.Element | null {
  const request = useAgentConfirmStore((s) => s.queue[0] ?? null)
  const denyRef = useRef<HTMLButtonElement>(null)
  const allowRef = useRef<HTMLButtonElement>(null)
  const t = useT()

  useEffect(() => {
    const unsubscribers = [
      window.api.on('agent:confirmRequest', (...args: unknown[]) => {
        enqueueAgentConfirm(args[0] as AgentConfirmRequest)
      }),
      window.api.on('agent:confirmCancelled', (...args: unknown[]) => {
        dropAgentConfirm(args[0] as string)
      })
    ]
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe()
    }
  }, [])

  // 요청이 바뀔 때마다 거부에 포커스를 두고, 닫히면 원래 자리로 돌려준다.
  const requestId = request?.id
  useEffect(() => {
    if (!requestId) return
    const previous = document.activeElement as HTMLElement | null
    denyRef.current?.focus()
    return () => previous?.focus()
  }, [requestId])

  useEscapeKey(() => {
    const current = useAgentConfirmStore.getState().queue[0]
    if (current) void answerAgentConfirm(current.id, false)
  }, request !== null)

  if (!request) return null

  const answer = (approved: boolean): void => void answerAgentConfirm(request.id, approved)
  const items = request.items.slice(0, MAX_ITEMS)
  const itemCount = t('common.itemCount', { count: request.totalItems })

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40"
      onClick={() => answer(false)}
      // 오버레이가 그리드 위에 뜨므로, 막지 않으면 마퀴 선택 핸들러가 함께 돈다.
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div
        role="alertdialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby="agent-confirm-heading agent-confirm-title"
        className="flex max-h-[calc(100vh_-_4rem)] w-[460px] max-w-[calc(100vw_-_2rem)] flex-col rounded-lg bg-white p-5 shadow-xl outline-none"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation()
          // 포커스가 뒤의 패널로 빠져나가지 않게 두 버튼 사이에 가둔다.
          if (e.key === 'Tab') {
            e.preventDefault()
            const next =
              document.activeElement === denyRef.current ? allowRef.current : denyRef.current
            next?.focus()
          }
        }}
      >
        <p id="agent-confirm-heading" className="text-xs font-medium text-gray-500">
          {t('agent.confirm.heading')}
        </p>
        <div className="mt-1 flex items-start gap-2">
          <h2
            id="agent-confirm-title"
            className="min-w-0 flex-1 break-words text-sm font-semibold text-gray-900"
          >
            {toolTitle(t, request.tool)}
          </h2>
          <TierBadge tier={request.tier} />
        </div>

        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-gray-500">{t('agent.confirm.client')}</dt>
          <dd className="min-w-0 truncate text-gray-800">
            {request.client ? plainText(request.client) : t('agent.confirm.unknownClient')}
          </dd>
          {request.host && (
            <>
              <dt className="text-gray-500">{t('agent.confirm.server')}</dt>
              <dd className="min-w-0 truncate text-gray-800">{plainText(request.host)}</dd>
            </>
          )}
        </dl>

        <ul
          aria-label={t('agent.confirm.items')}
          className="mt-3 min-h-0 flex-1 divide-y divide-gray-100 overflow-y-auto rounded-md border border-gray-200"
        >
          {items.map((item, i) => (
            <li key={i} className="flex items-center gap-2 px-2 py-1.5 text-xs">
              {item.kind === 'directory' ? (
                <Folder
                  size={14}
                  role="img"
                  aria-label={t('fileType.folder')}
                  className="shrink-0 text-amber-500"
                />
              ) : (
                <File
                  size={14}
                  role="img"
                  aria-label={t('fileType.file')}
                  className="shrink-0 text-gray-400"
                />
              )}
              <span className="min-w-0 flex-1 break-all font-mono text-gray-800">
                {plainText(item.path)}
              </span>
              {item.overwrites && (
                <span className="shrink-0 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10.5px] font-medium text-amber-800 ring-1 ring-inset ring-amber-200">
                  {t('agent.confirm.overwrites')}
                </span>
              )}
              {item.size !== undefined && (
                <span className="shrink-0 tabular-nums text-gray-500">
                  {formatBytes(item.size)}
                </span>
              )}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs font-medium text-gray-700">
          {request.totalBytes !== undefined
            ? t('agent.confirm.totalWithSize', {
                items: itemCount,
                size: formatBytes(request.totalBytes)
              })
            : t('agent.confirm.total', { items: itemCount })}
        </p>
        <p className="mt-2 text-xs text-gray-500">{t('agent.confirm.hint')}</p>

        <div className="mt-4 flex justify-end gap-2">
          <button
            ref={denyRef}
            onClick={() => answer(false)}
            className="rounded-md border border-gray-300 px-4 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-offset-1"
          >
            {t('agent.confirm.deny')}
          </button>
          <button
            ref={allowRef}
            onClick={() => answer(true)}
            className={`rounded-md px-4 py-1.5 text-sm font-medium text-white focus:outline-none focus:ring-2 focus:ring-offset-1 ${
              request.tier === 'D'
                ? 'bg-red-600 hover:bg-red-700 focus:ring-red-400'
                : 'bg-blue-600 hover:bg-blue-700 focus:ring-blue-400'
            }`}
          >
            {t('agent.confirm.allow')}
          </button>
        </div>
      </div>
    </div>
  )
}
