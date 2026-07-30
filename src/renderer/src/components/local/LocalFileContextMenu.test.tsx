/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { useLocalFsStore } from '@renderer/stores/useLocalFsStore'
import { useLocalSelectionStore } from '@renderer/stores/useLocalSelectionStore'
import { useSettingsStore } from '@renderer/stores/useSettingsStore'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import { useTransferStore } from '@renderer/stores/useTransferStore'
import {
  invokeCalls as sharedInvokeCalls,
  makeApiMock,
  menuRoot,
  stubMenuViewport
} from '@renderer/test/rendererTestUtils'
import { INVALID_LOCAL_NAME_MESSAGE } from '@shared/entryName'
import type { LocalFileEntry } from '@shared/types/local'
import { LocalFileContextMenu } from './LocalFileContextMenu'

// 실패가 조용히 삼켜지지 않는지 보려면 토스트 호출을 관찰해야 한다.
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), message: vi.fn() }
}))
const toastError = vi.mocked(toast.error)

/** Windows 경로를 쓴다: joinLocalPath가 OS를 문자열로 감지하므로 하드코딩된 '/' 조합을 잡아낸다. */
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

function dirEntry(name: string): LocalFileEntry {
  return {
    name,
    path: `${LOCAL_DIR}\\${name}`,
    type: 'directory',
    size: 0,
    modifiedAt: MODIFIED_AT,
    isImage: false
  }
}

const mockInvoke = vi.fn()
const mockEnqueue = vi.fn()
const mockRefresh = vi.fn()

interface SetupOptions {
  entries: LocalFileEntry[]
  selected: string[]
  /** 우클릭된 항목. 빈 공간 우클릭이면 null. */
  entry: LocalFileEntry | null
  connected?: boolean
  confirmBeforeDelete?: boolean
  onShowProperties?: (entry: LocalFileEntry) => void
  /** 기본은 (10,10) — 뷰포트 보정과 무관한 대다수 테스트에 안전한 값. */
  position?: { x: number; y: number } | null
}

function setup(options: SetupOptions): {
  onClose: ReturnType<typeof vi.fn>
  /** Test-107/108: 메뉴가 열린 채로 position prop만 바꿔 재렌더한다(부모의 재오픈을 흉내). */
  rerenderPosition: (position: { x: number; y: number } | null) => void
} {
  useLocalFsStore.setState({
    currentPath: LOCAL_DIR,
    entries: options.entries,
    refresh: mockRefresh
  })
  useLocalSelectionStore.setState({
    selectedNames: new Set(options.selected),
    lastClickedName: null
  })
  useFtpStore.setState({
    currentPath: REMOTE_DIR,
    connectionStatus: options.connected ? 'connected' : 'disconnected'
  })
  useSettingsStore.setState({ confirmBeforeDelete: options.confirmBeforeDelete ?? false })
  useTransferStore.setState({ enqueue: mockEnqueue })

  const onClose = vi.fn()
  const menu = (position: { x: number; y: number } | null): React.JSX.Element => (
    <LocalFileContextMenu
      entry={options.entry}
      position={position}
      onClose={onClose}
      onShowProperties={options.onShowProperties}
    />
  )
  // `??`는 명시적 null(닫힌 메뉴)을 "생략됨"과 뭉개버린다. undefined일 때만 기본값을
  // 적용해, 원격 헬퍼(renderMenu의 기본 파라미터)와 같은 계약(null이면 닫힌 메뉴)을 지킨다.
  const initialPosition = options.position !== undefined ? options.position : { x: 10, y: 10 }
  const { rerender } = render(menu(initialPosition))
  const rerenderPosition = (position: { x: number; y: number } | null): void => {
    rerender(menu(position))
  }
  return { onClose, rerenderPosition }
}

function invokeCalls(channel: string): unknown[][] {
  return sharedInvokeCalls(mockInvoke, channel)
}

