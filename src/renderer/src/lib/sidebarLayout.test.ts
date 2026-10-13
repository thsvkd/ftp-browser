import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CENTER_MIN,
  PANE_ANIM_MS,
  PANE_SPECS,
  applyPaneKey,
  clampPaneWidth,
  collapseAt,
  dragMax,
  dragRaw,
  expandAt,
  fitPaneWidths,
  formatPaneShortcut,
  matchPaneShortcut,
  paneKeyAction,
  resetPane,
  resolveDrag,
  sanitizePaneState,
  settleDrag,
  togglePane,
  type PaneShortcutEvent
} from './sidebarLayout'

describe('PANE_SPECS and clampPaneWidth', () => {
  it('pins the width table, rounds, rejects non-finite values and honours maxWidth', () => {
    // covers: Test-890
    expect(PANE_SPECS).toEqual({
      left: { min: 180, def: 220, max: 360 },
      right: { min: 240, def: 288, max: 480 }
    })
    expect(clampPaneWidth('left', 50)).toBe(180)
    expect(clampPaneWidth('left', 9999)).toBe(360)
    expect(clampPaneWidth('right', 100)).toBe(240)
    expect(clampPaneWidth('right', 9999)).toBe(480)
    expect(clampPaneWidth('left', 199.5)).toBe(200)
    expect(clampPaneWidth('left', 199.4)).toBe(199)
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(clampPaneWidth('left', bad)).toBe(220)
      expect(clampPaneWidth('right', bad)).toBe(288)
    }
    expect(clampPaneWidth('left', 340, 300)).toBe(300)
    expect(clampPaneWidth('left', 250, 300)).toBe(250)
    expect(clampPaneWidth('left', 340, 100)).toBe(180)
    expect(collapseAt('left')).toBe(90)
    expect(collapseAt('right')).toBe(120)
    expect(expandAt('left')).toBe(180)
    expect(expandAt('right')).toBe(240)
  })
})

describe('resolveDrag', () => {
  it('collapses an expanded pane at min - min/2 and keeps min between there and min', () => {
    // covers: Test-891
    expect(resolveDrag('left', 91, false)).toEqual({ collapsed: false, width: 180 })
    expect(resolveDrag('left', 90, false)).toEqual({ collapsed: true, width: 0 })
    expect(resolveDrag('left', 0, false)).toEqual({ collapsed: true, width: 0 })
    expect(resolveDrag('left', -40, false)).toEqual({ collapsed: true, width: 0 })
    expect(resolveDrag('left', 181, false)).toEqual({ collapsed: false, width: 181 })
    expect(resolveDrag('right', 121, false)).toEqual({ collapsed: false, width: 240 })
    expect(resolveDrag('right', 120, false)).toEqual({ collapsed: true, width: 0 })
  })

  it('uses hysteresis: a collapsed pane only expands once raw reaches min', () => {
    // covers: Test-892
    expect(resolveDrag('left', 179, true)).toEqual({ collapsed: true, width: 0 })
    expect(resolveDrag('left', 180, true)).toEqual({ collapsed: false, width: 180 })
    expect(resolveDrag('left', 300, true)).toEqual({ collapsed: false, width: 300 })
    expect(resolveDrag('right', 239, true)).toEqual({ collapsed: true, width: 0 })
    expect(resolveDrag('right', 240, true)).toEqual({ collapsed: false, width: 240 })
    expect(resolveDrag('left', 150, false)).toEqual({ collapsed: false, width: 180 })
    expect(resolveDrag('left', 150, true)).toEqual({ collapsed: true, width: 0 })
  })
})

