/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import { useSelectionStore } from '@renderer/stores/useSelectionStore'
import {
  useSettingsStore,
  GALLERY_THUMB_DEFAULT,
  GALLERY_THUMB_STEP
} from '@renderer/stores/useSettingsStore'
import {
  makeApiMock,
  remoteSelectedNames as selectedNames,
  stubGridLayout,
  type ApiMock
} from '@renderer/test/rendererTestUtils'
import type { FtpFileEntry } from '@shared/types/ftp'
import { FileGridView } from './FileGridView'

// 원격 경로는 POSIX 고정이다. 로컬 패널과 달리 OS를 감지하지 않는다.
const REMOTE_DIR = '/remote/dir'
const MODIFIED_AT = '2024-05-01T10:20:30.000Z'

function ftpFile(name: string, size = 1024): FtpFileEntry {
  return {
    name,
    type: 'file',
    size,
    modifiedAt: MODIFIED_AT,
    rawModifiedAt: MODIFIED_AT,
    isImage: false
  }
}

let apiMock: ApiMock
let layoutStub: ReturnType<typeof stubGridLayout>

function renderGrid(options: { selected?: string[] } = {}): void {
  useSelectionStore.setState({
    selectedNames: new Set(options.selected ?? []),
    lastClickedName: null
  })
  render(<FileGridView />)
}

/**
 * 갤러리 모드로 렌더한다. wheel 리스너는 `gallery`일 때만 등록되므로(FileGridView.tsx:146)
 * 줌 배선을 보려면 이 경로여야 한다. 반환값이 리스너가 붙은 스크롤 컨테이너다.
 */
function renderGallery(): HTMLElement {
  const { container } = render(<FileGridView gallery />)
  const root = container.firstElementChild
  if (!(root instanceof HTMLElement)) throw new Error('FileGridView rendered no root element')
  return root
}

function gridCell(name: string): HTMLElement {
  const cell = screen.getByText(name).closest('[data-grid-cell]')
  if (!(cell instanceof HTMLElement)) throw new Error(`No grid cell for "${name}"`)
  return cell
}

beforeEach(() => {
  vi.clearAllMocks()
  layoutStub = stubGridLayout()
  apiMock = makeApiMock(vi.fn())
  vi.stubGlobal('api', apiMock)

  useFtpStore.setState({
    currentPath: REMOTE_DIR,
    entries: [ftpFile('a.txt'), ftpFile('b.txt')],
    connectionStatus: 'connected',
    host: 'example.org',
    port: 21
  })
  useSelectionStore.setState({ selectedNames: new Set(), lastClickedName: null })
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

// macOS 지원 D그룹. 원격 그리드도 독립된 배선 코드를 가지므로 따로 확인한다(D7).
describe('FileGridView — platform-aware selection modifiers', () => {
  it('single-selects on Ctrl+click on macOS instead of toggling', () => {
    // covers: Test-153
    apiMock.platform = 'darwin'
    renderGrid({ selected: ['b.txt'] })

    fireEvent.click(gridCell('a.txt'), { ctrlKey: true })

    expect(selectedNames()).toEqual(['a.txt'])
  })

  it('toggles the selection on Cmd+click on macOS', () => {
    // covers: Test-154
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

// G그룹 배선 검증(정정 2). 원격 그리드도 로컬과 별개의 wheel 배선을 갖는다.
// wheel은 { passive: false } 네이티브 리스너라 실제 WheelEvent를 디스패치해야 한다.
describe('FileGridView — gallery zoom modifiers', () => {
  it('zooms the gallery on Cmd+wheel on macOS', () => {
    // covers: Test-161
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
