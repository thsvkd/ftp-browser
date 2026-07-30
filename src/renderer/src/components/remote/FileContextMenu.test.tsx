/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import { useSelectionStore } from '@renderer/stores/useSelectionStore'
import { useSettingsStore } from '@renderer/stores/useSettingsStore'
import {
  invokeCalls,
  makeApiMock,
  menuRoot,
  stubMenuViewport
} from '@renderer/test/rendererTestUtils'
import { INVALID_REMOTE_NAME_MESSAGE } from '@shared/entryName'
import type { FtpFileEntry } from '@shared/types/ftp'
import { FileContextMenu } from './FileContextMenu'

// 실패가 조용히 삼켜지지 않는지 보려면 토스트 호출을 관찰해야 한다.
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), message: vi.fn() }
}))
const toastError = vi.mocked(toast.error)

// 원격 경로는 POSIX 고정이다(`currentPath === '/' ? ... : ...`).
// 로컬의 joinLocalPath와 달리 OS를 감지하지 않는다.
const REMOTE_DIR = '/remote/dir'

const mockInvoke = vi.fn()
const mockRefresh = vi.fn()

function ftpFile(name: string, size = 1024): FtpFileEntry {
  return {
    name,
    type: 'file',
    size,
    modifiedAt: '2024-05-01T10:20:30.000Z',
    rawModifiedAt: '2024-05-01T10:20:30.000Z',
    isImage: false
  }
}

function calls(channel: string): unknown[][] {
  return invokeCalls(mockInvoke, channel)
}

/**
 * 메뉴를 렌더한다. `entry`가 null이면 빈 공간 우클릭에 해당한다.
 * `position` 기본은 (10,10) — 뷰포트 보정과 무관한 대다수 테스트에 안전한 값.
 */
function renderMenu(
  entry: FtpFileEntry | null,
  position: { x: number; y: number } | null = { x: 10, y: 10 }
): {
  onClose: ReturnType<typeof vi.fn>
  /** Test-107/108: 메뉴가 열린 채로 position prop만 바꿔 재렌더한다(부모의 재오픈을 흉내). */
  rerenderPosition: (position: { x: number; y: number } | null) => void
} {
  useFtpStore.setState({
    currentPath: REMOTE_DIR,
    entries: entry ? [entry] : [],
    connectionStatus: 'connected',
    refresh: mockRefresh
  })
  useSelectionStore.setState({
    selectedNames: new Set(entry ? [entry.name] : []),
    lastClickedName: null
  })
  const onClose = vi.fn()
  const menu = (pos: { x: number; y: number } | null): React.JSX.Element => (
    <FileContextMenu entry={entry} position={pos} onClose={onClose} />
  )
  const { rerender } = render(menu(position))
  const rerenderPosition = (pos: { x: number; y: number } | null): void => {
    rerender(menu(pos))
  }
  return { onClose, rerenderPosition }
}

/** 메뉴를 열고 인라인 입력에 이름을 넣어 Enter로 제출한다. */
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

beforeEach(() => {
  vi.clearAllMocks()
  mockInvoke.mockResolvedValue({ success: true })
  vi.stubGlobal('api', makeApiMock(mockInvoke))
  useSettingsStore.setState({ confirmBeforeDelete: false })
})

