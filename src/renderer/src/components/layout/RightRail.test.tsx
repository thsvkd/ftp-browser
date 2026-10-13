/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { toast } from 'sonner'
import { en } from '@renderer/i18n/locales/en'
import { fromFtpEntry } from '@renderer/lib/explorerEntry'
import { useShelfStore } from '@renderer/stores/useShelfStore'
import { useTabsStore } from '@renderer/stores/useTabsStore'
import { invokeCalls } from '@renderer/test/rendererTestUtils'
import { useDnd } from '@renderer/components/explorer/dnd'
import {
  ftp,
  local,
  remoteLoc,
  server,
  setupExplorer,
  type ExplorerHarness
} from '@renderer/components/explorer/explorerTestHarness'
import { RightRail } from './RightRail'

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
  Toaster: () => null
}))

let h: ExplorerHarness
afterEach(() => {
  cleanup()
  h.restore()
})

const dt = (): Record<string, unknown> => ({ types: [], files: [], dropEffect: '' })

describe('RightRail', () => {
  it('takes drops on the shelf segment while showing info and switches to the shelf when items are shelved', () => {
    // covers: Test-808
    h = setupExplorer({ remote: { '/photos': [] } })
    useTabsStore.getState().openTab(remoteLoc('/photos'))
    useShelfStore.setState({ railTab: 'info' })
    render(<RightRail />)
    const rail = screen.getByRole('tablist', { name: en['rail.label'] })
    const segment = within(rail).getByRole('tab', { name: new RegExp(`^${en['shelf.title']}`) })
    expect(segment.getAttribute('aria-selected')).toBe('false')
    expect(screen.getByRole('region', { name: en['rail.info'] })).toBeTruthy()

    act(() =>
      useDnd.setState({
        items: [fromFtpEntry(ftp('a.jpg'), '/photos', server())],
        over: null,
        thumbs: []
      })
    )
    const over = dt()
    fireEvent.dragOver(segment, { dataTransfer: over })
    expect(over.dropEffect).toBe('copy')
    fireEvent.drop(segment, { dataTransfer: dt() })

    expect(useShelfStore.getState().items.map((i) => i.entry.name)).toEqual(['a.jpg'])
    expect(useShelfStore.getState().railTab).toBe('shelf')
    const shelfTab = within(rail).getByRole('tab', { name: new RegExp(`^${en['shelf.title']}`) })
    expect(shelfTab.getAttribute('aria-selected')).toBe('true')
    expect(shelfTab.textContent).toContain('1')

    // 정보로 돌아가 다른 항목을 담아도(메뉴·Shift+S) 레일은 선반으로 바뀐다.
    fireEvent.click(within(rail).getByRole('tab', { name: en['rail.info'] }))
    expect(useShelfStore.getState().railTab).toBe('info')
    act(() => {
      useShelfStore.getState().add([fromFtpEntry(ftp('b.jpg'), '/photos', server())])
    })
    expect(useShelfStore.getState().railTab).toBe('shelf')
    expect(
      within(rail).getByRole('tab', { name: new RegExp(`^${en['shelf.title']}`) }).textContent
    ).toContain('2')
  })

  it('takes OS files on the shelf segment while showing info, but not on the info body', async () => {
    // covers: Test-879
    h = setupExplorer({ remote: { '/photos': [] } })
    useTabsStore.getState().openTab(remoteLoc('/photos'))
    useShelfStore.setState({ railTab: 'info' })
    h.api.getPathForFile.mockReturnValue('C:\\in\\a.jpg')
    h.handlers['local:stat'] = () => ({ success: true, data: [local('C:\\in', 'a.jpg')] })
    const osDt = (): Record<string, unknown> => ({
      types: ['Files'],
      files: [new File(['x'], 'a.jpg')],
      dropEffect: ''
    })
    render(<RightRail />)
    const rail = screen.getByRole('tablist', { name: en['rail.label'] })
    const segment = within(rail).getByRole('tab', { name: new RegExp(`^${en['shelf.title']}`) })

    const over = osDt()
    fireEvent.dragOver(segment, { dataTransfer: over })
    expect(over.dropEffect).toBe('copy')
    fireEvent.drop(segment, { dataTransfer: osDt() })
    await waitFor(() => expect(useShelfStore.getState().railTab).toBe('shelf'))
    expect(useShelfStore.getState().items.map((i) => i.entry.name)).toEqual(['a.jpg'])
    expect(
      within(rail).getByRole('tab', { name: new RegExp(`^${en['shelf.title']}`) }).textContent
    ).toContain('1')

    // 전부 중복이면 정보 탭에 머물고 토스트만 보인다
    fireEvent.click(within(rail).getByRole('tab', { name: en['rail.info'] }))
    expect(useShelfStore.getState().railTab).toBe('info')
    vi.mocked(toast).mockClear()
    fireEvent.drop(segment, { dataTransfer: osDt() })
    await waitFor(() => expect(toast).toHaveBeenCalledWith(en['toast.alreadyOnShelf']))
    expect(useShelfStore.getState().railTab).toBe('info')
    expect(useShelfStore.getState().items).toHaveLength(1)

    // 정보 본문은 대상이 아니다
    const stats = invokeCalls(h.invoke, 'local:stat').length
    const region = screen.getByRole('region', { name: en['rail.info'] })
    const body = osDt()
    expect(fireEvent.dragOver(region, { dataTransfer: body })).toBe(true)
    expect(body.dropEffect).toBe('')
    fireEvent.drop(region, { dataTransfer: osDt() })
    expect(invokeCalls(h.invoke, 'local:stat')).toHaveLength(stats)
  })
})
