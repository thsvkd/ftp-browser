import { randomUUID } from 'crypto'
import type { AgentActivity, AgentConfirmRequest, ServerEditorRequest } from '@shared/types/agent'

/** P4: 이 시간 안에 사용자가 답하지 않으면 거부로 본다. */
export const CONFIRM_TIMEOUT_MS = 120_000

/** BrowserWindow 중 확인·알림에 쓰는 부분. 테스트는 가짜를 넣는다. */
export interface AgentWindow {
  isDestroyed(): boolean
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
  webContents: { send(channel: string, ...args: unknown[]): void }
}

/** macOS `activate`가 창을 새로 만들 수 있으므로 창은 매번 getter로 얻는다. */
export type AgentWindowGetter = () => AgentWindow | null | undefined

function liveWindow(getWindow: AgentWindowGetter): AgentWindow | null {
  const win = getWindow()
  return win && !win.isDestroyed() ? win : null
}

/** 최소화를 풀고 보여 준 뒤 포커스한다(P3). */
function bringToFront(win: AgentWindow): void {
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

export type ConfirmInput = Omit<AgentConfirmRequest, 'id' | 'expiresAt'>

/** `aborted`: MCP 호출이 먼저 끊겼다(클라이언트 취소·타임아웃). 답을 받을 쪽이 없다. */
export type ConfirmOutcome = 'approved' | 'denied' | 'timeout' | 'unavailable' | 'aborted'

interface Entry {
  id: string
  input: ConfirmInput
  resolve: (outcome: ConfirmOutcome) => void
  signal?: AbortSignal
  onAbort: () => void
  timer?: ReturnType<typeof setTimeout>
}

/**
 * 에이전트 도구 실행 전 사용자 확인(P3–P6). 렌더러에 `agent:confirmRequest`를 한 번에 하나만 보내고
 * 나머지는 도착 순서대로 기다리게 한다. 보여 준 요청은 `timeoutMs` 뒤 `timeout`으로 끝나고
 * 렌더러에 `agent:confirmCancelled`(id)를 보낸다. 살아 있는 창이 없으면 바로 `unavailable`이다.
 */
export class ConfirmationBroker {
  private queue: Entry[] = []
  private current: Entry | null = null

  constructor(
    private getWindow: AgentWindowGetter,
    private timeoutMs = CONFIRM_TIMEOUT_MS
  ) {}

  request(input: ConfirmInput, signal?: AbortSignal): Promise<ConfirmOutcome> {
    if (!liveWindow(this.getWindow)) return Promise.resolve('unavailable')
    if (signal?.aborted) return Promise.resolve('aborted')
    return new Promise((resolve) => {
      const entry: Entry = {
        id: randomUUID(),
        input,
        resolve,
        signal,
        onAbort: () => this.abort(entry)
      }
      signal?.addEventListener('abort', entry.onAbort, { once: true })
      this.queue.push(entry)
      this.showNext()
    })
  }

  /** 렌더러의 답. 지금 보여 준 요청이 아니면(늦은 답, 모르는 id) 무시한다. */
  respond(id: string, approved: boolean): void {
    if (this.current?.id !== id) return
    this.settle(this.current, approved ? 'approved' : 'denied', false)
  }

  private showNext(): void {
    while (!this.current && this.queue.length > 0) {
      const entry = this.queue.shift()!
      const win = liveWindow(this.getWindow)
      if (!win) {
        this.release(entry, 'unavailable')
        continue
      }
      this.current = entry
      entry.timer = setTimeout(() => this.settle(entry, 'timeout', true), this.timeoutMs)
      bringToFront(win)
      const request: AgentConfirmRequest = {
        ...entry.input,
        id: entry.id,
        expiresAt: new Date(Date.now() + this.timeoutMs).toISOString()
      }
      win.webContents.send('agent:confirmRequest', request)
    }
  }

  private abort(entry: Entry): void {
    if (this.current === entry) {
      this.settle(entry, 'aborted', true)
      return
    }
    this.queue = this.queue.filter((queued) => queued !== entry)
    this.release(entry, 'aborted')
  }

  /** 보여 준 요청을 끝낸다. 렌더러가 스스로 닫지 않은 경우(timeout·abort)만 닫으라고 알린다. */
  private settle(entry: Entry, outcome: ConfirmOutcome, cancelDialog: boolean): void {
    clearTimeout(entry.timer)
    this.current = null
    if (cancelDialog)
      liveWindow(this.getWindow)?.webContents.send('agent:confirmCancelled', entry.id)
    this.release(entry, outcome)
    this.showNext()
  }

  private release(entry: Entry, outcome: ConfirmOutcome): void {
    entry.signal?.removeEventListener('abort', entry.onAbort)
    entry.resolve(outcome)
  }
}

/** 도구가 렌더러에 보내는 나머지 알림(P8 활동 토스트, T10 서버 편집기) */
export interface AgentNotifier {
  activity(activity: AgentActivity): void
  /** 창이 없어 열지 못했으면 false */
  openServerEditor(request: ServerEditorRequest): boolean
}

export function createAgentNotifier(getWindow: AgentWindowGetter): AgentNotifier {
  return {
    activity: (activity) => liveWindow(getWindow)?.webContents.send('agent:activity', activity),
    openServerEditor: (request) => {
      const win = liveWindow(getWindow)
      if (!win) return false
      bringToFront(win)
      win.webContents.send('agent:openServerEditor', request)
      return true
    }
  }
}
