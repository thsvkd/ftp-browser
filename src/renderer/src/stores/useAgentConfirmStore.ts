import { create } from 'zustand'
import { toast } from 'sonner'
import { t } from '@renderer/i18n'
import type { AgentConfirmRequest } from '@shared/types/agent'
import type { IpcResult } from '@shared/types/ipc'

/**
 * 에이전트 확인 요청 대기열(handoff agent-operations P3). 사용자의 `confirmDialog` 슬롯과 따로 둔다:
 * 한 번에 하나만 보이고(맨 앞), 나머지는 도착 순서대로 기다린다.
 */
export const useAgentConfirmStore = create<{ queue: AgentConfirmRequest[] }>(() => ({
  queue: []
}))

export function enqueueAgentConfirm(request: AgentConfirmRequest): void {
  const { queue } = useAgentConfirmStore.getState()
  if (queue.some((r) => r.id === request.id)) return
  useAgentConfirmStore.setState({ queue: [...queue, request] })
}

/** main이 시간 초과 등으로 거둬 간 요청. 답하지 않고 뺀다. */
export function dropAgentConfirm(id: string): void {
  const { queue } = useAgentConfirmStore.getState()
  useAgentConfirmStore.setState({ queue: queue.filter((r) => r.id !== id) })
}

export async function answerAgentConfirm(id: string, approved: boolean): Promise<void> {
  dropAgentConfirm(id)
  try {
    const result = await window.api.invoke<IpcResult<void>>('agent:confirmRespond', id, approved)
    if (!result.success) {
      toast.error(t('agent.confirm.respondFailed'), { description: result.error })
    }
  } catch (err) {
    toast.error(t('agent.confirm.respondFailed'), {
      description: err instanceof Error ? err.message : String(err)
    })
  }
}
