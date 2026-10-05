import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useT } from '@renderer/i18n'
import { maskToken, tierName, tokenFromCommand } from '@renderer/lib/agentText'
import { TierBadge } from '@renderer/components/agent/TierBadge'
import type {
  AgentClientSetup,
  AgentPolicy,
  CliInstallStatus,
  PolicyTier,
  PolicyValue,
  RiskTier
} from '@shared/types/agent'
import type { IpcResult } from '@shared/types/ipc'

const TIERS: RiskTier[] = ['R', 'W', 'D', 'X', 'C']
const POLICY_VALUES: PolicyValue[] = ['allow', 'ask', 'deny']

const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const subheading = 'text-xs font-semibold text-gray-600'
const hint = 'mt-0.5 text-xs text-gray-400'
const button =
  'shrink-0 rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50'
const codeBox =
  'mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-gray-50 p-2 font-mono text-[11px] text-gray-800 ring-1 ring-inset ring-gray-200'

/** IPC 실패와 reject를 같은 오류 토스트로 알리고, 성공했을 때만 데이터를 돌려준다. */
async function run<T>(
  channel: Parameters<typeof window.api.invoke>[0],
  title: string,
  ...args: unknown[]
): Promise<T | undefined> {
  try {
    const result = await window.api.invoke<IpcResult<T>>(channel, ...args)
    if (result.success) return result.data
    toast.error(title, { description: result.error })
  } catch (err) {
    toast.error(title, { description: reason(err) })
  }
  return undefined
}

/** 열 때 읽는 값. 읽지 못하면 그 부분을 그리지 않는다(사용자가 한 일이 아니므로 알리지 않는다). */
async function load<T>(channel: Parameters<typeof window.api.invoke>[0]): Promise<T | undefined> {
  try {
    const result = await window.api.invoke<IpcResult<T>>(channel)
    return result.success ? result.data : undefined
  } catch (err) {
    console.warn(`[AgentSettings] ${channel} failed:`, err)
    return undefined
  }
}

/**
 * Settings › Agent access의 2단계 부분(handoff agent-operations L8): 등급별 정책, 에이전트 연결 스니펫,
 * 명령줄 도구, 에이전트 스킬. 정책은 접근이 꺼져 있어도 미리 정할 수 있고, 나머지는 켜져 있을 때만 보인다.
 */
