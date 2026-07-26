/**
 * CLI flag that turns on every developer tool in a packaged build.
 *
 * Not `--debug`: Electron hands unrecognised leading flags to Node, which
 * rejects `--debug` outright (DEP0062) and exits before the app ever starts.
 */
export const DEVTOOLS_FLAG = '--devtools'

/** Token forwarded to the renderer via webPreferences.additionalArguments. */
export const DEBUG_RENDERER_ARG = '--ftp-browser-debug-tools'

/**
 * Developer tools are always available while developing; a packaged build has
 * to opt in with `--devtools` so shipped apps stay closed by default.
 */
export function isDebugEnabled(argv: readonly string[], isPackaged: boolean): boolean {
  if (!isPackaged) return true
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
