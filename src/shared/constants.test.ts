import { describe, it, expect } from 'vitest'
import { isImageFile, IMAGE_EXTENSIONS } from './constants'

describe('isImageFile', () => {
  it('should return true for supported image extensions', () => {
    const supported = [
      'photo.jpg',
      'photo.jpeg',
      'image.png',
      'animation.gif',
      'bitmap.bmp',
      'modern.webp',
      'scan.tiff',
      'scan.tif'
    ]
    for (const name of supported) {
      expect(isImageFile(name), `expected ${name} to be an image file`).toBe(true)
    }
  })

  it('should return true regardless of case', () => {
    expect(isImageFile('PHOTO.JPG')).toBe(true)
    expect(isImageFile('Image.PNG')).toBe(true)
    expect(isImageFile('file.Jpeg')).toBe(true)
  })

  it('should return false for non-image files', () => {
    const notImages = [
      'document.pdf',
      'readme.txt',
      'script.js',
      'archive.zip',
      'video.mp4',
      'music.mp3',
      'data.json',
      'page.html'
    ]
    for (const name of notImages) {
      expect(isImageFile(name), `expected ${name} to NOT be an image file`).toBe(false)
    }
  })

  it('should return false for files without extension', () => {
    expect(isImageFile('README')).toBe(false)
    expect(isImageFile('Makefile')).toBe(false)
  })

  it('should handle files with multiple dots', () => {
    expect(isImageFile('photo.backup.jpg')).toBe(true)
    expect(isImageFile('file.v2.txt')).toBe(false)
  })

  it('should handle dotfiles', () => {
    expect(isImageFile('.jpg')).toBe(true)
    expect(isImageFile('.gitignore')).toBe(false)
  })
})

describe('IMAGE_EXTENSIONS', () => {
  it('should contain all expected extensions', () => {
    const expected = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.tif']
    for (const ext of expected) {
      expect(IMAGE_EXTENSIONS.has(ext), `expected IMAGE_EXTENSIONS to contain ${ext}`).toBe(true)
    }
  })

  it('should have exactly 8 extensions', () => {
    expect(IMAGE_EXTENSIONS.size).toBe(8)
  })
})