export function AgentSettings({
  enabled,
  command
}: {
  enabled: boolean
  /** Claude Code 등록 명령. 토큰이 바뀌면 함께 바뀌므로 스니펫을 다시 읽고, 가릴 토큰도 여기서 얻는다. */
  command?: string
}): React.JSX.Element {
  const t = useT()
  const [policy, setPolicy] = useState<AgentPolicy>()
  const [setups, setSetups] = useState<AgentClientSetup[]>([])
  const [clientId, setClientId] = useState('')
  const [cli, setCli] = useState<CliInstallStatus>()
  const [installingCli, setInstallingCli] = useState(false)
  const [installingSkill, setInstallingSkill] = useState(false)

  useEffect(() => {
    void load<AgentPolicy>('agent:getPolicy').then((data) => data && setPolicy(data))
  }, [])

  useEffect(() => {
    if (!enabled) return
    void load<AgentClientSetup[]>('agent:getClientSetups').then((data) => data && setSetups(data))
    void load<CliInstallStatus>('agent:getCliStatus').then((data) => data && setCli(data))
  }, [enabled, command])

  const changePolicy = async (tier: PolicyTier, value: PolicyValue): Promise<void> => {
    if (!policy) return
    const saved = await run<AgentPolicy>('agent:setPolicy', t('settings.agentPolicyFailed'), {
      ...policy,
      [tier]: value
    })
    if (saved) setPolicy(saved)
  }

  const setup = setups.find((s) => s.id === clientId) ?? setups[0]
  const token = tokenFromCommand(command)

  // 스니펫에는 토큰이 들어 있을 수 있으므로 화면에는 가려서 보이고 원문은 클립보드로만 꺼낸다.
  const copySnippet = async (): Promise<void> => {
    if (!setup) return
    try {
      await navigator.clipboard.writeText(setup.snippet)
    } catch (err) {
      toast.error(t('settings.mcpCopyFailed'), { description: reason(err) })
      return
    }
    toast.success(t('settings.agentSnippetCopied'))
  }

  const installCli = async (): Promise<void> => {
    setInstallingCli(true)
    const status = await run<CliInstallStatus>('agent:installCli', t('settings.agentCliFailed'))
    if (status) {
      setCli(status)
      // 스니펫은 설치된 ftpb를 가리킨다(PATH에 없으면 절대 경로). 설치가 바꿨을 수 있으니 다시 읽는다.
      const fresh = await load<AgentClientSetup[]>('agent:getClientSetups')
      if (fresh) setSetups(fresh)
    }
    setInstallingCli(false)
  }

  const installSkill = async (): Promise<void> => {
    setInstallingSkill(true)
    const result = await run<{ paths: string[] }>(
      'agent:installSkill',
      t('settings.agentSkillFailed')
    )
    if (result) {
      toast.success(t('settings.agentSkillInstalled'), { description: result.paths.join('\n') })
    }
    setInstallingSkill(false)
  }

  const masked = setup ? maskToken(setup.snippet, token) : ''

  return (
    <>
      {policy && (
        <div role="group" aria-labelledby="agent-permissions-title" className="mt-4">
          <h4 id="agent-permissions-title" className={subheading}>
            {t('settings.agentPermissions')}
          </h4>
          <p className={hint}>{t('settings.agentPermissionsHint')}</p>
          <ul className="mt-2 space-y-2">
            {TIERS.map((tier) => (
              <li key={tier} className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <TierBadge tier={tier} />
                  <p className={hint}>{t(`settings.agentTier${tier}`)}</p>
                </div>
                {tier === 'R' ? (
                  <span className="shrink-0 py-1 text-sm text-gray-500">
                    {t('settings.agentAlwaysAllowed')}
                  </span>
                ) : (
                  <select
                    aria-label={tierName(t, tier)}
                    value={policy[tier]}
                    onChange={(e) => void changePolicy(tier, e.target.value as PolicyValue)}
                    className="shrink-0 rounded-md border border-gray-300 px-2 py-1 text-sm text-gray-700 focus:border-blue-500 focus:outline-none"
                  >
                    {POLICY_VALUES.map((value) => (
                      <option key={value} value={value}>
                        {t(
                          value === 'allow'
                            ? 'settings.agentPolicyAllow'
                            : value === 'ask'
                              ? 'settings.agentPolicyAsk'
                              : 'settings.agentPolicyDeny'
                        )}
                      </option>
                    ))}
                  </select>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {enabled && setup && (
        <div role="group" aria-labelledby="agent-connect-title" className="mt-4">
          <h4 id="agent-connect-title" className={subheading}>
            {t('settings.agentConnect')}
          </h4>
          <div className="mt-2 flex items-center justify-between gap-3">
            <label htmlFor="agent-client" className="text-sm text-gray-700">
              {t('settings.agentClient')}
            </label>
            <select
              id="agent-client"
              value={setup.id}
              onChange={(e) => setClientId(e.target.value)}
              className="min-w-0 rounded-md border border-gray-300 px-2 py-1 text-sm text-gray-700 focus:border-blue-500 focus:outline-none"
            >
              {setups.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
          </div>
          <pre
            role="region"
            aria-label={t('settings.agentSnippetFor', { client: setup.title })}
            // 가로로 넘치는 상자를 키보드로도 스크롤할 수 있게 한다.
            tabIndex={0}
            className={codeBox}
          >
            {masked}
          </pre>
          <p className="mt-1 text-xs text-gray-500">{maskToken(setup.notes, token)}</p>
          {masked !== setup.snippet && <p className={hint}>{t('settings.agentTokenHidden')}</p>}
          <div className="mt-2 flex items-center gap-3">
            <button onClick={() => void copySnippet()} className={button}>
              {t('settings.agentCopySnippet')}
            </button>
            <a
              href={setup.docsUrl}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-blue-600 hover:underline"
            >
              {t('settings.agentDocs', { client: setup.title })}
            </a>
          </div>
        </div>
      )}

      {enabled && (
        <div role="group" aria-labelledby="agent-cli-title" className="mt-4">
          <h4 id="agent-cli-title" className={subheading}>
            {t('settings.agentCli')}
          </h4>
          <p className={hint}>{t('settings.agentCliDescription')}</p>
          {cli && (
            <div className="mt-2 flex items-start justify-between gap-3">
              <div className="min-w-0 text-xs">
                <p className={`break-all ${cli.error ? 'text-red-600' : 'text-gray-700'}`}>
                  {cli.error
                    ? t('settings.agentCliError', { reason: cli.error })
                    : cli.installed
                      ? t('settings.agentCliInstalled', { path: cli.path })
                      : t('settings.agentCliNotInstalled')}
                </p>
                {cli.installed && !cli.onPath && cli.pathHint && (
                  <>
                    <p className="mt-1 text-gray-500">{t('settings.agentCliNotOnPath')}</p>
                    <pre className={codeBox}>{cli.pathHint}</pre>
                  </>
                )}
              </div>
              <button onClick={() => void installCli()} disabled={installingCli} className={button}>
                {cli.installed ? t('settings.agentCliReinstall') : t('settings.agentCliInstall')}
              </button>
            </div>
          )}
        </div>
      )}

      {enabled && (
        <div role="group" aria-labelledby="agent-skill-title" className="mt-4">
          <h4 id="agent-skill-title" className={subheading}>
            {t('settings.agentSkill')}
          </h4>
          <div className="flex items-start justify-between gap-3">
            <p className={hint}>{t('settings.agentSkillDescription')}</p>
            <button
              onClick={() => void installSkill()}
              disabled={installingSkill}
              className={button}
            >
              {t('settings.agentSkillInstall')}
            </button>
          </div>
        </div>
      )}
    </>
  )
}
