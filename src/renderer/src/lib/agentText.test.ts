import { describe, expect, it } from 'vitest'
import { maskToken, plainText } from './agentText'

describe('plainText', () => {
  it('makes C1 controls and invisible format characters visible, and nothing next to them', () => {
    // covers: Test-647
    const escaped: [string, string][] = [
      ['\u0080', '\\u0080'],
      ['\u0085', '\\u0085'],
      ['\u009b', '\\u009B'],
      ['\u009f', '\\u009F'],
      ['\u200b', '\\u200B'],
      ['\u200c', '\\u200C'],
      ['\u200d', '\\u200D'],
      ['\u200e', '\\u200E'],
      ['\u200f', '\\u200F'],
      ['\u2060', '\\u2060'],
      ['\u2061', '\\u2061'],
      ['\u2062', '\\u2062'],
      ['\u2063', '\\u2063'],
      ['\u2064', '\\u2064'],
      ['\ufeff', '\\uFEFF']
    ]
    for (const [ch, shown] of escaped) {
      expect(plainText(`claude${ch}-code`), shown).toBe(`claude${shown}-code`)
    }
    // 이미 다루던 C0·DEL·방향 제어 문자도 그대로 드러난다.
    expect(plainText('a\nb\u0000c\u007fd\u202ee\u2066f')).toBe(
      'a\\nb\\u0000c\\u007Fd\\u202Ee\\u2066f'
    )
    // 범위 바로 바깥의 글자(~, NBSP, 악센트 글자, hair space, 하이픈, 수학 공백)와 이모지의 변형 선택자는 그대로다.
    const kept = 'a~\u00a0\u00e9\u200a\u2010\u205f사진\u2764\ufe0f\uff01'
    expect(plainText(kept)).toBe(kept)
  })
})

describe('maskToken', () => {
  it('masks the token, but not long path segments such as a UUID folder', () => {
    // covers: Test-649
    const MASK = '••••••••'
    // McpService의 토큰과 같은 모양: 32바이트 base64url = 43자.
    const token = 'Zx9_Q-4rT1vB8nK2mP0sL7wY3hJ6cF5dA1eG9iU0oR4'
    const other = 'q8W-3nZ_x0Lr5Tb7Yk2Mv9Pc4Hs6Jd1Fg0Ae3Ui8Oo2'
    const uuidShim = '/home/kim/.config/FTP Browser/cli/0f8e3c2a-9b1d-4e5f-a6b7-c8d9e0f1a2b3/ftpb'
    const posixShim = `/opt/${other}/ftpb`
    const winShim = `C:\\Users\\kim\\${other}\\ftpb.cmd`

    // 아는 토큰은 그 문자열만 가린다.
    expect(maskToken(`"Authorization":"Bearer ${token}" ${uuidShim}`, token)).toBe(
      `"Authorization":"Bearer ${MASK}" ${uuidShim}`
    )
    expect(maskToken(`${posixShim} ${other}`, token)).toBe(`${posixShim} ${other}`)

    // 모르면 앱 토큰 모양(정확히 43자)이면서 경로의 한 토막이 아닌 덩어리만 가린다.
    expect(maskToken(`Bearer ${other} ${uuidShim} ${posixShim} ${winShim}`, undefined)).toBe(
      `Bearer ${MASK} ${uuidShim} ${posixShim} ${winShim}`
    )
    expect(maskToken(other, undefined)).toBe(MASK)
    expect(maskToken(`token=${other}&`, undefined)).toBe(`token=${MASK}&`)
    const near = `${'A'.repeat(42)} ${'B'.repeat(44)} ${other}/x x\\${other}`
    expect(maskToken(near, undefined)).toBe(near)
  })
})
