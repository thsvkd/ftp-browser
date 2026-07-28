/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within, fireEvent, createEvent, cleanup } from '@testing-library/react'
import { useLocalFsStore } from '@renderer/stores/useLocalFsStore'
import { useLocalSelectionStore } from '@renderer/stores/useLocalSelectionStore'
import { useSettingsStore } from '@renderer/stores/useSettingsStore'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import {
  localSelectedNames as selectedNames,
  makeApiMock,
  queryMenu,
  type ApiMock
} from '@renderer/test/rendererTestUtils'
import { formatBytes, formatDate } from '@renderer/lib/utils'
import type { LocalFileEntry } from '@shared/types/local'
import { LocalFileList } from './LocalFileList'

const LOCAL_DIR = 'C:\\work'
const REMOTE_DIR = '/remote/dir'
const MODIFIED_AT = '2024-05-01T10:20:30.000Z'

function fileEntry(name: string, size = 1024): LocalFileEntry {
  return {
    name,
    path: `${LOCAL_DIR}\\${name}`,
    type: 'file',
    size,
    modifiedAt: MODIFIED_AT,
    isImage: false
  }
}

const mockInvoke = vi.fn()
let apiMock: ApiMock

interface RenderOptions {
  entries?: LocalFileEntry[]
  selected?: string[]
}

function renderList(options: RenderOptions = {}): HTMLElement {
  // 이 파일의 어떤 테스트도 삭제·이름변경·폴더생성을 트리거하지 않으므로
  // refresh를 목으로 갈아끼울 이유가 없다(그 경로는 LocalFileContextMenu.test.tsx 담당).
  useLocalFsStore.setState({
    currentPath: LOCAL_DIR,
    entries: options.entries ?? [fileEntry('a.txt'), fileEntry('b.txt')]
  })
  useLocalSelectionStore.setState({
    selectedNames: new Set(options.selected ?? []),
    lastClickedName: null
  })

  const { container } = render(<LocalFileList />)
  const root = container.firstElementChild
  if (!(root instanceof HTMLElement)) throw new Error('LocalFileList rendered no root element')
  return root
}

/**
 * Properties 다이얼로그의 필드 블록. 전역에서 유일한 전체 경로 텍스트에서 위로 올라가며
 * 모든 라벨을 품는 첫 조상을 찾는다. 리스트 뷰의 테이블 헤더(Name/Size/Modified)가
 * 조회에 섞이지 않도록 스코프를 좁히는 용도다.
 */
function getPropertiesPanel(fullPath: string): HTMLElement {
  let node: HTMLElement | null = screen.getByText(fullPath)
  while (node) {
    const text = node.textContent ?? ''
    if (text.includes('Name') && text.includes('Modified')) return node
    node = node.parentElement
  }
  throw new Error('Properties dialog fields not found')
}

/** InfoRow는 라벨과 값을 한 행 안의 형제로 렌더한다(원격 FilePropertiesDialog 구조). */
function propertyValue(panel: HTMLElement, label: string): string {
  const row = within(panel).getByText(label).parentElement
  if (!row) throw new Error(`No row element for property "${label}"`)
  return (row.textContent ?? '').slice(label.length).trim()
}

beforeEach(() => {
  vi.clearAllMocks()
  mockInvoke.mockResolvedValue({ success: true })
  apiMock = makeApiMock(mockInvoke)
  vi.stubGlobal('api', apiMock)

  useFtpStore.setState({ currentPath: REMOTE_DIR, connectionStatus: 'connected' })
  useSettingsStore.setState({ confirmBeforeDelete: false, showHidden: false })
})

afterEach(() => {
  // RTL이 auto-cleanup을 등록하지만 그것은 이 훅보다 **나중에** 돈다(실측).
  // 언마운트가 아래 전역 해제보다 먼저 일어나도록 여기서 명시적으로 부른다.
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('LocalFileList — context menu wiring', () => {
  it('opens the context menu when a file row is right-clicked', () => {
    // covers: Test-42
    renderList()

    fireEvent.contextMenu(screen.getByText('a.txt'))

    expect(queryMenu()).not.toBeNull()
  })

  it('opens a selection-less context menu when empty space is right-clicked', () => {
    // covers: Test-44
    // 비자명한 선택을 심어야 "선택이 메뉴로 새지 않는다"가 반증 가능해진다.
    const root = renderList({ selected: ['a.txt', 'b.txt'] })

    fireEvent.contextMenu(root)

    expect(queryMenu()).not.toBeNull()
    expect(screen.queryByRole('button', { name: /^Delete/ })).toBeNull()
  })

  it('selects an unselected row as the single selection when it is right-clicked', () => {
    // covers: Test-45
    renderList({ selected: ['b.txt'] })

    fireEvent.contextMenu(screen.getByText('a.txt'))

    expect(selectedNames()).toEqual(['a.txt'])
    expect(queryMenu()).not.toBeNull()
  })

  it('keeps the existing selection when one of several selected rows is right-clicked', () => {
    // covers: Test-46
    renderList({ selected: ['a.txt', 'b.txt'] })

    fireEvent.contextMenu(screen.getByText('a.txt'))

    expect(selectedNames()).toEqual(['a.txt', 'b.txt'])
    // 메뉴가 실제로 열렸고 선택 전체를 대상으로 삼았음을 함께 본다.
    expect(queryMenu()).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete (2)' })).not.toBeNull()
  })

  it('closes the context menu when a click lands outside it', () => {
    // covers: Test-47
    renderList()
    fireEvent.contextMenu(screen.getByText('a.txt'))
    expect(queryMenu()).not.toBeNull()

    fireEvent.click(document.body)

    expect(queryMenu()).toBeNull()
  })

  it('yields to the native menu on Shift+right-click while debug tools are on', () => {
    // covers: Test-48
    apiMock.debugToolsEnabled = true
    renderList()
    const row = screen.getByText('a.txt')

    // 대조군: 일반 우클릭은 앱 메뉴를 열고 preventDefault로 네이티브 메뉴를 막는다.
    const plain = createEvent.contextMenu(row)
    fireEvent(row, plain)
    expect(queryMenu()).not.toBeNull()
    expect(plain.defaultPrevented).toBe(true)

    // 다음 관찰이 위 메뉴의 잔상이 아니도록 닫는다.
    fireEvent.click(document.body)
    expect(queryMenu()).toBeNull()

    // 본 케이스: Shift+우클릭은 앱 메뉴를 열지 않고 네이티브에 양보한다.
    const shifted = createEvent.contextMenu(row, { shiftKey: true })
    fireEvent(row, shifted)
    expect(queryMenu()).toBeNull()
    expect(shifted.defaultPrevented).toBe(false)
  })

  it('shows name, full path, size and modified time in the properties dialog', () => {
    // covers: Test-60
    const photo = fileEntry('photo.png', 2048)
    renderList({ entries: [photo] })

    fireEvent.contextMenu(screen.getByText('photo.png'))
    fireEvent.click(screen.getByRole('button', { name: 'Properties' }))

    const panel = getPropertiesPanel('C:\\work\\photo.png')
    expect(propertyValue(panel, 'Name')).toBe('photo.png')
    expect(propertyValue(panel, 'Full Path')).toBe('C:\\work\\photo.png')
    expect(propertyValue(panel, 'Size')).toContain(formatBytes(2048))
    expect(propertyValue(panel, 'Modified')).toBe(formatDate(MODIFIED_AT))
  })
})
