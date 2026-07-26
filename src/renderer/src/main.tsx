import './styles/globals.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { shouldDeferToNativeContextMenu } from './lib/debugTools'

// Electron에서 파일 드롭 시 해당 파일로 네비게이션하는 기본 동작 방지
document.addEventListener('dragover', (e) => e.preventDefault())
document.addEventListener('drop', (e) => e.preventDefault())

// 네이티브 컨텍스트 메뉴는 디버그 모드의 Shift+우클릭에만 넘긴다. 그 외에는 차단해
// 기존 동작(앱 자체 메뉴 또는 아무 메뉴 없음)을 그대로 유지한다.
document.addEventListener('contextmenu', (e) => {
  if (!shouldDeferToNativeContextMenu(e, window.api?.debugToolsEnabled ?? false)) {
    e.preventDefault()
  }
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
