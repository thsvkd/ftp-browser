import { useCallback, useState } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { Toolbar } from './Toolbar'
import { StatusBar } from './StatusBar'
import { RemoteExplorer } from '@renderer/components/remote/RemoteExplorer'
import { LocalExplorer } from '@renderer/components/local/LocalExplorer'
import { TransferPanel } from '@renderer/components/transfer/TransferPanel'
import { OperationPanel } from '@renderer/components/transfer/OperationPanel'
import { ConnectDialog } from '@renderer/components/server/ConnectDialog'
import { SettingsDialog } from '@renderer/components/settings/SettingsDialog'
import { useThumbnailListener } from '@renderer/hooks/useThumbnailListener'
import { useLocalThumbnailListener } from '@renderer/hooks/useLocalThumbnailListener'
import { useUpdateListener } from '@renderer/hooks/useUpdateListener'

export function AppShell(): React.JSX.Element {
  const [connectOpen, setConnectOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const openSettings = useCallback(() => setSettingsOpen(true), [])

  useThumbnailListener()
  useLocalThumbnailListener()
  useUpdateListener(openSettings)

  return (
    <div className="flex h-full flex-col">
      <Toolbar onConnectClick={() => setConnectOpen(true)} onSettingsClick={openSettings} />
      <div className="flex-1 overflow-hidden">
        <Group orientation="horizontal">
          <Panel defaultSize="50%" minSize="25%">
            <LocalExplorer />
          </Panel>
          <Separator className="w-1 bg-gray-200 hover:bg-blue-400 transition-colors" />
          <Panel defaultSize="50%" minSize="25%">
            <RemoteExplorer />
          </Panel>
        </Group>
      </div>
      <OperationPanel />
      <TransferPanel />
      <StatusBar />
      <ConnectDialog open={connectOpen} onClose={() => setConnectOpen(false)} />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  )
}
