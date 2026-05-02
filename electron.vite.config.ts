import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react()],
    server: {
      // Hyper-V/WSL2가 5173 같은 흔한 dev 포트를 동적으로 예약해
      // EACCES(::1:port) 바인딩 실패가 발생하므로, IANA unassigned 영역의
      // 거의 사용되지 않는 포트로 고정한다. strictPort로 폴백도 차단.
      port: 31415,
      strictPort: true
    }
  }
})
