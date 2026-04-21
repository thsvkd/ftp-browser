import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useLocalFsStore } from './useLocalFsStore'
import type { LocalFileEntry } from '@shared/types/local'

// Mock window.api
const mockInvoke = vi.fn()

vi.stubGlobal('window', {
  api: {
    invoke: mockInvoke
  }
})

interface ListResult {
  success: true
  data: { path: string; entries: LocalFileEntry[] }
}

function makeListResult(path: string, entries: Array<{ name: string }> = []): ListResult {
  return {
    success: true,
    data: {
      path,
      entries: entries.map((e) => ({
        name: e.name,
        path: `${path}/${e.name}`,
        type: 'file' as const,
        size: 100,
        modifiedAt: '2024-01-01',
        isImage: false
      }))
    }
  }
}

describe('useLocalFsStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset store to initial state
    useLocalFsStore.setState({
      currentPath: '',
      entries: [],
      loading: false,
      error: null,
      history: [],
      historyIndex: -1
    })
  })

  describe('navigateTo', () => {
    it('should update currentPath and entries', async () => {
      mockInvoke.mockResolvedValue(makeListResult('/home/user', [{ name: 'file.txt' }]))

      await useLocalFsStore.getState().navigateTo('/home/user')

      const state = useLocalFsStore.getState()
      expect(state.currentPath).toBe('/home/user')
      expect(state.entries).toHaveLength(1)
      expect(state.entries[0].name).toBe('file.txt')
      expect(state.loading).toBe(false)
    })

    it('should add path to history', async () => {
      mockInvoke.mockResolvedValue(makeListResult('/home'))

      await useLocalFsStore.getState().navigateTo('/home')

      const state = useLocalFsStore.getState()
      expect(state.history).toEqual(['/home'])
      expect(state.historyIndex).toBe(0)
    })

    it('should build history sequentially', async () => {
      mockInvoke
        .mockResolvedValueOnce(makeListResult('/home'))
        .mockResolvedValueOnce(makeListResult('/home/user'))
        .mockResolvedValueOnce(makeListResult('/home/user/docs'))

      await useLocalFsStore.getState().navigateTo('/home')
      await useLocalFsStore.getState().navigateTo('/home/user')
      await useLocalFsStore.getState().navigateTo('/home/user/docs')

      const state = useLocalFsStore.getState()
      expect(state.history).toEqual(['/home', '/home/user', '/home/user/docs'])
      expect(state.historyIndex).toBe(2)
    })

    it('should truncate forward history when navigating to new path', async () => {
      mockInvoke
        .mockResolvedValueOnce(makeListResult('/a'))
        .mockResolvedValueOnce(makeListResult('/b'))
        .mockResolvedValueOnce(makeListResult('/c'))

      await useLocalFsStore.getState().navigateTo('/a')
      await useLocalFsStore.getState().navigateTo('/b')
      await useLocalFsStore.getState().navigateTo('/c')

      // Go back to /b
      mockInvoke.mockResolvedValue(makeListResult('/b'))
      await useLocalFsStore.getState().goBack()

      // Navigate to /d (should truncate /c from history)
      mockInvoke.mockResolvedValue(makeListResult('/d'))
      await useLocalFsStore.getState().navigateTo('/d')

      const state = useLocalFsStore.getState()
      expect(state.history).toEqual(['/a', '/b', '/d'])
      expect(state.historyIndex).toBe(2)
    })

    it('should set error on failure', async () => {
      mockInvoke.mockResolvedValue({ success: false, error: 'Permission denied' })

      await useLocalFsStore.getState().navigateTo('/root/secret')

      const state = useLocalFsStore.getState()
      expect(state.error).toBe('Permission denied')
      expect(state.loading).toBe(false)
    })
  })

  describe('refresh', () => {
    it('should reload entries without modifying history', async () => {
      // Initial navigation
      mockInvoke.mockResolvedValue(makeListResult('/home', [{ name: 'old.txt' }]))
      await useLocalFsStore.getState().navigateTo('/home')

      const historyBefore = [...useLocalFsStore.getState().history]
      const indexBefore = useLocalFsStore.getState().historyIndex

      // Refresh
      mockInvoke.mockResolvedValue(
        makeListResult('/home', [{ name: 'old.txt' }, { name: 'new.txt' }])
      )
      await useLocalFsStore.getState().refresh()

      const state = useLocalFsStore.getState()
      expect(state.entries).toHaveLength(2)
      expect(state.history).toEqual(historyBefore)
      expect(state.historyIndex).toBe(indexBefore)
    })

    it('should not add duplicate entry to history', async () => {
      mockInvoke.mockResolvedValue(makeListResult('/home'))
      await useLocalFsStore.getState().navigateTo('/home')

      // Refresh multiple times
      mockInvoke.mockResolvedValue(makeListResult('/home'))
      await useLocalFsStore.getState().refresh()
      await useLocalFsStore.getState().refresh()
      await useLocalFsStore.getState().refresh()

      const state = useLocalFsStore.getState()
      expect(state.history).toEqual(['/home'])
      expect(state.historyIndex).toBe(0)
    })

    it('should keep currentPath unchanged', async () => {
      mockInvoke.mockResolvedValue(makeListResult('/home/user'))
      await useLocalFsStore.getState().navigateTo('/home/user')

      mockInvoke.mockResolvedValue(makeListResult('/home/user'))
      await useLocalFsStore.getState().refresh()

      expect(useLocalFsStore.getState().currentPath).toBe('/home/user')
    })

    it('should set error on refresh failure', async () => {
      mockInvoke.mockResolvedValue(makeListResult('/home'))
      await useLocalFsStore.getState().navigateTo('/home')

      mockInvoke.mockResolvedValue({ success: false, error: 'IO error' })
      await useLocalFsStore.getState().refresh()

      const state = useLocalFsStore.getState()
      expect(state.error).toBe('IO error')
      expect(state.loading).toBe(false)
    })
  })

  describe('goBack / goForward', () => {
    it('should navigate back in history', async () => {
      mockInvoke
        .mockResolvedValueOnce(makeListResult('/a'))
        .mockResolvedValueOnce(makeListResult('/b'))

      await useLocalFsStore.getState().navigateTo('/a')
      await useLocalFsStore.getState().navigateTo('/b')

      mockInvoke.mockResolvedValue(makeListResult('/a'))
      await useLocalFsStore.getState().goBack()

      const state = useLocalFsStore.getState()
      expect(state.currentPath).toBe('/a')
      expect(state.historyIndex).toBe(0)
      // History should remain intact
      expect(state.history).toEqual(['/a', '/b'])
    })

    it('should not go back past the beginning', async () => {
      mockInvoke.mockResolvedValue(makeListResult('/a'))
      await useLocalFsStore.getState().navigateTo('/a')

      await useLocalFsStore.getState().goBack()

      expect(useLocalFsStore.getState().historyIndex).toBe(0)
      // invoke should not have been called again for goBack
      expect(mockInvoke).toHaveBeenCalledTimes(1)
    })

    it('should navigate forward in history', async () => {
      mockInvoke
        .mockResolvedValueOnce(makeListResult('/a'))
        .mockResolvedValueOnce(makeListResult('/b'))

      await useLocalFsStore.getState().navigateTo('/a')
      await useLocalFsStore.getState().navigateTo('/b')

      // Go back
      mockInvoke.mockResolvedValue(makeListResult('/a'))
      await useLocalFsStore.getState().goBack()

      // Go forward
      mockInvoke.mockResolvedValue(makeListResult('/b'))
      await useLocalFsStore.getState().goForward()

      const state = useLocalFsStore.getState()
      expect(state.currentPath).toBe('/b')
      expect(state.historyIndex).toBe(1)
    })

    it('should not go forward past the end', async () => {
      mockInvoke.mockResolvedValue(makeListResult('/a'))
      await useLocalFsStore.getState().navigateTo('/a')

      await useLocalFsStore.getState().goForward()

      expect(useLocalFsStore.getState().historyIndex).toBe(0)
    })

    it('goBack should not modify history array', async () => {
      mockInvoke
        .mockResolvedValueOnce(makeListResult('/a'))
        .mockResolvedValueOnce(makeListResult('/b'))
        .mockResolvedValueOnce(makeListResult('/c'))

      await useLocalFsStore.getState().navigateTo('/a')
      await useLocalFsStore.getState().navigateTo('/b')
      await useLocalFsStore.getState().navigateTo('/c')

      mockInvoke.mockResolvedValue(makeListResult('/b'))
      await useLocalFsStore.getState().goBack()

      expect(useLocalFsStore.getState().history).toEqual(['/a', '/b', '/c'])
    })
  })

  describe('navigateUp', () => {
    it('should navigate to parent directory', async () => {
      mockInvoke.mockResolvedValue(makeListResult('/home/user'))
      await useLocalFsStore.getState().navigateTo('/home/user')

      mockInvoke.mockResolvedValue(makeListResult('/home'))
      await useLocalFsStore.getState().navigateUp()

      expect(useLocalFsStore.getState().currentPath).toBe('/home')
    })

    it('should not navigate up from root', async () => {
      mockInvoke.mockResolvedValue(makeListResult('/'))
      await useLocalFsStore.getState().navigateTo('/')

      const callCount = mockInvoke.mock.calls.length
      await useLocalFsStore.getState().navigateUp()

      // Should not have made another IPC call
      expect(mockInvoke).toHaveBeenCalledTimes(callCount)
    })
  })

  describe('init', () => {
    it('should navigate to home directory', async () => {
      mockInvoke
        .mockResolvedValueOnce({ success: true, data: '/home/user' }) // getHome
        .mockResolvedValueOnce(makeListResult('/home/user')) // navigateTo -> list

      await useLocalFsStore.getState().init()

      expect(useLocalFsStore.getState().currentPath).toBe('/home/user')
    })
  })
})
