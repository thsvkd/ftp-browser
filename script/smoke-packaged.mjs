/* eslint-disable @typescript-eslint/explicit-function-return-type -- Node executes this CI entrypoint as JavaScript. */

import { spawn } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const SMOKE_TEST_FLAG = '--smoke-test'
const SMOKE_USER_DATA_ENV = 'FTP_BROWSER_SMOKE_USER_DATA'
const SMOKE_TIMEOUT_MS = 30_000
const TERMINATION_TIMEOUT_MS = 5_000

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await collectFiles(entryPath)))
    else if (entry.isFile()) files.push(entryPath)
  }

  return files
}

function isPackagedExecutable(filePath) {
  const normalized = filePath.replaceAll(path.sep, '/')

  if (process.platform === 'win32') {
    return /\/win(?:-[^/]+)?-unpacked\/ftp-browser\.exe$/i.test(normalized)
  }
  if (process.platform === 'darwin') {
    return /\/FTP Browser\.app\/Contents\/MacOS\/FTP Browser$/.test(normalized)
  }
  if (process.platform === 'linux') {
    return /\/linux(?:-[^/]+)?-unpacked\/ftp-browser$/.test(normalized)
  }
  return false
}

async function findPackagedExecutable(distDirectory) {
  const candidates = (await collectFiles(distDirectory)).filter(isPackagedExecutable)
  if (candidates.length !== 1) {
    throw new Error(
      `Expected exactly one packaged executable for ${process.platform}/${process.arch}, found ${candidates.length}: ${candidates.join(', ')}`
    )
  }
  return candidates[0]
}

function runBoundedCommand(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const commandProcess = spawn(command, args, {
      stdio: 'ignore',
      windowsHide: true
    })
    let settled = false

    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      commandProcess.removeAllListeners()
      if (error) reject(error)
      else resolve()
    }

    const timeout = setTimeout(() => {
      commandProcess.kill('SIGKILL')
      commandProcess.unref()
      finish(new Error(`${command} did not finish within ${timeoutMs}ms`))
    }, timeoutMs)

    commandProcess.once('error', finish)
    commandProcess.once('close', (code, signal) => {
      if (code === 0) finish()
      else
        finish(
          new Error(`${command} exited with code ${String(code)} and signal ${String(signal)}`)
        )
    })
  })
}

export async function terminateProcessTree(
  child,
  platform = process.platform,
  runCommand = runBoundedCommand
) {
  if (typeof child.pid !== 'number') {
    if (!child.kill('SIGKILL')) throw new Error('Smoke process has no PID and could not be killed')
    return
  }

  if (platform === 'win32') {
    try {
      await runCommand('taskkill', ['/pid', String(child.pid), '/T', '/F'], TERMINATION_TIMEOUT_MS)
    } catch (taskkillError) {
      const directKillSucceeded = child.kill('SIGKILL')
      throw new Error(
        `Windows process-tree termination failed${directKillSucceeded ? '; direct child kill was used as fallback' : ''}`,
        { cause: taskkillError }
      )
    }
    return
  }

  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch (groupKillError) {
    if (
      groupKillError instanceof Error &&
      'code' in groupKillError &&
      groupKillError.code === 'ESRCH'
    ) {
      return
    }
    const directKillSucceeded = child.kill('SIGKILL')
    throw new Error(
      `POSIX process-group termination failed${directKillSucceeded ? '; direct child kill was used as fallback' : ''}`,
      { cause: groupKillError }
    )
  }
}

function detachChild(child) {
  child.stdin?.destroy()
  child.stdout?.destroy()
  child.stderr?.destroy()
  child.unref()
}

function describeProcessExit(code, signal) {
  return `Packaged app exited with code ${String(code)} and signal ${String(signal)}`
}

