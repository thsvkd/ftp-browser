/**
 * CLI flag that turns on every developer tool.
 *
 * Not `--debug`: Electron hands unrecognised leading flags to Node, which
 * rejects `--debug` outright (DEP0062) and exits before the app ever starts.
 */
export const DEVTOOLS_FLAG = '--devtools'

/** Token forwarded to the renderer via webPreferences.additionalArguments. */
export const DEBUG_RENDERER_ARG = '--ftp-browser-debug-tools'

/**
 * Developer tools stay off until the app is launched with `--devtools`.
 *
 * This holds for development builds too. Enabling them implicitly under `npm run
 * dev` made F12 and right-click Inspect appear without anyone asking for them,
 * and it meant the dev build and the shipped build behaved differently — so a
 * flag-related regression could only ever surface after packaging.
 */
export function isDebugEnabled(argv: readonly string[]): boolean {
  return argv.includes(DEVTOOLS_FLAG)
}

/**
 * Extra argv entries handed to the renderer process. The preload script reads
 * them straight off `process.argv`, so the renderer learns about debug mode
 * synchronously without an IPC round trip.
 */
export function debugRendererArgs(debugEnabled: boolean): string[] {
  return debugEnabled ? [DEBUG_RENDERER_ARG] : []
}

/** Counterpart of `debugRendererArgs`, evaluated inside the preload script. */
export function hasDebugRendererArg(argv: readonly string[]): boolean {
  return argv.includes(DEBUG_RENDERER_ARG)
}
