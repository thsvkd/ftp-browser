/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { en } from '@renderer/i18n/locales/en'
import { useServerStore } from '@renderer/stores/useServerStore'
import { useTabsStore } from '@renderer/stores/useTabsStore'
import { emptyDraft } from '@renderer/lib/serverAddress'
import {
  activeTab,
  ftp,
  local,
  setupExplorer,
  type ExplorerHarness
} from '@renderer/components/explorer/explorerTestHarness'
import { AppShell } from './AppShell'

const HOME = 'C:\\Users\\me\\Downloads'

let h: ExplorerHarness
beforeEach(() => {
  vi.clearAllMocks()
  h = setupExplorer({
    connected: false,
    local: { [HOME]: [local(HOME, 'a.txt')] },
    remote: { '/photos': [ftp('x.jpg')], '/': [ftp('r.txt')] }
  })
  h.handlers['local:getHome'] = () => ({ success: true, data: HOME })
  h.handlers['ftp:getRecentPaths'] = () => ({
    success: true,
    data: [{ path: '/photos', lastVisited: '' }]
  })
  useServerStore.setState({
    servers: [],
    draft: emptyDraft(),
    address: '',
    connecting: false,
    error: ''
  })
})
afterEach(() => {
  cleanup()
  h.restore()
})

const connectFromToolbar = async (): Promise<void> => {
  const user = userEvent.setup()
  await user.type(screen.getByRole('textbox', { name: 'Server address' }), 'me@nas.local{Enter}')
}

describe('AppShell — start and connect', () => {
  it('starts with one local tab at home and activates a remote tab at the start folder on connect', async () => {
    // covers: Test-825
    render(<AppShell />)
    await waitFor(() => expect(useTabsStore.getState().tabs).toHaveLength(1))
    expect(activeTab().loc).toEqual({ side: 'local', path: HOME })

    await connectFromToolbar()
    await waitFor(() =>
      expect(activeTab().loc).toEqual({
        side: 'remote',
        path: '/photos',
        server: 'me@nas.local:21'
      })
    )
    expect(useTabsStore.getState().tabs.map((t) => t.loc.side)).toEqual(['local', 'remote'])
  })

  it('falls back to the root when the start folder cannot be listed', async () => {
    // covers: Test-825
    delete h.remote['/photos']
    render(<AppShell />)
    await waitFor(() => expect(useTabsStore.getState().tabs).toHaveLength(1))

    await connectFromToolbar()
    await waitFor(() =>
      expect(activeTab().loc).toEqual({ side: 'remote', path: '/', server: 'me@nas.local:21' })
    )
  })
})

describe('AppShell — regions', () => {
  it('cycles focus sidebar → tabs → list → rail with F6 and back with Shift+F6', async () => {
    // covers: Test-834
    render(<AppShell />)
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy())
    const key = (shiftKey = false): void => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'F6', shiftKey })
    }
    const sidebarCurrent = within(
      screen.getByRole('navigation', { name: en['sidebar.label'] })
    ).getByRole('button', { name: 'Downloads' })
    expect(sidebarCurrent.getAttribute('aria-current')).toBe('location')
    const shelfTab = screen.getByRole('tab', { name: new RegExp(`^${en['shelf.title']}`) })

    // 처음에는 다른 것이 포커스를 갖고 있지 않으니 목록이 받는다(함정 13).
    expect(document.activeElement).toBe(screen.getByRole('listbox'))
    key()
    expect(document.activeElement).toBe(shelfTab)
    key()
    expect(document.activeElement).toBe(sidebarCurrent)
    key()
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Downloads' }))
    key()
    expect(document.activeElement).toBe(screen.getByRole('listbox'))
    key(true)
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Downloads' }))
    key(true)
    expect(document.activeElement).toBe(sidebarCurrent)
    key(true)
    expect(document.activeElement).toBe(shelfTab)
  })
})
