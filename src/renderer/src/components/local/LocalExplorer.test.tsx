/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { toast } from 'sonner'
import { useLocalFsStore } from '@renderer/stores/useLocalFsStore'
import { useSettingsStore } from '@renderer/stores/useSettingsStore'
import { invokeCalls, makeApiMock } from '@renderer/test/rendererTestUtils'
import { en } from '@renderer/i18n/locales/en'
import { LocalExplorer } from './LocalExplorer'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), message: vi.fn() }
}))
const toastError = vi.mocked(toast.error)

const mockInvoke = vi.fn()

/** 원격 패널에서 끌어온 파일들을 로컬 패널에 놓는다(원격 패널이 쓰는 커스텀 MIME). */
function dropRemoteFiles(
  root: HTMLElement,
  files: Array<{ remotePath: string; fileName: string; size: number }>
): void {
  const payload = JSON.stringify(files)
  fireEvent.drop(root, {
    dataTransfer: {
      types: ['application/x-remote-files'],
      files: [],
      getData: (type: string) => (type === 'application/x-remote-files' ? payload : '')
    }
  })
}

function renderExplorer(localDir: string): HTMLElement {
  // currentPath가 있으면 init()이 돌지 않아 목 IPC만으로 렌더된다.
  useLocalFsStore.setState({ currentPath: localDir, entries: [], loading: false, error: null })
  const { container } = render(<LocalExplorer />)
  const root = container.firstElementChild
  if (!(root instanceof HTMLElement)) throw new Error('LocalExplorer rendered no root element')
  return root
}

beforeEach(() => {
  vi.clearAllMocks()
  mockInvoke.mockResolvedValue({ success: true, data: [] })
  vi.stubGlobal('api', makeApiMock(mockInvoke))
  useSettingsStore.setState({ localViewMode: 'list' })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// 원격 이름은 서버가 정한다. POSIX 서버의 `..\..\x`를 그대로 붙이면 Windows에서 현재
// 폴더 밖에 쓰고, `a:b`는 `a`의 대체 데이터 스트림이 된다.
describe('LocalExplorer — dropping remote files', () => {
  it('saves hostile names under sanitised names inside the current folder', async () => {
    const root = renderExplorer('C:\\work')

    dropRemoteFiles(root, [
      { remotePath: '/srv/..\\..\\evil.dll', fileName: '..\\..\\evil.dll', size: 3 },
      { remotePath: '/srv/a:b', fileName: 'a:b', size: 4 }
    ])

    await waitFor(() => expect(invokeCalls(mockInvoke, 'transfer:enqueueBatch')).toHaveLength(1))
    expect(invokeCalls(mockInvoke, 'transfer:enqueueBatch')[0][0]).toMatchObject({
      direction: 'download',
      items: [
        {
          localPath: 'C:\\work\\.._.._evil.dll',
          remotePath: '/srv/..\\..\\evil.dll',
          fileName: '..\\..\\evil.dll',
          totalBytes: 3
        },
        { localPath: 'C:\\work\\a_b', remotePath: '/srv/a:b', fileName: 'a:b', totalBytes: 4 }
      ]
    })
  })

  it('skips a name that cannot be saved, says so, and still downloads the rest', async () => {
    const root = renderExplorer('C:\\work')

    dropRemoteFiles(root, [
      { remotePath: '/srv/..', fileName: '..', size: 1 },
      { remotePath: '/srv/ok.txt', fileName: 'ok.txt', size: 2 }
    ])

    await waitFor(() => expect(invokeCalls(mockInvoke, 'transfer:enqueueBatch')).toHaveLength(1))
    expect(toastError).toHaveBeenCalledWith(en['toast.unsafeNamesSkipped'], { description: '..' })
    expect(invokeCalls(mockInvoke, 'transfer:enqueueBatch')[0][0]).toMatchObject({
      items: [{ localPath: 'C:\\work\\ok.txt', fileName: 'ok.txt' }]
    })
  })
})