beforeEach(() => {
  vi.clearAllMocks()
  mockInvoke.mockResolvedValue({ success: true })
  vi.stubGlobal('api', makeApiMock(mockInvoke))
})

afterEach(() => {
  // RTL이 auto-cleanup을 등록하지만 그것은 이 훅보다 **나중에** 돈다(실측).
  // 언마운트가 아래 전역 해제보다 먼저 일어나도록 여기서 명시적으로 부른다.
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('LocalFileContextMenu — menu composition', () => {
  it('omits Upload when the selection is directories only', async () => {
    // covers: Test-49
    const docs = dirEntry('docs')
    setup({ entries: [docs], selected: ['docs'], entry: docs, connected: true })

    expect(screen.queryByRole('button', { name: /^Upload/ })).toBeNull()
    // 메뉴 자체는 떠 있어야 한다 — Upload만 빠진 것임을 보인다.
    expect(screen.queryByRole('button', { name: 'New Folder' })).not.toBeNull()
  })

  it('omits Rename when several items are selected', async () => {
    // covers: Test-50
    const a = fileEntry('a.txt')
    const b = fileEntry('b.txt')
    setup({ entries: [a, b], selected: ['a.txt', 'b.txt'], entry: a, connected: true })

    expect(screen.queryByRole('button', { name: 'Rename' })).toBeNull()
    // 메뉴가 아예 안 그려져도 통과하지 않도록, 다중 선택 메뉴가 떴음을 함께 본다.
    expect(screen.queryByRole('button', { name: 'Delete (2)' })).not.toBeNull()
  })

  it('shows the selected count in the Delete label for a multi selection', async () => {
    // covers: Test-51
    const a = fileEntry('a.txt')
    const b = fileEntry('b.txt')
    const docs = dirEntry('docs')
    setup({
      entries: [a, b, docs],
      selected: ['a.txt', 'b.txt', 'docs'],
      entry: a,
      connected: true
    })

    expect(screen.queryByRole('button', { name: 'Delete (3)' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
  })

  it('shows only New Folder when nothing is selected', async () => {
    // covers: Test-52
    setup({ entries: [fileEntry('a.txt')], selected: [], entry: null, connected: true })

    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['New Folder'])
  })

  it('omits Upload while FTP is disconnected', async () => {
    // covers: Test-53
    const a = fileEntry('a.txt')
    setup({ entries: [a], selected: ['a.txt'], entry: a, connected: false })

    expect(screen.queryByRole('button', { name: /^Upload/ })).toBeNull()
    // 연결 여부와 무관한 항목은 그대로 있어야 한다.
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeNull()
  })
})

describe('LocalFileContextMenu — actions', () => {
  it('deletes the selection through local:deleteBatch with each path and directory flag', async () => {
    // covers: Test-54
    const user = userEvent.setup()
    const docs = dirEntry('docs')
    const a = fileEntry('a.txt')
    setup({
      entries: [docs, a],
      selected: ['docs', 'a.txt'],
      entry: a,
      connected: true,
      confirmBeforeDelete: false
    })

    await user.click(screen.getByRole('button', { name: 'Delete (2)' }))

    await waitFor(() => {
      expect(invokeCalls('local:deleteBatch')).toHaveLength(1)
    })
    // 순서는 계약에 없으므로 결합하지 않는다. 구성과 개수만 고정한다.
    const targets = invokeCalls('local:deleteBatch')[0][0]
    expect(targets).toHaveLength(2)
    expect(targets).toEqual(
      expect.arrayContaining([
        { path: 'C:\\work\\docs', isDirectory: true },
        { path: 'C:\\work\\a.txt', isDirectory: false }
      ])
    )
  })

  it('does not delete when confirmBeforeDelete is on and the user cancels', async () => {
    // covers: Test-55
    const user = userEvent.setup()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const a = fileEntry('a.txt')
    setup({
      entries: [a],
      selected: ['a.txt'],
      entry: a,
      connected: true,
      confirmBeforeDelete: true
    })

    await user.click(screen.getByRole('button', { name: 'Delete' }))

    // 주의점 2: LocalExplorer의 Delete 키 경로와 같은 확인 메시지 규칙이어야 한다.
    expect(confirmSpy).toHaveBeenCalledWith('Delete "a.txt"?')
    expect(invokeCalls('local:deleteBatch')).toEqual([])
  })

  it('renames through local:rename with the old and the new path', async () => {
    // covers: Test-56
    const user = userEvent.setup()
    const a = fileEntry('a.txt')
    setup({ entries: [a], selected: ['a.txt'], entry: a, connected: true })

    await user.click(screen.getByRole('button', { name: 'Rename' }))
    const input = screen.getByRole('textbox')
    await user.clear(input)
    await user.type(input, 'renamed.txt{Enter}')

    await waitFor(() => {
      expect(invokeCalls('local:rename')).toEqual([['C:\\work\\a.txt', 'C:\\work\\renamed.txt']])
    })
  })

  it('does not rename when the name is unchanged or emptied', async () => {
    // covers: Test-57
    const user = userEvent.setup()
    const a = fileEntry('a.txt')

    // 1) 그대로 제출
    setup({ entries: [a], selected: ['a.txt'], entry: a, connected: true })
    await user.click(screen.getByRole('button', { name: 'Rename' }))
    await user.type(screen.getByRole('textbox'), '{Enter}')
    expect(invokeCalls('local:rename')).toEqual([])

    // 2) 비운 뒤 제출. no-op 제출 후 Rename 버튼이 되돌아온다는 보장은 계약에 없으므로
    //    앞 시나리오의 잔여 상태에 기대지 않고 새로 렌더한다.
    cleanup()
    setup({ entries: [a], selected: ['a.txt'], entry: a, connected: true })
    await user.click(screen.getByRole('button', { name: 'Rename' }))
    const input = screen.getByRole('textbox')
    await user.clear(input)
    await user.type(input, '{Enter}')

    expect(invokeCalls('local:rename')).toEqual([])
  })

  it('creates a folder through local:mkdir under the current path', async () => {
    // covers: Test-58
    const user = userEvent.setup()
    setup({ entries: [], selected: [], entry: null, connected: true })

    // 인라인 입력으로 받는다. window.prompt는 Electron이 예외를 던지므로 쓸 수 없다(§6).
    await user.click(screen.getByRole('button', { name: 'New Folder' }))
    await user.type(screen.getByRole('textbox'), 'New Docs{Enter}')

    await waitFor(() => {
      expect(invokeCalls('local:mkdir')).toEqual([['C:\\work\\New Docs']])
    })
  })

  it('queues one upload per selected file against the remote current path', async () => {
    // covers: Test-59
    const user = userEvent.setup()
    const docs = dirEntry('docs')
    const a = fileEntry('a.txt', 10)
    const b = fileEntry('b.txt', 20)
    setup({
      entries: [docs, a, b],
      selected: ['docs', 'a.txt', 'b.txt'],
      entry: a,
      connected: true
    })

    await user.click(screen.getByRole('button', { name: 'Upload (2)' }))

    await waitFor(() => {
      expect(mockEnqueue.mock.calls).toEqual([
        ['upload', 'C:\\work\\a.txt', '/remote/dir/a.txt', 'a.txt', 10],
        ['upload', 'C:\\work\\b.txt', '/remote/dir/b.txt', 'b.txt', 20]
      ])
    })
  })
})

// 주의점 7: 삭제·이름변경·폴더생성 뒤 목록을 갱신하지 않으면 화면이 낡은 채 남는다.
// 세 동작이 각각 독립된 코드 경로라 케이스를 분리해 둔다.
describe('LocalFileContextMenu — listing refresh', () => {
  it('refreshes the listing and clears the selection after a delete', async () => {
    // covers: Test-72
    const user = userEvent.setup()
    const a = fileEntry('a.txt')
    setup({
      entries: [a],
      selected: ['a.txt'],
      entry: a,
      connected: true,
      confirmBeforeDelete: false
    })

    await user.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => {
      expect(mockRefresh).toHaveBeenCalled()
    })
    expect([...useLocalSelectionStore.getState().selectedNames]).toEqual([])
  })

  it('refreshes the listing after a rename is submitted', async () => {
    // covers: Test-73
    const user = userEvent.setup()
    const a = fileEntry('a.txt')
    setup({ entries: [a], selected: ['a.txt'], entry: a, connected: true })

    await user.click(screen.getByRole('button', { name: 'Rename' }))
    const input = screen.getByRole('textbox')
    await user.clear(input)
    await user.type(input, 'renamed.txt{Enter}')

    await waitFor(() => {
      expect(mockRefresh).toHaveBeenCalled()
    })
  })

  it('refreshes the listing after a new folder is created', async () => {
    // covers: Test-74
    const user = userEvent.setup()
    setup({ entries: [], selected: [], entry: null, connected: true })

    await user.click(screen.getByRole('button', { name: 'New Folder' }))
    await user.type(screen.getByRole('textbox'), 'New Docs{Enter}')

    await waitFor(() => {
      expect(mockRefresh).toHaveBeenCalled()
    })
  })
})

// C-3: 적대적 리뷰가 찾아낸 결함들의 회귀 테스트.
describe('LocalFileContextMenu — failure handling and name validation', () => {
  /** 메뉴를 열고 인라인 입력에 이름을 넣어 제출한다. */
  async function submitInlineName(
    user: ReturnType<typeof userEvent.setup>,
    trigger: 'Rename' | 'New Folder',
    name: string
  ): Promise<void> {
    await user.click(screen.getByRole('button', { name: trigger }))
    const input = screen.getByRole('textbox')
    await user.clear(input)
    await user.type(input, `${name}{Enter}`)
  }

  it('still clears the selection, refreshes and closes when the IPC call rejects', async () => {
    // covers: Test-81
    const user = userEvent.setup()
    // preload 화이트리스트 거부처럼 invoke 자체가 reject하는 상황.
    mockInvoke.mockRejectedValue(new Error('channel not allowed'))
    const a = fileEntry('a.txt')
    const { onClose } = setup({
      entries: [a],
      selected: ['a.txt'],
      entry: a,
      connected: true,
      confirmBeforeDelete: false
    })

    await user.click(screen.getByRole('button', { name: 'Delete' }))

    // 세 가지 정리가 모두 일어나야 한다. 하나라도 건너뛰면 메뉴가 열린 채 멈춘다.
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled()
    })
    expect(mockRefresh).toHaveBeenCalled()
    expect([...useLocalSelectionStore.getState().selectedNames]).toEqual([])
  })

  it('rejects a rename to a name containing a path separator', async () => {
    // covers: Test-82
    const user = userEvent.setup()
    const a = fileEntry('a.txt')

    for (const unsafe of ['..\\other', 'sub/child']) {
      setup({ entries: [a], selected: ['a.txt'], entry: a, connected: true })
      await submitInlineName(user, 'Rename', unsafe)
      expect(invokeCalls('local:rename')).toEqual([])
      // §6: 위반 시 toast.error로 표면화한다. 조용히 무시하면 사용자는 이름이 왜
      // 그대로인지 알 수 없으므로, "거부"는 IPC 미호출과 표면화 둘 다를 뜻한다.
      expect(toastError).toHaveBeenCalledWith('Invalid name', {
        description: INVALID_LOCAL_NAME_MESSAGE
      })
      cleanup()
    }

    // 대조군: 구분자가 없는 이름은 정상 호출된다. 검증이 통째로 사라지거나
    // 반대로 모든 이름을 거부해도 이 대비에서 잡힌다.
    setup({ entries: [a], selected: ['a.txt'], entry: a, connected: true })
    await submitInlineName(user, 'Rename', 'renamed.txt')

    await waitFor(() => {
      expect(invokeCalls('local:rename')).toEqual([['C:\\work\\a.txt', 'C:\\work\\renamed.txt']])
    })
  })

  it('rejects a new folder name containing a path separator', async () => {
    // covers: Test-83
    const user = userEvent.setup()

    for (const unsafe of ['..\\other', 'sub/child']) {
      setup({ entries: [], selected: [], entry: null, connected: true })
      await submitInlineName(user, 'New Folder', unsafe)
      expect(invokeCalls('local:mkdir')).toEqual([])
      expect(toastError).toHaveBeenCalledWith('Invalid name', {
        description: INVALID_LOCAL_NAME_MESSAGE
      })
      cleanup()
    }

    // 대조군: 구분자가 없는 이름은 정상 호출된다.
    setup({ entries: [], selected: [], entry: null, connected: true })
    await submitInlineName(user, 'New Folder', 'New Docs')

    await waitFor(() => {
      expect(invokeCalls('local:mkdir')).toEqual([['C:\\work\\New Docs']])
    })
  })
})

describe('LocalFileContextMenu — inline input affordances', () => {
  /** 인라인 입력의 접근 가능한 이름. 스크린리더에 노출되는 유일한 설명이다. */
  function textboxLabel(): string {
    const input = screen.getByRole('textbox')
    const label = input.getAttribute('aria-label') ?? ''
    // 실제로 그 이름으로 조회되는지까지 확인해 aria-label이 접근성 트리에
    // 반영됨을 고정한다(속성만 붙어 있고 이름이 안 잡히는 경우를 배제).
    expect(screen.getByRole('textbox', { name: label })).toBe(input)
    return label
  }

  it('labels the inline input differently for rename and for a new folder', async () => {
    // covers: Test-93
    const user = userEvent.setup()
    const a = fileEntry('a.txt')

    setup({ entries: [a], selected: ['a.txt'], entry: a, connected: true })
    await user.click(screen.getByRole('button', { name: 'Rename' }))
    const renameLabel = textboxLabel()
    cleanup()

    setup({ entries: [], selected: [], entry: null, connected: true })
    await user.click(screen.getByRole('button', { name: 'New Folder' }))
    const newFolderLabel = textboxLabel()

    expect(renameLabel).not.toBe('')
    expect(newFolderLabel).not.toBe('')
    // 두 모드가 같은 문구로 붕괴하거나 서로 뒤바뀌는 변형을 함께 잡는다.
    // 정확한 카피에 결합하지 않도록 "폴더"라는 의미만 본다.
    expect(newFolderLabel).toMatch(/folder/i)
    expect(renameLabel).not.toMatch(/folder/i)
    expect(renameLabel).not.toBe(newFolderLabel)
  })

  it('cancels the inline input on Escape without calling IPC', async () => {
    // covers: Test-94
    const user = userEvent.setup()

    const { onClose } = setup({ entries: [], selected: [], entry: null, connected: true })
    await user.click(screen.getByRole('button', { name: 'New Folder' }))
    await user.type(screen.getByRole('textbox'), 'New Docs{Escape}')

    expect(invokeCalls('local:mkdir')).toEqual([])
    expect(onClose).toHaveBeenCalled()

    // 대조군: 같은 이름을 Enter로 내면 호출된다. "항상 취소" 변형을 잡는다.
    cleanup()
    setup({ entries: [], selected: [], entry: null, connected: true })
    await user.click(screen.getByRole('button', { name: 'New Folder' }))
    await user.type(screen.getByRole('textbox'), 'New Docs{Enter}')

    await waitFor(() => {
      expect(invokeCalls('local:mkdir')).toEqual([['C:\\work\\New Docs']])
    })
  })
})

// Test-87. Test-81이 다루는 reject 경로와 달리, invoke가 정상 resolve하면서
// { success: false }를 싣고 오는 경로다. 실패를 조용히 삼키면 사용자는 아무 일도
// 일어나지 않은 화면을 본다. `{ success: false }`를 반환하는 핸들러는 delete·rename·
// mkdir 셋이며(upload는 enqueue가 throw하는 reject 경로라 Test-81 형태다) 각각
// 독립된 호출 지점이므로 하나씩 확인한다.
describe('LocalFileContextMenu — failed IPC results surface as toasts', () => {
  it('surfaces a failed delete result', async () => {
    // covers: Test-87
    const user = userEvent.setup()
    mockInvoke.mockResolvedValue({ success: false, error: 'permission denied' })
    const a = fileEntry('a.txt')
    setup({
      entries: [a],
      selected: ['a.txt'],
      entry: a,
      connected: true,
      confirmBeforeDelete: false
    })

    await user.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith('Failed to delete', {
        description: 'permission denied'
      })
    })
  })

  it('surfaces a failed rename result', async () => {
    // covers: Test-87
    const user = userEvent.setup()
    mockInvoke.mockResolvedValue({ success: false, error: 'Target already exists: b.txt' })
    const a = fileEntry('a.txt')
    setup({ entries: [a], selected: ['a.txt'], entry: a, connected: true })

    await user.click(screen.getByRole('button', { name: 'Rename' }))
    const input = screen.getByRole('textbox')
    await user.clear(input)
    await user.type(input, 'b.txt{Enter}')

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith('Failed to rename', {
        description: 'Target already exists: b.txt'
      })
    })
  })

  it('surfaces a failed new folder result', async () => {
    // covers: Test-87
    const user = userEvent.setup()
    mockInvoke.mockResolvedValue({ success: false, error: 'EEXIST' })
    setup({ entries: [], selected: [], entry: null, connected: true })

    await user.click(screen.getByRole('button', { name: 'New Folder' }))
    await user.type(screen.getByRole('textbox'), 'New Docs{Enter}')

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith('Failed to create folder', {
        description: 'EEXIST'
      })
    })
  })
})