describe('resolveDrag upper bound and dragMax', () => {
  it('caps at max or the given maxWidth, and dragMax leaves CENTER_MIN for the body', () => {
    // covers: Test-893
    expect(resolveDrag('left', 999, false)).toEqual({ collapsed: false, width: 360 })
    expect(resolveDrag('right', 999, false)).toEqual({ collapsed: false, width: 480 })
    expect(resolveDrag('left', 999, false, 300)).toEqual({ collapsed: false, width: 300 })
    expect(CENTER_MIN).toBe(480)
    expect(dragMax('left', 1024, 288)).toBe(256)
    expect(dragMax('left', null, 288)).toBe(360)
    expect(dragMax('right', 0, 100)).toBe(480)
    expect(dragMax('left', 600, 480)).toBe(180)
    expect(dragMax('right', 5000, 0)).toBe(480)
  })
})

describe('dragRaw and settleDrag', () => {
  it('follows the pointer in the growing direction and remembers the starting width when it ends collapsed', () => {
    // covers: Test-894
    expect(dragRaw('left', { width: 220, collapsed: false }, 220, 300)).toBe(300)
    expect(dragRaw('left', { width: 220, collapsed: false }, 220, 200)).toBe(200)
    expect(dragRaw('right', { width: 288, collapsed: false }, 700, 640)).toBe(348)
    expect(dragRaw('right', { width: 288, collapsed: false }, 700, 760)).toBe(228)
    expect(dragRaw('left', { width: 300, collapsed: true }, 2, 182)).toBe(180)
    expect(settleDrag({ width: 220, collapsed: false }, { collapsed: false, width: 300 })).toEqual({
      width: 300,
      collapsed: false
    })
    expect(settleDrag({ width: 220, collapsed: false }, { collapsed: true, width: 0 })).toEqual({
      width: 220,
      collapsed: true
    })
    expect(settleDrag({ width: 300, collapsed: true }, { collapsed: true, width: 0 })).toEqual({
      width: 300,
      collapsed: true
    })
  })
})

describe('togglePane and resetPane', () => {
  it('flips only collapsed and resets to the default width', () => {
    // covers: Test-895
    const s = { width: 300, collapsed: false }
    expect(togglePane(s)).toEqual({ width: 300, collapsed: true })
    expect(togglePane(togglePane(s))).toEqual(s)
    expect(resetPane('left')).toEqual({ width: 220, collapsed: false })
    expect(resetPane('right')).toEqual({ width: 288, collapsed: false })
  })
})

describe('paneKeyAction and applyPaneKey', () => {
  it('maps keys by pane side and never collapses with arrows', () => {
    // covers: Test-896
    expect(paneKeyAction('left', 'ArrowRight', false)).toEqual({ kind: 'grow', step: 16 })
    expect(paneKeyAction('left', 'ArrowLeft', false)).toEqual({ kind: 'shrink', step: 16 })
    expect(paneKeyAction('left', 'ArrowRight', true)).toEqual({ kind: 'grow', step: 64 })
    expect(paneKeyAction('left', 'ArrowLeft', true)).toEqual({ kind: 'shrink', step: 64 })
    expect(paneKeyAction('right', 'ArrowLeft', false)).toEqual({ kind: 'grow', step: 16 })
    expect(paneKeyAction('right', 'ArrowRight', false)).toEqual({ kind: 'shrink', step: 16 })
    expect(paneKeyAction('left', 'Home', false)).toEqual({ kind: 'min' })
    expect(paneKeyAction('left', 'End', false)).toEqual({ kind: 'max' })
    expect(paneKeyAction('left', 'Enter', false)).toEqual({ kind: 'toggle' })
    for (const k of ['a', 'ArrowUp', 'Escape']) expect(paneKeyAction('left', k, false)).toBeNull()

    const open = { width: 220, collapsed: false }
    expect(applyPaneKey('left', open, { kind: 'grow', step: 16 })).toEqual({
      width: 236,
      collapsed: false
    })
    expect(
      applyPaneKey('left', { width: 180, collapsed: false }, { kind: 'shrink', step: 16 })
    ).toEqual({ width: 180, collapsed: false })
    expect(
      applyPaneKey('left', { width: 360, collapsed: false }, { kind: 'grow', step: 16 })
    ).toEqual({ width: 360, collapsed: false })
    expect(applyPaneKey('left', open, { kind: 'grow', step: 64 }, 250)).toEqual({
      width: 250,
      collapsed: false
    })
    expect(applyPaneKey('left', open, { kind: 'min' })).toEqual({ width: 180, collapsed: false })
    expect(applyPaneKey('left', open, { kind: 'max' })).toEqual({ width: 360, collapsed: false })
    expect(applyPaneKey('left', open, { kind: 'toggle' })).toEqual({ width: 220, collapsed: true })

    const shut = { width: 300, collapsed: true }
    expect(applyPaneKey('left', shut, { kind: 'grow', step: 16 })).toEqual({
      width: 300,
      collapsed: false
    })
    expect(applyPaneKey('left', shut, { kind: 'shrink', step: 16 })).toEqual(shut)
    expect(applyPaneKey('left', shut, { kind: 'min' })).toEqual({ width: 180, collapsed: false })
    expect(applyPaneKey('left', shut, { kind: 'max' })).toEqual({ width: 360, collapsed: false })
    expect(applyPaneKey('left', shut, { kind: 'toggle' })).toEqual({
      width: 300,
      collapsed: false
    })
  })
})

