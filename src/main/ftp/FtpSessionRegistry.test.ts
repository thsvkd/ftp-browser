import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * 레지스트리는 매니저를 스스로 만든다. 실제 FTP 연결을 막도록 매니저 클래스를 목으로 세우고,
 * 만들어진 인스턴스를 순서대로 기억한다(vi.hoisted: vi.mock보다 먼저 실행된다).
 */
const state = vi.hoisted(() => ({
  instances: [] as Array<
    import('events').EventEmitter & {
      connect: import('vitest').Mock
      disconnect: import('vitest').Mock
    }
  >
}))

vi.mock('./FtpConnectionManager', async () => {
  const { EventEmitter } = await import('events')
  return {
    FtpConnectionManager: class extends EventEmitter {
      connect = vi.fn(async () => ({ success: true }))
      disconnect = vi.fn(async () => {})
      isConnected = (): boolean => false
      constructor() {
        super()
        state.instances.push(this as unknown as (typeof state.instances)[number])
      }
    }
  }
})

import { FtpSessionRegistry, serverKeyOf } from './FtpSessionRegistry'
import type { FtpConnectPayload } from '@shared/types/ftp'

const A: FtpConnectPayload = {
  host: 'a.example',
  port: 21,
  user: 'u',
  password: 'x',
  secure: false
}
const B: FtpConnectPayload = { ...A, host: 'b.example' }

describe('FtpSessionRegistry', () => {
  beforeEach(() => {
    state.instances.length = 0
  })

  it('uses the same manager for the same server key and another manager for a different key', async () => {
    // covers: Test-906
    const registry = new FtpSessionRegistry()

    await registry.connect(A)
    await registry.connect(A)
    // placeholder(1) + 세션 하나: 같은 키의 두 번째 연결도 새 매니저를 만들지 않는다(함정 C의 누수 없음)
    expect(state.instances).toHaveLength(2)

    await registry.connect(B)
    expect(state.instances).toHaveLength(3)
    expect(registry.get(serverKeyOf(A))).toBe(state.instances[1])
    expect(registry.get(serverKeyOf(B))).toBe(state.instances[2])
    expect(registry.get(serverKeyOf(A))).not.toBe(registry.get(serverKeyOf(B)))
  })

  it('returns the primary session for get() without an argument and creates nothing', async () => {
    // covers: Test-907
    const registry = new FtpSessionRegistry()
    const primary = registry.get()
    expect(registry.get()).toBe(primary)
    expect(state.instances).toHaveLength(1) // 인자를 안 주는 호출이 매니저를 만들지 않는다

    await registry.connect(A)
    // M3: 가장 최근에 연결한 세션이 primary다(MCP·기존 호출부의 경로)
    expect(registry.get()).toBe(registry.get(serverKeyOf(A)))
    expect(state.instances).toHaveLength(2) // get() 호출이 매니저를 더 만들지 않았다
  })

  it('disconnect(server) closes only that session and leaves the others running', async () => {
    // covers: Test-908
    const registry = new FtpSessionRegistry()
    await registry.connect(A)
    await registry.connect(B) // primary = B

    await registry.disconnect(serverKeyOf(A))
    expect(state.instances[1].disconnect).toHaveBeenCalledTimes(1)
    expect(state.instances[2].disconnect).not.toHaveBeenCalled()

    await registry.disconnect() // 인자 없음 = primary만
    expect(state.instances[2].disconnect).toHaveBeenCalledTimes(1)
    // 세션은 남아 있어(닫혔을 뿐) 같은 키를 다시 쓸 수 있다
    expect(registry.get(serverKeyOf(A))).toBe(state.instances[1])
    expect(registry.get(serverKeyOf(B))).toBe(state.instances[2])
  })
})
