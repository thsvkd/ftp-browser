import { useEffect } from 'react'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import type { FtpConnectionState } from '@shared/types/ftp'

/**
 * main이 알리는 연결 상태(`ftp:connectionStatus`)를 `useFtpStore.connections`에 넣는다. 앱에서 한 번
 * (AppShell) 구독한다: 탭이 없어도 사이드바·상태 표시줄이 받고, 탐색 영역이 둘이어도 두 번 받지 않는다.
 */
export function useConnectionStatus(): void {
  useEffect(
    () =>
      window.api.on('ftp:connectionStatus', (...args: unknown[]) =>
        useFtpStore.getState().setConnectionState(args[0] as FtpConnectionState)
      ),
    []
  )
}