describe('fitPaneWidths', () => {
  const open = (width: number): { width: number; collapsed: boolean } => ({
    width,
    collapsed: false
  })

  it('shrinks proportionally to the slack above min, stops at min, and ignores unmeasured containers', () => {
    // covers: Test-897
    expect(fitPaneWidths(1024, open(360), open(480))).toEqual({ left: 233, right: 311 })
    expect(fitPaneWidths(1200, open(220), open(288))).toEqual({ left: 220, right: 288 })
    expect(fitPaneWidths(null, open(360), open(480))).toEqual({ left: 360, right: 480 })
    expect(fitPaneWidths(0, open(360), open(480))).toEqual({ left: 360, right: 480 })
    expect(fitPaneWidths(null, { width: 300, collapsed: true }, open(480))).toEqual({
      left: 0,
      right: 480
    })
    expect(fitPaneWidths(800, { width: 300, collapsed: true }, open(480))).toEqual({
      left: 0,
      right: 320
    })
    expect(fitPaneWidths(600, open(220), open(288))).toEqual({ left: 180, right: 240 })
  })

  it('lets the pane touched last keep its width first', () => {
    // covers: Test-897
    expect(fitPaneWidths(1024, open(233), open(480))).toEqual({ left: 202, right: 342 })
    expect(fitPaneWidths(1024, open(233), open(480), null)).toEqual({ left: 202, right: 342 })
    expect(fitPaneWidths(1024, open(233), open(480), 'left')).toEqual({ left: 233, right: 311 })
    expect(fitPaneWidths(1024, open(233), open(480), 'right')).toEqual({ left: 180, right: 364 })
    expect(fitPaneWidths(1000, open(300), open(260), 'left')).toEqual({ left: 280, right: 240 })
  })
})

describe('sanitizePaneState', () => {
  it('repairs persisted values', () => {
    // covers: Test-898
    const def = { width: 220, collapsed: false }
    for (const raw of [undefined, null, 'x', [], 7]) {
      expect(sanitizePaneState('left', raw)).toEqual(def)
    }
    expect(sanitizePaneState('right', undefined)).toEqual({ width: 288, collapsed: false })
    expect(sanitizePaneState('left', { width: '300' })).toEqual(def)
    expect(sanitizePaneState('left', { width: NaN })).toEqual(def)
    expect(sanitizePaneState('left', { width: 9999, collapsed: true })).toEqual({
      width: 360,
      collapsed: true
    })
    expect(sanitizePaneState('left', { width: 50 })).toEqual({ width: 180, collapsed: false })
    expect(sanitizePaneState('left', { width: 300, collapsed: 'yes' }).collapsed).toBe(false)
    expect(sanitizePaneState('left', { width: 300, collapsed: 1 }).collapsed).toBe(false)
    expect(sanitizePaneState('left', { width: 300, collapsed: true }).collapsed).toBe(true)
  })
})

