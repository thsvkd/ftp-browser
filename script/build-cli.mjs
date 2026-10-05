/* eslint-disable @typescript-eslint/explicit-function-return-type -- Node and the electron-vite config run this build helper as JavaScript. */

import { chmodSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'

/**
 * Bundles the `ftpb` CLI (src/main/cli/main.ts) into one self-contained CommonJS file,
 * out/cli/ftpb.cjs: every import inlined, only Node built-ins required, so it runs from any folder
 * under system Node ≥ 18 or the app executable with ELECTRON_RUN_AS_NODE=1 (§2.6 L1). A separate
 * build because electron-vite's main entry externalizes `dependencies` and would split modules
 * shared with the main process into chunks.
 */
export async function buildCli({
  root = process.cwd(),
  outDir = path.join(root, 'out', 'cli')
} = {}) {
  const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  await build({
    configFile: false,
    root,
    logLevel: 'warn',
    resolve: { alias: { '@shared': path.join(root, 'src', 'shared') } },
    define: { 'process.env.FTPB_VERSION': JSON.stringify(version) },
    ssr: { noExternal: true, target: 'node' },
    build: {
      ssr: path.join(root, 'src', 'main', 'cli', 'main.ts'),
      outDir,
      emptyOutDir: true,
      target: 'node18',
      minify: false,
      sourcemap: false,
      copyPublicDir: false,
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: 'ftpb.cjs',
          inlineDynamicImports: true,
          banner: '#!/usr/bin/env node'
        }
      }
    }
  })
  // The shebang lets Unix run it directly as ./ftpb.cjs too.
  chmodSync(path.join(outDir, 'ftpb.cjs'), 0o755)
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await buildCli()
}
