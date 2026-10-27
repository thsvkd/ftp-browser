/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { toast } from 'sonner'
import { en } from '@renderer/i18n/locales/en'
import { fromFtpEntry, fromLocalEntry, type ExplorerEntry } from '@renderer/lib/explorerEntry'
import { emptyDraft } from '@renderer/lib/serverAddress'
import { useServerStore } from '@renderer/stores/useServerStore'
import { useShelfStore } from '@renderer/stores/useShelfStore'
import { useTabsStore, visiblePanes } from '@renderer/stores/useTabsStore'
import { invokeCalls } from '@renderer/test/rendererTestUtils'
import {
  ftp,
  local,
  localLoc,
  remoteLoc,
  server,
  setConnection,
  setupExplorer,
  type ExplorerHarness
} from '@renderer/components/explorer/explorerTestHarness'
import { AppShell } from '@renderer/components/layout/AppShell'
import { ConflictSheet } from '@renderer/components/activity/ConflictSheet'
import { ConfirmDialog } from '@renderer/components/common/ConfirmDialog'
import { useDnd } from '@renderer/components/explorer/dnd'
import { installDropGuard } from '@renderer/lib/osDropGuard'
import type { FtpServer } from '@shared/types/ftp'
import type { LocalFileEntry } from '@shared/types/local'
import { Shelf } from './Shelf'

/** 원격 채널의 호출 인자. 첫 인자(연결 키)가 연결된 서버인지 보고 뗀다. */
function remoteCalls(invoke: Parameters<typeof invokeCalls>[0], channel: string): unknown[][] {
  return invokeCalls(invoke, channel).map(([conn, ...args]) => {
    expect(conn).toBe(server())
    return args
  })
}

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
  Toaster: () => null
}))

let h: ExplorerHarness
// 내려놓으면 더미가 활동 알약으로 날아간다(Web Animations). jsdom에는 없다.
beforeEach(() => {
  HTMLElement.prototype.animate = vi.fn(() => ({}) as Animation)
})
afterEach(() => {
  cleanup()
  h.restore()
  Reflect.deleteProperty(HTMLElement.prototype, 'animate')
})

const remoteItem = (name: string): ExplorerEntry =>
  fromFtpEntry(ftp(name, { size: 1024 }), '/x', server())
const localItem = (name: string): ExplorerEntry =>
  fromLocalEntry(local('C:\\pics', name, { size: 2048 }))
const shelfNames = (): string[] => useShelfStore.getState().items.map((i) => i.entry.name)
const row = (name: string): HTMLElement =>
  within(screen.getByRole('list', { name: en['shelf.items'] })).getByRole('listitem', {
    name: new RegExp(`^${name.replace('.', '\\.')},`)
  })

describe('Shelf — list and drop button', () => {
  it('shows each item with source dot, size and direction, removes with Delete and names the drop', () => {
    // covers: Test-806
    h = setupExplorer({ remote: { '/DCIM/2024': [] } })
    useShelfStore.getState().add([localItem('b.jpg'), localItem('c.jpg'), remoteItem('a.jpg')])
    useTabsStore.getState().openTab(remoteLoc('/DCIM/2024'))
    render(<Shelf />)

    expect(row('b.jpg').getAttribute('aria-label')).toBe(`b.jpg, ${en['sidebar.thisPc']}, 2 KB`)
    expect(row('a.jpg').getAttribute('aria-label')).toBe('a.jpg, example.org:21, 1 KB')
    expect(row('b.jpg').querySelector('[data-side="local"]')).toBeTruthy()
    expect(row('a.jpg').querySelector('[data-side="remote"]')).toBeTruthy()
    // 원격 탭에서 로컬 항목은 올라가고(↑), 같은 쪽 항목은 방향이 없다.
    expect(row('b.jpg').textContent).toContain('↑')
    expect(row('a.jpg').textContent).not.toMatch(/[↑↓]/)
    // 버튼 문구: 동사·수·목적지 이름, 둘째 줄은 출처와 전체 경로
    expect(
      screen.getByRole('button', {
        name: /^Upload 2 · Move 1 to 2024\s*→ example\.org:21 › \/DCIM\/2024/
      })
    ).toBeTruthy()

    row('a.jpg').focus()
    fireEvent.keyDown(row('a.jpg'), { key: 'Delete' })
    expect(shelfNames()).toEqual(['b.jpg', 'c.jpg'])
    expect(document.activeElement).toBe(row('c.jpg'))
    const drop = screen.getByRole('button', { name: /^Upload 2 to 2024\s*→/ })
    expect(drop.hasAttribute('disabled')).toBe(false)

    // 막히면 사유와 함께 비활성
    act(() => setConnection(server(), 'disconnected'))
    const blocked = screen.getByRole('button', { name: new RegExp(en['shelf.cantDropHere']) })
    expect(blocked.hasAttribute('disabled')).toBe(true)
    expect(blocked.textContent).toContain(en['send.invalidNotConnected'])
  })
})

