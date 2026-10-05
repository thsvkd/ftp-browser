import type Database from 'better-sqlite3'
import {
  DEFAULT_AGENT_POLICY,
  type AgentPolicy,
  type PolicyTier,
  type PolicyValue
} from '@shared/types/agent'

const KEY = 'agentPolicy'
const TIERS: readonly PolicyTier[] = ['W', 'D', 'X', 'C']
const VALUES: readonly PolicyValue[] = ['allow', 'ask', 'deny']

/** 등급 W·D·X·C가 모두 있고 각각 allow/ask/deny인 객체만 정책이다. R이나 다른 키가 섞이면 아니다. */
export function parseAgentPolicy(value: unknown): AgentPolicy | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const entries = Object.entries(value)
  if (entries.length !== TIERS.length) return null
  for (const [tier, policy] of entries) {
    if (!TIERS.includes(tier as PolicyTier) || !VALUES.includes(policy as PolicyValue)) return null
  }
  return { ...(value as AgentPolicy) }
}

/**
 * 등급별 에이전트 정책(P1). SQLite `settings`의 `agentPolicy`에 JSON으로 둔다.
 * 값이 없거나 망가졌으면 `DEFAULT_AGENT_POLICY`로 읽는다. 요청마다 읽으므로 캐시하지 않는다.
 */
export class AgentPolicyStore {
  constructor(private db: Database.Database) {}

  get(): AgentPolicy {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY) as
      | { value: string }
      | undefined
    if (!row) return { ...DEFAULT_AGENT_POLICY }
    try {
      return parseAgentPolicy(JSON.parse(row.value)) ?? { ...DEFAULT_AGENT_POLICY }
    } catch {
      return { ...DEFAULT_AGENT_POLICY }
    }
  }

  /** 잘못된 값은 저장하지 않고 throw한다(렌더러가 IPC를 직접 불러도 막는다). */
  set(value: unknown): AgentPolicy {
    const policy = parseAgentPolicy(value)
    if (!policy) {
      throw new Error('Invalid agent policy: W, D, X and C must each be "allow", "ask" or "deny".')
    }
    this.db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(KEY, JSON.stringify(policy))
    return policy
  }
}
