/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import { useSelectionStore } from '@renderer/stores/useSelectionStore'
import { useSettingsStore } from '@renderer/stores/useSettingsStore'
import {
  makeApiMock,
  remoteSelectedNames as selectedNames,
  type ApiMock
} from '@renderer/test/rendererTestUtils'
import type { FtpFileEntry } from '@shared/types/ftp'
import { FileListView } from './FileListView'

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

function renderList(options: { selected?: string[] } = {}): void {
  useFtpStore.setState({
    currentPath: REMOTE_DIR,
    entries: [ftpFile('a.txt'), ftpFile('b.txt')]
  })
  useSelectionStore.setState({
    selectedNames: new Set(options.selected ?? []),
    lastClickedName: null
  })

  render(<FileListView />)
}

beforeEach(() => {
  vi.clearAllMocks()
  apiMock = makeApiMock(vi.fn())
  vi.stubGlobal('api', apiMock)

  useFtpStore.setState({ connectionStatus: 'connected', host: 'example.org', port: 21 })
  useSettingsStore.setState({ confirmBeforeDelete: false, showHidden: false })
})

afterEach(() => {
  // RTL이 auto-cleanup을 등록하지만 그것은 이 훅보다 **나중에** 돈다(실측).
  // 언마운트가 아래 전역 해제보다 먼저 일어나도록 여기서 명시적으로 부른다.
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// macOS 지원 D그룹. 원격 리스트는 로컬과 별개의 배선 코드를 가지므로 따로 확인한다(D7).
describe('FileListView — platform-aware selection modifiers', () => {
  it('single-selects on Ctrl+click on macOS instead of toggling', () => {
    // covers: Test-151
    apiMock.platform = 'darwin'
    renderList({ selected: ['b.txt'] })

    fireEvent.click(screen.getByText('a.txt'), { ctrlKey: true })

    expect(selectedNames()).toEqual(['a.txt'])
  })

  it('toggles the selection on Cmd+click on macOS', () => {
    // covers: Test-152
    apiMock.platform = 'darwin'
    renderList({ selected: ['b.txt'] })
    const row = screen.getByText('a.txt')

    fireEvent.click(row, { metaKey: true })
    expect(selectedNames()).toEqual(['a.txt', 'b.txt'])

    // 토글이므로 같은 항목을 다시 누르면 빠진다. 이 왕복이 없으면
    // "항상 선택에 더하기만" 하는 구현도 통과한다.
    fireEvent.click(row, { metaKey: true })
    expect(selectedNames()).toEqual(['b.txt'])
  })
})
