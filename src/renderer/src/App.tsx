import { Toaster } from 'sonner'
import { AppShell } from '@renderer/components/layout/AppShell'

function App(): React.JSX.Element {
  return (
    <>
      <AppShell />
      <Toaster position="bottom-right" richColors closeButton />
    </>
  )
}

export default App
