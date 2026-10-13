/**
 * 항목들을 어떤 위치에 보내면 무슨 일이 일어나는가(순수). 다른 쪽이면 전송, 같은 쪽이면
 * 원격은 이동·로컬은 복사(D15), 다른 서버의 원격 항목은 서버 간 복사(`relay`, MC17).
 * 막히면 `invalid`에 사유의 i18n 키를 담는다.
 */
import { parentPath, type ExplorerEntry, type Loc } from './explorerEntry'
import type { ConnKey } from '@shared/connKey'
import type { TransferDirection } from '@shared/types/transfer'

export type SendInvalid =
  | 'send.invalidNothing'
  | 'send.invalidIntoItself'
  | 'send.invalidNotConnected'
  | 'send.invalidHere'
  | 'send.invalidRemoteCopy'

export interface SendPlan {
  /** 다른 쪽으로 전송할 항목 */
  transfer: ExplorerEntry[]
  /** 같은 쪽에서 옮기거나 복사할 항목 */
  sameSide: ExplorerEntry[]
  /** 다른 서버로 복사할 원격 항목(원격 목적지의 서버와 다른 서버의 것) */
  relay: ExplorerEntry[]
  /** 이미 그 폴더에 있어 그대로 두는 수 */
  here: number
  direction: TransferDirection | null
  sameSideVerb: 'move' | 'copy' | null
  invalid: SendInvalid | null
}

export function planSend(
  items: readonly ExplorerEntry[],
  dest: Loc,
  connected: ReadonlySet<ConnKey>,
  opts: { copy?: boolean } = {}
): SendPlan {
  const plan: SendPlan = {
    transfer: [],
    sameSide: [],
    relay: [],
    here: 0,
    direction: null,
    sameSideVerb: null,
    invalid: null
  }
  const refuse = (invalid: SendInvalid): SendPlan => ({ ...plan, invalid })
  if (!items.length) return refuse('send.invalidNothing')

  // 로컬 경로는 macOS·Linux에서 '/'이므로 두 구분자를 모두 본다.
  const seps = dest.side === 'remote' ? ['/'] : ['\\', '/']
  for (const e of items) {
    if (e.side !== dest.side) {
      plan.transfer.push(e)
      continue
    }
    // 다른 서버의 같은 경로는 "자기 안으로"도 "이미 여기"도 아니다: 그 서버로 복사한다(함정 13).
    if (e.side === 'remote' && e.server !== dest.server) {
      plan.relay.push(e)
      continue
    }
    if (dest.path === e.path || seps.some((s) => dest.path.startsWith(e.path + s)))
      return refuse('send.invalidIntoItself')
    if (parentPath(e.side, e.path) === dest.path) plan.here++
    else plan.sameSide.push(e)
  }

  const remotes = [
    ...items.filter((e) => e.side === 'remote'),
    ...(dest.side === 'remote' ? [dest] : [])
  ]
  if (remotes.some((r) => !r.server || !connected.has(r.server)))
    return refuse('send.invalidNotConnected')
  if (opts.copy && dest.side === 'remote' && plan.sameSide.length)
    return refuse('send.invalidRemoteCopy')
  // 서버 간 복사는 아직 실행하지 않는다(multi-connection S5b가 이 줄을 지운다).
  if (plan.relay.length) return refuse('send.invalidRemoteCopy')
  if (!plan.transfer.length && !plan.sameSide.length && !plan.relay.length)
    return refuse('send.invalidHere')

  if (plan.transfer.length) plan.direction = dest.side === 'remote' ? 'upload' : 'download'
  if (plan.sameSide.length) plan.sameSideVerb = dest.side === 'remote' ? 'move' : 'copy'
  return plan
}
