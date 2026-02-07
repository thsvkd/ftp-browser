import { useEffect } from 'react'
import { useThumbnailStore } from '@renderer/stores/useThumbnailStore'

interface ThumbnailReadyEvent {
  cacheKey: string
  dataUrl: string
  width: number
  height: number
  fromCache: boolean
}

interface ThumbnailErrorEvent {
  cacheKey: string
  error: string
}

export function useThumbnailListener(): void {
  useEffect(() => {
    const unsubReady = window.api.on('thumbnail:ready', (...args: unknown[]) => {
      const event = args[0] as ThumbnailReadyEvent
      useThumbnailStore.getState().setThumbnail(event.cacheKey, {
        dataUrl: event.dataUrl,
        width: event.width,
        height: event.height
      })
    })

    const unsubError = window.api.on('thumbnail:error', (...args: unknown[]) => {
      const event = args[0] as ThumbnailErrorEvent
      useThumbnailStore.getState().setError(event.cacheKey, event.error)
    })

    return () => {
      unsubReady()
      unsubError()
    }
  }, [])
}
