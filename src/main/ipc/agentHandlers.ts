import { ipcMain } from 'electron'
import type { IpcResult } from '@shared/types/ipc'
import type { AgentPolicy } from '@shared/types/agent'
import type { AgentPolicyStore } from '../mcp/agentPolicy'
import type { ConfirmationBroker } from '../mcp/confirmationBroker'
import { ipcError } from '../utils/errorClassifier'

/** 에이전트 확인 응답과 등급별 정책(§2.7). 실패는 IpcResult 값으로 돌려준다. */
export function registerAgentHandlers(policy: AgentPolicyStore, broker: ConfirmationBroker): void {
  ipcMain.handle(
    'agent:confirmRespond',
    (_event, id: unknown, approved: unknown): IpcResult<void> => {
      try {
        // 승인은 정확히 true일 때만이다.
        if (typeof id === 'string') broker.respond(id, approved === true)
        return { success: true, data: undefined }
      } catch (err) {
        return ipcError(err)
      }
    }
  )
  ipcMain.handle('agent:getPolicy', (): IpcResult<AgentPolicy> => {
    try {
      return { success: true, data: policy.get() }
    } catch (err) {
      return ipcError(err)
    }
  })
  ipcMain.handle('agent:setPolicy', (_event, value: unknown): IpcResult<AgentPolicy> => {
    try {
      return { success: true, data: policy.set(value) }
    } catch (err) {
      return ipcError(err)
    }
  })
}
