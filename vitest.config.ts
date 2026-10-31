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
    // 기본 5초는 느린 CI 러너에서 모자란다. 같은 테스트가 로컬에서는 SettingsDialog 0.2초, database
    // 4~17ms인데 macOS Intel·Windows 러너에서는 5.2~6.5초, 4.4~6.7초가 걸려 타임아웃으로 실패했고
    // (경쟁 조건이 아니라 jsdom 렌더·SQLite fsync 같은 CPU·디스크 작업이다), 4.6초(accessibility)·
    // 3.5초(Explorer)처럼 아슬아슬한 테스트가 여러 파일에 흩어져 있다. 파일마다 늘리는 것으로는 다음
    // 파일이 또 걸리므로 한 곳에서 넉넉히 둔다. 통과하는 테스트의 속도에는 영향이 없다.
    testTimeout: 15_000,
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
