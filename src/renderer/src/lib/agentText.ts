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
 * 원격 서버·에이전트가 정한 문자열을 한 줄 텍스트로 보이게 한다. 개행·제어 문자(C0·DEL·C1), 글자 방향을
 * 뒤집는 문자(`photo\u202Egpj.exe`), 폭 없는 서식 문자(`claude\u200B-code`)는 이름을 다르게 보이게
 * 하므로 `\n`, `\u202E` 같은 표기로 바꾼다(handoff agent-operations §9 R10).
 */
export function plainText(text: string): string {
  return text.replace(
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g,
    (ch) => {
      if (ch === '\n') return '\\n'
      if (ch === '\r') return '\\r'
      if (ch === '\t') return '\\t'
      return `\\u${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`
    }
  )
}

const MASK = '••••••••'

/** McpService의 Claude Code 명령에서 토큰 원문을 꺼낸다(`--header "Authorization: Bearer <token>"`). */
export function tokenFromCommand(command: string | undefined): string | undefined {
  return command ? /Bearer ([^\s"']+)/.exec(command)?.[1] : undefined
}

/**
 * 연동 스니펫을 화면에 보일 때 토큰 원문을 가린다(handoff agent-operations L8·M13). 아는 토큰은 그 문자열만
 * 가린다. 모르면 앱 토큰 모양(32바이트 base64url = 정확히 43자)이면서 경로의 한 토막이 아닌(`/`·`\`에
 * 붙지 않은) 덩어리만 가린다. UUID 같은 셔임 경로의 폴더 이름은 그대로 보인다. 복사는 원문으로 한다.
 */
export function maskToken(text: string, token: string | undefined): string {
  if (token) return text.split(token).join(MASK)
  return text.replace(/(?<![\w\-/\\])[\w-]{43}(?![\w\-/\\])/g, MASK)
}