describe('Shelf — the open island panel', () => {
  it('heads with count, size, sources, clear and collapse, ends with the hint and the drop, and moves focus with left and right', () => {
    // covers: Test-1325
    h = setupExplorer({ remote: { '/DCIM/2024': [] } })
    useShelfStore.getState().add([localItem('b.jpg'), localItem('c.jpg'), remoteItem('a.jpg')])
    useShelfStore.getState().setDockOpen(true)
    useTabsStore.getState().openTab(remoteLoc('/DCIM/2024'))
    render(<Shelf />)

    expect(screen.getByText('3 items')).toBeTruthy()
    expect(screen.getByText('5 KB')).toBeTruthy()
    expect(screen.getByText(en['sidebar.thisPc']).parentElement?.textContent).toContain('2')
    expect(screen.getByText('example.org:21').parentElement?.textContent).toContain('1')
    expect(screen.getByText(en['shelf.panelHint'])).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Upload 2 · Move 1 to 2024\s*→/ })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: en['shelf.collapse'] }))
    expect(useShelfStore.getState().dockOpen).toBe(false)

    row('b.jpg').focus()
    fireEvent.keyDown(row('b.jpg'), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(row('c.jpg'))
    fireEvent.keyDown(row('c.jpg'), { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(row('b.jpg'))

    fireEvent.click(screen.getByRole('button', { name: en['shelf.clear'] }))
    expect(shelfNames()).toEqual([])
  })
})