// B절: 위치 통합. getBoundingClientRect를 목해 메뉴 크기를 (160,200)으로,
// window.innerWidth/innerHeight를 (1000,800)으로 고정한다(LocalFileGridView.test.tsx의
// stubLayout 패턴을 따르되, 공용 헬퍼 stubMenuViewport로 중복을 피한다).
describe('LocalFileContextMenu — viewport clamping', () => {
  const MOCK_MENU_SIZE = { width: 160, height: 200 }
  const MOCK_VIEWPORT = { width: 1000, height: 800 }
  let viewportStub: ReturnType<typeof stubMenuViewport>

  beforeEach(() => {
    viewportStub = stubMenuViewport(MOCK_MENU_SIZE, MOCK_VIEWPORT)
  })

  afterEach(() => {
    viewportStub.restore()
  })

  it('flips the menu upward when it opens near the bottom edge', () => {
    // covers: Test-104
    const a = fileEntry('a.txt')
    setup({
      entries: [a],
      selected: ['a.txt'],
      entry: a,
      connected: true,
      position: { x: 10, y: 700 }
    })

    expect(menuRoot().style.top).toBe('500px')
  })

  it('keeps the anchor position when the menu fully fits the viewport', () => {
    // covers: Test-106
    const a = fileEntry('a.txt')
    setup({
      entries: [a],
      selected: ['a.txt'],
      entry: a,
      connected: true,
      position: { x: 10, y: 10 }
    })

    expect(menuRoot().style.left).toBe('10px')
    expect(menuRoot().style.top).toBe('10px')
  })

  it('keeps the flipped position after switching to the inline rename input', async () => {
    // covers: Test-107
    // Test-108과 짝이다. 이 케이스만 있으면 위치를 영영 갱신하지 않는 구현도 통과한다.
    // editing 브랜치는 New Folder 버튼을 렌더하지 않으므로(Test-52) 루트는 그 전에
    // 한 번만 잡아 참조를 재사용한다(같은 외곽 div가 재사용되므로 유효하다).
    // 메뉴 크기를 입력창 한 줄(60px)로 줄여, "전환 시 다시 측정하면 더 이상 넘치지
    // 않아 700px로 돌아가는" 재측정 구현(핸드오프 §5 기각안)을 걸러낸다.
    // 700+60=760<=796이라 재측정 구현이면 top이 700px가 되어 이 단언이 실패한다.
    // 한계: "크기를 (160,200)으로 하드코딩한" 구현은 B절 전체를 통과한다. 잡으려면
    // Test-104/108의 확정 기대값을 바꿔야 해 §6 1:1 금지에 걸리므로, D6(useLayoutEffect
    // +ref 실측) 준수는 구현 리뷰와 §8-5 E2E 실측으로 확인한다.
    const user = userEvent.setup()
    const a = fileEntry('a.txt')
    setup({
      entries: [a],
      selected: ['a.txt'],
      entry: a,
      connected: true,
      position: { x: 10, y: 700 }
    })
    const root = menuRoot()
    expect(root.style.top).toBe('500px')

    viewportStub.setMenuSize({ width: 160, height: 60 })
    await user.click(screen.getByRole('button', { name: 'Rename' }))

    expect(screen.getByRole('textbox')).not.toBeNull()
    expect(root.style.top).toBe('500px')
  })

  it('recomputes the position on every reopen', () => {
    // covers: Test-108
    const a = fileEntry('a.txt')
    const { rerenderPosition } = setup({
      entries: [a],
      selected: ['a.txt'],
      entry: a,
      connected: true,
      position: { x: 10, y: 700 }
    })
    expect(menuRoot().style.top).toBe('500px')

    rerenderPosition(null)
    rerenderPosition({ x: 10, y: 10 })

    expect(menuRoot().style.top).toBe('10px')
  })
})

