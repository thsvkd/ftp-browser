/**
 * jest-dom의 커스텀 matcher(`toBeInTheDocument` 등)를 vitest의 expect에 붙인다.
 *
 * node 환경 테스트에도 함께 로드되지만 matcher 등록만 하므로 DOM 없이도 안전하고,
 * 그 테스트들이 matcher를 쓰지 않으면 아무 영향이 없다.
 */
import '@testing-library/jest-dom/vitest'

/**
 * Node 22는 `--localstorage-file` 없이 실행하면 전역 `localStorage` 바인딩을 값이
 * undefined인 채로 노출하고, 이 바인딩이 jsdom의 `window.localStorage`까지 가린다.
 * `useSettingsStore`의 persist 미들웨어는 모듈 평가 시점에 저장소를 클로저로 붙잡으므로
 * 스토어가 import되기 전(=setupFiles)에 심어야 한다. 나중에 심으면 이미 undefined를
 * 붙잡은 뒤라 `setState`가 `storage.setItem` 접근에서 터진다.
 *
 * node 환경 테스트는 `window`가 없어 이 블록을 건너뛴다.
 */
if (typeof window !== 'undefined' && !globalThis.localStorage) {
  const entries = new Map<string, string>()
  const memoryStorage: Storage = {
    get length() {
      return entries.size
    },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()][index] ?? null,
    removeItem: (key) => {
      entries.delete(key)
    },
    setItem: (key, value) => {
      entries.set(key, String(value))
    }
  }
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: memoryStorage
  })
}
