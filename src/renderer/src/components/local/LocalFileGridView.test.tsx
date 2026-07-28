/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, createEvent, cleanup, waitFor } from '@testing-library/react'
import { useLocalFsStore } from '@renderer/stores/useLocalFsStore'
import { useLocalSelectionStore } from '@renderer/stores/useLocalSelectionStore'
import { useSettingsStore } from '@renderer/stores/useSettingsStore'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import {
  invokeCalls,
  localSelectedNames as selectedNames,
  makeApiMock,
  queryMenu,
  type ApiMock
} from '@renderer/test/rendererTestUtils'
import type { LocalFileEntry } from '@shared/types/local'
import { LocalFileGridView } from './LocalFileGridView'

const LOCAL_DIR = 'C:\\work'
const REMOTE_DIR = '/remote/dir'

function fileEntry(name: string): LocalFileEntry {
  return {
    name,
    path: `${LOCAL_DIR}\\${name}`,
    type: 'file',
    size: 1024,
    modifiedAt: '2024-05-01T10:20:30.000Z',
    isImage: false
  }
}

const mockInvoke = vi.fn()
// Test-80이 Delete를 눌러 refresh()를 태우므로 실제 목록 재조회를 차단한다.
const mockRefresh = vi.fn()
let apiMock: ApiMock

function calls(channel: string): unknown[][] {
  return invokeCalls(mockInvoke, channel)
}

const LAYOUT_PROPS = [
  'clientWidth',
  'clientHeight',
  'offsetWidth',
  'offsetHeight',
  'getBoundingClientRect'
] as const

let savedLayoutDescriptors: Array<[string, PropertyDescriptor | undefined]> = []

/**
 * jsdom은 레이아웃을 계산하지 않아 스크롤 컨테이너 크기가 0이고, 그러면 TanStack Virtual이
 * 아무 행도 렌더하지 않는다(실측: 스텁 없이는 컨테이너가 자식 없이 비어 있어 셀을 찾지 못한다).
 * 셀을 우클릭하려면 실제 크기가 필요하므로 채워 넣고, 다른 테스트 파일로 새지 않도록
 * 원본 디스크립터를 저장해 두었다가 되돌린다.
 */
function stubLayout(): void {
  savedLayoutDescriptors = LAYOUT_PROPS.map((prop) => [
    prop,
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop)
  ])

  const rect = {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 1200,
    bottom: 800,
    width: 1200,
    height: 800,
    toJSON: () => ({})
  }
  const values: Record<string, unknown> = {
    clientWidth: 1200,
    clientHeight: 800,
    offsetWidth: 1200,
    offsetHeight: 800,
    getBoundingClientRect: () => rect
  }
  for (const prop of LAYOUT_PROPS) {
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      value: values[prop]
    })
  }
}

function restoreLayout(): void {
  for (const [prop, descriptor] of savedLayoutDescriptors) {
    if (descriptor) {
      Object.defineProperty(HTMLElement.prototype, prop, descriptor)
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, prop)
    }
  }
  savedLayoutDescriptors = []
}

function renderGrid(options: { selected?: string[] } = {}): HTMLElement {
  useLocalSelectionStore.setState({
    selectedNames: new Set(options.selected ?? []),
    lastClickedName: null
  })
  const { container } = render(<LocalFileGridView />)
  const root = container.firstElementChild
  if (!(root instanceof HTMLElement)) throw new Error('LocalFileGridView rendered no root element')
  return root
}

function gridCell(name: string): HTMLElement {
  const cell = screen.getByText(name).closest('[data-grid-cell]')
  if (!(cell instanceof HTMLElement)) throw new Error(`No grid cell for "${name}"`)
  return cell
}

beforeEach(() => {
  vi.clearAllMocks()
  mockInvoke.mockResolvedValue({ success: true })
  stubLayout()
  apiMock = makeApiMock(mockInvoke)
  vi.stubGlobal('api', apiMock)

  useLocalFsStore.setState({
    currentPath: LOCAL_DIR,
    entries: [fileEntry('a.txt'), fileEntry('b.txt')],
    refresh: mockRefresh
  })
  useLocalSelectionStore.setState({ selectedNames: new Set(), lastClickedName: null })
  useFtpStore.setState({ currentPath: REMOTE_DIR, connectionStatus: 'connected' })
  useSettingsStore.setState({ confirmBeforeDelete: false, showHidden: false })
})

