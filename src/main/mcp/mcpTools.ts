import { McpServer } from '@modelcontextprotocol/server'
import type { AgentPolicy } from '@shared/types/agent'
import type { OperationJob } from '@shared/types/operation'
import type { AgentServices } from '../agent/types'
import type { AgentNotifier, ConfirmInput, ConfirmOutcome } from './confirmationBroker'
import type { JobHandles } from './jobHandles'
import {
  buildInstructions,
  registerTools,
  type ActionLock,
  type ToolDefinition
} from './toolRegistry'
import { LOCAL_TOOLS } from './tools/localTools'
import { REMOTE_TOOLS } from './tools/remoteTools'
import { SESSION_TOOLS } from './tools/sessionTools'
import { TRANSFER_TOOLS } from './tools/transferTools'

export interface PreviewRequest {
  remotePath: string
  fileSize: number
  modifiedAt: string
}

export type PreviewOutcome =
  | { ok: true; /** base64 JPEG */ data: string; width: number; height: number }
  | { ok: false; error: string }

/** 도구가 쓰는 앱 서비스. 테스트는 가짜를 넣는다. 요청마다 새 McpServer가 같은 deps를 공유한다. */
export interface McpToolDeps {
  version: string
  services: AgentServices
  /** OperationManager.getAll: list_jobs·get_status가 파일 작업을 전송과 함께 센다 */
  operations: { getAll(): OperationJob[] }
  /** 요청 시점의 정책(P1). 설명 첫 줄, `_meta`, tools/list, 실행 여부가 이것을 따른다 */
  policy: { get(): AgentPolicy }
  /** ConfirmationBroker.request */
  confirm(request: ConfirmInput, signal?: AbortSignal): Promise<ConfirmOutcome>
  notify: AgentNotifier
  /** 앱 썸네일 파이프라인으로 미리보기를 만든다. 결과는 요청과 같은 순서다. */
  previews(requests: PreviewRequest[]): Promise<PreviewOutcome[]>
  jobHandles: JobHandles
  /** §9 R1: R이 아닌 호출을 하나씩 지나게 한다. 앱에 하나만 둔다 */
  actionLock: ActionLock
  /**
   * §9 R2 에이전트 폴더(앱은 agentFolderPath로 고른 다운로드 폴더). 로컬에 쓰는 W 도구는
   * 이 안에서만 W 정책을 따르고 밖이면 사용자에게 묻는다
   */
  localRoot: string
  /** 테스트가 줄이는 대기 시간 */
  timing?: { deleteWaitMs?: number; progressIntervalMs?: number }
}

/** §2.2의 도구 전부. 순서는 tools/list 순서다. */
export const TOOL_DEFINITIONS: ToolDefinition[] = [
  ...SESSION_TOOLS,
  ...REMOTE_TOOLS,
  ...LOCAL_TOOLS,
  ...TRANSFER_TOOLS
]

/** 요청마다 새로 만든다. 설명 첫 줄과 목록이 지금의 정책을 따른다. */
export function createMcpToolServer(deps: McpToolDeps): McpServer {
  const policy = deps.policy.get()
  const server = new McpServer(
    { name: 'ftp-browser', version: deps.version },
    { instructions: buildInstructions(policy, deps.localRoot) }
  )
  registerTools(server, TOOL_DEFINITIONS, policy, deps)
  return server
}
