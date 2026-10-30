import type { AgentActivityEvent } from '@shared/types/mcp'
import type { OperationJob } from '@shared/types/operation'
import type { TransferJob, TransferUpdate } from '@shared/types/transfer'
import type { OperationManager } from '../operation/OperationManager'
import type { TransferHub } from '../transfer/TransferHub'
import type { Listenable } from './jobTracker'

/** 에이전트 도구 호출 하나. 끝나면 `end()`. `stopped`는 사용자가 이 호출을 중지하면 풀린다. */
export interface ActivityCall {
  /** 이 호출이 시작한 전송·파일 작업 id. 호출이 이미 중지됐으면 바로 취소한다. */
  track(ids: string[]): void
  end(): void
  stopped: Promise<void>
  /** 사용자가 이 호출을 중지했다. 중지된 호출은 서버 명령·큐 넣기를 더 하지 않는다(A7). */
  isStopped(): boolean
}

/**
 * 에이전트가 앱을 쓰는 중인지 센다(agent-activity A1). 진행 중인 도구 호출과 에이전트가 시작한 전송·파일
 * 작업이 남아 있으면 활성이다. 활성이 바뀌거나 호출이 시작·끝날 때 `emit`한다. 앱에 하나다.
 */
export interface AgentActivity {
  begin(tool: string, input: Record<string, unknown>, client?: string): ActivityCall
  /** 진행 중인 호출을 끝내고 에이전트의 남은 작업을 취소한다. MCP는 그대로다(A5). */
  stop(): void
  /** 마지막으로 알린 상태. 새로 고친 창이 처음에 읽는다(A10). */
  current(): AgentActivityEvent
}

/** 제어문자를 공백으로 바꾸고 앞뒤 공백을 지운 뒤 `max`자로 자른다. 원격 이름은 신뢰할 수 없는 데이터다. */
const clean = (text: string, max: number): string =>
  Array.from(text.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ').trim())
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
  // 공백·제어문자뿐인 이름은 이름이 없는 것과 같다(A9)
  const name = envelopeName && clean(envelopeName, 40)
  if (name) return name
  return KNOWN_AGENTS.find(([pattern]) => pattern.test(userAgent ?? ''))?.[1]
}

const isRunning = (status: string): boolean => status === 'pending' || status === 'active'