afterEach(() => {
  // RTL이 auto-cleanup을 등록하지만 그것은 이 훅보다 **나중에** 돈다(실측).
  // 언마운트가 아래 프로토타입 복원·전역 해제보다 먼저 일어나야 한다.
  cleanup()
  restoreLayout()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('LocalFileGridView — context menu wiring', () => {
  it('opens the context menu when a grid cell is right-clicked', () => {
    // covers: Test-43
    renderGrid()

    fireEvent.contextMenu(gridCell('a.txt'))

    expect(queryMenu()).not.toBeNull()
  })

  it('opens a selection-less context menu when empty space is right-clicked', () => {
    // covers: Test-67
    // 비자명한 선택을 심어야 "선택이 메뉴로 새지 않는다"가 반증 가능해진다.
    const root = renderGrid({ selected: ['a.txt', 'b.txt'] })

    fireEvent.contextMenu(root)

    expect(queryMenu()).not.toBeNull()
    expect(screen.queryByRole('button', { name: /^Delete/ })).toBeNull()
  })

  it('selects an unselected cell as the single selection when it is right-clicked', () => {
    // covers: Test-68
    renderGrid({ selected: ['b.txt'] })

    fireEvent.contextMenu(gridCell('a.txt'))

    expect(selectedNames()).toEqual(['a.txt'])
    expect(queryMenu()).not.toBeNull()
  })

  it('keeps the existing selection when one of several selected cells is right-clicked', () => {
    // covers: Test-69
    renderGrid({ selected: ['a.txt', 'b.txt'] })

    fireEvent.contextMenu(gridCell('a.txt'))

    expect(selectedNames()).toEqual(['a.txt', 'b.txt'])
    // 메뉴가 실제로 열렸고 선택 전체를 대상으로 삼았음을 함께 본다.
    expect(queryMenu()).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete (2)' })).not.toBeNull()
  })

  it('closes the context menu when a click lands outside it', () => {
    // covers: Test-70
    renderGrid()
    fireEvent.contextMenu(gridCell('a.txt'))
    expect(queryMenu()).not.toBeNull()

    fireEvent.click(document.body)

    expect(queryMenu()).toBeNull()
  })

  it('yields to the native menu on Shift+right-click while debug tools are on', () => {
    // covers: Test-71
    apiMock.debugToolsEnabled = true
    renderGrid()
    const cell = gridCell('a.txt')

    // 대조군: 일반 우클릭은 앱 메뉴를 열고 preventDefault로 네이티브 메뉴를 막는다.
    const plain = createEvent.contextMenu(cell)
    fireEvent(cell, plain)
    expect(queryMenu()).not.toBeNull()
    expect(plain.defaultPrevented).toBe(true)

    // 다음 관찰이 위 메뉴의 잔상이 아니도록 닫는다.
    fireEvent.click(document.body)
    expect(queryMenu()).toBeNull()

    // 본 케이스: Shift+우클릭은 앱 메뉴를 열지 않고 네이티브에 양보한다.
    const shifted = createEvent.contextMenu(cell, { shiftKey: true })
    fireEvent(cell, shifted)
    expect(queryMenu()).toBeNull()
    expect(shifted.defaultPrevented).toBe(false)
  })

  it('keeps the whole selection when a menu item is pressed with the mouse', async () => {
    // covers: Test-80
    useLocalFsStore.setState({
      currentPath: LOCAL_DIR,
      entries: [fileEntry('a.txt'), fileEntry('b.txt'), fileEntry('c.txt')],
      refresh: mockRefresh
    })
    renderGrid({ selected: ['a.txt', 'b.txt', 'c.txt'] })

    fireEvent.contextMenu(gridCell('a.txt'))
    const deleteButton = screen.getByRole('button', { name: 'Delete (3)' })

    // 마퀴 선택은 mousedown에 붙어 있고 메뉴는 그리드 컨테이너의 DOM 자식이다.
    // click만 쏘면 이 버그는 재현되지 않으므로 실제 입력 순서를 그대로 밟는다.
    fireEvent.mouseDown(deleteButton)
    fireEvent.click(deleteButton)

    await waitFor(() => {
      expect(calls('local:deleteBatch')).toHaveLength(1)
    })
    // 핵심 단언: 눌린 순간 선택이 비워졌다면 1건만 전달된다.
    expect(calls('local:deleteBatch')[0][0]).toHaveLength(3)
  })
})
