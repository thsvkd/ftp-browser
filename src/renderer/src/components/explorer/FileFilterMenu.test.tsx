/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { en } from '@renderer/i18n/locales/en'
import { fromLocalEntry, type ExplorerEntry } from '@renderer/lib/explorerEntry'
import { EMPTY_FILTER, type TabFilter } from '@renderer/lib/fileCategories'
import { MENU_VIEWPORT_MARGIN } from '@renderer/lib/menuPosition'
import { useFileCategoryStore } from '@renderer/stores/useFileCategoryStore'
import { useActiveTab, useTabsStore } from '@renderer/stores/useTabsStore'
import { stubMenuViewport } from '@renderer/test/rendererTestUtils'
import { FileFilterMenu } from './FileFilterMenu'
import {
  activeTab,
  local,
  localLoc,
  setupExplorer,
  type ExplorerHarness
} from './explorerTestHarness'

const DIR = 'C:\\c'
const entry = (name: string, dir = false): ExplorerEntry =>
  fromLocalEntry(local(DIR, name, { dir }))
const FOLDER = ['a.jpg', 'a.PNG', 'b.cr3', 'c.mp4', 'd.txt', 'README', '.hidden.jpg', 'sub'].map(
  (n) => entry(n, n === 'sub')
)
/** 숨김 파일은 호출한 쪽(Explorer)이 설정에 맞춰 걸러 넘긴다(E19). */
const visibleOnly = (list: ExplorerEntry[]): ExplorerEntry[] => list.filter((e) => !e.hidden)

let h: ExplorerHarness
let entries: ExplorerEntry[]

function Host({ list = entries }: { list?: ExplorerEntry[] }): React.JSX.Element | null {
  const tab = useActiveTab()
  return tab ? <FileFilterMenu tab={tab} entries={list} hiddenCount={2} compact={false} /> : null
}

beforeEach(() => {
  h = setupExplorer()
  entries = visibleOnly(FOLDER)
  useTabsStore.getState().openTab(localLoc(DIR))
})
afterEach(() => {
  cleanup()
  h.restore()
})

const trigger = (): HTMLElement => screen.getByRole('button', { name: en['filter.button'] })
const open = (list?: ExplorerEntry[]): ReturnType<typeof render> => {
  const result = render(<Host list={list} />)
  fireEvent.click(trigger())
  return result
}
const dialog = (): HTMLElement => screen.getByRole('dialog', { name: en['filter.menuLabel'] })
const advancedButton = (): HTMLElement => screen.getByRole('button', { name: /Advanced/ })
const advanced = (): HTMLElement =>
  screen.getByRole('group', { name: en['filter.advancedHeading'] })
const filterNow = (): TabFilter => activeTab().filter
const rowTexts = (root: HTMLElement): string[] =>
  within(root)
    .getAllByRole('checkbox')
    .map((c) => c.closest('label')?.textContent ?? '')
const check = (name: string | RegExp): void => {
  fireEvent.click(within(dialog()).getByRole('checkbox', { name }))
}

describe('FileFilterMenu — opening and closing', () => {
  it('stays open after the click that opened it and closes on outside pointerdown, Esc and blur', async () => {
    // covers: Test-938
    const actEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    const prevEnv = actEnv.IS_REACT_ACT_ENVIRONMENT
    render(<Host />)
    // 실제 마우스는 act() 밖에서 pointerdown → mouseup → click 순서로 들어온다.
    actEnv.IS_REACT_ACT_ENVIRONMENT = false
    try {
      const press = (el: HTMLElement): void => {
        for (const type of ['pointerdown', 'mouseup', 'click'])
          el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }))
      }
      press(trigger())
      await waitFor(() => expect(dialog()).toBeTruthy())
      await new Promise((r) => setTimeout(r, 30))
      expect(dialog()).toBeTruthy()
      expect(trigger().getAttribute('aria-expanded')).toBe('true')

      // 트리거를 다시 누르면 닫힌다.
      press(trigger())
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

      press(trigger())
      await waitFor(() => expect(dialog()).toBeTruthy())
      await new Promise((r) => setTimeout(r, 30))
    } finally {
      actEnv.IS_REACT_ACT_ENVIRONMENT = prevEnv
    }

    // 안쪽 pointerdown·체크박스 클릭으로는 닫히지 않는다.
    act(() => {
      within(dialog())
        .getAllByRole('checkbox')[0]
        .dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    })
    check(/Images/)
    expect(dialog()).toBeTruthy()

    // 바깥 pointerdown
    act(() => {
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    })
    expect(screen.queryByRole('dialog')).toBeNull()

    // Esc는 포커스를 트리거로 돌려준다.
    fireEvent.click(trigger())
    expect(dialog()).toBeTruthy()
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger())

    // 창 blur
    fireEvent.click(trigger())
    expect(dialog()).toBeTruthy()
    act(() => {
      window.dispatchEvent(new Event('blur'))
    })
    expect(screen.queryByRole('dialog')).toBeNull()

    // 닫힌 뒤에는 리스너가 남지 않는다: Esc가 포커스를 다시 가져가지 않는다.
    const other = document.createElement('button')
    document.body.append(other)
    other.focus()
    fireEvent.keyDown(other, { key: 'Escape' })
    expect(document.activeElement).toBe(other)
    other.remove()

    // 열린 채 언마운트해도 이후 이벤트가 오류를 내지 않는다.
    fireEvent.click(trigger())
    cleanup()
    expect(() => {
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      window.dispatchEvent(new Event('blur'))
    }).not.toThrow()
  })
})

