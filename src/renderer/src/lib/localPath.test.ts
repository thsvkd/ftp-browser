import { describe, it, expect } from 'vitest'
import { getParentPath, joinLocalPath } from './localPath'

describe('getParentPath', () => {
  describe('Windows paths', () => {
    it('should return parent directory', () => {
      expect(getParentPath('C:\\Users\\test\\docs')).toBe('C:\\Users\\test')
    })

    it('should return parent for nested path', () => {
      expect(getParentPath('C:\\Users\\test')).toBe('C:\\Users')
    })

    it('should return null for drive root', () => {
      expect(getParentPath('C:\\')).toBeNull()
    })

    it('should treat bare drive letter as non-Windows path (no trailing separator)', () => {
      // isWindowsPath requires C:\ or C:/ — bare "C:" is not matched
      expect(getParentPath('C:')).toBe('/')
    })

    it('should handle trailing separator', () => {
      expect(getParentPath('C:\\Users\\test\\')).toBe('C:\\Users')
    })

    it('should handle path with forward slashes', () => {
      expect(getParentPath('C:/Users/test')).toBe('C:/Users')
    })

    it('should return the drive root for a path just below root', () => {
      expect(getParentPath('C:\\Users')).toBe('C:\\')
      expect(getParentPath('D:/work/')).toBe('D:/')
    })
  })

  describe('Unix paths', () => {
    it('should return parent directory', () => {
      expect(getParentPath('/home/user/docs')).toBe('/home/user')
    })

    it('should return root for top-level directory', () => {
      expect(getParentPath('/home')).toBe('/')
    })

    it('should return null for root', () => {
      expect(getParentPath('/')).toBeNull()
    })

    it('should handle trailing slash', () => {
      expect(getParentPath('/home/user/')).toBe('/home')
    })
  })
})

describe('joinLocalPath', () => {
  describe('Windows paths', () => {
    it('should join directory and filename', () => {
      expect(joinLocalPath('C:\\Users\\test', 'file.txt')).toBe('C:\\Users\\test\\file.txt')
    })

    it('should not double separator when dir ends with backslash', () => {
      expect(joinLocalPath('C:\\Users\\test\\', 'file.txt')).toBe('C:\\Users\\test\\file.txt')
    })

    it('should join at drive root', () => {
      expect(joinLocalPath('C:\\', 'Users')).toBe('C:\\Users')
    })

    it('should handle subdirectory names', () => {
      expect(joinLocalPath('C:\\Users', 'Documents')).toBe('C:\\Users\\Documents')
    })
  })

  describe('Unix paths', () => {
    it('should join directory and filename', () => {
      expect(joinLocalPath('/home/user', 'file.txt')).toBe('/home/user/file.txt')
    })

    it('should not double separator when dir ends with slash', () => {
      expect(joinLocalPath('/home/user/', 'file.txt')).toBe('/home/user/file.txt')
    })

    it('should join at root', () => {
      expect(joinLocalPath('/', 'home')).toBe('/home')
    })

    it('should handle nested joins', () => {
      expect(joinLocalPath('/usr/local', 'bin')).toBe('/usr/local/bin')
    })
  })

  describe('special filenames', () => {
    it('should handle filenames with spaces', () => {
      expect(joinLocalPath('/home/user', 'my file.txt')).toBe('/home/user/my file.txt')
    })

    it('should handle unicode filenames', () => {
      expect(joinLocalPath('C:\\Users', '한글폴더')).toBe('C:\\Users\\한글폴더')
    })

    it('should handle dotfiles', () => {
      expect(joinLocalPath('/home/user', '.gitignore')).toBe('/home/user/.gitignore')
    })
  })
})
