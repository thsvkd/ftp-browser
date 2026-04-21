import { describe, it, expect } from 'vitest'
import {
  splitLocalPath,
  buildLocalPath,
  getParentPath,
  getRootLabel,
  getRootPath,
  joinLocalPath,
  isRootPath
} from './localPath'

describe('splitLocalPath', () => {
  it('should split Windows path', () => {
    expect(splitLocalPath('C:\\Users\\test\\docs')).toEqual(['C:', 'Users', 'test', 'docs'])
  })

  it('should split Unix path', () => {
    expect(splitLocalPath('/home/user/docs')).toEqual(['home', 'user', 'docs'])
  })

  it('should handle mixed separators', () => {
    expect(splitLocalPath('C:/Users\\test')).toEqual(['C:', 'Users', 'test'])
  })

  it('should filter empty parts from trailing separator', () => {
    expect(splitLocalPath('/home/user/')).toEqual(['home', 'user'])
  })

  it('should handle root paths', () => {
    expect(splitLocalPath('C:\\')).toEqual(['C:'])
    expect(splitLocalPath('/')).toEqual([])
  })
})

describe('buildLocalPath', () => {
  it('should build Windows path up to index', () => {
    const parts = ['C:', 'Users', 'test', 'docs']
    expect(buildLocalPath('C:\\Users\\test\\docs', parts, 0)).toBe('C:')
    expect(buildLocalPath('C:\\Users\\test\\docs', parts, 1)).toBe('C:\\Users')
    expect(buildLocalPath('C:\\Users\\test\\docs', parts, 3)).toBe('C:\\Users\\test\\docs')
  })

  it('should build Unix path up to index', () => {
    const parts = ['home', 'user', 'docs']
    expect(buildLocalPath('/home/user/docs', parts, 0)).toBe('/home')
    expect(buildLocalPath('/home/user/docs', parts, 2)).toBe('/home/user/docs')
  })

  it('should prefix Unix paths with /', () => {
    const parts = ['usr', 'local', 'bin']
    expect(buildLocalPath('/usr/local/bin', parts, 1)).toBe('/usr/local')
  })
})

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

    it('should return null for path just below root', () => {
      expect(getParentPath('C:\\Users')).toBeNull()
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

describe('getRootLabel', () => {
  it('should return drive letter for Windows', () => {
    expect(getRootLabel('C:\\Users\\test')).toBe('C:')
    expect(getRootLabel('D:\\data')).toBe('D:')
  })

  it('should return / for Unix', () => {
    expect(getRootLabel('/home/user')).toBe('/')
  })
})

describe('getRootPath', () => {
  it('should return drive root for Windows', () => {
    expect(getRootPath('C:\\Users\\test')).toBe('C:\\')
    expect(getRootPath('D:\\data\\files')).toBe('D:\\')
  })

  it('should return / for Unix', () => {
    expect(getRootPath('/home/user')).toBe('/')
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

describe('isRootPath', () => {
  describe('Windows paths', () => {
    it('should return true for drive root with backslash', () => {
      expect(isRootPath('C:\\')).toBe(true)
    })

    it('should return false for bare drive letter (no trailing separator)', () => {
      // isWindowsPath requires C:\ or C:/ — bare "C:" falls through to Unix check
      expect(isRootPath('C:')).toBe(false)
    })

    it('should return false for subdirectories', () => {
      expect(isRootPath('C:\\Users')).toBe(false)
      expect(isRootPath('C:\\Users\\test')).toBe(false)
    })

    it('should handle different drive letters', () => {
      expect(isRootPath('D:\\')).toBe(true)
      expect(isRootPath('Z:\\')).toBe(true)
    })

    it('should handle lowercase drive letters', () => {
      expect(isRootPath('c:\\')).toBe(true)
    })
  })

  describe('Unix paths', () => {
    it('should return true for root /', () => {
      expect(isRootPath('/')).toBe(true)
    })

    it('should return false for non-root paths', () => {
      expect(isRootPath('/home')).toBe(false)
      expect(isRootPath('/usr/local')).toBe(false)
    })
  })
})
