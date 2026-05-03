import { useState } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { Toolbar } from './Toolbar'
import { StatusBar } from './StatusBar'
import { RemoteExplorer } from '@renderer/components/remote/RemoteExplorer'
import { LocalExplorer } from '@renderer/components/local/LocalExplorer'
import { TransferPanel } from '@renderer/components/transfer/TransferPanel'
import { ConnectDialog } from '@renderer/components/server/ConnectDialog'
import { useThumbnailListener } from '@renderer/hooks/useThumbnailListener'
import { useLocalThumbnailListener } from '@renderer/hooks/useLocalThumbnailListener'

export function AppShell(): React.JSX.Element {
  const [connectOpen, setConnectOpen] = useState(false)

  useThumbnailListener()
  useLocalThumbnailListener()

  return (
    <div className="flex h-full flex-col">
      <Toolbar onConnectClick={() => setConnectOpen(true)} />
      <div className="flex-1 overflow-hidden">
        <PanelGroup direction="horizontal">
          <Panel defaultSize={50} minSize={25}>
            <LocalExplorer />
          </Panel>
          <PanelResizeHandle className="w-1 bg-gray-200 hover:bg-blue-400 transition-colors" />
          <Panel defaultSize={50} minSize={25}>
            <RemoteExplorer />
          </Panel>
        </PanelGroup>
      </div>
      <TransferPanel />
      <StatusBar />
      <ConnectDialog open={connectOpen} onClose={() => setConnectOpen(false)} />
    </div>
  )
}