describe('Shelf — dropping into the active tab', () => {
  const setup = (): void => {
    h = setupExplorer({ local: { 'C:\\dl': [] } })
    h.handlers['transfer:send'] = () => ({
      success: true,
      data: { batchId: 'b1', ids: ['t1'], skipped: [], conflicts: [], totalBytes: 1024 }
    })
    useTabsStore.getState().openTab(localLoc('C:\\dl'))
  }
  const sends = (): unknown[][] => remoteCalls(h.invoke, 'transfer:send')

  it('downloads remote items into the local tab by button, Enter and Ctrl+Enter anywhere, and empties the shelf', async () => {
    // covers: Test-807
    setup()
    render(<AppShell />)
    // 선반 카드는 담은 뒤에야 뜬다(F3): 빈 폴더엔 listbox가 없어 경로 막대로 셸을 기다린다.
    await screen.findByRole('navigation', { name: en['path.label'] })

    useShelfStore.getState().add([remoteItem('a.jpg')])
    fireEvent.click(
      await screen.findByRole('button', { name: /^Download 1 to dl\s*→ This PC › C:\\dl/ })
    )
    await waitFor(() => expect(shelfNames()).toEqual([]))
    expect(sends()).toEqual([[{ direction: 'download', sources: ['/x/a.jpg'], destDir: 'C:\\dl' }]])

    act(() => {
      useShelfStore.getState().add([remoteItem('b.jpg')])
      // 담아도 펼쳐지지 않는다(shelf-island I8): 행에서 Enter를 누르려면 펼친다
      useShelfStore.getState().setDockOpen(true)
    })
    fireEvent.keyDown(row('b.jpg'), { key: 'Enter' })
    await waitFor(() => expect(shelfNames()).toEqual([]))
    expect(sends()).toHaveLength(2)

    act(() => {
      useShelfStore.getState().add([remoteItem('c.jpg')])
    })
    fireEvent.keyDown(document.body, { key: 'Enter', ctrlKey: true })
    await waitFor(() => expect(shelfNames()).toEqual([]))
    expect(sends()[2]).toEqual([
      { direction: 'download', sources: ['/x/c.jpg'], destDir: 'C:\\dl' }
    ])
  })

  it('runs the transfer and the same-side copy of a mixed shelf together, and keeps the shelf on failure', async () => {
    // covers: Test-807
    setup()
    useShelfStore.getState().add([remoteItem('a.jpg'), localItem('b.jpg')])
    render(<Shelf />)
    fireEvent.click(screen.getByRole('button', { name: /^Download 1 · Copy 1 to dl\s*→/ }))
    await waitFor(() => expect(shelfNames()).toEqual([]))
    expect(sends()).toEqual([[{ direction: 'download', sources: ['/x/a.jpg'], destDir: 'C:\\dl' }]])
    expect(invokeCalls(h.invoke, 'local:copyFiles')).toEqual([
      [['C:\\pics\\b.jpg'], 'C:\\dl', ['b.jpg']]
    ])

    // 다운로드만 실패하면 복사를 시작한 항목은 빠지고 실패한 항목만 남는다
    const send = h.handlers['transfer:send']
    h.handlers['transfer:send'] = () => ({ success: false, error: 'boom' })
    act(() => {
      useShelfStore.getState().add([remoteItem('d.jpg'), localItem('e.jpg')])
    })
    fireEvent.click(screen.getByRole('button', { name: /^Download 1 · Copy 1 to dl\s*→/ }))
    await waitFor(() => expect(sends()).toHaveLength(2))
    await waitFor(() => expect(shelfNames()).toEqual(['d.jpg']))

    // 내려놓는 중에 다시 눌러도 같은 항목을 또 보내지 않는다
    h.handlers['transfer:send'] = send
    const button = screen.getByRole('button', { name: /^Download 1 to dl\s*→ This PC › C:\\dl/ })
    fireEvent.click(button)
    fireEvent.click(button)
    await waitFor(() => expect(shelfNames()).toEqual([]))
    expect(sends()).toHaveLength(3)
  })
})

describe('Shelf — items from two servers', () => {
  const B = 'you@b.example:2121'
  const fromB = (name: string): ExplorerEntry => fromFtpEntry(ftp(name, { size: 1024 }), '/y', B)
  const sends = (): unknown[][] => invokeCalls(h.invoke, 'transfer:send')
  const done = {
    success: true,
    data: { batchId: 'b1', ids: ['t1'], skipped: [], conflicts: [], totalBytes: 1 }
  }

  it("downloads each server's items with its own connection and copies across servers as a relay", async () => {
    // covers: Test-1025
    h = setupExplorer({ local: { 'C:\\dl': [] }, remote: { '/in': [] } })
    setConnection(B, 'connected')
    h.handlers['transfer:send'] = () => done
    useTabsStore.getState().openTab(localLoc('C:\\dl'))
    useShelfStore.getState().add([remoteItem('a.jpg'), fromB('b.jpg'), remoteItem('c.jpg')])
    render(
      <>
        <Shelf />
        <ConflictSheet />
      </>
    )

    fireEvent.click(screen.getByRole('button', { name: /^Download 3 to dl\s*→/ }))
    await waitFor(() => expect(shelfNames()).toEqual([]))
    expect(sends()).toEqual([
      [server(), { direction: 'download', sources: ['/x/a.jpg', '/x/c.jpg'], destDir: 'C:\\dl' }],
      [B, { direction: 'download', sources: ['/y/b.jpg'], destDir: 'C:\\dl' }]
    ])

    // A의 항목을 B의 원격 탭에: 받는 쪽 연결로 서버 간 복사를 보낸다. 충돌이면 결정을 붙여 다시 보낸다
    h.invoke.mockClear()
    let asked = false
    h.handlers['transfer:send'] = () => {
      if (asked) return done
      asked = true
      return {
        success: true,
        data: {
          ids: [],
          skipped: [],
          totalBytes: 1,
          conflicts: [
            {
              target: '/in/a.jpg',
              source: '/x/a.jpg',
              name: 'a.jpg',
              incoming: { size: 1024, modifiedAt: '2024-01-02T00:00:00.000Z' },
              existing: { size: 10, modifiedAt: '2024-01-01T00:00:00.000Z' }
            }
          ]
        }
      }
    }
    act(() => {
      useTabsStore.getState().openTab({ side: 'remote', path: '/in', server: B })
      useShelfStore.getState().add([remoteItem('a.jpg')])
    })
    fireEvent.click(await screen.findByRole('button', { name: /^Copy 1 to in\s*→/ }))
    const open = await screen.findByRole('alertdialog')
    fireEvent.click(within(open).getByRole('radio', { name: 'Overwrite' }))
    fireEvent.click(within(open).getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(shelfNames()).toEqual([]))
    const relay = {
      direction: 'relay',
      sourceServer: server(),
      sources: ['/x/a.jpg'],
      destDir: '/in'
    }
    expect(sends()).toEqual([
      [B, relay],
      [B, { ...relay, decisions: { '/in/a.jpg': 'overwrite' } }]
    ])
  })
})