// C절: 닫기 트리거 5종(D9). 위치 보정과 무관하므로 기본 (10,10)로 연다.
describe('LocalFileContextMenu — dismiss triggers', () => {
  function openMenu(): { onClose: ReturnType<typeof vi.fn> } {
    const a = fileEntry('a.txt')
    return setup({ entries: [a], selected: ['a.txt'], entry: a, connected: true })
  }

  it('closes on an outside left click', () => {
    // covers: Test-109
    const { onClose } = openMenu()

    fireEvent.click(document.body)

    expect(onClose).toHaveBeenCalled()
  })

  it('does not close on a click inside the menu', () => {
    // covers: Test-110
    const { onClose } = openMenu()

    fireEvent.click(menuRoot())

    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes on Escape while showing the button list', () => {
    // covers: Test-111
    const { onClose } = openMenu()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(onClose).toHaveBeenCalled()
  })

  it('closes on an outside right click', () => {
    // covers: Test-112
    const { onClose } = openMenu()

    fireEvent.contextMenu(document.body)

    expect(onClose).toHaveBeenCalled()
  })

  it('does not close on a right click inside the menu', () => {
    // covers: Test-113
    const { onClose } = openMenu()

    fireEvent.contextMenu(menuRoot())

    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes when the window loses focus', () => {
    // covers: Test-115
    const { onClose } = openMenu()

    fireEvent.blur(window)

    expect(onClose).toHaveBeenCalled()
  })

  it('closes when a scroll container outside the menu scrolls', () => {
    // covers: Test-116
    // 함정 2: 내부 스크롤은 document까지 버블링되지 않는다. capture 단계 등록이
    // 없으면 이 테스트가 RED가 된다.
    const { onClose } = openMenu()
    const scrollContainer = document.createElement('div')
    document.body.appendChild(scrollContainer)

    try {
      fireEvent.scroll(scrollContainer)
      expect(onClose).toHaveBeenCalled()
    } finally {
      document.body.removeChild(scrollContainer)
    }
  })
})
