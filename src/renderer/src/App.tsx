import { useEffect } from 'react'
import { Toaster } from 'sonner'
import { useLocale } from '@renderer/i18n'
import { AppShell } from '@renderer/components/layout/AppShell'
import { ConfirmDialog } from '@renderer/components/common/ConfirmDialog'
import { AgentConfirmDialog } from '@renderer/components/agent/AgentConfirmDialog'

function App(): React.JSX.Element {
  const locale = useLocale()
  // lang이 맞아야 한중일 공통 한자가 해당 언어 글꼴로 그려지고, 스크린리더도 올바른 음성을 고른다.
  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  return (
    <>
      <AppShell />
      <ConfirmDialog />
      <AgentConfirmDialog />
      <Toaster position="bottom-right" richColors closeButton />
    </>
  )
}

export default App
