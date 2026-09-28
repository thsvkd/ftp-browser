import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import type { BrowserWindow } from 'electron'
import { hideOnCloseOnMac } from './windowLifecycle'

class FakeWindow extends EventEmitter {
  fullScreen = false
  hide = vi.fn()
  setFullScreen = vi.fn((value: boolean) => {
    this.fullScreen = value
  })
  isFullScreen = (): boolean => this.fullScreen

  /** Emit `close` the way Electron does and report whether it was prevented. */
  close(): boolean {
    let prevented = false
    this.emit('close', { preventDefault: () => (prevented = true) })
    return prevented
  }
}

function setup(platform: NodeJS.Platform, quitting = false): { win: FakeWindow; quit: () => void } {
  const win = new FakeWindow()
  let isQuitting = quitting
  hideOnCloseOnMac(win as unknown as BrowserWindow, platform, () => isQuitting)
  return { win, quit: () => (isQuitting = true) }
}

describe('hideOnCloseOnMac', () => {
  it('hides the window instead of closing it on macOS', () => {
    const { win } = setup('darwin')

    expect(win.close()).toBe(true)
    expect(win.hide).toHaveBeenCalledTimes(1)
  })

  it('lets the window close when the app is quitting', () => {
    const { win, quit } = setup('darwin')
    quit()

    expect(win.close()).toBe(false)
    expect(win.hide).not.toHaveBeenCalled()
  })

  it('leaves full screen before hiding so no empty Space is left behind', () => {
    const { win } = setup('darwin')
    win.fullScreen = true

    expect(win.close()).toBe(true)
    expect(win.setFullScreen).toHaveBeenCalledWith(false)
    expect(win.hide).not.toHaveBeenCalled()

    win.emit('leave-full-screen')
    expect(win.hide).toHaveBeenCalledTimes(1)
  })

  it.each(['win32', 'linux'] as const)('does nothing on %s, where closing quits', (platform) => {
    const { win } = setup(platform)

    expect(win.close()).toBe(false)
    expect(win.listenerCount('close')).toBe(0)
  })
})