describe('Shelf — same-side conflicts', () => {
  const sheet = (): Promise<HTMLElement> => screen.findByRole('alertdialog')
  /** 충돌 시트에서 라디오를 고르고 확인을 누른다. */
  const choose = async (name: string): Promise<void> => {
    const open = await sheet()
    fireEvent.click(within(open).getByRole('radio', { name }))
    fireEvent.click(within(open).getByRole('button', { name: 'Confirm' }))
  }
  const channels = (): string[] =>
    h.invoke.mock.calls
      .map(([c]) => c as string)
      .filter((c) => c === 'ftp:deleteBatch' || c === 'ftp:rename')

  it('asks before moving onto an existing remote name: overwrite deletes then renames, keep-both picks a free name, cancel does nothing', async () => {
    // covers: Test-838
    h = setupExplorer({ remote: { '/dst': [ftp('a.jpg'), ftp('a (1).jpg')] } })
    useTabsStore.getState().openTab(remoteLoc('/dst'))
    useShelfStore.getState().add([remoteItem('a.jpg'), remoteItem('c.jpg')])
    render(
      <>
        <Shelf />
        <ConflictSheet />
      </>
    )
    const drop = (): void => {
      fireEvent.click(screen.getByRole('button', { name: /^Move \d to dst\s*→/ }))
    }

    drop()
    expect(within(await sheet()).getByText('"a.jpg" already exists')).toBeTruthy()
    expect(channels()).toEqual([])
    fireEvent.click(within(await sheet()).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(channels()).toEqual([])
    expect(shelfNames()).toEqual(['a.jpg', 'c.jpg'])

    // 덮어쓰기: 대상을 숨은 이름으로 비켜 두고, 옮긴 뒤에 지운다
    drop()
    await choose('Overwrite')
    await waitFor(() => expect(shelfNames()).toEqual([]))
    const renames = (): unknown[][] => remoteCalls(h.invoke, 'ftp:rename')
    const aside = renames()[0][1] as string
    expect(aside).toMatch(/^\/dst\/\.a\.jpg\.[a-z0-9]+\.old$/)
    expect(renames()).toEqual([
      ['/dst/a.jpg', aside],
      ['/x/a.jpg', '/dst/a.jpg'],
      ['/x/c.jpg', '/dst/c.jpg']
    ])
    expect(remoteCalls(h.invoke, 'ftp:deleteBatch')).toEqual([
      [[{ path: aside, isDirectory: false }]]
    ])
    expect(channels()).toEqual(['ftp:rename', 'ftp:rename', 'ftp:deleteBatch', 'ftp:rename'])

    // 옮기기가 실패하면 비켜 둔 대상을 제자리로 되돌리고 지우지 않는다
    h.handlers['ftp:rename'] = (_conn, from) =>
      from === '/x/a.jpg' ? { success: false, error: '550 denied' } : { success: true }
    act(() => {
      useShelfStore.getState().add([remoteItem('a.jpg')])
    })
    drop()
    await choose('Overwrite')
    await waitFor(() => expect(renames()).toHaveLength(6))
    const aside2 = renames()[3][1] as string
    expect(renames().slice(3)).toEqual([
      ['/dst/a.jpg', aside2],
      ['/x/a.jpg', '/dst/a.jpg'],
      [aside2, '/dst/a.jpg']
    ])
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(invokeCalls(h.invoke, 'ftp:deleteBatch')).toHaveLength(1)
    expect(shelfNames()).toEqual(['a.jpg'])
    delete h.handlers['ftp:rename']

    drop()
    await choose('Keep both (rename)')
    await waitFor(() => expect(shelfNames()).toEqual([]))
    expect(remoteCalls(h.invoke, 'ftp:rename').at(-1)).toEqual(['/x/a.jpg', '/dst/a (2).jpg'])
    expect(invokeCalls(h.invoke, 'ftp:deleteBatch')).toHaveLength(1)
  })

  it('asks before copying onto an existing local name: keep-both passes new names, skip copies nothing, an unreadable folder only toasts', async () => {
    // covers: Test-839
    h = setupExplorer({
      local: { 'C:\\dl': [local('C:\\dl', 'b.jpg'), local('C:\\dl', 'E.JPG')] }
    })
    useTabsStore.getState().openTab(localLoc('C:\\dl'))
    useShelfStore.getState().add([localItem('b.jpg'), localItem('e.jpg')])
    render(
      <>
        <Shelf />
        <ConflictSheet />
      </>
    )
    const drop = (): void => {
      fireEvent.click(screen.getByRole('button', { name: /^Copy \d to dl\s*→/ }))
    }
    const copies = (): unknown[][] => invokeCalls(h.invoke, 'local:copyFiles')

    drop()
    // "나머지에 적용"이 기본으로 켜져 있어 두 충돌에 같은 결정(Windows는 대소문자 무시)
    await choose('Keep both (rename)')
    await waitFor(() => expect(shelfNames()).toEqual([]))
    expect(copies()).toEqual([
      [['C:\\pics\\b.jpg', 'C:\\pics\\e.jpg'], 'C:\\dl', ['b (1).jpg', 'e (1).jpg']]
    ])

    act(() => {
      useShelfStore.getState().add([localItem('b.jpg'), localItem('e.jpg')])
    })
    drop()
    await choose('Skip')
    await waitFor(() => expect(shelfNames()).toEqual([]))
    expect(copies()).toHaveLength(1)

    h.handlers['local:list'] = () => ({ success: false, error: 'EACCES' })
    act(() => {
      useShelfStore.getState().add([localItem('b.jpg')])
    })
    drop()
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(en['toast.sendFailed'], { description: 'EACCES' })
    )
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(copies()).toHaveLength(1)
    expect(shelfNames()).toEqual(['b.jpg'])
  })
})

