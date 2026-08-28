/* eslint-disable @typescript-eslint/explicit-function-return-type -- Vitest executes this JavaScript harness directly. */

import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runSmokeProcess, runWithCleanup, terminateProcessTree } from './smoke-packaged.mjs'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function createFakeChild() {
  const child = new EventEmitter()
  child.pid = 12345
  child.stdin = { destroy: vi.fn() }
  child.stdout = Object.assign(new EventEmitter(), { destroy: vi.fn() })
  child.stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() })
  child.kill = vi.fn(() => true)
  child.unref = vi.fn()
  return child
}

function startFakeSmoke({
  terminateTree = vi.fn().mockResolvedValue(),
  timeoutMs = 25,
  platform = 'linux'
} = {}) {
  const child = createFakeChild()
  const signalSource = new EventEmitter()
  const spawnProcess = vi.fn(() => child)
  const promise = runSmokeProcess('/fake/app', '/fake/user-data', {
    timeoutMs,
    platform,
    spawnProcess,
    terminateTree,
    signalSource
  })
  return { child, promise, signalSource, spawnProcess, terminateTree }
}

describe('packaged smoke process lifecycle', () => {
  it('should disable the Chromium sandbox for the Linux CI smoke process', async () => {
    const harness = startFakeSmoke()
    harness.child.emit('close', 0, null)

    await harness.promise
    expect(harness.spawnProcess).toHaveBeenCalledWith(
      '/fake/app',
      ['--smoke-test', '--no-sandbox'],
      expect.any(Object)
    )
  })

  it.each(['darwin', 'win32'])(
    'should keep the Chromium sandbox enabled on %s',
    async (platform) => {
      const harness = startFakeSmoke({ platform })
      harness.child.emit('close', 0, null)

      await harness.promise
      expect(harness.spawnProcess.mock.calls[0][1]).toEqual(['--smoke-test'])
    }
  )

  it('should pass only after a clean app exit', async () => {
    const harness = startFakeSmoke()
    harness.child.emit('close', 0, null)

    await expect(harness.promise).resolves.toBeUndefined()
    expect(harness.terminateTree).not.toHaveBeenCalled()
  })

  it('should time out without waiting for a close event retained by descendants', async () => {
    vi.useFakeTimers()
    const harness = startFakeSmoke()
    const assertion = expect(harness.promise).rejects.toThrow('timed out after 25ms')

    await vi.advanceTimersByTimeAsync(25)
    await assertion

    expect(harness.terminateTree).toHaveBeenCalledWith(harness.child, 'linux')
    expect(harness.child.stdout.destroy).toHaveBeenCalled()
    expect(harness.child.stderr.destroy).toHaveBeenCalled()
    expect(harness.child.unref).toHaveBeenCalled()
  })

  it('should preserve both timeout and process-tree termination failures', async () => {
    vi.useFakeTimers()
    const terminateTree = vi.fn().mockRejectedValue(new Error('tree kill failed'))
    const harness = startFakeSmoke({ terminateTree })
    const assertion = expect(harness.promise).rejects.toThrow(
      'timed out after 25ms; process-tree cleanup also failed: tree kill failed'
    )

    await vi.advanceTimersByTimeAsync(25)
    await assertion
  })

  it('should terminate the process tree when the runner is cancelled', async () => {
    const harness = startFakeSmoke()
    const unrelatedSignalListener = vi.fn()
    harness.signalSource.on('SIGTERM', unrelatedSignalListener)
    harness.signalSource.emit('SIGTERM')

    await expect(harness.promise).rejects.toThrow('cancelled by SIGTERM')
    expect(harness.terminateTree).toHaveBeenCalledWith(harness.child, 'linux')
    expect(harness.child.unref).toHaveBeenCalled()
    expect(unrelatedSignalListener).toHaveBeenCalledOnce()
    expect(harness.signalSource.listeners('SIGTERM')).toEqual([unrelatedSignalListener])
  })
})

describe('packaged smoke process-tree termination', () => {
  it('should kill the detached POSIX process group by negative PID', async () => {
    const child = createFakeChild()
    const killProcessGroup = vi.spyOn(process, 'kill').mockReturnValue(true)

    await terminateProcessTree(child, 'linux')

    expect(killProcessGroup).toHaveBeenCalledWith(-12345, 'SIGKILL')
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('should use taskkill for the complete Windows process tree', async () => {
    const child = createFakeChild()
    const runCommand = vi.fn().mockResolvedValue()

    await terminateProcessTree(child, 'win32', runCommand)

    expect(runCommand).toHaveBeenCalledWith('taskkill', ['/pid', '12345', '/T', '/F'], 5_000)
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('should report taskkill failure after attempting a direct-child fallback', async () => {
    const child = createFakeChild()
    const runCommand = vi.fn().mockRejectedValue(new Error('taskkill unavailable'))

    await expect(terminateProcessTree(child, 'win32', runCommand)).rejects.toThrow(
      'Windows process-tree termination failed; direct child kill was used as fallback'
    )
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })
})

describe('packaged smoke cleanup', () => {
  it('should preserve the primary failure when temporary-directory cleanup also fails', async () => {
    let error
    try {
      await runWithCleanup(
        () => Promise.reject(new Error('renderer failed')),
        () => Promise.reject(new Error('directory locked'))
      )
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(AggregateError)
    expect(error.message).toContain(
      'renderer failed; temporary user-data cleanup also failed: directory locked'
    )
    expect(error.errors).toHaveLength(2)
  })
})
