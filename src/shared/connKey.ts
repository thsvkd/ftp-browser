/**
 * 연결 키 `"user@host:port"`. 렌더러의 `Loc.server`와 같은 문자열이고, main의 연결·전송 작업·이벤트가
 * 어느 서버 것인지 가리킨다(multi-connection MC2). 호스트 대소문자는 정규화하지 않는다.
 */
export type ConnKey = string

/** 분할 뷰 전의 단일 패널이 쓰는 뷰어 id(split-view.md P2). */
export const MAIN_VIEWER = 'left'

/** 빈 사용자 이름은 `'anonymous'`로 접속하므로 키도 그렇게 만든다. */
export function connKey(host: string, port: number, user: string): ConnKey {
  return `${user || 'anonymous'}@${host}:${port}`
}

/** 마지막 `@`로 사용자를, 마지막 `:`로 포트를 나눈다. `@`가 없거나 포트가 1~65535 정수가 아니면 null. */
export function parseConnKey(key: string): { user: string; host: string; port: number } | null {
  const at = key.lastIndexOf('@')
  if (at < 0) return null
  const hostPort = key.slice(at + 1)
  const colon = hostPort.lastIndexOf(':')
  if (colon < 0) return null
  const portText = hostPort.slice(colon + 1)
  if (!/^\d+$/.test(portText)) return null
  const port = Number(portText)
  if (port < 1 || port > 65535) return null
  return { user: key.slice(0, at), host: hostPort.slice(0, colon), port }
}
