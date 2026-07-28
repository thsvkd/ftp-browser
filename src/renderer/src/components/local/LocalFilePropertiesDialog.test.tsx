/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { useLocalFsStore } from '@renderer/stores/useLocalFsStore'
import type { LocalFileEntry } from '@shared/types/local'
import { LocalFilePropertiesDialog } from './LocalFilePropertiesDialog'

const LOCAL_DIR = 'C:\\work'
const MODIFIED_AT = '2024-05-01T10:20:30.000Z'

function entryOf(overrides: Partial<LocalFileEntry> & { name: string }): LocalFileEntry {
  // `name`은 overrides에 반드시 있으므로 base에 두면 스프레드가 덮어써 무용하다.
  // `path`만 name에서 파생시키고 나머지는 기본값으로 둔다.
  const base: Omit<LocalFileEntry, 'name'> = {
    path: `${LOCAL_DIR}\\${overrides.name}`,
    type: 'file',
    size: 1024,
    modifiedAt: MODIFIED_AT,
    isImage: false
  }
  return { ...base, ...overrides }
}

interface RenderedDialog {
  onClose: ReturnType<typeof vi.fn>
  /** 전체 화면 오버레이. 바깥 클릭의 대상이다. */
  overlay: HTMLElement
  /** 오버레이 안의 카드. 내부 클릭의 대상이다. */
  card: HTMLElement
}

function renderDialog(entry: LocalFileEntry): RenderedDialog {
  const onClose = vi.fn()
  const { container } = render(<LocalFilePropertiesDialog entry={entry} onClose={onClose} />)
  const overlay = container.firstElementChild
  if (!(overlay instanceof HTMLElement)) throw new Error('dialog rendered no overlay')
  const card = overlay.firstElementChild
  if (!(card instanceof HTMLElement)) throw new Error('dialog rendered no card')
  return { onClose, overlay, card }
}

/** InfoRow는 라벨과 값을 한 행 안의 형제로 렌더한다. */
function propertyValue(label: string): string {
  const row = screen.getByText(label).parentElement
  if (!row) throw new Error(`No row element for property "${label}"`)
  return (row.textContent ?? '').slice(label.length).trim()
}

function typeLabelFor(entry: LocalFileEntry): string {
  const { unmount } = render(<LocalFilePropertiesDialog entry={entry} onClose={vi.fn()} />)
  const label = propertyValue('Type')
  unmount()
  return label
}

beforeEach(() => {
  useLocalFsStore.setState({ currentPath: LOCAL_DIR })
})

afterEach(() => {
  // RTL이 auto-cleanup을 등록하지만 그것은 이 훅보다 **나중에** 돈다(실측).
  // 언마운트가 아래 목 복원보다 먼저 일어나도록 여기서 명시적으로 부른다.
  cleanup()
  vi.restoreAllMocks()
})

describe('LocalFilePropertiesDialog — dismissal', () => {
  it('closes when Escape is pressed', () => {
    // covers: Test-75
    const { onClose } = renderDialog(entryOf({ name: 'photo.png', isImage: true }))
    expect(screen.queryByRole('heading', { name: 'Properties' })).not.toBeNull()

    // 대조군: 아무 키나 닫으면 안 된다. Escape 판정이 사라진 구현을 걸러낸다.
    fireEvent.keyDown(document, { key: 'a' })
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(onClose).toHaveBeenCalled()
  })

  it('closes when the overlay outside the dialog is clicked', () => {
    // covers: Test-76
    const { onClose, overlay } = renderDialog(entryOf({ name: 'photo.png', isImage: true }))

    fireEvent.click(overlay)

    expect(onClose).toHaveBeenCalled()
  })

  it('stays open when the inside of the dialog is clicked', () => {
    // covers: Test-77
    const { onClose, overlay, card } = renderDialog(entryOf({ name: 'photo.png', isImage: true }))
    // 다이얼로그가 실제로 떠 있는 상태에서의 관찰임을 먼저 고정한다.
    expect(screen.queryByRole('heading', { name: 'Properties' })).not.toBeNull()

    fireEvent.click(card)
    expect(onClose).not.toHaveBeenCalled()

    // 대조군: 같은 시나리오에서 오버레이 클릭은 닫는다. 내부 클릭만 막혔음을 보인다.
    fireEvent.click(overlay)
    expect(onClose).toHaveBeenCalled()
  })
})

describe('LocalFilePropertiesDialog — fields', () => {
  it('labels the type differently for each kind of entry', () => {
    // covers: Test-78
    const labels = {
      directory: typeLabelFor(entryOf({ name: 'docs', type: 'directory', size: 0 })),
      image: typeLabelFor(entryOf({ name: 'photo.png', isImage: true })),
      extension: typeLabelFor(entryOf({ name: 'notes.txt' })),
      extensionless: typeLabelFor(entryOf({ name: 'README' }))
    }

    // 대소문자 규칙 같은 계약 밖 세부에는 결합하지 않고 의미만 단언한다.
    expect(labels.directory).toMatch(/director/i)
    expect(labels.image).toMatch(/image/i)
    expect(labels.image).toMatch(/png/i)
    expect(labels.extension).toMatch(/txt/i)
    expect(labels.extensionless).toMatch(/^file$/i)

    // 네 분기가 서로 다른 라벨을 내야 한다. 한 분기가 사라져 다른 분기로
    // 흡수되면 위 개별 단언은 통과해도 이 단언이 잡는다.
    expect(new Set(Object.values(labels)).size).toBe(4)
  })

  it('shows the current directory as the Location', () => {
    // covers: Test-85
    // Full Path와 다른 값이어야 selector가 죽었을 때(=행이 사라질 때)만이 아니라
    // 엉뚱한 값을 넣었을 때도 잡힌다.
    useLocalFsStore.setState({ currentPath: 'C:\\work\\photos' })
    renderDialog(entryOf({ name: 'photo.png', isImage: true, path: 'C:\\work\\photos\\photo.png' }))

    expect(propertyValue('Location')).toBe('C:\\work\\photos')
  })

  it('omits the Size row for a directory', () => {
    // covers: Test-79
    renderDialog(entryOf({ name: 'docs', type: 'directory', size: 0 }))

    expect(screen.queryByText('Size')).toBeNull()
    // 대조군: 다이얼로그는 떠 있고 다른 행은 그대로다. 렌더 실패로 인한 통과가 아니다.
    expect(propertyValue('Name')).toBe('docs')
    expect(propertyValue('Type')).toMatch(/director/i)

    // 파일에는 Size가 나온다 — 조건이 통째로 참이 되거나 거짓이 되는 변형을 함께 잡는다.
    cleanup()
    renderDialog(entryOf({ name: 'notes.txt', size: 2048 }))
    expect(screen.queryByText('Size')).not.toBeNull()
  })
})