afterEach(() => {
  // RTL이 auto-cleanup을 등록하지만 그것은 이 훅보다 **나중에** 돈다(실측).
  // 언마운트가 아래 전역 해제보다 먼저 일어나도록 여기서 명시적으로 부른다.
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('FileContextMenu — inline name input', () => {
  it('creates a remote folder through ftp:mkdir from the inline input', async () => {
    // covers: Test-84
    // 원격 패널도 window.prompt를 썼고, Electron이 prompt를 막아 예외를 던지는 탓에
    // 실제 앱에서는 한 번도 동작하지 않았다. 인라인 입력으로 고친 것에 대한 회귀 테스트다.
    const user = userEvent.setup()
    renderMenu(null)

    await submitInlineName(user, 'New Folder', 'New Docs')

    await waitFor(() => {
      expect(calls('ftp:mkdir')).toEqual([['/remote/dir/New Docs']])
    })
  })

  it('renames through ftp:rename with the old and the new path', async () => {
    // covers: Test-89
    const user = userEvent.setup()
    renderMenu(ftpFile('a.txt'))

    await submitInlineName(user, 'Rename', 'renamed.txt')

    await waitFor(() => {
      expect(calls('ftp:rename')).toEqual([['/remote/dir/a.txt', '/remote/dir/renamed.txt']])
    })
  })

  it('rejects a name containing a path separator before reaching IPC', async () => {
    // covers: Test-90
    const user = userEvent.setup()

    // 원격의 구분자는 `/` 하나뿐이다. `\`는 FTP 파일명에서 합법이므로
    // 여기 목록에 넣으면 안 된다(로컬 Test-82/83과 갈리는 지점).
    for (const unsafe of ['sub/child', '../escape']) {
      renderMenu(ftpFile('a.txt'))
      await submitInlineName(user, 'Rename', unsafe)
      expect(calls('ftp:rename')).toEqual([])
      // §6: 위반 시 toast.error로 표면화한다. "거부"는 IPC 미호출과 표면화 둘 다다.
      expect(toastError).toHaveBeenCalledWith('Invalid name', {
        description: INVALID_REMOTE_NAME_MESSAGE
      })
      cleanup()

      renderMenu(null)
      await submitInlineName(user, 'New Folder', unsafe)
      expect(calls('ftp:mkdir')).toEqual([])
      expect(toastError).toHaveBeenCalledWith('Invalid name', {
        description: INVALID_REMOTE_NAME_MESSAGE
      })
      cleanup()
    }

    // 대조군: 구분자가 없는 이름은 정상 호출된다. 검증이 통째로 사라지거나
    // 반대로 모든 이름을 거부해도 이 대비에서 잡힌다.
    renderMenu(null)
    await submitInlineName(user, 'New Folder', 'New Docs')

    await waitFor(() => {
      expect(calls('ftp:mkdir')).toEqual([['/remote/dir/New Docs']])
    })
  })
})

describe('FileContextMenu — inline input affordances', () => {
  /** 인라인 입력의 접근 가능한 이름. */
  function textboxLabel(): string {
    const input = screen.getByRole('textbox')
    const label = input.getAttribute('aria-label') ?? ''
    expect(screen.getByRole('textbox', { name: label })).toBe(input)
    return label
  }

  it('labels the inline input differently for rename and for a new folder', async () => {
    // covers: Test-93
    const user = userEvent.setup()

    renderMenu(ftpFile('a.txt'))
    await user.click(screen.getByRole('button', { name: 'Rename' }))
    const renameLabel = textboxLabel()
    cleanup()

    renderMenu(null)
    await user.click(screen.getByRole('button', { name: 'New Folder' }))
    const newFolderLabel = textboxLabel()

    expect(renameLabel).not.toBe('')
    expect(newFolderLabel).not.toBe('')
    expect(newFolderLabel).toMatch(/folder/i)
    expect(renameLabel).not.toMatch(/folder/i)
    expect(renameLabel).not.toBe(newFolderLabel)
  })

  it('cancels the inline input on Escape without calling IPC', async () => {
    // covers: Test-94
    const user = userEvent.setup()

    const { onClose } = renderMenu(null)
    await user.click(screen.getByRole('button', { name: 'New Folder' }))
    await user.type(screen.getByRole('textbox'), 'New Docs{Escape}')

    expect(calls('ftp:mkdir')).toEqual([])
    // "취소된다"는 IPC 미호출만이 아니라 입력이 실제로 닫히는 것까지를 뜻한다.
    // 이것이 없으면 Escape 분기를 통째로 없애는 변형이 살아남는다.
    expect(onClose).toHaveBeenCalled()

    // 대조군: 같은 이름을 Enter로 내면 호출된다. "항상 취소" 변형을 잡는다.
    cleanup()
    renderMenu(null)
    await user.click(screen.getByRole('button', { name: 'New Folder' }))
    await user.type(screen.getByRole('textbox'), 'New Docs{Enter}')

    await waitFor(() => {
      expect(calls('ftp:mkdir')).toEqual([['/remote/dir/New Docs']])
    })
  })

  it('does not rename when the name is unchanged or emptied', async () => {
    // covers: Test-95
    const user = userEvent.setup()
    const a = ftpFile('a.txt')

    // 1) 그대로 제출
    renderMenu(a)
    await user.click(screen.getByRole('button', { name: 'Rename' }))
    await user.type(screen.getByRole('textbox'), '{Enter}')
    expect(calls('ftp:rename')).toEqual([])

    // 2) 비운 뒤 제출. no-op 제출 후의 잔여 상태에 기대지 않도록 새로 렌더한다.
    cleanup()
    renderMenu(a)
    await user.click(screen.getByRole('button', { name: 'Rename' }))
    const input = screen.getByRole('textbox')
    await user.clear(input)
    await user.type(input, '{Enter}')

    expect(calls('ftp:rename')).toEqual([])
  })
})

// Test-91. invoke가 정상 resolve하면서 { success: false }를 싣고 오는 경로다.
// FTP의 550(권한 거부)·553(이름 거부)이 여기로 온다. 반환값을 안 보면 조용히 통과한다.
describe('FileContextMenu — failed IPC results surface as toasts', () => {
  it('surfaces a failed rename result', async () => {
    // covers: Test-91
    const user = userEvent.setup()
    mockInvoke.mockResolvedValue({ success: false, error: '550 Permission denied' })
    renderMenu(ftpFile('a.txt'))

    await submitInlineName(user, 'Rename', 'renamed.txt')

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith('Failed to rename', {
        description: '550 Permission denied'
      })
    })
  })

  it('surfaces a failed new folder result', async () => {
    // covers: Test-91
    const user = userEvent.setup()
    mockInvoke.mockResolvedValue({ success: false, error: '553 Name not allowed' })
    renderMenu(null)

    await submitInlineName(user, 'New Folder', 'New Docs')

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith('Failed to create folder', {
        description: '553 Name not allowed'
      })
    })
  })
})

