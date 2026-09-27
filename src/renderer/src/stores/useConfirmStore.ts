import { create } from 'zustand'
import { useSettingsStore } from '@renderer/stores/useSettingsStore'
import { t } from '@renderer/i18n'

export interface ConfirmRequest {
  title: string
  message?: string
  confirmLabel: string
  destructive?: boolean
  resolve: (confirmed: boolean) => void
}

export const useConfirmStore = create<{ request: ConfirmRequest | null }>(() => ({
  request: null
}))

/** In-app replacement for `window.confirm`: resolves true only when the user confirms. */
export function confirmDialog(options: Omit<ConfirmRequest, 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => {
    // 한 번에 하나만 띄운다. 앞선 요청은 취소로 끝낸다.
    useConfirmStore.getState().request?.resolve(false)
    useConfirmStore.setState({ request: { ...options, resolve } })
  })
}

/** Delete confirmation shared by both panels. Skips the dialog when the setting is off. */
export async function confirmDelete(
  items: ReadonlyArray<{ name: string; type: string }>
): Promise<boolean> {
  if (!useSettingsStore.getState().confirmBeforeDelete) return true
  return confirmDialog({
    // 한 항목일 때 이름을 보이는 문구는 별도 키다. ko·ja·zh는 1도 'other'로 골라 _one이 쓰이지 않는다.
    title:
      items.length === 1
        ? t('delete.confirmTitleNamed', { name: items[0].name })
        : t('delete.confirmTitle', { count: items.length }),
    message: items.some((item) => item.type === 'directory')
      ? t('delete.folderWarning')
      : undefined,
    confirmLabel: t('common.delete'),
    destructive: true
  })
}
