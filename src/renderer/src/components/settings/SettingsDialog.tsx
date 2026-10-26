import { useState, useEffect, useCallback } from 'react'
import { useEscapeKey } from '@renderer/hooks/useEscapeKey'
import { X, Copy, Database, RotateCcw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useSettingsStore } from '@renderer/stores/useSettingsStore'
import { useServerStore } from '@renderer/stores/useServerStore'
import { useFileCategoryStore } from '@renderer/stores/useFileCategoryStore'
import { EMPTY_OVERRIDES } from '@renderer/lib/fileCategories'
import { confirmDialog } from '@renderer/stores/useConfirmStore'
import { TILE_MAX, TILE_MIN, TILE_STEP } from '@renderer/lib/explorerLayout'
import { formatBytes } from '@renderer/lib/utils'
import { installUpdate } from '@renderer/lib/installUpdate'
import { LOCALES, useLocale, useT, type LanguageSetting } from '@renderer/i18n'
import { FileCategorySettings } from './FileCategorySettings'
import type { IpcResult } from '@shared/types/ipc'
import type { UpdateState } from '@shared/types/update'
import type { McpState } from '@shared/types/mcp'
import type { PasswordProtection } from '@shared/types/ftp'
import { MAX_CACHE_SIZE_BYTES, type ThemeSetting } from '@shared/constants'

interface SettingsDialogProps {
  open: boolean
  onClose: () => void
}

interface CacheStats {
  totalBytes: number
  totalCount: number
}

