import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { DEFAULT_AGENT_POLICY } from '@shared/types/agent'
import { AgentPolicyStore } from './agentPolicy'

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
})

afterEach(() => {
  db.close()
})

describe('AgentPolicyStore', () => {
  it('defaults, persists across instances, and rejects malformed policies', () => {
    // covers: Test-459
    const store = new AgentPolicyStore(db)
    expect(store.get()).toEqual(DEFAULT_AGENT_POLICY)

    const policy = { W: 'ask', D: 'deny', X: 'allow', C: 'ask' } as const
    expect(store.set(policy)).toEqual(policy)
    expect(new AgentPolicyStore(db).get()).toEqual(policy)

    for (const bad of [
      null,
      'allow',
      [],
      { W: 'ask', D: 'deny', X: 'allow' },
      { ...policy, C: 'maybe' },
      { ...policy, R: 'deny' },
      { ...policy, W: 1 }
    ]) {
      expect(() => store.set(bad), JSON.stringify(bad)).toThrow(/policy/i)
    }
    expect(new AgentPolicyStore(db).get()).toEqual(policy)

    // 손으로 망가뜨린 값은 기본값으로 읽는다.
    db.prepare("UPDATE settings SET value = '{not json' WHERE key = 'agentPolicy'").run()
    expect(store.get()).toEqual(DEFAULT_AGENT_POLICY)
    db.prepare(`UPDATE settings SET value = '{"W":"allow"}' WHERE key = 'agentPolicy'`).run()
    expect(store.get()).toEqual(DEFAULT_AGENT_POLICY)
  })
})
