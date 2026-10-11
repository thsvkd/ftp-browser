import { useState, useEffect, useCallback } from 'react'
import { useEscapeKey } from '@renderer/hooks/useEscapeKey'
import { X, Database, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useSettingsStore } from '@renderer/stores/useSettingsStore'
import { TILE_MAX, TILE_MIN, TILE_STEP } from '@renderer/lib/explorerLayout'
import { formatBytes } from '@renderer/lib/utils'
import { installUpdate } from '@renderer/lib/installUpdate'
import { LOCALES, useLocale, useT, type LanguageSetting } from '@renderer/i18n'
import type { IpcResult } from '@shared/types/ipc'
import type { UpdateState } from '@shared/types/update'
import type { McpState } from '@shared/types/mcp'

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
  const showHidden = useSettingsStore((s) => s.showHidden)
  const setShowHidden = useSettingsStore((s) => s.setShowHidden)
  const confirmBeforeDelete = useSettingsStore((s) => s.confirmBeforeDelete)
  const language = useSettingsStore((s) => s.language)
  const setLanguage = useSettingsStore((s) => s.setLanguage)
  const t = useT()
  const locale = useLocale()
  const setConfirmBeforeDelete = useSettingsStore((s) => s.setConfirmBeforeDelete)

  const [cacheStats, setCacheStats] = useState<CacheStats | null>(null)
  const [clearing, setClearing] = useState(false)
  const [updateState, setUpdateState] = useState<UpdateState | null>(null)
  const [mcpState, setMcpState] = useState<McpState | null>(null)
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

  useEffect(() => {
    if (!open) return
    void fetchCacheStats()
    void fetchUpdateState()
    void fetchMcpState()
    return window.api.on('update:stateChanged', (...args: unknown[]) => {
      setUpdateState(args[0] as UpdateState)
    })
  }, [open, fetchCacheStats, fetchUpdateState, fetchMcpState])

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
