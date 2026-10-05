/**
 * 에이전트 확인·알림 문구 도우미. 도구 제목은 `agent.tool.<tool>` 번역을 쓰고, 번역이 없는
 * (앱보다 새) 도구는 이름을 그대로 보인다.
 */
import { en } from '@renderer/i18n/locales/en'
import type { MessageKey, t as translateFn } from '@renderer/i18n'
import type { RiskTier } from '@shared/types/agent'

export function toolTitle(t: typeof translateFn, tool: string): string {
  const key = `agent.tool.${tool}`
  return key in en ? t(key as MessageKey) : plainText(tool)
}

export function tierName(t: typeof translateFn, tier: RiskTier): string {
  return t(`agent.tier.${tier}`)
}

/**
 * 원격 서버·에이전트가 정한 문자열을 한 줄 텍스트로 보이게 한다. 개행·제어 문자와 글자 방향을
 * 뒤집는 문자(`photo‮gpj.exe`)는 이름을 다르게 보이게 하므로 `\n`, `‮` 같은 표기로 바꾼다.
 */
export function plainText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g, (ch) => {
    if (ch === '\n') return '\\n'
    if (ch === '\r') return '\\r'
    if (ch === '\t') return '\\t'
    return `\\u${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`
  })
}

const MASK = '••••••••'

/** McpService의 Claude Code 명령에서 토큰 원문을 꺼낸다(`--header "Authorization: Bearer <token>"`). */
export function tokenFromCommand(command: string | undefined): string | undefined {
  return command ? /Bearer ([^\s"']+)/.exec(command)?.[1] : undefined
}

/**
 * 연동 스니펫을 화면에 보일 때 토큰 원문을 가린다(handoff agent-operations L8·M13). 아는 토큰은 그대로
 * 찾아 가리고, 토큰처럼 생긴 긴 base64url 덩어리(토큰은 32바이트 = 43자)도 가린다. 복사는 원문으로 한다.
 */
export function maskToken(text: string, token: string | undefined): string {
  const known = token ? text.split(token).join(MASK) : text
  return known.replace(/[A-Za-z0-9_-]{32,}/g, MASK)
}
