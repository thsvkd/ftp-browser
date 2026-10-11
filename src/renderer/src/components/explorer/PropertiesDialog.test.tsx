/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { en } from '@renderer/i18n/locales/en'
import { fromFtpEntry, fromLocalEntry, type ExplorerEntry } from '@renderer/lib/explorerEntry'
import { formatDate } from '@renderer/lib/utils'
import { ftp, local, setupExplorer, type ExplorerHarness } from './explorerTestHarness'
import { PropertiesDialog } from './PropertiesDialog'

let h: ExplorerHarness
beforeEach(() => {
  h = setupExplorer()
})
afterEach(() => {
  cleanup()
  h.restore()
})

const DIR = 'C:\\work'
const file = (name: string, opts = {}): ExplorerEntry => fromLocalEntry(local(DIR, name, opts))

function open(entry: ExplorerEntry): { onClose: ReturnType<typeof vi.fn>; overlay: HTMLElement } {
  const onClose = vi.fn()
  render(<PropertiesDialog entry={entry} onClose={onClose} />)
  const overlay = screen.getByRole('dialog').parentElement
  if (!overlay) throw new Error('no overlay')
  return { onClose, overlay }
}

/** 사실 목록은 `dt`(이름)·`dd`(값) 짝이다. */
function fact(label: string): string | null {
  const dt = screen.queryAllByText(label, { selector: 'dt' })[0]
  return dt?.nextElementSibling?.textContent ?? null
}

function typeOf(entry: ExplorerEntry): string | null {
  const { unmount } = render(<PropertiesDialog entry={entry} onClose={vi.fn()} />)
  const v = fact(en['file.type'])
  unmount()
  return v
}

describe('PropertiesDialog — dismissal (migrated)', () => {
  it('closes on Escape and not on other keys', () => {
    // covers: Test-75
    const { onClose } = open(file('photo.png'))
    expect(screen.getByRole('dialog', { name: en['properties.title'] })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'a' })
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('closes when the overlay outside the dialog is clicked', () => {
    // covers: Test-76
    const { onClose, overlay } = open(file('photo.png'))
    fireEvent.click(overlay)
    expect(onClose).toHaveBeenCalled()
  })

  it('stays open when the inside of the dialog is clicked', () => {
    // covers: Test-77
    const { onClose, overlay } = open(file('photo.png'))
    fireEvent.click(screen.getByRole('dialog'))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(overlay)
    expect(onClose).toHaveBeenCalled()
  })
})

describe('PropertiesDialog — facts (migrated)', () => {
  it('labels the type differently for each kind of entry', () => {
    // covers: Test-78
    const labels = {
      directory: typeOf(file('docs', { dir: true })),
      image: typeOf(file('photo.png')),
      extension: typeOf(file('notes.txt')),
      extensionless: typeOf(file('README'))
    }
    expect(labels.directory).toMatch(/folder/i)
    expect(labels.image).toMatch(/image/i)
    expect(labels.image).toMatch(/png/i)
    expect(labels.extension).toMatch(/txt/i)
    expect(labels.extensionless).toMatch(/^file$/i)
    expect(new Set(Object.values(labels)).size).toBe(4)
  })

  it('omits the size for a folder and shows it for a file', () => {
    // covers: Test-79
    open(file('docs', { dir: true }))
    expect(fact(en['file.size'])).toBeNull()
    expect(screen.getByRole('heading', { name: 'docs' })).toBeTruthy()
    expect(fact(en['file.type'])).toMatch(/folder/i)
    cleanup()
    open(file('notes.txt', { size: 2048 }))
    expect(fact(en['file.size'])).not.toBeNull()
  })

  it('shows the containing folder as the location', () => {
    // covers: Test-85
    open(fromFtpEntry(ftp('a.jpg'), '/photos/2024', 'me@nas:21'))
    expect(fact(en['properties.location'])).toBe('/photos/2024')
    expect(fact(en['properties.fullPath'])).toBe('/photos/2024/a.jpg')
  })

  it('shows the name, full path, size and modified time', () => {
    // covers: Test-60
    const entry = file('report.pdf', { size: 2048 })
    open(entry)
    expect(screen.getByRole('heading', { name: 'report.pdf' })).toBeTruthy()
    expect(fact(en['properties.fullPath'])).toBe(`${DIR}\\report.pdf`)
    expect(fact(en['file.size'])).toBe('2 KB (2,048 bytes)')
    expect(fact(en['file.modified'])).toBe(formatDate(entry.modifiedAt))
  })
})
