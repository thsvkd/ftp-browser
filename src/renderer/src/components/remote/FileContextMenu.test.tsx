/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { useFtpStore } from '@renderer/stores/useFtpStore'
import { useSelectionStore } from '@renderer/stores/useSelectionStore'
import { useSettingsStore } from '@renderer/stores/useSettingsStore'
import { invokeCalls, makeApiMock } from '@renderer/test/rendererTestUtils'
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

/** 메뉴를 렌더한다. `entry`가 null이면 빈 공간 우클릭에 해당한다. */
function renderMenu(entry: FtpFileEntry | null): { onClose: ReturnType<typeof vi.fn> } {
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
  render(<FileContextMenu entry={entry} position={{ x: 10, y: 10 }} onClose={onClose} />)
  return { onClose }
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
