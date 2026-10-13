/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fireEvent } from '@testing-library/react'
import { useDnd } from '@renderer/components/explorer/dnd'
import type { ExplorerEntry } from './explorerEntry'
import { installDropGuard } from './osDropGuard'

const dt = (types: string[], dropEffect = ''): { types: string[]; dropEffect: string } => ({
  types,
  dropEffect
})

let uninstall: () => void

beforeEach(() => {
  useDnd.setState({ items: null, over: null, thumbs: [] })
  uninstall = installDropGuard(document)
})

afterEach(() => {
  uninstall()
  document.body.innerHTML = ''
  useDnd.setState({ items: null, over: null, thumbs: [] })
})

describe('installDropGuard', () => {
  it('stops the window from taking dropped files and shows a no-drop cursor for OS files outside any target', () => {
    // covers: Test-880
    // (a) 앱 안 드래그가 없고 Files가 있으면 막고 금지 커서
    const files = dt(['Files'], 'copy')
    expect(fireEvent.dragOver(document.body, { dataTransfer: files })).toBe(false)
    expect(files.dropEffect).toBe('none')

    // (b) Files가 없고 앱 안 드래그도 없으면 막기만 하고 dropEffect는 그대로(기존 동작 보존)
    const text = dt(['text/plain'], 'copy')
    expect(fireEvent.dragOver(document.body, { dataTransfer: text })).toBe(false)
    expect(text.dropEffect).toBe('copy')

    // (c) 앱 안 드래그 중에는 Files가 있어도 dropEffect를 건드리지 않는다
    useDnd.setState({ items: [{ name: 'a.jpg' } as ExplorerEntry] })
    const inApp = dt(['Files'], 'move')
    expect(fireEvent.dragOver(document.body, { dataTransfer: inApp })).toBe(false)
    expect(inApp.dropEffect).toBe('move')
    useDnd.setState({ items: null })

    // (d) drop은 늘 막는다
    expect(fireEvent.drop(document.body, { dataTransfer: dt(['Files']) })).toBe(false)
    expect(fireEvent.drop(document.body, { dataTransfer: dt(['text/plain']) })).toBe(false)

    // (e) 전파를 멈추는 요소(놓기 대상의 모사) 안의 dragover는 가드에 닿지 않는다
    const stopper = document.createElement('div')
    stopper.addEventListener('dragover', (e) => e.stopPropagation())
    document.body.append(stopper)
    const inside = dt(['Files'], 'copy')
    fireEvent.dragOver(stopper, { dataTransfer: inside })
    expect(inside.dropEffect).toBe('copy')

    // (f) 해제하면 이후 dragover는 막히지 않는다
    uninstall()
    expect(fireEvent.dragOver(document.body, { dataTransfer: dt(['Files']) })).toBe(true)
    expect(fireEvent.drop(document.body, { dataTransfer: dt(['Files']) })).toBe(true)
  })

  it('is what main.tsx installs, once, with no raw document drag listeners left', () => {
    // covers: Test-883
    // main.tsx는 부트스트랩이라 import하면 앱이 렌더된다. 소스 문자열로만 고정한다.
    const source = readFileSync(join(process.cwd(), 'src/renderer/src/main.tsx'), 'utf8')

    expect(source.match(/installDropGuard\(document\)/g)).toHaveLength(1)
    expect(source).not.toContain("addEventListener('dragover'")
    expect(source).not.toContain("addEventListener('drop'")
  })
})
