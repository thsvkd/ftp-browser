import { describe, it, expect } from 'vitest'
import { isInsideFolder } from './paths'

describe('isInsideFolder', () => {
  it('compares normalized absolute paths, ignoring case only on Windows', () => {
    // covers: Test-612
    const posix: Array<[string, string, boolean]> = [
      ['/home/me/Downloads', '/home/me/Downloads', true],
      ['/home/me/Downloads', '/home/me/Downloads/', true],
      ['/home/me/Downloads/', '/home/me/Downloads/a/b.jpg', true],
      ['/home/me/Downloads', '/home/me/Downloads/./a//b', true],
      ['/home/me/Downloads', '/home/me/Downloads/../.config/autostart', false],
      ['/home/me/Downloads', '/home/me/Downloads-evil/x', false],
      ['/home/me/Downloads', '/home/me', false],
      ['/home/me/Downloads', '/home/me/downloads/x', false],
      ['/', '/etc/passwd', true]
    ]
    for (const [root, target, inside] of posix) {
      expect(isInsideFolder(root, target, 'linux'), `${root} ${target}`).toBe(inside)
    }
    const win32: Array<[string, string, boolean]> = [
      ['C:\\Users\\Me\\Downloads', 'c:\\users\\me\\downloads\\a.jpg', true],
      ['C:\\Users\\Me\\Downloads', 'C:/Users/Me/Downloads/sub/a.jpg', true],
      ['C:\\Users\\Me\\Downloads\\', 'C:\\Users\\Me\\DOWNLOADS', true],
      ['C:\\Users\\Me\\Downloads', 'C:\\Users\\Me\\Downloads\\..\\AppData\\Roaming', false],
      ['C:\\Users\\Me\\Downloads', 'C:\\Users\\Me\\Downloads2\\a.jpg', false],
      ['C:\\Users\\Me\\Downloads', 'D:\\Users\\Me\\Downloads\\a.jpg', false],
      ['C:\\', 'c:\\Windows', true]
    ]
    for (const [root, target, inside] of win32) {
      expect(isInsideFolder(root, target, 'win32'), `${root} ${target}`).toBe(inside)
    }
  })
})
