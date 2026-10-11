/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { en } from '@renderer/i18n/locales/en'
import { generateCacheKeyRenderer } from '@renderer/lib/cacheKey'
import { fromFtpEntry, fromLocalEntry } from '@renderer/lib/explorerEntry'
import { useGalleryStore } from '@renderer/stores/useGalleryStore'
import { useThumbnailStore } from '@renderer/stores/useThumbnailStore'
import { invokeCalls } from '@renderer/test/rendererTestUtils'
import {
  HOST,
  MODIFIED_AT,
  PORT,
  ftp,
  local,
  setupExplorer,
  type ExplorerHarness
} from '@renderer/components/explorer/explorerTestHarness'
import { EntryThumb } from './EntryThumb'

let h: ExplorerHarness
beforeEach(() => {
  h = setupExplorer()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  h.restore()
})

const remote = (name: string, opts = {}): ReturnType<typeof fromFtpEntry> =>
  fromFtpEntry(ftp(name, opts), '/photos', 'me@nas:21')

describe('EntryThumb', () => {
  it('shows a shimmer while waiting, "Slow response" after 3 s, a glyph for non-images and the folder preview for folders', () => {
    // covers: Test-830
    vi.useFakeTimers()
    render(<EntryThumb entry={remote('a.jpg')} />)
    expect(screen.getByRole('img', { name: en['thumbnail.loading'] })).toBeTruthy()
    expect(screen.queryByText(en['thumbnail.slow'])).toBeNull()
    act(() => vi.advanceTimersByTime(3000))
    expect(screen.getByText(en['thumbnail.slow'])).toBeTruthy()
    // 그리드 안의 타일은 스스로 요청하지 않는다(그리드의 배치가 요청한다).
    expect(invokeCalls(h.invoke, 'thumbnail:request')).toEqual([])
    cleanup()
    vi.useRealTimers()

    // 그리드 밖(request)은 한 건을 priority 1로 요청한다(D30).
    render(<EntryThumb entry={remote('b.jpg')} request />)
    expect(invokeCalls(h.invoke, 'thumbnail:request')).toEqual([
      [
        {
          remotePath: '/photos/b.jpg',
          fileName: 'b.jpg',
          fileSize: 1024,
          modifiedAt: MODIFIED_AT,
          priority: 1
        }
      ]
    ])
    cleanup()

    // 이미지가 아니면 종류 글리프와 확장자(대기 표시 없음).
    const { container } = render(<EntryThumb entry={fromLocalEntry(local('C:\\d', 'a.zip'))} />)
    expect(screen.queryByRole('img', { name: en['thumbnail.loading'] })).toBeNull()
    expect(container.querySelector('svg.lucide-file-archive, svg[class*="archive"]')).not.toBeNull()
    expect(screen.getByText('zip')).toBeTruthy()
    cleanup()

    // 폴더는 폴더 미리보기(안의 첫 사진)를 그린다.
    const inner = { name: 'x.jpg', size: 10, modifiedAt: MODIFIED_AT, itemCount: 4 }
    useGalleryStore.setState({
      remoteFolderPreviews: { '/photos/sub': { status: 'resolved', preview: inner } }
    })
    useThumbnailStore.setState({
      thumbnails: {
        [generateCacheKeyRenderer(HOST, PORT, '/photos/sub/x.jpg', 10, MODIFIED_AT)]: {
          dataUrl: 'data:image/png;base64,AA==',
          width: 1,
          height: 1
        }
      }
    })
    render(<EntryThumb entry={remote('sub', { dir: true })} folderPreview />)
    expect(
      screen.getByAltText(en['preview.folderAlt'].replace('{{path}}', '/photos/sub'))
    ).toBeTruthy()
  })
})
