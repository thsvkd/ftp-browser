import { describe, it, expect, vi, beforeEach } from 'vitest'

// appMenu.ts drives electron's Menu; mock it so the module loads under node.
vi.mock('electron', () => ({
  Menu: {
    buildFromTemplate: vi.fn((template: unknown[]) => ({ template })),
    setApplicationMenu: vi.fn()
  }
}))

import { Menu } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { buildAppMenuTemplate, applyApplicationMenu } from './appMenu'

/** 서브메뉴의 직계 항목들. Electron은 배열 또는 Menu 인스턴스를 받는다. */
function submenuItems(item: MenuItemConstructorOptions): MenuItemConstructorOptions[] {
  const submenu = item.submenu
  if (!Array.isArray(submenu)) {
    throw new Error(`Menu "${String(item.label)}" has no array submenu`)
  }
  return submenu
}

function darwinTemplate(): MenuItemConstructorOptions[] {
  const template = buildAppMenuTemplate('darwin')
  if (!template) throw new Error('buildAppMenuTemplate("darwin") returned null')
  return template
}

/** 라벨로 찾은 최상위 메뉴의 직계 role 목록. */
function submenuRoles(template: MenuItemConstructorOptions[], label: string): string[] {
  const menu = template.find((item) => item.label === label)
  if (!menu) throw new Error(`No "${label}" menu in the template`)
  return submenuItems(menu).map((item) => item.role ?? '')
}

/**
 * 기본 서브메뉴를 **자동으로 채우는** Electron 매크로 role (D10 금지 대상).
 *
 * `{ role: 'viewMenu' }`는 Reload / Force Reload / **Toggle Developer Tools** / Reset Zoom으로
 * 펼쳐지지만, 템플릿 객체에는 `'viewMenu'` 문자열 하나만 남는다. 즉 아래 role 스캔은 전개
 * 결과를 볼 수 없어 `toggleDevTools` 부재만으로는 D5를 지킬 수 없다. 전개를 잡을 수 없으니
 * **매크로 이름 자체의 부재**로 검사한다.
 *
 * 앞의 5개가 Electron이 항목을 주입하는 role 전부다(`appMenu`·`fileMenu`·`editMenu`·
 * `viewMenu`·`windowMenu`). `help`는 항목을 주입하진 않지만 최상위 메뉴를 통째로 OS에
 * 위임하므로 D10의 "명시적 submenu 배열" 원칙에 어긋나 함께 막는다.
 *
 * 제외한 것: `services`·`window`·`recentDocuments`·`shareMenu`. 이들은 항목을 주입하지 않아
 * `toggleDevTools`를 되살릴 수 없고, 특히 `{ role: 'services' }`는 표준 macOS 앱 메뉴를
 * 명시적 submenu로 펼쳐 쓸 때 그 안에 들어가는 정상 항목이다. 막으면 D10을 지킨 구현이
 * 오탐으로 걸린다.
 */
const MACRO_ROLES = ['appMenu', 'fileMenu', 'editMenu', 'viewMenu', 'windowMenu', 'help']

/** 템플릿 전체(중첩 서브메뉴 포함)의 role 목록. */
function allRoles(items: MenuItemConstructorOptions[]): string[] {
  return items.flatMap((item) => {
    const submenu = item.submenu
    const nested = Array.isArray(submenu) ? allRoles(submenu) : []
    return item.role ? [item.role, ...nested] : nested
  })
}

beforeEach(() => {
  vi.mocked(Menu.buildFromTemplate).mockClear()
  vi.mocked(Menu.setApplicationMenu).mockClear()
})

describe('buildAppMenuTemplate', () => {
  it('should return no template on Windows', () => {
    // covers: Test-117
    expect(buildAppMenuTemplate('win32')).toBeNull()
  })

  it('should return no template on Linux', () => {
    // covers: Test-118
    expect(buildAppMenuTemplate('linux')).toBeNull()
  })

  it('should put an app menu carrying the quit role first on macOS', () => {
    // covers: Test-119
    const [appMenu] = darwinTemplate()

    expect(submenuItems(appMenu).map((item) => item.role)).toContain('quit')
  })

  it('should offer the clipboard roles in the macOS Edit menu', () => {
    // covers: Test-120
    const roles = submenuRoles(darwinTemplate(), 'Edit')

    expect(roles).toEqual(expect.arrayContaining(['cut', 'copy', 'paste', 'selectAll']))
  })

  it('should offer undo and redo in the macOS Edit menu', () => {
    // covers: Test-121
    const roles = submenuRoles(darwinTemplate(), 'Edit')

    expect(roles).toEqual(expect.arrayContaining(['undo', 'redo']))
  })

  it('should offer a Window menu with minimize and close on macOS', () => {
    // covers: Test-122
    const roles = submenuRoles(darwinTemplate(), 'Window')

    expect(roles).toEqual(expect.arrayContaining(['minimize', 'close']))
  })

  it('should never expose a toggleDevTools role on macOS', () => {
    // covers: Test-123
    // D5: 메뉴 항목이 생기면 --devtools 플래그 없이도 개발자 도구가 열린다.
    const roles = allRoles(darwinTemplate())

    expect(roles).not.toContain('toggleDevTools')
    // D10: 매크로 role은 런타임 전개 결과를 이 스캔에서 숨긴다. 위 단언만으로는
    // `{ role: 'viewMenu' }` 하나로 Toggle Developer Tools가 되살아나는 것을 못 잡는다.
    expect(roles.filter((role) => MACRO_ROLES.includes(role))).toEqual([])
  })
})

describe('applyApplicationMenu', () => {
  it('should install the built macOS template as the application menu', () => {
    // covers: Test-124
    const template = darwinTemplate()
    vi.mocked(Menu.buildFromTemplate).mockClear()

    applyApplicationMenu('darwin')

    expect(Menu.buildFromTemplate).toHaveBeenCalledWith(template)
    const built = vi.mocked(Menu.buildFromTemplate).mock.results[0].value
    expect(Menu.setApplicationMenu).toHaveBeenCalledWith(built)
  })

  it('should clear the application menu on Windows', () => {
    // covers: Test-125
    applyApplicationMenu('win32')

    expect(Menu.setApplicationMenu).toHaveBeenCalledWith(null)
    // D6: Windows는 메뉴바 자체가 없어야 하므로 메뉴를 만들지도 않는다.
    expect(Menu.buildFromTemplate).not.toHaveBeenCalled()
  })

  it('should clear the application menu on Linux', () => {
    // covers: Test-163
    // 정정 3: Test-117·118은 템플릿만, Test-124·125는 darwin/win32만 봤다.
    // linux 적용 경로가 비어 있었다.
    applyApplicationMenu('linux')

    expect(Menu.setApplicationMenu).toHaveBeenCalledWith(null)
    expect(Menu.buildFromTemplate).not.toHaveBeenCalled()
  })
})
