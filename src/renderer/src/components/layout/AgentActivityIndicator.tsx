import { useEffect, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { useT, type MessageKey } from '@renderer/i18n'
import type { IpcResult } from '@shared/types/ipc'
import type { AgentActivityEvent } from '@shared/types/mcp'

/** 호출이 끝난 뒤에도 표시가 남는 시간. 에이전트는 다음 호출을 생각하는 중일 수 있다(agent-activity A4). */
export const AGENT_ACTIVITY_LINGER_MS = 30_000

/**
 * 에이전트가 MCP로 앱을 쓰는 동안 창 가장자리 글로우와 툴바 아래 pill을 띄운다. pill의 [중지]는 에이전트의
 * 호출과 남은 작업만 멈추고 MCP는 그대로 둔다(A5). 대상은 원격 이름일 수 있어 텍스트로만 그린다.
 */
export function AgentActivityIndicator(): React.JSX.Element | null {
  const t = useT()
  const [event, setEvent] = useState<AgentActivityEvent | null>(null)

  useEffect(
    () =>
      window.api.on('agent:activity', (...args) => {
        const next = args[0] as AgentActivityEvent
        setEvent(next.stopped ? null : next)
      }),
    []
  )

  useEffect(() => {
    if (!event || event.active) return
    const timer = setTimeout(() => setEvent(null), AGENT_ACTIVITY_LINGER_MS)
    return () => clearTimeout(timer)
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

  return (
    <>
      <div
        data-agent-glow
        data-active={event.active}
        aria-hidden
        className="agent-glow pointer-events-none absolute inset-0 z-[70]"
      />
      <div
        role="status"
        className="pop absolute left-1/2 top-[60px] z-[71] flex max-w-[min(560px,calc(100%-32px))] -translate-x-1/2 items-center gap-2 rounded-full border border-[color-mix(in_srgb,var(--agent)_45%,var(--bd))] bg-[var(--sf)] py-1 pl-3 pr-1 text-sm text-[var(--tx)] shadow-[var(--shadow)]"
      >
        <Sparkles aria-hidden className="h-4 w-4 shrink-0 text-[var(--agent)]" />
        <span className="shrink-0 font-medium">{t('agent.working', { client })}</span>
        {detail && <span className="min-w-0 truncate text-[var(--mu)]">{detail}</span>}
        <button
          onClick={() => void stop()}
          aria-label={t('agent.stopLabel')}
          className="shrink-0 rounded-full border border-[var(--bd2)] px-2.5 py-0.5 text-xs hover:bg-[var(--hv)]"
        >
          {t('agent.stop')}
        </button>
      </div>
    </>
  )
}