export function SettingsDialog({ open, onClose }: SettingsDialogProps): React.JSX.Element | null {
  const tileSize = useSettingsStore((s) => s.tileSize)
  const setTileSize = useSettingsStore((s) => s.setTileSize)
  const viewMode = useSettingsStore((s) => s.viewMode)
  const setViewMode = useSettingsStore((s) => s.setViewMode)
  const showHidden = useSettingsStore((s) => s.showHidden)
  const setShowHidden = useSettingsStore((s) => s.setShowHidden)
  const confirmBeforeDelete = useSettingsStore((s) => s.confirmBeforeDelete)
  const language = useSettingsStore((s) => s.language)
  const setLanguage = useSettingsStore((s) => s.setLanguage)
  const theme = useSettingsStore((s) => s.theme)
  const setTheme = useSettingsStore((s) => s.setTheme)
  const resetSettings = useSettingsStore((s) => s.reset)
  const servers = useServerStore((s) => s.servers)
  const loadServers = useServerStore((s) => s.loadServers)
  const t = useT()
  const locale = useLocale()
  const setConfirmBeforeDelete = useSettingsStore((s) => s.setConfirmBeforeDelete)

  const [cacheStats, setCacheStats] = useState<CacheStats | null>(null)
  const [clearing, setClearing] = useState(false)
  const [updateState, setUpdateState] = useState<UpdateState | null>(null)
  const [mcpState, setMcpState] = useState<McpState | null>(null)
  // 저장된 서버 수는 로드 전에 0개로 단정하지 않는다(함정 C). undefined는 로드 중, false는 실패다.
  const [serversLoaded, setServersLoaded] = useState<boolean>()
  // undefined는 조회 중, null은 조회 실패다.
  const [protection, setProtection] = useState<PasswordProtection['level'] | null>()
  // 톱니 버튼으로 열면 포커스가 창 밖에 남으므로, 포커스와 관계없이 Esc로 닫는다.
  useEscapeKey(onClose, open)

  const fetchCacheStats = useCallback(async () => {
    const result = await window.api.invoke<IpcResult<CacheStats>>('cache:getStats')
    if (result.success) {
      setCacheStats(result.data)
    }
  }, [])

  const fetchUpdateState = useCallback(async () => {
    const result = await window.api.invoke<IpcResult<UpdateState>>('update:getState')
    if (result.success) setUpdateState(result.data)
  }, [])

  const fetchMcpState = useCallback(async () => {
    const result = await window.api.invoke<IpcResult<McpState>>('mcp:getState')
    if (result.success) setMcpState(result.data)
  }, [])

  // 저장된 서버 수를 세기 위해 설정창이 열릴 때마다 다시 부른다(함정 C).
  const refreshServers = useCallback(async () => {
    setServersLoaded(await loadServers())
  }, [loadServers])

  const fetchProtection = useCallback(async () => {
    const result = await window.api.invoke<IpcResult<PasswordProtection>>(
      'ftp:getPasswordProtection'
    )
    setProtection(result.success && result.data ? result.data.level : null)
  }, [])

  useEffect(() => {
    if (!open) return
    void fetchCacheStats()
    void fetchUpdateState()
    void fetchMcpState()
    void refreshServers()
    void fetchProtection()
    return window.api.on('update:stateChanged', (...args: unknown[]) => {
      setUpdateState(args[0] as UpdateState)
    })
  }, [open, fetchCacheStats, fetchUpdateState, fetchMcpState, refreshServers, fetchProtection])

  if (!open) return null

  const handleClearCache = async (): Promise<void> => {
    setClearing(true)
    try {
      await window.api.invoke('cache:clear')
      await fetchCacheStats()
    } finally {
      setClearing(false)
    }
  }

  const runUpdateCommand = async (channel: 'update:check' | 'update:download'): Promise<void> => {
    const result = await window.api.invoke<IpcResult<UpdateState>>(channel)
    if (result.success) setUpdateState(result.data)
  }

  const setAutoUpdate = async (enabled: boolean): Promise<void> => {
    const result = await window.api.invoke<IpcResult<UpdateState>>('update:setAutoUpdate', enabled)
    if (result.success) setUpdateState(result.data)
  }

  const setMcpEnabled = async (enabled: boolean): Promise<void> => {
    try {
      const result = await window.api.invoke<IpcResult<McpState>>('mcp:setEnabled', enabled)
      if (result.success) setMcpState(result.data)
      else toast.error(t('settings.mcpToggleFailed'), { description: result.error })
    } catch (err) {
      toast.error(t('settings.mcpToggleFailed'), {
        description: err instanceof Error ? err.message : String(err)
      })
    }
  }

  // 등록 명령에는 토큰이 들어 있으므로 명령은 화면에 보여 주지 않고 클립보드로만 꺼낸다.
  const copyCommand = async (command: string | undefined, copied: string): Promise<void> => {
    if (!command) return
    try {
      await navigator.clipboard.writeText(command)
    } catch (err) {
      toast.error(t('settings.mcpCopyFailed'), {
        description: err instanceof Error ? err.message : String(err)
      })
      return
    }
    toast.success(copied)
  }

  const regenerateMcpToken = async (): Promise<void> => {
    const result = await window.api.invoke<IpcResult<McpState>>('mcp:regenerateToken')
    if (!result.success) return
    setMcpState(result.data)
    toast.success(t('settings.mcpTokenRegenerated'))
  }

  // 제보에 필요한 조합을 한 줄로 복사한다(S5). 새 IPC 없이 전부 이미 가진 값이다(S4).
  const copyDiagnostics = async (): Promise<void> => {
    const proc = window.electron?.process
    const line = [
      `FTP Browser ${updateState?.currentVersion ?? ''}`,
      proc?.platform ?? '',
      `electron ${proc?.versions.electron ?? ''}`,
      `node ${proc?.versions.node ?? ''}`,
      `locale ${locale}`
    ].join(' · ')
    try {
      await navigator.clipboard.writeText(line)
      toast.success(t('settings.diagnosticsCopied'))
    } catch (err) {
      // 실패해도 조용히 토스트로만 알린다(S5). 새 키를 만들지 않기 위해 사유를 그대로 보여 준다.
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const resetAllSettings = async (): Promise<void> => {
    const confirmed = await confirmDialog({
      title: t('settings.reset'),
      message: t('settings.resetConfirm'),
      confirmLabel: t('settings.reset'),
      destructive: true
    })
    if (!confirmed) return
    resetSettings()
    // 파일 카테고리 편집은 별도 스토어(`ftp-browser-file-categories`)라 따로 되돌린다.
    useFileCategoryStore.setState({ overrides: EMPTY_OVERRIDES })
    toast.success(t('settings.resetDone'))
  }

  const downloadingLabel = (percent = 0): string =>
    t('update.downloading', {
      percent: new Intl.NumberFormat(locale, { style: 'percent' }).format(Math.round(percent) / 100)
    })

  const updateDescription = (): string => {
    if (!updateState) return t('common.loading')
    const version = updateState.availableVersion ?? ''
    switch (updateState.status) {
      case 'unsupported':
        // main의 message는 영어 고정 문장이라 보여 주지 않고 번역 키로 대신한다.
        return t('update.unsupported')
      case 'checking':
        return t('update.checking')
      case 'available':
        return t('update.available', { version })
      case 'downloading':
        return downloadingLabel(updateState.progressPercent)
      case 'ready':
        return t('update.ready', { version })
      case 'up-to-date':
        return t('update.upToDate')
      case 'error':
        return updateState.message
          ? t('update.failedWithReason', { reason: updateState.message })
          : t('update.failed')
      default:
        return t('update.idle')
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-6" onClick={onClose}>
      {/* 머리말·꼬리말은 고정하고 본문만 스크롤한다. 스크롤바가 내용에 붙지 않도록 본문에 좌우 여백을 둔다. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
        className="flex max-h-full w-[680px] max-w-full flex-col overflow-hidden rounded-lg bg-[var(--sf)] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--bd)] px-6">
          <h2 id="settings-dialog-title" className="text-base font-semibold">
            {t('settings.title')}
          </h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-[var(--mu)] hover:bg-[var(--hv)] hover:text-[var(--tx)]"
            aria-label={t('settings.close')}
          >
            <X size={18} />
          </button>
        </header>

        <div className="min-h-0 flex-1 divide-y divide-[var(--bd)] overflow-y-auto px-6 [scrollbar-gutter:stable] [&>section]:py-5">
          <section>
            <label className="flex items-center justify-between gap-6">
              <span className="text-sm text-[var(--tx)]">{t('settings.language')}</span>
              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value as LanguageSetting)}
                className="w-56 rounded-md border border-[var(--bd2)] px-2 py-1.5 text-sm text-[var(--tx)] focus:border-[var(--ac)] focus:outline-none"
              >
                <option value="system">{t('settings.languageSystem')}</option>
                {LOCALES.map((l) => (
                  <option key={l.code} value={l.code} lang={l.code}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="mt-3 flex items-center justify-between gap-6">
              <span className="text-sm text-[var(--tx)]">{t('settings.theme')}</span>
              <select
                value={theme}
                onChange={(e) => setTheme(e.target.value as ThemeSetting)}
                className="w-56 rounded-md border border-[var(--bd2)] px-2 py-1.5 text-sm text-[var(--tx)] focus:border-[var(--ac)] focus:outline-none"
              >
                <option value="system">{t('settings.themeSystem')}</option>
                <option value="light">{t('settings.themeLight')}</option>
                <option value="dark">{t('settings.themeDark')}</option>
              </select>
            </label>
            {/* 새 탭의 기본 보기(D16). 격자 섹션은 크기 전용으로 남는다(S2). */}
            <div className="mt-3 flex items-center justify-between gap-6">
              <span id="settings-view-mode" className="text-sm text-[var(--tx)]">
                {t('settings.viewMode')}
              </span>
              <div
                role="group"
                aria-labelledby="settings-view-mode"
                className="flex w-56 shrink-0 rounded-full bg-[var(--bg)] p-1 text-[12.5px]"
              >
                {(['grid', 'list'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={viewMode === mode}
                    onClick={() => setViewMode(mode)}
                    className={`flex-1 rounded-full px-3 py-1 ${
                      viewMode === mode
                        ? 'bg-[var(--sf)] text-[var(--tx)] shadow'
                        : 'text-[var(--mu)] hover:text-[var(--tx)]'
                    }`}
                  >
                    {mode === 'grid' ? t('settings.viewModeGrid') : t('settings.viewModeList')}
                  </button>
                ))}
              </div>
            </div>
          </section>

          {/* Grid */}
          <section>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--mu)]">
              {t('settings.grid')}
            </h3>
            <div className="flex items-center justify-between gap-6">
              <div className="min-w-0">
                <label htmlFor="thumb-size" className="text-sm text-[var(--tx)]">
                  {t('settings.thumbnailSize')}
                </label>
                <p className="mt-0.5 break-keep text-xs text-[var(--mu)]">
                  {t('settings.zoomTip')}
                </p>
              </div>
              <div className="flex w-48 shrink-0 items-center gap-3">
                <input
                  id="thumb-size"
                  type="range"
                  min={TILE_MIN}
                  max={TILE_MAX}
                  step={TILE_STEP}
                  value={tileSize}
                  onChange={(e) => setTileSize(Number(e.target.value))}
                  className="min-w-0 flex-1 accent-[var(--ac)]"
                />
                <span className="w-12 text-right text-sm tabular-nums text-[var(--mu)]">
                  {tileSize}px
                </span>
              </div>
            </div>
          </section>

          {/* Browsing */}
          <section>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--mu)]">
              {t('settings.browsing')}
            </h3>
            <label className="flex cursor-pointer items-center justify-between py-1">
              <span className="text-sm text-[var(--tx)]">{t('settings.showHidden')}</span>
              <input
                type="checkbox"
                checked={showHidden}
                onChange={(e) => setShowHidden(e.target.checked)}
                className="h-4 w-4 rounded accent-[var(--ac)]"
              />
            </label>
            <label className="flex cursor-pointer items-center justify-between py-1">
              <span className="text-sm text-[var(--tx)]">{t('settings.confirmDelete')}</span>
              <input
                type="checkbox"
                checked={confirmBeforeDelete}
                onChange={(e) => setConfirmBeforeDelete(e.target.checked)}
                className="h-4 w-4 rounded accent-[var(--ac)]"
              />
            </label>
          </section>

          <FileCategorySettings />

          {/* Account & security — 파일 카테고리 다음, 캐시 바로 앞(S1). 보호 경고를 여기로 옮겼다(S6). */}
          <section>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--mu)]">
              {t('settings.account')}
            </h3>
            <p className="text-sm text-[var(--tx)]">
              {serversLoaded === undefined
                ? t('common.loading')
                : serversLoaded
                  ? // loadServers는 success+undefined 응답에서 undefined를 넣을 수 있어 방어한다(함정 C).
                    t('settings.savedServersCount', { count: servers?.length ?? 0 })
                  : '—'}
            </p>
            <div className="mt-2 flex items-center justify-between gap-6 py-1">
              <span className="text-sm text-[var(--tx)]">
                {t('settings.passwordProtectionLevel')}
              </span>
              {/* 약한 보호(basic·none)의 경고 문구를 섹션 안에서 항상 보여 준다(S6). */}
              <span
                className={`text-sm ${
                  protection === 'keyring' || !protection ? 'text-[var(--mu)]' : 'text-[var(--dg)]'
                }`}
              >
                {protection === undefined
                  ? t('common.loading')
                  : protection === null
                    ? '—'
                    : protection === 'keyring'
                      ? t('settings.passwordProtectionStrong')
                      : protection === 'basic'
                        ? t('servers.passwordProtectionBasic')
                        : t('servers.passwordProtectionNone')}
              </span>
            </div>
          </section>

          {/* Cache */}
          <section>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--mu)]">
              {t('settings.cache')}
            </h3>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm text-[var(--tx)]">
                <Database size={14} className="text-[var(--mu)]" />
                <span>
                  {cacheStats
                    ? t('settings.cacheSummary', {
                        count: cacheStats.totalCount,
                        size: formatBytes(cacheStats.totalBytes)
                      })
                    : t('common.loading')}
                </span>
              </div>
              <button
                onClick={handleClearCache}
                disabled={clearing || !cacheStats || cacheStats.totalCount === 0}
                className="flex items-center gap-1.5 rounded-md border border-[var(--bd2)] px-3 py-1.5 text-sm text-[var(--tx)] hover:bg-[var(--hv)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Trash2 size={14} />
                {clearing ? t('settings.clearingCache') : t('settings.clearCache')}
              </button>
            </div>
            <p className="mt-2 text-xs text-[var(--mu)]">
              {t('settings.cacheLimit', { size: formatBytes(MAX_CACHE_SIZE_BYTES) })}
            </p>
          </section>

          {/* Updates */}
          <section>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--mu)]">
              {t('settings.updates')}
            </h3>
            <div className="flex items-center justify-between gap-6">
              <div className="min-w-0">
                <div className="text-sm text-[var(--tx)]">
                  {updateState
                    ? t('update.version', { version: updateState.currentVersion })
                    : t('update.versionUnknown')}
                </div>
                <p className="mt-0.5 text-xs text-[var(--mu)]">{updateDescription()}</p>
              </div>
              {updateState?.status === 'available' ? (
                <button
                  onClick={() => void runUpdateCommand('update:download')}
                  className="shrink-0 rounded-md border border-[var(--bd2)] px-3 py-1.5 text-sm text-[var(--tx)] hover:bg-[var(--hv)]"
                >
                  {t('update.download', { version: updateState.availableVersion ?? '' })}
                </button>
              ) : updateState?.status === 'ready' ? (
                <button
                  onClick={() => void installUpdate()}
                  className="shrink-0 rounded-md bg-[var(--ac)] px-3 py-1.5 text-sm font-medium text-[var(--acx)] hover:brightness-110"
                >
                  {t('update.restartAndUpdate')}
                </button>
              ) : updateState?.status !== 'unsupported' ? (
                <button
                  onClick={() => void runUpdateCommand('update:check')}
                  disabled={
                    !updateState ||
                    updateState.status === 'checking' ||
                    updateState.status === 'downloading'
                  }
                  className="shrink-0 rounded-md border border-[var(--bd2)] px-3 py-1.5 text-sm text-[var(--tx)] hover:bg-[var(--hv)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {updateState?.status === 'checking'
                    ? t('update.checkingButton')
                    : updateState?.status === 'downloading'
                      ? downloadingLabel(updateState.progressPercent)
                      : t('update.check')}
                </button>
              ) : null}
            </div>
            <label className="mt-3 flex cursor-pointer items-center justify-between gap-6 py-1">
              <span className="text-sm text-[var(--tx)]">
                {t('update.auto')}
                <span className="mt-0.5 block text-xs text-[var(--mu)]">
                  {t('update.autoDescription')}
                </span>
              </span>
              <input
                type="checkbox"
                checked={updateState?.autoUpdate ?? false}
                disabled={!updateState || updateState.status === 'unsupported'}
                onChange={(e) => void setAutoUpdate(e.target.checked)}
                className="h-4 w-4 shrink-0 rounded accent-[var(--ac)] disabled:cursor-not-allowed"
              />
            </label>
          </section>

          {/* Agent access (MCP) */}
          <section>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--mu)]">
              {t('settings.mcp')}
            </h3>
            <label className="flex cursor-pointer items-center justify-between gap-6 py-1">
              <span className="text-sm text-[var(--tx)]">
                {t('settings.mcpEnable')}
                <span className="mt-0.5 block text-xs leading-relaxed text-[var(--mu)]">
                  {t('settings.mcpDescription')}
                </span>
              </span>
              <input
                type="checkbox"
                checked={mcpState?.enabled ?? false}
                disabled={!mcpState}
                onChange={(e) => void setMcpEnabled(e.target.checked)}
                className="h-4 w-4 shrink-0 rounded accent-[var(--ac)] disabled:cursor-not-allowed"
              />
            </label>
            {mcpState?.enabled && (
              <div className="mt-3 rounded-md border border-[var(--bd)] bg-[var(--sb)] p-3">
                <p
                  className={`break-all text-xs ${mcpState.error ? 'text-[var(--dg)]' : 'text-[var(--mu)]'}`}
                >
                  {mcpState.error
                    ? t('settings.mcpStartFailed', { reason: mcpState.error })
                    : t('settings.mcpRunning', { url: mcpState.url })}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    onClick={() =>
                      void copyCommand(mcpState.command, t('settings.mcpCommandCopied'))
                    }
                    disabled={!mcpState.command}
                    className="rounded-md border border-[var(--bd2)] bg-[var(--sf)] px-3 py-1.5 text-sm text-[var(--tx)] hover:bg-[var(--hv)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {t('settings.mcpCopyCommand')}
                  </button>
                  <button
                    onClick={() =>
                      void copyCommand(mcpState.cliCommand, t('settings.mcpCliCommandCopied'))
                    }
                    disabled={!mcpState.cliCommand}
                    className="rounded-md border border-[var(--bd2)] bg-[var(--sf)] px-3 py-1.5 text-sm text-[var(--tx)] hover:bg-[var(--hv)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {t('settings.mcpCopyCliCommand')}
                  </button>
                  <button
                    onClick={() => void regenerateMcpToken()}
                    className="rounded-md border border-[var(--bd2)] bg-[var(--sf)] px-3 py-1.5 text-sm text-[var(--tx)] hover:bg-[var(--hv)]"
                  >
                    {t('settings.mcpRegenerateToken')}
                  </button>
                </div>
              </div>
            )}
          </section>

          {/* About — 새 IPC 없이 창에 이미 있는 값으로 만든다(S4). 초기화 버튼도 여기 있다(S7). */}
          <section>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--mu)]">
              {t('settings.about')}
            </h3>
            <dl className="space-y-1 text-sm text-[var(--tx)]">
              <div className="flex items-center justify-between gap-6">
                <dt className="text-[var(--mu)]">{window.electron?.process.platform}</dt>
                <dd>{updateState?.currentVersion ?? t('update.versionUnknown')}</dd>
              </div>
              <div className="flex items-center justify-between gap-6">
                <dt className="text-[var(--mu)]">electron</dt>
                <dd>{window.electron?.process.versions.electron}</dd>
              </div>
              <div className="flex items-center justify-between gap-6">
                <dt className="text-[var(--mu)]">node</dt>
                <dd>{window.electron?.process.versions.node}</dd>
              </div>
            </dl>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                onClick={() => void copyDiagnostics()}
                className="flex items-center gap-1.5 rounded-md border border-[var(--bd2)] px-3 py-1.5 text-sm text-[var(--tx)] hover:bg-[var(--hv)]"
              >
                <Copy size={14} />
                {t('settings.copyDiagnostics')}
              </button>
              <button
                onClick={() => void resetAllSettings()}
                className="flex items-center gap-1.5 rounded-md border border-[var(--bd2)] px-3 py-1.5 text-sm text-[var(--tx)] hover:bg-[var(--hv)]"
              >
                <RotateCcw size={14} />
                {t('settings.reset')}
              </button>
            </div>
          </section>
        </div>

        <footer className="flex h-14 shrink-0 items-center justify-end border-t border-[var(--bd)] bg-[var(--sb)] px-6">
          <button
            onClick={onClose}
            className="rounded-md bg-[var(--ac)] px-4 py-1.5 text-sm font-medium text-[var(--acx)] hover:brightness-110"
          >
            {t('common.done')}
          </button>
        </footer>
      </div>
    </div>
  )
}