describe('matchPaneShortcut and formatPaneShortcut', () => {
  const ev = (patch: Partial<PaneShortcutEvent>): PaneShortcutEvent => ({
    code: 'KeyB',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    altGraph: false,
    ...patch
  })

  it('matches by e.code with the platform modifier only', () => {
    // covers: Test-899
    expect(matchPaneShortcut(ev({ metaKey: true }), 'darwin')).toBe('left')
    expect(matchPaneShortcut(ev({ metaKey: true, altKey: true }), 'darwin')).toBe('right')
    expect(matchPaneShortcut(ev({ ctrlKey: true }), 'darwin')).toBeNull()
    expect(matchPaneShortcut(ev({ ctrlKey: true, metaKey: true }), 'darwin')).toBeNull()
    expect(matchPaneShortcut(ev({ ctrlKey: true }), 'win32')).toBe('left')
    expect(matchPaneShortcut(ev({ ctrlKey: true, altKey: true }), 'win32')).toBe('right')
    expect(matchPaneShortcut(ev({ ctrlKey: true }), 'linux')).toBe('left')
    expect(matchPaneShortcut(ev({ metaKey: true }), 'win32')).toBeNull()
    expect(matchPaneShortcut(ev({ ctrlKey: true, metaKey: true }), 'win32')).toBeNull()
    expect(matchPaneShortcut(ev({}), 'win32')).toBeNull()
    expect(matchPaneShortcut(ev({ ctrlKey: true, shiftKey: true }), 'win32')).toBeNull()
    expect(matchPaneShortcut(ev({ metaKey: true, shiftKey: true }), 'darwin')).toBeNull()
    expect(
      matchPaneShortcut(ev({ ctrlKey: true, altKey: true, altGraph: true }), 'win32')
    ).toBeNull()
    expect(matchPaneShortcut(ev({ ctrlKey: true, code: 'KeyV' }), 'win32')).toBeNull()
    expect(formatPaneShortcut('left', 'darwin')).toBe('⌘B')
    expect(formatPaneShortcut('right', 'darwin')).toBe('⌥⌘B')
    expect(formatPaneShortcut('left', 'win32')).toBe('Ctrl+B')
    expect(formatPaneShortcut('right', 'linux')).toBe('Ctrl+Alt+B')
    expect(formatPaneShortcut('left', '')).toBe('Ctrl+B')
  })
})

describe('design token contract', () => {
  it('keeps globals.css :root in step with PANE_SPECS and the motion constants', () => {
    // covers: Test-900
    const css = readFileSync(resolve(__dirname, '../styles/globals.css'), 'utf8')
    const rootBlock = /:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    const token = (name: string): string | undefined =>
      new RegExp(`--${name}:\\s*([^;]+);`).exec(rootBlock)?.[1].trim()
    for (const side of ['left', 'right'] as const) {
      expect(token(`sidebar-${side}-min`)).toBe(`${PANE_SPECS[side].min}px`)
      expect(token(`sidebar-${side}-default`)).toBe(`${PANE_SPECS[side].def}px`)
      expect(token(`sidebar-${side}-max`)).toBe(`${PANE_SPECS[side].max}px`)
    }
    expect(token('handle-hit')).toBe('6px')
    expect(token('handle-line')).toBe('2px')
    expect(token('handle-hover-delay')).toBe('300ms')
    expect(token('pane-anim')).toBe(`${PANE_ANIM_MS}ms`)
    const reduced =
      /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''
    expect(reduced).toMatch(/\.side-pane\s*\{[^}]*transition:\s*none/)
  })
})
