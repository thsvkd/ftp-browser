/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import { useSelectionStore } from '@renderer/stores/useSelectionStore'
import { useSettingsStore } from '@renderer/stores/useSettingsStore'
import { useContextMenuStore, CONTEXT_MENU_OWNERS } from '@renderer/stores/useContextMenuStore'
import {
  makeApiMock,
  queryMenu,
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
  // 소유권 스토어는 모듈 싱글턴이라 앞 테스트가 남긴 ownerId가 다음 테스트의
  // 마운트 직후 effect에 걸린다. 초기화하지 않으면 실행 순서에 따라 결과가 갈린다.
  useContextMenuStore.setState({ ownerId: null })
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

// 소유권 배선(B절). 스토어 단위 테스트만으로는 뷰가 그 스토어를 실제로 쓰는지 알 수 없어
// (함정 C) 배선을 통째로 빼먹어도 전부 통과한다. 원격 리스트는 로컬과 별개의 배선 코드를
// 가지므로 여기서 따로 메운다.
describe('FileListView — context menu ownership wiring', () => {
  it('closes its menu when ownership moves to another view', () => {
    // covers: Test-228
    renderList()
    fireEvent.contextMenu(screen.getByText('a.txt'))
    expect(queryMenu()).not.toBeNull()
    // 우클릭이 소유권을 실제로 주장해야 반대편 뷰가 자기 메뉴를 닫는다. 이 단언이 없으면
    // 뷰에서 claimMenu 호출을 통째로 지워도 이 테스트가 통과한다 — ownerId가 계속 null이라
    // 아래 소유권 이동이 여전히 "내 id가 아님"을 만들어 메뉴가 닫히기 때문이다.
    expect(useContextMenuStore.getState().ownerId).toBe(CONTEXT_MENU_OWNERS.remoteList)

    // 두 패널을 한 테스트에 함께 띄우는 경로는 없다(그건 E2E 몫). 소유권 이동만 필요하므로
    // 스토어의 open을 다른 id로 직접 부른다. 로컬 뷰 자체의 배선은 Test-225가 따로 덮는다.
    act(() => {
      useContextMenuStore.getState().open(CONTEXT_MENU_OWNERS.localList)
    })

    expect(queryMenu()).toBeNull()
  })
})