// B절: 위치 통합. getBoundingClientRect를 목해 메뉴 크기를 (160,200)으로,
// window.innerWidth/innerHeight를 (1000,800)으로 고정한다.
describe('FileContextMenu — viewport clamping', () => {
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
    // covers: Test-105
    renderMenu(ftpFile('a.txt'), { x: 10, y: 700 })

    expect(menuRoot().style.top).toBe('500px')
  })

  it('keeps the anchor position when the menu fully fits the viewport', () => {
    // covers: Test-106
    renderMenu(ftpFile('a.txt'), { x: 10, y: 10 })

    expect(menuRoot().style.left).toBe('10px')
    expect(menuRoot().style.top).toBe('10px')
  })

  it('keeps the flipped position after switching to the inline rename input', async () => {
    // covers: Test-107
    // Test-108과 짝이다. 이 케이스만 있으면 위치를 영영 갱신하지 않는 구현도 통과한다.
    // editing 브랜치는 New Folder 버튼을 렌더하지 않으므로 루트는 그 전에 한 번만
    // 잡아 참조를 재사용한다(같은 외곽 div가 재사용되므로 유효하다).
    // 메뉴 크기를 입력창 한 줄(60px)로 줄여, "전환 시 다시 측정하면 더 이상 넘치지
    // 않아 700px로 돌아가는" 재측정 구현(핸드오프 §5 기각안)을 걸러낸다.
    // 700+60=760<=796이라 재측정 구현이면 top이 700px가 되어 이 단언이 실패한다.
    // 한계: "크기를 (160,200)으로 하드코딩한" 구현은 B절 전체를 통과한다. 잡으려면
    // Test-105/108의 확정 기대값을 바꿔야 해 §6 1:1 금지에 걸리므로, D6(useLayoutEffect
    // +ref 실측) 준수는 구현 리뷰와 §8-5 E2E 실측으로 확인한다.
    const user = userEvent.setup()
    renderMenu(ftpFile('a.txt'), { x: 10, y: 700 })
    const root = menuRoot()
    expect(root.style.top).toBe('500px')

    viewportStub.setMenuSize({ width: 160, height: 60 })
    await user.click(screen.getByRole('button', { name: 'Rename' }))

    expect(screen.getByRole('textbox')).not.toBeNull()
    expect(root.style.top).toBe('500px')
  })

  it('recomputes the position on every reopen', () => {
    // covers: Test-108
    const { rerenderPosition } = renderMenu(ftpFile('a.txt'), { x: 10, y: 700 })
    expect(menuRoot().style.top).toBe('500px')

    rerenderPosition(null)
    rerenderPosition({ x: 10, y: 10 })

    expect(menuRoot().style.top).toBe('10px')
  })
})

// C절: 닫기 트리거 5종(D9). 위치 보정과 무관하므로 기본 (10,10)로 연다.
describe('FileContextMenu — dismiss triggers', () => {
  function openMenu(): { onClose: ReturnType<typeof vi.fn> } {
    return renderMenu(ftpFile('a.txt'))
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
