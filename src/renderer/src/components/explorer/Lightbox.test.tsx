/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { fromFtpEntry } from '@renderer/lib/explorerEntry'
import { Lightbox } from './Lightbox'
import { flush, ftp, server, setupExplorer, type ExplorerHarness } from './explorerTestHarness'

let h: ExplorerHarness
beforeEach(() => {
  h = setupExplorer()
})
afterEach(() => {
  cleanup()
  h.restore()
})

const renderVideo = (): HTMLElement => {
  const entry = fromFtpEntry(ftp('a.webm'), '/videos', server())
  render(<Lightbox items={[entry]} index={0} onIndex={vi.fn()} onClose={vi.fn()} />)
  return screen.getByRole('dialog')
}

describe('Lightbox video preview', () => {
  it('shows the loading placeholder, not "No preview available", while a video loads', async () => {
    // covers: Test-1294
    h.handlers['ftp:downloadPreview'] = () => new Promise(() => {})
    const dialog = renderVideo()
    await flush()

    expect(dialog.querySelector('.animate-pulse')).not.toBeNull()
    expect(screen.queryByText('No preview available')).toBeNull()
  })

  it('shows the preview.failed text when the <video> fails to decode', async () => {
    // covers: Test-1297
    h.handlers['ftp:downloadPreview'] = () => ({
      success: true,
      data: 'data:video/webm;base64,AA=='
    })
    const dialog = renderVideo()
    await flush()

    const video = dialog.querySelector('video')
    expect(video).not.toBeNull()
    fireEvent.error(video as HTMLVideoElement)

    expect(dialog.querySelector('video')).toBeNull()
    expect(screen.getByText(/Couldn't load the preview\./)).toBeTruthy()
  })
})
