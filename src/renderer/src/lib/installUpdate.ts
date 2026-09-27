import { t } from '@renderer/i18n'
import { confirmDialog } from '@renderer/stores/useConfirmStore'
import { useOperationStore } from '@renderer/stores/useOperationStore'
import { useTransferStore } from '@renderer/stores/useTransferStore'

/** Restart into the downloaded update, asking first when a transfer or file operation would be cut off. */
export async function installUpdate(): Promise<void> {
  const busy =
    useTransferStore
      .getState()
      .jobs.some((job) => job.status === 'pending' || job.status === 'active') ||
    useOperationStore.getState().jobs.some((job) => job.status === 'active')
  if (
    busy &&
    !(await confirmDialog({
      title: t('update.restartTitle'),
      message: t('update.restartMessage'),
      confirmLabel: t('update.restart'),
      destructive: true
    }))
  ) {
    return
  }
  void window.api.invoke('update:install')
}
