import { useState, useEffect, useCallback } from 'react'
import { useEscapeKey } from '@renderer/hooks/useEscapeKey'
import { X, Database, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  useSettingsStore,
  GALLERY_THUMB_MIN,
  GALLERY_THUMB_MAX
} from '@renderer/stores/useSettingsStore'
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
  const galleryThumbSize = useSettingsStore((s) => s.galleryThumbSize)
  const setGalleryThumbSize = useSettingsStore((s) => s.setGalleryThumbSize)
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
    const result = await window.api.invoke<IpcResult<McpState>>('mcp:setEnabled', enabled)
    if (result.success) setMcpState(result.data)
  }

  // 명령에 토큰이 들어 있으므로 화면에 보여 주지 않고 클립보드로만 꺼낸다.
  const copyMcpCommand = async (): Promise<void> => {
    if (!mcpState?.command) return
    await navigator.clipboard.writeText(mcpState.command)
    toast.success(t('settings.mcpCommandCopied'))
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
        className="w-[480px] rounded-lg bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 id="settings-dialog-title" className="text-lg font-semibold">
            {t('settings.title')}
          </h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            aria-label={t('settings.close')}
          >
            <X size={18} />
          </button>
        </div>

        <div className="max-h-[calc(100vh_-_12rem)] space-y-6 overflow-y-auto">
          <section>
            <label className="flex items-center justify-between">
              <span className="text-sm text-gray-700">{t('settings.language')}</span>
              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value as LanguageSetting)}
                className="rounded-md border border-gray-300 px-2 py-1 text-sm text-gray-700 focus:border-blue-500 focus:outline-none"
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

          {/* Gallery */}
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">
              {t('settings.gallery')}
            </h3>
            <div className="flex items-center justify-between">
              <label htmlFor="thumb-size" className="text-sm text-gray-700">
                {t('settings.thumbnailSize')}
              </label>
              <span className="text-sm tabular-nums text-gray-500">{galleryThumbSize}px</span>
            </div>
            <input
              id="thumb-size"
              type="range"
              min={GALLERY_THUMB_MIN}
              max={GALLERY_THUMB_MAX}
              value={galleryThumbSize}
              onChange={(e) => setGalleryThumbSize(Number(e.target.value))}
              className="mt-2 w-full accent-blue-600"
            />
            <p className="mt-1 text-xs text-gray-400">{t('settings.zoomTip')}</p>
          </section>

          {/* Browsing */}
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">
              {t('settings.browsing')}
            </h3>
            <label className="flex cursor-pointer items-center justify-between py-1">
              <span className="text-sm text-gray-700">{t('settings.showHidden')}</span>
              <input
                type="checkbox"
                checked={showHidden}
                onChange={(e) => setShowHidden(e.target.checked)}
                className="h-4 w-4 rounded accent-blue-600"
              />
            </label>
            <label className="flex cursor-pointer items-center justify-between py-1">
              <span className="text-sm text-gray-700">{t('settings.confirmDelete')}</span>
              <input
                type="checkbox"
                checked={confirmBeforeDelete}
                onChange={(e) => setConfirmBeforeDelete(e.target.checked)}
                className="h-4 w-4 rounded accent-blue-600"
              />
            </label>
          </section>

          {/* Cache */}
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">
              {t('settings.cache')}
            </h3>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm text-gray-700">
                <Database size={14} className="text-gray-400" />
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
                className="flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Trash2 size={14} />
                {clearing ? t('settings.clearingCache') : t('settings.clearCache')}
              </button>
            </div>
          </section>

          {/* Updates */}
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">
              {t('settings.updates')}
            </h3>
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="text-sm text-gray-700">
                  {updateState
                    ? t('update.version', { version: updateState.currentVersion })
                    : t('update.versionUnknown')}
                </div>
                <p className="mt-0.5 text-xs text-gray-400">{updateDescription()}</p>
              </div>
              {updateState?.status === 'available' ? (
                <button
                  onClick={() => void runUpdateCommand('update:download')}
                  className="shrink-0 rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
                >
                  {t('update.download', { version: updateState.availableVersion ?? '' })}
                </button>
              ) : updateState?.status === 'ready' ? (
                <button
                  onClick={() => void installUpdate()}
                  className="shrink-0 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
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
                  className="shrink-0 rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {updateState?.status === 'checking'
                    ? t('update.checkingButton')
                    : updateState?.status === 'downloading'
                      ? downloadingLabel(updateState.progressPercent)
                      : t('update.check')}
                </button>
              ) : null}
            </div>
            <label className="mt-2 flex cursor-pointer items-center justify-between py-1">
              <span className="text-sm text-gray-700">
                {t('update.auto')}
                <span className="block text-xs text-gray-400">{t('update.autoDescription')}</span>
              </span>
              <input
                type="checkbox"
                checked={updateState?.autoUpdate ?? false}
                disabled={!updateState || updateState.status === 'unsupported'}
                onChange={(e) => void setAutoUpdate(e.target.checked)}
                className="h-4 w-4 shrink-0 rounded accent-blue-600 disabled:cursor-not-allowed"
              />
            </label>
          </section>

          {/* Agent access (MCP) */}
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">
              {t('settings.mcp')}
            </h3>
            <label className="flex cursor-pointer items-center justify-between gap-4 py-1">
              <span className="text-sm text-gray-700">
                {t('settings.mcpEnable')}
                <span className="block text-xs text-gray-400">{t('settings.mcpDescription')}</span>
              </span>
              <input
                type="checkbox"
                checked={mcpState?.enabled ?? false}
                disabled={!mcpState}
                onChange={(e) => void setMcpEnabled(e.target.checked)}
                className="h-4 w-4 shrink-0 rounded accent-blue-600 disabled:cursor-not-allowed"
              />
            </label>
            {mcpState?.enabled && (
              <>
                <p
                  className={`mt-1 break-all text-xs ${mcpState.error ? 'text-red-600' : 'text-gray-400'}`}
                >
                  {mcpState.error
                    ? t('settings.mcpStartFailed', { reason: mcpState.error })
                    : t('settings.mcpRunning', { url: mcpState.url })}
                </p>
                <div className="mt-2 flex gap-2">
                  <button
                    onClick={() => void copyMcpCommand()}
                    disabled={!mcpState.command}
                    className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {t('settings.mcpCopyCommand')}
                  </button>
                  <button
                    onClick={() => void regenerateMcpToken()}
                    className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
                  >
                    {t('settings.mcpRegenerateToken')}
                  </button>
                </div>
              </>
            )}
          </section>
        </div>

        <div className="mt-6 flex justify-end">
          <button
            onClick={onClose}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            {t('common.done')}
          </button>
        </div>
      </div>
    </div>
  )
}