describe('Shelf — OS drops', () => {
  const dt = (types: string[], files: File[] = []): Record<string, unknown> => ({
    types,
    files,
    dropEffect: ''
  })
  const osFile = (name: string, path: string): File => {
    h.api.getPathForFile.mockImplementation((f: File) => (f.name === name ? path : ''))
    return new File(['x'], name)
  }
  const statOf = (...entries: LocalFileEntry[]): void => {
    h.handlers['local:stat'] = () => ({ success: true, data: entries })
  }
  const target = (): HTMLElement => document.querySelector<HTMLElement>('[data-shelf-target]')!
  const stats = (): unknown[][] => invokeCalls(h.invoke, 'local:stat')

  it('takes OS files on an empty and a filled shelf, and keeps the copy effect under the document guard', async () => {
    // covers: Test-877
    h = setupExplorer({ local: { 'C:\\dl': [] } })
    useTabsStore.getState().openTab(localLoc('C:\\dl'))
    render(<Shelf />)

    // 빈 선반
    const empty = dt(['Files'])
    expect(fireEvent.dragOver(target(), { dataTransfer: empty })).toBe(false)
    expect(empty.dropEffect).toBe('copy')
    expect(screen.getByText(en['shelf.dropHere'])).toBeTruthy()
    const a = osFile('a.jpg', 'C:\\in\\a.jpg')
    statOf(local('C:\\in', 'a.jpg'))
    fireEvent.drop(target(), { dataTransfer: dt(['Files'], [a]) })
    await waitFor(() => expect(shelfNames()).toEqual(['a.jpg']))
    expect(stats()).toEqual([[['C:\\in\\a.jpg']]])
    expect(useDnd.getState().over).toBeNull()

    // 채운 선반
    const filled = dt(['Files'])
    expect(fireEvent.dragOver(target(), { dataTransfer: filled })).toBe(false)
    expect(filled.dropEffect).toBe('copy')
    const b = osFile('b.jpg', 'C:\\in\\b.jpg')
    statOf(local('C:\\in', 'b.jpg'))
    fireEvent.drop(target(), { dataTransfer: dt(['Files'], [b]) })
    await waitFor(() => expect(shelfNames()).toEqual(['a.jpg', 'b.jpg']))
    expect(useDnd.getState().over).toBeNull()
    cleanup()
    h.restore()

    // 문서 가드를 켠 채로: 대상이 전파를 멈춰 가드가 'none'으로 덮지 않는다(함정 6).
    // 선반의 놓기 대상은 이제 도크의 담기 띠다: OS 드래그가 앱 안에 들어오면 띠가 뜬다.
    h = setupExplorer({ local: { 'C:\\dl': [] } })
    useTabsStore.getState().openTab(localLoc('C:\\dl'))
    const uninstall = installDropGuard(document)
    try {
      render(<AppShell />)
      // 빈 폴더엔 listbox가 없어 경로 막대로 셸을 기다린다.
      await screen.findByRole('navigation', { name: en['path.label'] })
      fireEvent.dragEnter(document.body, { dataTransfer: dt(['Files']) })
      await screen.findByText(en['shelf.dockHint'])
      const over = dt(['Files'])
      fireEvent.dragOver(target(), { dataTransfer: over })
      expect(over.dropEffect).toBe('copy')
    } finally {
      uninstall()
    }
  })

  it('ignores drags that are neither OS files nor in-app items, and still shelves in-app drags', () => {
    // covers: Test-878
    h = setupExplorer({ local: { 'C:\\dl': [] } })
    useTabsStore.getState().openTab(localLoc('C:\\dl'))
    render(<Shelf />)

    const text = dt(['text/plain'])
    expect(fireEvent.dragOver(target(), { dataTransfer: text })).toBe(true)
    expect(text.dropEffect).toBe('')
    fireEvent.drop(target(), { dataTransfer: dt(['text/plain'], [new File(['x'], 'z.txt')]) })
    expect(stats()).toEqual([])
    expect(shelfNames()).toEqual([])

    // 앱 안 드래그는 지금처럼 담고 local:stat을 부르지 않는다(회귀)
    act(() => useDnd.setState({ items: [remoteItem('a.jpg')], over: null, thumbs: [] }))
    fireEvent.drop(target(), { dataTransfer: dt([]) })
    expect(shelfNames()).toEqual(['a.jpg'])
    expect(stats()).toEqual([])
  })

  it('shows an OS folder as one folder row, leaves it out of the total, and drops it into remote and local tabs', async () => {
    // covers: Test-881
    h = setupExplorer({ remote: { '/dst': [] }, local: { 'C:\\dl': [] } })
    h.handlers['transfer:send'] = () => ({
      success: true,
      data: { batchId: 'b1', ids: ['t1'], skipped: [], conflicts: [], totalBytes: 0 }
    })
    useTabsStore.getState().openTab(remoteLoc('/dst'))
    render(<Shelf />)

    const folder = new File(['x'], 'docs')
    const photo = new File(['x'], 'a.jpg')
    const paths: Record<string, string> = { docs: 'C:\\in\\docs', 'a.jpg': 'C:\\in\\a.jpg' }
    h.api.getPathForFile.mockImplementation((f: File) => paths[f.name] ?? '')
    // 실제 폴더 항목은 크기가 0이 아니다. 합계에는 파일(100 B)만 더해져야 한다
    statOf(
      local('C:\\in', 'docs', { dir: true, size: 4096 }),
      local('C:\\in', 'a.jpg', { size: 100 })
    )
    fireEvent.drop(target(), { dataTransfer: dt(['Files'], [folder, photo]) })
    await waitFor(() => expect(shelfNames()).toEqual(['docs', 'a.jpg']))
    expect(row('docs').getAttribute('aria-label')).toBe(
      `docs, ${en['sidebar.thisPc']}, ${en['send.folderContents']}`
    )
    expect(screen.getByText('100 B')).toBeTruthy()
    expect(screen.queryByText('4 KB')).toBeNull()

    // 원격 탭: 폴더와 파일 경로를 업로드로 보내고, 성공하면 선반이 빈다
    fireEvent.click(screen.getByRole('button', { name: /^Upload 2 to dst\s*→/ }))
    await waitFor(() => expect(shelfNames()).toEqual([]))
    expect(remoteCalls(h.invoke, 'transfer:send')).toEqual([
      [
        {
          direction: 'upload',
          sources: ['C:\\in\\docs', 'C:\\in\\a.jpg'],
          destDir: '/dst'
        }
      ]
    ])

    // 로컬 탭: local:copyFiles로 복사한다
    fireEvent.drop(target(), { dataTransfer: dt(['Files'], [folder, photo]) })
    await waitFor(() => expect(shelfNames()).toEqual(['docs', 'a.jpg']))
    act(() => {
      useTabsStore.getState().openTab(localLoc('C:\\dl'))
    })
    fireEvent.click(await screen.findByRole('button', { name: /^Copy 2 to dl\s*→/ }))
    await waitFor(() => expect(shelfNames()).toEqual([]))
    expect(invokeCalls(h.invoke, 'local:copyFiles')).toEqual([
      [['C:\\in\\docs', 'C:\\in\\a.jpg'], 'C:\\dl', ['docs', 'a.jpg']]
    ])
  })
})