export function createAgentActivity(
  emit: (event: AgentActivityEvent) => void,
  transfers: Pick<TransferHub, 'getAll' | 'cancelMany'> &
    Listenable<'queue:updated', TransferUpdate>,
  operations: Pick<OperationManager, 'getAll' | 'requestCancel'> &
    Listenable<'operation:updated', OperationJob[]>
): AgentActivity {
  /** 진행 중인 호출과 그 호출의 중지 신호 */
  const calls = new Map<object, () => void>()
  const jobs = new Set<string>()
  let last: Pick<AgentActivityEvent, 'client' | 'tool' | 'target'> = {}
  let active = false
  let latest: AgentActivityEvent = { active: false }
  /**
   * 중지했지만 취소가 듣지 않은 전송(메인 연결로 도는 것). 끝날 때까지 표시를 `stopping`으로 남기고, 재시도로
   * 대기에 돌아오면 그때 취소한다(A8·A13). 추적이 끝나면(`jobs`에서 빠지면) 함께 잊는다.
   */
  const stoppedJobs = new Set<string>()

  /** 추적하는 작업 중 아직 도는 것. 끝났거나 목록에서 빠진 것은 잊는다. */
  const runningJobs = (
    all: TransferJob[] = jobs.size > 0 ? transfers.getAll() : []
  ): { transfers: string[]; operations: string[] } => {
    const running = { transfers: [] as string[], operations: [] as string[] }
    if (jobs.size === 0) return running
    for (const job of all)
      if (jobs.has(job.id) && isRunning(job.status)) running.transfers.push(job.id)
    for (const job of operations.getAll())
      if (jobs.has(job.id) && isRunning(job.status)) running.operations.push(job.id)
    const still = new Set([...running.transfers, ...running.operations])
    for (const id of jobs) {
      if (still.has(id)) continue
      jobs.delete(id)
      stoppedJobs.delete(id)
    }
    return running
  }

  /** 전송은 한 번에(큐마다 목록을 한 번만 훑는다, A8), 파일 작업은 하나가 실패해도 나머지를 요청한다. */
  const cancel = ({ transfers: t, operations: o }: ReturnType<typeof runningJobs>): void => {
    try {
      if (t.length > 0) transfers.cancelMany(t)
    } finally {
      for (const id of o) {
        try {
          operations.requestCancel(id)
        } catch (err) {
          console.warn('[agent] Failed to cancel an operation:', err)
        }
      }
    }
  }

  /** 호출 없이 중지가 취소하지 못한 전송만 남아 기다리는 중이다 */
  const stopping = (): boolean => calls.size === 0 && [...jobs].some((id) => stoppedJobs.has(id))

  const publish = (extra: Partial<AgentActivityEvent> = {}): void => {
    active = calls.size > 0 || jobs.size > 0
    latest = { active, ...last, ...(stopping() ? { stopping: true } : {}), ...extra }
    try {
      emit(latest)
    } catch (err) {
      // 알리지 못해도 호출·작업 추적은 이어 간다
      console.warn('[agent] Failed to send the activity:', err)
    }
  }

  /** 취소하고도 아직 도는 추적 작업을 기억한다 */
  const remember = (ids: Iterable<string>): void => {
    runningJobs()
    for (const id of ids) if (jobs.has(id)) stoppedJobs.add(id)
  }

  /** 작업 알림마다 다시 보고, 활성이나 기다림이 바뀔 때만 알린다(전송 진행률마다 보내지 않는다). */
  const recheck = (): void => {
    if (jobs.size === 0) return
    const wasStopping = latest.stopping === true
    let all = transfers.getAll()
    const retried = all
      .filter((job) => stoppedJobs.has(job.id) && job.status === 'pending')
      .map((job) => job.id)
    if (retried.length > 0) {
      transfers.cancelMany(retried)
      all = transfers.getAll()
    }
    runningJobs(all)
    if ((calls.size > 0 || jobs.size > 0) === active && stopping() === wasStopping) return
    // 기다리던 전송이 끝나면 30초 대기 없이 사라진다
    publish(wasStopping && calls.size === 0 && jobs.size === 0 ? { stopped: true } : {})
  }
  transfers.on('queue:updated', recheck)
  operations.on('operation:updated', recheck)

  return {
    begin(tool, input, client) {
      const call = {}
      let halted = false
      let resolveStopped = (): void => undefined
      const stopped = new Promise<void>((resolve) => (resolveStopped = resolve))
      calls.set(call, () => {
        halted = true
        resolveStopped()
      })
      last = { tool, target: summarizeTarget(input), client }
      publish()
      return {
        stopped,
        isStopped: () => halted,
        track: (ids) => {
          for (const id of ids) jobs.add(id)
          // 중지된 호출은 큐에 넣지 않지만(A7), 그래도 들어온 작업은 넣자마자 취소한다
          if (halted) {
            const running = runningJobs()
            const mine = new Set(ids)
            cancel({
              transfers: running.transfers.filter((id) => mine.has(id)),
              operations: running.operations.filter((id) => mine.has(id))
            })
            for (const id of running.operations) if (mine.has(id)) jobs.delete(id)
            remember(running.transfers.filter((id) => mine.has(id)))
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
        const running = runningJobs()
        cancel(running)
        // 파일 작업은 다음 명령 전에 멈춘다. 취소가 듣지 않은 전송(메인 연결로 도는 것)만 끝날 때까지
        // 표시를 남기고, 취소된 전송은 runningJobs가 잊는다(A8).
        for (const id of running.operations) jobs.delete(id)
        remember(running.transfers)
      } finally {
        const stops = [...calls.values()]
        calls.clear()
        stops.forEach((stopCall) => stopCall())
        publish(jobs.size > 0 ? {} : { stopped: true })
      }
    },
    current: () => latest
  }
}
