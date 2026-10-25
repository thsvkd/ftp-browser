/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { en } from '@renderer/i18n/locales/en'
import { useListingStore } from '@renderer/stores/useListingStore'
import { useTabsStore } from '@renderer/stores/useTabsStore'
import {
  remoteLoc,
  setupExplorer,
  type ExplorerHarness
} from '@renderer/components/explorer/explorerTestHarness'
import { RightRail } from './RightRail'

let h: ExplorerHarness
afterEach(() => {
  cleanup()
  h.restore()
})

describe('RightRail', () => {
  it('has no shelf segment anymore: info alone fills the whole rail', () => {
    // covers: Test-903
    h = setupExplorer({ remote: { '/photos': [] } })
    useTabsStore.getState().openTab(remoteLoc('/photos'))
    useListingStore.getState().put(remoteLoc('/photos'), [])
    render(<RightRail />)

    const rail = screen.getByRole('region', { name: en['rail.info'] })
    expect(within(rail).queryByRole('tablist')).toBeNull()
    expect(within(rail).queryByRole('tab')).toBeNull()
    expect(within(rail).getByRole('heading', { name: 'photos' })).toBeTruthy()
  })
})
