import { useEffect, useRef, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { useT, type MessageKey } from '@renderer/i18n'
import type { IpcResult } from '@shared/types/ipc'
import type { AgentActivityEvent } from '@shared/types/mcp'

/** 호출이 끝난 뒤에도 표시가 남는 시간. 에이전트는 다음 호출을 생각하는 중일 수 있다(agent-activity A4). */
export const AGENT_ACTIVITY_LINGER_MS = 30_000

/**
 * 에이전트가 MCP로 앱을 쓰는 동안 창 가장자리 글로우와 툴바 아래 pill을 띄운다. 활성 중에는 [중지]가 늘 닿도록
 * 대화상자 위에 두고, 남아 있는 30초 동안과 중지 뒤 기다리는 동안은 [중지]를 끈 채 그 아래에 둔다(A11·A13). pill의
 * [중지]는 에이전트의 호출과 남은 작업만 멈추고 MCP는 그대로 둔다(A5). 대상은 원격 이름일 수 있어 텍스트로만 그린다.
 */
export function AgentActivityIndicator(): React.JSX.Element | null {
  const t = useT()
  const [event, setEvent] = useState<AgentActivityEvent | null>(null)
  /** [중지]에 오기 전에 포커스가 있던 곳. pill이 사라지며 포커스를 잃으면 그리로 돌려준다(A13). */
  const returnTo = useRef<HTMLElement | null>(null)

  useEffect(() => {
    let heard = false
    const off = window.api.on('agent:activity', (...args) => {
      const next = args[0] as AgentActivityEvent
      heard = true
      setEvent(next.stopped ? null : next)
    })
    // 새로 고친 창은 지금 진행 중인 활동부터 그린다(A10). 그사이 온 이벤트가 더 새롭다.
    void window.api
      .invoke<IpcResult<AgentActivityEvent>>('agent:getActivity')
      .then((result) => {
        if (!heard && result?.success && result.data?.active) setEvent(result.data)
      })
      .catch(() => undefined)
    return off
  }, [])

  useEffect(() => {
    if (!event || event.active) return
    const timer = setTimeout(() => setEvent(null), AGENT_ACTIVITY_LINGER_MS)
    return () => clearTimeout(timer)
  }, [event])

  useEffect(() => {
    if (event) return
    const el = returnTo.current
    returnTo.current = null
    if (el?.isConnected && document.activeElement === document.body) el.focus()
  }, [event])

  if (!event) return null

  const stop = async (): Promise<void> => {
    try {
      const result = await window.api.invoke<IpcResult<void>>('agent:stop')
      if (!result.success) toast.error(t('agent.stopFailed'), { description: result.error })
    } catch (err) {
      toast.error(t('agent.stopFailed'), {
        description: err instanceof Error ? err.message : String(err)
      })
    }
  }

  const client = event.client ?? t('agent.unknownClient')
  const action = event.tool && t(`agent.action.${event.tool}` as MessageKey)
  const detail = [action, event.target].filter(Boolean).join(' · ')

  // 남아 있는 동안과 중지 뒤 취소할 수 없는 전송을 기다리는 동안은 멈출 것이 없다: [중지]를 끄고(포커스는 남긴다)
  // 대화상자·팝오버 아래에 두며 클릭을 통과시킨다(A11·A13)
  const passive = !event.active || !!event.stopping

  return (
    <>
      <div
        data-agent-glow
        data-active={event.active && !event.stopping}
        aria-hidden
        className="agent-glow pointer-events-none absolute inset-0 z-[70]"
      />
      <div
        data-agent-pill
        className={`pop absolute left-1/2 top-[60px] flex ${passive ? 'pointer-events-none z-40' : 'z-[71]'} max-w-[min(560px,calc(100%-32px))] -translate-x-1/2 items-center gap-2 rounded-full border border-[color-mix(in_srgb,var(--agent)_45%,var(--bd))] bg-[var(--sf)] py-1 pl-3 pr-1 text-sm text-[var(--tx)] shadow-[var(--shadow)]`}
      >
        <Sparkles aria-hidden className="h-4 w-4 shrink-0 text-[var(--agent)]" />
        {/* 호출마다 바뀌는 동작·대상은 읽지 않고, 일하는 중·중지됨만 알린다 */}
        <span role="status" className="min-w-0 max-w-[14rem] truncate font-medium">
          {t(event.stopping ? 'agent.stopped' : 'agent.working', { client })}
        </span>
        {event.stopping ? (
          <span className="min-w-0 truncate text-[var(--mu)]">{t('agent.stoppingDetail')}</span>
        ) : (
          detail && <span className="min-w-0 truncate text-[var(--mu)]">{detail}</span>
        )}
        <button
          onClick={() => !passive && void stop()}
          onFocus={(e) => {
            if (e.relatedTarget instanceof HTMLElement) returnTo.current = e.relatedTarget
          }}
          aria-label={t('agent.stopLabel')}
          aria-disabled={passive}
          className={`shrink-0 rounded-full border border-[var(--bd2)] px-2.5 py-0.5 text-xs ${passive ? 'opacity-50' : 'hover:bg-[var(--hv)]'}`}
        >
          {t('agent.stop')}
        </button>
      </div>
    </>
  )
}