describe('FileFilterMenu — categories', () => {
  it('lists visible categories in order with folder counts and keeps empty ones checkable', () => {
    // covers: Test-939
    open()
    expect(rowTexts(dialog())).toEqual([
      'Images (2)',
      'RAW (1)',
      'Videos (1)',
      'Audio (0)',
      'Documents (1)',
      'Archives (0)',
      'Code (0)'
    ])
    const audio = within(dialog()).getByRole('checkbox', { name: /Audio/ })
    expect(audio.closest('label')?.getAttribute('data-empty')).toBe('true')
    expect((audio as HTMLInputElement).disabled).toBe(false)
    expect(
      within(dialog())
        .getByRole('checkbox', { name: /Images/ })
        .closest('label')?.dataset.empty
    ).toBeUndefined()
    fireEvent.click(audio)
    expect(filterNow().categories).toEqual(['audio'])
    cleanup()

    // 숨김 파일이 목록에 들어 있으면(설정으로 보임) 센다.
    render(<Host list={FOLDER} />)
    fireEvent.click(trigger())
    expect(rowTexts(dialog())[0]).toBe('Images (3)')
    cleanup()

    // 숨긴 카테고리는 빠지고 사용자 카테고리는 끝에 온다.
    useFileCategoryStore.getState().setHidden('code', true)
    useFileCategoryStore.getState().setHidden('audio', true)
    const id = useFileCategoryStore.getState().addCustom('Mine')!
    useFileCategoryStore.getState().addExtension(id, 'txt')
    render(<Host />)
    fireEvent.click(trigger())
    expect(rowTexts(dialog())).toEqual([
      'Images (2)',
      'RAW (1)',
      'Videos (1)',
      'Documents (1)',
      'Archives (0)',
      'Mine (1)'
    ])
    cleanup()

    // 개수는 로케일 숫자 서식을 따른다.
    const many = Array.from({ length: 1200 }, (_, i) => entry(`f${i}.jpg`))
    render(<Host list={many} />)
    fireEvent.click(trigger())
    expect(rowTexts(dialog())[0]).toBe('Images (1,200)')
  })

  it('stacks checks in order (OR), resets with Show all and leaves other tabs alone', () => {
    // covers: Test-940
    const other = useTabsStore.getState().openTab(localLoc('C:\\other'), false)
    open()
    const showAll = (): HTMLButtonElement =>
      within(dialog()).getByRole('button', { name: en['explorer.showAll'] })
    expect(showAll().disabled).toBe(true)

    check(/Images/)
    check(/Videos/)
    expect(filterNow().categories).toEqual(['image', 'video'])
    check(/Images/)
    expect(filterNow().categories).toEqual(['video'])
    check(/Images/)
    expect(filterNow().categories).toEqual(['video', 'image'])
    expect(useTabsStore.getState().tabs.find((t) => t.id === other)!.filter).toBe(EMPTY_FILTER)

    expect(showAll().disabled).toBe(false)
    fireEvent.click(showAll())
    expect(filterNow()).toEqual(EMPTY_FILTER)
    for (const box of within(dialog()).getAllByRole('checkbox'))
      expect((box as HTMLInputElement).checked).toBe(false)
    expect(showAll().disabled).toBe(true)
    // 비활성이 된 버튼에 포커스가 남지 않고 첫 체크박스로 옮겨 간다.
    expect(document.activeElement).toBe(within(dialog()).getAllByRole('checkbox')[0])
  })
})

