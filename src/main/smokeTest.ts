export const PACKAGED_SMOKE_TEST_FLAG = '--smoke-test'
export const PACKAGED_SMOKE_USER_DATA_ENV = 'FTP_BROWSER_SMOKE_USER_DATA'

type DidFailLoadListener = (
  event: unknown,
  errorCode: number,
  errorDescription: string,
  validatedURL: string,
  isMainFrame: boolean
) => void

const RENDERER_MOUNT_CHECK = `new Promise((resolve) => {
  const deadline = Date.now() + 5000
  const check = () => {
    if (document.getElementById('root')?.childElementCount) resolve(true)
    else if (Date.now() >= deadline) resolve(false)
    else setTimeout(check, 50)
  }
  check()
})`

export interface SmokeWebContents {
  once(event: 'did-finish-load', listener: () => void): unknown
  on(event: 'did-fail-load', listener: DidFailLoadListener): unknown
  removeListener(event: 'did-finish-load', listener: () => void): unknown
  removeListener(event: 'did-fail-load', listener: DidFailLoadListener): unknown
  executeJavaScript(script: string): Promise<unknown>
}

export interface PackagedSmokeRuntime {
  exit(code: number): void
  log(message: string): void
  error(message: string): void
  setTimeout(handler: () => void, timeoutMs: number): ReturnType<typeof setTimeout>
  clearTimeout(handle: ReturnType<typeof setTimeout>): void
}

export function isPackagedSmokeTest(argv: readonly string[], isPackaged: boolean): boolean {
  return isPackaged && argv.includes(PACKAGED_SMOKE_TEST_FLAG)
}

export function startPackagedSmokeTest(
  webContents: SmokeWebContents,
  runtime: PackagedSmokeRuntime,
  timeoutMs = 20_000
): () => void {
  let completed = false

  function cleanup(): void {
    runtime.clearTimeout(timeout)
    webContents.removeListener('did-finish-load', onRendererReady)
    webContents.removeListener('did-fail-load', onRendererLoadFailed)
  }

  function complete(code: 0 | 1, message: string): void {
    if (completed) return
    completed = true
    cleanup()
    if (code === 0) runtime.log(message)
    else runtime.error(message)
    runtime.exit(code)
  }

  function onRendererReady(): void {
    void webContents
      .executeJavaScript(RENDERER_MOUNT_CHECK)
      .then((rendererMounted) => {
        if (rendererMounted === true) {
          complete(0, '[smoke] renderer ready')
        } else {
          complete(1, '[smoke] renderer root is empty')
        }
      })
      .catch((error: unknown) => {
        complete(1, `[smoke] renderer verification failed: ${String(error)}`)
      })
  }

  function onRendererLoadFailed(
    _event: unknown,
    errorCode: number,
    errorDescription: string,
    validatedURL: string,
    isMainFrame: boolean
  ): void {
    if (!isMainFrame) return
    complete(1, `[smoke] renderer load failed: ${errorDescription} (${errorCode}): ${validatedURL}`)
  }

  const timeout = runtime.setTimeout(
    () => complete(1, `[smoke] renderer readiness timed out after ${timeoutMs}ms`),
    timeoutMs
  )
  webContents.once('did-finish-load', onRendererReady)
  webContents.on('did-fail-load', onRendererLoadFailed)

  return () => {
    if (completed) return
    completed = true
    cleanup()
  }
}
