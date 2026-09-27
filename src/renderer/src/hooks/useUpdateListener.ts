import { useEffect } from 'react'
import { toast } from 'sonner'
import { getLocale, t } from '@renderer/i18n'
import { installUpdate } from '@renderer/lib/installUpdate'
import type { UpdateState } from '@shared/types/update'

/** One toast slot: available → downloading → ready replace each other in place. */
const TOAST_ID = 'app-update'

const downloadingText = (percent: number): string =>
  t('update.downloading', {
    percent: new Intl.NumberFormat(getLocale(), { style: 'percent' }).format(
      Math.round(percent) / 100
    )
  })

export function useUpdateListener(): void {
  useEffect(() => {
    // 주기 확인(checking → available)이나 설정 변경으로 같은 소식이 다시 와도 한 번만 알린다.
    let announced = ''
    // 사용자가 알림에서 다운로드를 시작했을 때만 진행률·오류를 같은 알림에 이어서 보여 준다.
    let downloadingFromToast = false
    // 업데이트 알림은 저절로 사라지지 않고, 닫기(X)를 눌러야만 사라진다.
    const sticky = { id: TOAST_ID, duration: Infinity }
    // 같은 id로 바꿔 그리면 sonner가 이전 옵션을 합치므로, 진행 중·오류 알림에서는 버튼을 명시적으로 뺀다.
    const progress = { ...sticky, action: undefined }

    return window.api.on('update:stateChanged', (...args: unknown[]) => {
      const state = args[0] as UpdateState
      const version = state.availableVersion ?? ''

      if (downloadingFromToast && state.status === 'downloading') {
        toast.loading(downloadingText(state.progressPercent ?? 0), progress)
        return
      }
      if (downloadingFromToast && state.status === 'error') {
        downloadingFromToast = false
        toast.error(t('update.failed'), { ...progress, description: state.message })
        return
      }

      // 자동 업데이트가 켜져 있으면 'available'은 곧바로 다운로드로 이어지므로 알릴 필요가 없다.
      const announce =
        (state.status === 'available' && !state.autoUpdate) || state.status === 'ready'
      const key = `${state.status}:${version}`
      if (!announce || key === announced) return
      announced = key

      if (state.status === 'available') {
        toast.message(t('update.toastAvailable', { version }), {
          ...sticky,
          action: {
            label: t('update.update'),
            onClick: (event) => {
              // 알림을 닫지 않고 같은 자리에서 다운로드 진행률로 바꾼다.
              event.preventDefault()
              downloadingFromToast = true
              toast.loading(downloadingText(0), progress)
              void window.api.invoke('update:download')
            }
          }
        })
      } else {
        downloadingFromToast = false
        toast.success(t('update.toastReady', { version }), {
          ...sticky,
          action: {
            label: t('update.update'),
            onClick: (event) => {
              // 확인창에서 취소하면 알림이 그대로 남아야 한다.
              event.preventDefault()
              void installUpdate()
            }
          }
        })
      }
    })
  }, [])
}
