import { useEffect } from 'react'
import { toast } from 'sonner'
import { t } from '@renderer/i18n'
import { toolTitle } from '@renderer/lib/agentText'
import type { AgentActivity } from '@shared/types/agent'

/** 결과마다 토스트 종류와 문구. 사람이 에이전트가 한 일과 거부된 요청을 본다. */
const SHOW = {
  done: { kind: 'success', key: 'agent.activity.done' },
  started: { kind: 'info', key: 'agent.activity.started' },
  denied: { kind: 'warning', key: 'agent.activity.denied' },
  failed: { kind: 'error', key: 'agent.activity.failed' }
} as const

/** `agent:activity`(handoff agent-operations P8)를 짧은 토스트로 알린다. */
export function useAgentActivityToast(): void {
  useEffect(() => {
    return window.api.on('agent:activity', (...args: unknown[]) => {
      const activity = args[0] as AgentActivity
      const show = SHOW[activity.outcome]
      if (!show) return
      toast[show.kind](t(show.key, { action: toolTitle(t, activity.tool) }), {
        description:
          activity.totalItems !== undefined
            ? t('common.itemCount', { count: activity.totalItems })
            : undefined
      })
    })
  }, [])
}
