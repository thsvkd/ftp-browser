import type { AgentActivityEvent } from '@shared/types/mcp'
import type { OperationJob } from '@shared/types/operation'
import type { TransferUpdate } from '@shared/types/transfer'
import type { OperationManager } from '../operation/OperationManager'
import type { TransferHub } from '../transfer/TransferHub'
import type { Listenable } from './jobTracker'

/** 에이전트 도구 호출 하나. 끝나면 `end()`. `stopped`는 사용자가 이 호출을 중지하면 풀린다. */
export interface ActivityCall {
  /** 이 호출이 시작한 전송·파일 작업 id. 호출이 이미 중지됐으면 바로 취소한다. */
  track(ids: string[]): void
  end(): void
  stopped: Promise<void>
}

/**
 * 에이전트가 앱을 쓰는 중인지 센다(agent-activity A1). 진행 중인 도구 호출과 에이전트가 시작한 전송·파일
 * 작업이 남아 있으면 활성이다. 활성이 바뀌거나 호출이 시작·끝날 때 `emit`한다. 앱에 하나다.
 */
export interface AgentActivity {
  begin(tool: string, input: Record<string, unknown>, client?: string): ActivityCall
  /** 진행 중인 호출을 끝내고 에이전트의 남은 작업을 취소한다. MCP는 그대로다(A5). */
  stop(): void
}

/** 제어문자를 공백으로 바꾸고 `max`자로 자른다. 원격 이름은 신뢰할 수 없는 데이터다. */
const clean = (text: string, max: number): string =>
  Array.from(text.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' '))
    .slice(0, max)
    .join('')

/** 호출이 무엇에 대한 것인지(A3) */
export function summarizeTarget(input: Record<string, unknown>): string | undefined {
  const first = (key: string): string | undefined => {
    const value = input[key]
    if (typeof value === 'string') return value
    if (!Array.isArray(value) || value.length === 0) return undefined
    return value.length > 1 ? `${value[0]} +${value.length - 1}` : String(value[0])
  }
  const text =
    typeof input.from === 'string' && typeof input.to === 'string'
      ? `${input.from} → ${input.to}`
      : (first('path') ??
        first('paths') ??
        first('remotePaths') ??
        first('localPaths') ??
        (input.server === undefined ? undefined : String(input.server)))
  return text === undefined ? undefined : clean(text, 120)
}

/** User-Agent에서 알아보는 에이전트. 그 밖의 User-Agent(`node` 등)는 이름으로 쓰지 않는다. */
const KNOWN_AGENTS: Array<[RegExp, string]> = [
  [/claude/i, 'Claude Code'],
  [/codex/i, 'Codex'],
  [/cursor/i, 'Cursor']
]

/** 에이전트 이름(A2): 요청 envelope의 clientInfo.name, 없으면 알려진 User-Agent */
export function clientName(envelopeName?: string, userAgent?: string | null): string | undefined {
  if (envelopeName) return clean(envelopeName, 40)
  return KNOWN_AGENTS.find(([pattern]) => pattern.test(userAgent ?? ''))?.[1]
}

const isRunning = (status: string): boolean => status === 'pending' || status === 'active'

export function createAgentActivity(
  emit: (event: AgentActivityEvent) => void,
  transfers: Pick<TransferHub, 'getAll' | 'cancel'> & Listenable<'queue:updated', TransferUpdate>,
  operations: Pick<OperationManager, 'getAll' | 'requestCancel'> &
    Listenable<'operation:updated', OperationJob[]>
): AgentActivity {
  /** 진행 중인 호출과 그 호출의 중지 신호 */
  const calls = new Map<object, () => void>()
  const jobs = new Set<string>()
  let last: Pick<AgentActivityEvent, 'client' | 'tool' | 'target'> = {}
  let active = false

  /** 추적하는 작업 중 아직 도는 것. 끝났거나 목록에서 빠진 것은 잊는다. */
  const runningJobs = (): { transfers: string[]; operations: string[] } => {
    const running = { transfers: [] as string[], operations: [] as string[] }
    if (jobs.size === 0) return running
    for (const job of transfers.getAll())
      if (jobs.has(job.id) && isRunning(job.status)) running.transfers.push(job.id)
    for (const job of operations.getAll())
      if (jobs.has(job.id) && isRunning(job.status)) running.operations.push(job.id)
    const still = new Set([...running.transfers, ...running.operations])
    for (const id of jobs) if (!still.has(id)) jobs.delete(id)
    return running
  }

  const cancel = ({ transfers: t, operations: o }: ReturnType<typeof runningJobs>): void => {
    t.forEach((id) => transfers.cancel(id))
    o.forEach((id) => operations.requestCancel(id))
  }

  const publish = (extra: Partial<AgentActivityEvent> = {}): void => {
    active = calls.size > 0 || jobs.size > 0
    emit({ active, ...last, ...extra })
  }

  /** 작업 알림마다 다시 보고, 활성이 바뀔 때만 알린다(전송 진행률마다 보내지 않는다). */
  const recheck = (): void => {
    if (jobs.size === 0) return
    runningJobs()
    if ((calls.size > 0 || jobs.size > 0) !== active) publish()
  }
  transfers.on('queue:updated', recheck)
  operations.on('operation:updated', recheck)

  return {
    begin(tool, input, client) {
      const call = {}
      let stopCall = (): void => undefined
      const stopped = new Promise<void>((resolve) => (stopCall = resolve))
      calls.set(call, stopCall)
      last = { tool, target: summarizeTarget(input), client }
      publish()
      return {
        stopped,
        track: (ids) => {
          for (const id of ids) jobs.add(id)
          // 중지 뒤에 계획을 마치고 큐에 넣은 작업(폴더 목록 읽기 중 중지)은 넣자마자 취소한다
          if (!calls.has(call)) {
            const running = runningJobs()
            const mine = new Set(ids)
            cancel({
              transfers: running.transfers.filter((id) => mine.has(id)),
              operations: running.operations.filter((id) => mine.has(id))
            })
            ids.forEach((id) => jobs.delete(id))
          }
        },
        end: () => {
          // stop() 뒤에 끝난 호출은 이미 잊었다
          if (!calls.delete(call)) return
          runningJobs()
          publish()
        }
      }
    },
    stop() {
      try {
        cancel(runningJobs())
      } finally {
        jobs.clear()
        const stops = [...calls.values()]
        calls.clear()
        stops.forEach((stopCall) => stopCall())
        publish({ stopped: true })
      }
    }
  }
}
