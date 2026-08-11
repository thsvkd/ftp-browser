/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, createEvent, cleanup, waitFor } from '@testing-library/react'
import { useLocalFsStore } from '@renderer/stores/useLocalFsStore'
import { useLocalSelectionStore } from '@renderer/stores/useLocalSelectionStore'
import {
  useSettingsStore,
  GALLERY_THUMB_DEFAULT,
  GALLERY_THUMB_STEP
} from '@renderer/stores/useSettingsStore'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import {
  invokeCalls,
  localSelectedNames as selectedNames,
  makeApiMock,
  queryMenu,
  stubGridLayout,
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

let layoutStub: ReturnType<typeof stubGridLayout>

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

/**
 * 갤러리 모드로 렌더한다. wheel 리스너는 `gallery`일 때만 등록되므로(LocalFileGridView.tsx:136)
 * 줌 배선을 보려면 이 경로여야 한다. 반환값이 리스너가 붙은 스크롤 컨테이너다.
 */
function renderGallery(): HTMLElement {
  const { container } = render(<LocalFileGridView gallery />)
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
  layoutStub = stubGridLayout()
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
  layoutStub.restore()
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

// macOS 지원 D그룹. 그리드도 리스트와 같은 배선을 독립적으로 갖는다(D7).
describe('LocalFileGridView — platform-aware selection modifiers', () => {
  it('single-selects on Ctrl+click on macOS instead of toggling', () => {
    // covers: Test-149
    apiMock.platform = 'darwin'
    renderGrid({ selected: ['b.txt'] })

    fireEvent.click(gridCell('a.txt'), { ctrlKey: true })

    expect(selectedNames()).toEqual(['a.txt'])
  })

  it('toggles the selection on Cmd+click on macOS', () => {
    // covers: Test-150
    apiMock.platform = 'darwin'
    renderGrid({ selected: ['b.txt'] })
    const cell = gridCell('a.txt')

    fireEvent.click(cell, { metaKey: true })
    expect(selectedNames()).toEqual(['a.txt', 'b.txt'])

    // 토글이므로 같은 항목을 다시 누르면 빠진다. 이 왕복이 없으면
    // "항상 선택에 더하기만" 하는 구현도 통과한다.
    fireEvent.click(cell, { metaKey: true })
    expect(selectedNames()).toEqual(['b.txt'])
  })
})

// G그룹 배선 검증(정정 2). 순수 함수 Test-144~146만으로는 뷰가 그 함수를 실제로 부르는지
// 알 수 없다. wheel은 { passive: false } 네이티브 리스너라 React 합성 이벤트가 아닌
// 실제 WheelEvent를 디스패치해야 한다.
describe('LocalFileGridView — gallery zoom modifiers', () => {
  it('zooms the gallery on Cmd+wheel on macOS', () => {
    // covers: Test-160
    apiMock.platform = 'darwin'
    useSettingsStore.setState({ galleryThumbSize: GALLERY_THUMB_DEFAULT })
    const root = renderGallery()

    fireEvent.wheel(root, { deltaY: -100, metaKey: true })

    // "핸들러가 불렸다"가 아니라 크기가 정확히 한 스텝 움직였음을 본다.
    expect(useSettingsStore.getState().galleryThumbSize).toBe(
      GALLERY_THUMB_DEFAULT + GALLERY_THUMB_STEP
    )
  })
})

// D절(핸드오프 함정 1): 닫기 트리거로 document에 새 contextmenu 리스너가 붙으면,
// 메뉴를 여는 우클릭 자체가 같은 native 이벤트로 그 리스너까지 버블링돼 메뉴를
// 열자마자 닫아버릴 수 있다.
//
// 한계 — 이 테스트는 그 회귀를 잡지 못한다(핸드오프 함정 4). jsdom의 이벤트
// dispatch는 JS 스택 안에서 동기로 끝나 전파 도중 마이크로태스크 체크포인트가
// 돌지 않고, React 19는 sync-lane 작업을 마이크로태스크로 스케줄한다. 따라서
// 메뉴 커밋이 dispatch 중간에 일어나지 않아, 자기충돌 가드를 통째로 지워도 이
// 테스트는 GREEN이다. 실제 보장은 8절 E2E 체크리스트 (a)가 전담한다.
// 안전망으로 오인하지 말 것.
describe('LocalFileGridView — context menu self-conflict guard', () => {
  it('keeps the menu open despite the new document contextmenu dismiss listener', () => {
    // covers: Test-114
    renderGrid()

    fireEvent.contextMenu(gridCell('a.txt'))

    expect(queryMenu()).not.toBeNull()
  })
})