export async function runSmokeProcess(
  executable,
  userDataPath,
  {
    timeoutMs = SMOKE_TIMEOUT_MS,
    platform = process.platform,
    spawnProcess = spawn,
    terminateTree = terminateProcessTree,
    signalSource = process
  } = {}
) {
  const smokeArgs = platform === 'linux' ? [SMOKE_TEST_FLAG, '--no-sandbox'] : [SMOKE_TEST_FLAG]
  const child = spawnProcess(executable, smokeArgs, {
    detached: platform !== 'win32',
    env: {
      ...process.env,
      [SMOKE_USER_DATA_ENV]: userDataPath,
      ELECTRON_ENABLE_LOGGING: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })

  child.stdout?.on('data', (chunk) => process.stdout.write(chunk))
  child.stderr?.on('data', (chunk) => process.stderr.write(chunk))

  let resolveChildOutcome
  const onChildError = (error) => resolveChildOutcome({ kind: 'spawn-error', error })
  const onChildClose = (code, signal) => resolveChildOutcome({ kind: 'close', code, signal })
  const childOutcome = new Promise((resolve) => {
    resolveChildOutcome = resolve
    child.once('error', onChildError)
    child.once('close', onChildClose)
  })

  let timeout
  const timeoutOutcome = new Promise((resolve) => {
    timeout = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs)
  })

  let resolveSignalOutcome
  const onSigint = () => resolveSignalOutcome({ kind: 'signal', signal: 'SIGINT' })
  const onSigterm = () => resolveSignalOutcome({ kind: 'signal', signal: 'SIGTERM' })
  const signalOutcome = new Promise((resolve) => {
    resolveSignalOutcome = resolve
    signalSource.once('SIGINT', onSigint)
    signalSource.once('SIGTERM', onSigterm)
  })

  const outcome = await Promise.race([childOutcome, timeoutOutcome, signalOutcome])

  if (timeout !== undefined) clearTimeout(timeout)
  signalSource.removeListener('SIGINT', onSigint)
  signalSource.removeListener('SIGTERM', onSigterm)

  if (outcome.kind === 'close') {
    if (outcome.code === 0) return
    throw new Error(describeProcessExit(outcome.code, outcome.signal))
  }
  if (outcome.kind === 'spawn-error') throw outcome.error

  const primaryError =
    outcome.kind === 'timeout'
      ? new Error(`Packaged app smoke test timed out after ${timeoutMs}ms`)
      : new Error(`Packaged app smoke test cancelled by ${outcome.signal}`)
  let terminationError

  try {
    await terminateTree(child, platform)
  } catch (error) {
    terminationError = error
  } finally {
    detachChild(child)
  }

  if (terminationError) {
    throw new AggregateError(
      [primaryError, terminationError],
      `${primaryError.message}; process-tree cleanup also failed: ${terminationError instanceof Error ? terminationError.message : String(terminationError)}`
    )
  }
  throw primaryError
}

export async function runWithCleanup(operation, cleanup) {
  let result
  let primaryError

  try {
    result = await operation()
  } catch (error) {
    primaryError = error
  }

  try {
    await cleanup()
  } catch (cleanupError) {
    if (primaryError) {
      const primaryMessage =
        primaryError instanceof Error ? primaryError.message : String(primaryError)
      const cleanupMessage =
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      throw new AggregateError(
        [primaryError, cleanupError],
        `${primaryMessage}; temporary user-data cleanup also failed: ${cleanupMessage}`
      )
    }
    throw cleanupError
  }

  if (primaryError) throw primaryError
  return result
}

async function main() {
  const distDirectory = path.resolve('dist')
  const userDataPath = await mkdtemp(path.join(tmpdir(), 'ftp-browser-smoke-'))

  await runWithCleanup(
    async () => {
      const executable = await findPackagedExecutable(distDirectory)
      console.log(`[smoke] launching ${executable}`)
      await runSmokeProcess(executable, userDataPath)
      console.log('[smoke] packaged app passed')
    },
    () => rm(userDataPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  )
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isEntrypoint) {
  main().catch((error) => {
    console.error(
      `[smoke] packaged app failed: ${error instanceof Error ? error.message : String(error)}`
    )
    process.exitCode = 1
  })
}
