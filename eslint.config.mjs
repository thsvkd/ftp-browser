import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

export default defineConfig(
  // .stryker-tmp는 stryker가 뮤테이션마다 소스를 통째로 복사해 두는 샌드박스다.
  // .gitignore에는 있지만 flat config는 gitignore를 읽지 않아 `eslint .`이 사본까지
  // 훑고, 중단된 실행이 남긴 잔여 샌드박스가 있으면 수백 건의 거짓 오류가 난다.
  { ignores: ['**/node_modules', '**/dist', '**/out', '**/.stryker-tmp'] },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules
    }
  },
  eslintConfigPrettier
)
