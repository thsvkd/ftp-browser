import { useEffect } from 'react'
import { useLocalThumbnailStore } from '@renderer/stores/useLocalThumbnailStore'
import type { LocalThumbnailResult } from '@shared/types/gallery'

interface LocalThumbnailErrorEvent {
  cacheKey: string
  error: string
}

export function useLocalThumbnailListener(): void {
  useEffect(() => {
    const unsubReady = window.api.on('localThumbnail:ready', (...args: unknown[]) => {
      const event = args[0] as LocalThumbnailResult
      useLocalThumbnailStore.getState().setThumbnail(event.cacheKey, {
        dataUrl: event.dataUrl,
        width: event.width,
        height: event.height
      })
    })

    const unsubError = window.api.on('localThumbnail:error', (...args: unknown[]) => {
      const event = args[0] as LocalThumbnailErrorEvent
      useLocalThumbnailStore.getState().setError(event.cacheKey, event.error)
    })

    return () => {
      unsubReady()
      unsubError()
    }
  }, [])
}