describe('Shelf — the two-step connect of an unconnected server tab', () => {
  /**
   * 익명 저장 서버: 저장 비밀번호가 없어 자동 연결(MC12)이 걸리지 않고, 익명이라 바로
   * 연결된다(`canConnectSaved`). 자리표시자 시도와 겹치는 이중 `ftp:connect`를 막는 조건이다.
   */
  const NAS2: FtpServer = {
    id: 9,
    name: 'NAS2',
    host: 'b.lan',
    port: 21,
    username: '',
    hasPassword: false,
    secure: false
  }
  const NAS2_KEY = 'anonymous@b.lan:21'
  const sends = (): unknown[][] => invokeCalls(h.invoke, 'transfer:send')
  const dt = (): Record<string, unknown> => ({
    types: [],
    files: [],
    dropEffect: '',
    setData: vi.fn(),
    setDragImage: vi.fn(),
    effectAllowed: ''
  })

  /** 로컬 탭과 미연결 서버 탭, 선반 항목 하나를 앱 전체(모달 포함)에 연다. */
  async function openUnconnectedTab(): Promise<void> {
    h = setupExplorer({
      local: { 'C:\\pics': [local('C:\\pics', 'a.jpg')] },
      remote: { '/y': [ftp('sub', { dir: true }), ftp('b.jpg')], '/old': [] }
    })
    h.handlers['ftp:getRecentServers'] = () => ({ success: true, data: [NAS2] })
    h.handlers['ftp:getRecentPaths'] = () => ({
      success: true,
      data: [{ path: '/y', lastVisited: '' }]
    })
    h.handlers['transfer:send'] = () => ({
      success: true,
      data: { batchId: 'b1', ids: ['t1'], skipped: [], conflicts: [], totalBytes: 1024 }
    })
    useServerStore.setState({
      servers: [NAS2],
      draft: emptyDraft(),
      address: '',
      connecting: false,
      error: ''
    })
    useTabsStore.getState().openTab(localLoc('C:\\pics'))
    useTabsStore.getState().openTab({ side: 'remote', path: '/old', server: NAS2_KEY }, false)
    useShelfStore.getState().add([localItem('a.jpg')])
    useShelfStore.getState().setDockOpen(true)
    render(
      <>
        <AppShell />
        <ConfirmDialog />
      </>
    )
    await screen.findByRole('region', { name: en['shelf.title'] })
  }

  it('starts a connect with a pane instead of a transfer when the shelf lands on an unconnected server tab', async () => {
    // covers: Test-1264
    await openUnconnectedTab()

    fireEvent.dragStart(row('a.jpg'), { dataTransfer: dt() })
    fireEvent.drop(screen.getByRole('tab', { name: 'old' }), { dataTransfer: dt() })

    // 전송은 시작되지 않는다...
    expect(sends()).toEqual([])
    // ...분할이 먼저 생기고 그 칸에 연결 시도 안내가 뜬다...
    const s = useTabsStore.getState()
    expect(s.split).toBeTruthy()
    expect(visiblePanes(s)).toHaveLength(2)
    const right = document.querySelector('[data-region="content"] [data-pane="right"]')
    expect(right?.textContent).toContain(en['sidebar.serverConnecting'])
    // ...연결 시도가 시작된다.
    await waitFor(() => expect(invokeCalls(h.invoke, 'ftp:connect')).toHaveLength(1))
    expect(invokeCalls(h.invoke, 'ftp:connect')[0][0]).toMatchObject({ host: NAS2.host })
    // 선반은 그대로다.
    expect(shelfNames()).toEqual(['a.jpg'])
    expect(sends()).toEqual([])
    await waitFor(() => expect(useServerStore.getState().connecting).toBe(false))
  })

  it('drops the shelf into a folder of the pane that connect opened and sends it as before', async () => {
    // covers: Test-1265
    await openUnconnectedTab()
    fireEvent.dragStart(row('a.jpg'), { dataTransfer: dt() })
    fireEvent.drop(screen.getByRole('tab', { name: 'old' }), { dataTransfer: dt() })

    // 연결이 성공해 그 서버 패널이 열린다. 선반은 그대로다.
    await waitFor(() => {
      const st = useTabsStore.getState()
      expect(st.tabs.find((t) => t.id === st.split?.rightId)?.loc).toEqual({
        side: 'remote',
        path: '/y',
        server: NAS2_KEY
      })
    })
    expect(shelfNames()).toEqual(['a.jpg'])

    // 그 패널의 목록에 다시 끌어놓으면 기존처럼 전송된다.
    fireEvent.dragStart(row('a.jpg'), { dataTransfer: dt() })
    const list = document.getElementById(`explorer-list-${useTabsStore.getState().split?.rightId}`)
    expect(list).toBeTruthy()
    fireEvent.dragOver(list as HTMLElement, { dataTransfer: dt() })
    fireEvent.drop(list as HTMLElement, { dataTransfer: dt() })
    await waitFor(() => expect(sends()).toHaveLength(1))
    expect(sends()[0]).toEqual([
      NAS2_KEY,
      { direction: 'upload', sources: ['C:\\pics\\a.jpg'], destDir: '/y' }
    ])
    expect(shelfNames()).toEqual([])
    expect(useTabsStore.getState().split).toBeTruthy()
  })

  it('sends right away on an already connected server tab, without splitting', async () => {
    // covers: Test-1266
    h = setupExplorer({
      local: { 'C:\\pics': [local('C:\\pics', 'b.jpg')] },
      remote: { '/x': [ftp('sub', { dir: true })] }
    })
    h.handlers['transfer:send'] = () => ({
      success: true,
      data: { batchId: 'b1', ids: ['t1'], skipped: [], conflicts: [], totalBytes: 1024 }
    })
    useTabsStore.getState().openTab(remoteLoc('/x')) // 이미 연결된 서버(기본 connected)
    useShelfStore.getState().add([localItem('b.jpg')])
    useShelfStore.getState().setDockOpen(true)
    render(
      <>
        <AppShell />
        <ConfirmDialog />
      </>
    )
    await screen.findByRole('region', { name: en['shelf.title'] })

    fireEvent.dragStart(row('b.jpg'), { dataTransfer: dt() })
    fireEvent.drop(screen.getByRole('tab', { name: 'x' }), { dataTransfer: dt() })

    await waitFor(() => expect(sends()).toHaveLength(1))
    expect(sends()[0]).toEqual([
      server(),
      { direction: 'upload', sources: ['C:\\pics\\b.jpg'], destDir: '/x' }
    ])
    // 분할 없이 바로 전송한다(M19의 예외 — 회귀 방어).
    expect(useTabsStore.getState().split).toBeNull()
    expect(shelfNames()).toEqual([])
  })
})
