import { useEffect } from 'react'
import { toast } from 'sonner'
import type { UpdateState } from '@shared/types/update'

export function useUpdateListener(openSettings: () => void): void {
  useEffect(
    () =>
      window.api.on('update:stateChanged', (...args: unknown[]) => {
        const state = args[0] as UpdateState
        if (state.status === 'available') {
          toast.message(`Version ${state.availableVersion} is available`, {
            action: { label: 'View', onClick: openSettings }
          })
        } else if (state.status === 'ready') {
          toast.success(`Version ${state.availableVersion} is ready to install`, {
            action: { label: 'View', onClick: openSettings }
          })
        }
      }),
    [openSettings]
  )
}