describe('FileFilterMenu — advanced extensions', () => {
  it('lists the folder extensions with counts and keeps orphan conditions as removable chips', () => {
    // covers: Test-941
    const { rerender } = open()
    expect(advancedButton().getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('group', { name: en['filter.advancedHeading'] })).toBeNull()
    fireEvent.click(advancedButton())
    expect(advancedButton().getAttribute('aria-expanded')).toBe('true')
    expect(rowTexts(advanced())).toEqual([
      '.cr3 (1)',
      '.jpg (1)',
      '.mp4 (1)',
      '.png (1)',
      '.txt (1)',
      '(no extension) (1)'
    ])

    fireEvent.click(within(advanced()).getByRole('checkbox', { name: '.jpg (1)' }))
    fireEvent.click(within(advanced()).getByRole('checkbox', { name: '(no extension) (1)' }))
    expect(filterNow()).toMatchObject({ extensions: ['jpg'], noExtension: true })
    check(/Videos/)
    expect(filterNow().categories).toEqual(['video'])
    // 접었다 펴도 체크는 유지된다.
    fireEvent.click(advancedButton())
    fireEvent.click(advancedButton())
    expect(
      (within(advanced()).getByRole('checkbox', { name: '.jpg (1)' }) as HTMLInputElement).checked
    ).toBe(true)

    // 다른 폴더(.gif만): .jpg 행은 없고 칩이 된다. 저장된 필터는 그대로다.
    const gifs = [entry('x.gif')]
    rerender(<Host list={gifs} />)
    expect(rowTexts(advanced())).toEqual(['.gif (1)', '(no extension) (0)'])
    const zero = within(advanced()).getByRole('checkbox', { name: '(no extension) (0)' })
    expect(zero.closest('label')?.getAttribute('data-empty')).toBe('true')
    expect((zero as HTMLInputElement).checked).toBe(true)
    expect(filterNow().extensions).toEqual(['jpg'])
    const remove = within(advanced()).getByRole('button', { name: 'Remove jpg' })
    fireEvent.click(zero)
    expect(filterNow().noExtension).toBe(false)
    expect(rowTexts(advanced())).toEqual(['.gif (1)'])
    fireEvent.click(remove)
    expect(filterNow().extensions).toEqual([])

    // .jpg가 있는 폴더로 돌아오면 칩은 사라지고 행이 체크돼 있다.
    act(() =>
      useTabsStore
        .getState()
        .patchTab(activeTab().id, { filter: { ...EMPTY_FILTER, extensions: ['jpg'] } })
    )
    expect(within(advanced()).getByRole('button', { name: 'Remove jpg' })).toBeTruthy()
    rerender(<Host />)
    expect(within(advanced()).queryByRole('button', { name: 'Remove jpg' })).toBeNull()
    expect(
      (within(advanced()).getByRole('checkbox', { name: '.jpg (1)' }) as HTMLInputElement).checked
    ).toBe(true)

    // 확장자 조건이 있으면 열 때 "고급…"이 펼쳐져 있다. 없으면 접혀 있다.
    cleanup()
    render(<Host />)
    fireEvent.click(trigger())
    expect(advancedButton().getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(within(advanced()).getByRole('checkbox', { name: '.jpg (1)' }))
    cleanup()
    render(<Host />)
    fireEvent.click(trigger())
    expect(advancedButton().getAttribute('aria-expanded')).toBe('false')
  })
})

describe('FileFilterMenu — extension tags', () => {
  const input = (): HTMLInputElement =>
    within(advanced()).getByRole('textbox', { name: en['filter.extensionInput'] })
  const type = (value: string, key: string, extra: KeyboardEventInit = {}): void => {
    fireEvent.change(input(), { target: { value } })
    fireEvent.keyDown(input(), { key, ...extra })
  }

  it('confirms on Enter, comma and space, normalises, derives chips and rejects bad tokens', () => {
    // covers: Test-942
    open()
    fireEvent.click(advancedButton())

    type('.TAR.GZ', 'Enter')
    expect(filterNow().extensions).toEqual(['tar.gz'])
    expect(within(advanced()).getByRole('button', { name: 'Remove tar.gz' })).toBeTruthy()
    expect(input().value).toBe('')

    type('tar.gz', 'Enter')
    expect(filterNow().extensions).toEqual(['tar.gz'])

    type('log', ',')
    type('md', ' ')
    expect(filterNow().extensions).toEqual(['tar.gz', 'log', 'md'])

    // 폴더에 있는 확장자는 칩이 아니라 그 행이 체크된다.
    type('.PNG', 'Enter')
    expect(filterNow().extensions).toContain('png')
    expect(within(advanced()).queryByRole('button', { name: 'Remove png' })).toBeNull()
    expect(
      (within(advanced()).getByRole('checkbox', { name: '.png (1)' }) as HTMLInputElement).checked
    ).toBe(true)

    // 붙여넣기는 같은 규칙으로 쪼갠다.
    fireEvent.paste(input(), { clipboardData: { getData: () => 'zip, 7z  .TXT' } })
    expect(filterNow().extensions).toEqual(['tar.gz', 'log', 'md', 'png', 'zip', '7z', 'txt'])

    // 잘못된 토큰은 입력칸에 남고 aria-invalid.
    type('a/b', 'Enter')
    expect(input().value).toBe('a/b')
    expect(input().getAttribute('aria-invalid')).toBe('true')
    expect(filterNow().extensions).not.toContain('a/b')
    fireEvent.change(input(), { target: { value: '' } })
    expect(input().getAttribute('aria-invalid')).toBe('false')

    // IME 조합 중의 Enter·Space는 확정하지 않는다.
    type('rar', 'Enter', { isComposing: true })
    type('rar', ' ', { isComposing: true })
    fireEvent.keyDown(input(), { key: 'Process', keyCode: 229 })
    expect(filterNow().extensions).not.toContain('rar')
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(filterNow().extensions).toContain('rar')

    // 칩 제거 버튼
    fireEvent.click(within(advanced()).getByRole('button', { name: 'Remove tar.gz' }))
    expect(filterNow().extensions).not.toContain('tar.gz')

    // 입력칸의 키는 목록 단축키(Delete·type-ahead)로 새지 않는다. Esc는 닫기로 이어진다.
    const leaked = vi.fn()
    document.addEventListener('keydown', leaked)
    fireEvent.keyDown(input(), { key: 'Delete' })
    fireEvent.keyDown(input(), { key: 'a' })
    expect(leaked).not.toHaveBeenCalled()
    fireEvent.keyDown(input(), { key: 'Escape' })
    expect(leaked).toHaveBeenCalledTimes(1)
    document.removeEventListener('keydown', leaked)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('FileFilterMenu — keyboard and accessibility', () => {
  it('wires the trigger to the dialog, focuses the first control and toggles with Space', async () => {
    // covers: Test-943
    const user = userEvent.setup()
    const tab = activeTab()
    render(<Host />)
    expect(trigger().getAttribute('aria-haspopup')).toBe('dialog')
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    expect(trigger().getAttribute('aria-controls')).toBe(`filter-menu-${tab.id}`)

    trigger().focus()
    await user.keyboard('{Enter}')
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    expect(dialog().id).toBe(`filter-menu-${tab.id}`)
    expect(dialog().getAttribute('aria-label')).toBe('File type filter')
    // "모두 보기"는 비활성이라 첫 체크박스가 포커스를 받는다.
    expect(document.activeElement).toBe(within(dialog()).getByRole('checkbox', { name: /Images/ }))
    await user.keyboard('{Tab}')
    expect(document.activeElement).toBe(within(dialog()).getByRole('checkbox', { name: /RAW/ }))
    await user.keyboard(' ')
    expect(filterNow().categories).toEqual(['raw'])
  })

  it('is moved back inside the viewport by clampMenuPosition when it would overflow', () => {
    // covers: Test-943
    const viewport = stubMenuViewport({ width: 288, height: 200 }, { width: 1000, height: 800 })
    try {
      render(<Host />)
      const el = trigger()
      Object.defineProperty(el, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({ left: 900, right: 1000, top: 740, bottom: 780, width: 100, height: 40 })
      })
      fireEvent.click(el)
      const style = dialog().style
      expect(style.position).toBe('fixed')
      // 오른쪽 끝: 앵커 x(right - 288 = 712) + 288 이 뷰포트(1000) - 여백(4)을 넘어 뒤집힌다.
      // 보정이 없으면 left는 712로 남아 팝오버의 오른쪽 끝이 뷰포트 밖 여백을 침범한다.
      expect(parseFloat(style.left)).toBe(712 - 288)
      expect(parseFloat(style.left) + 288).toBeLessThanOrEqual(1000 - MENU_VIEWPORT_MARGIN)
      expect(parseFloat(style.left)).toBeGreaterThanOrEqual(MENU_VIEWPORT_MARGIN)
      // 아래: bottom(780) + 4 + 200 이 뷰포트(800)를 넘어 앵커 기준으로 뒤집힌다.
      expect(parseFloat(style.top)).toBe(780 + 4 - 200)
    } finally {
      viewport.restore()
    }
  })
})
