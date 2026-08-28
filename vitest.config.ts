import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  // JSX 변환용.
  plugins: [react()],
  test: {
    globals: true,
    // 기본은 node. 렌더러 컴포넌트 테스트만 파일 상단 `@vitest-environment jsdom`
    // docblock으로 전환한다. 전역을 jsdom으로 바꾸면 fs·electron을 다루는 기존
    // main 프로세스 테스트가 불필요하게 DOM 환경에서 돌아간다.
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'script/**/*.test.mjs'],
    exclude: ['node_modules', 'out', 'dist'],
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/main/**/*.ts', 'src/shared/**/*.ts'],
      exclude: ['src/main/index.ts', 'src/main/ipc/**']
    }
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer/src')
    }
  }
})
