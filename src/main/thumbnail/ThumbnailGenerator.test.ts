import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ThumbnailGenerator } from './ThumbnailGenerator'

// Mock sharp
const mockToBuffer = vi.fn()
const mockMetadata = vi.fn()
const mockSharpInstance = {
  rotate: vi.fn().mockReturnThis(),
  resize: vi.fn().mockReturnThis(),
  jpeg: vi.fn().mockReturnThis(),
  toBuffer: mockToBuffer,
  metadata: mockMetadata
}

vi.mock('sharp', () => ({
  default: vi.fn(() => mockSharpInstance)
}))

vi.mock('@shared/constants', () => ({
  THUMBNAIL_SIZE: 150,
  THUMBNAIL_QUALITY: 80
}))

describe('ThumbnailGenerator', () => {
  let generator: ThumbnailGenerator

  beforeEach(() => {
    vi.clearAllMocks()
    generator = new ThumbnailGenerator()
  })

  describe('generate', () => {
    it('should generate a thumbnail with correct pipeline', async () => {
      const inputBuffer = Buffer.from('fake-image-data')
      const outputBuffer = Buffer.from('fake-thumbnail-data')

      mockToBuffer.mockResolvedValue({
        data: outputBuffer,
        info: { width: 150, height: 100, format: 'jpeg' }
      })

      const result = await generator.generate(inputBuffer)

      expect(result.buffer).toBe(outputBuffer)
      expect(result.width).toBe(150)
      expect(result.height).toBe(100)
      expect(result.format).toBe('jpeg')

      // Verify the pipeline: rotate -> resize -> jpeg -> toBuffer
      expect(mockSharpInstance.rotate).toHaveBeenCalled()
      expect(mockSharpInstance.resize).toHaveBeenCalledWith(150, 150, {
        fit: 'inside',
        withoutEnlargement: true
      })
      expect(mockSharpInstance.jpeg).toHaveBeenCalledWith({ quality: 80 })
      expect(mockToBuffer).toHaveBeenCalledWith({ resolveWithObject: true })
    })

    it('should handle small images without enlargement', async () => {
      const inputBuffer = Buffer.from('small-image')
      mockToBuffer.mockResolvedValue({
        data: Buffer.from('small-thumb'),
        info: { width: 50, height: 30, format: 'jpeg' }
      })

      const result = await generator.generate(inputBuffer)

      expect(result.width).toBe(50)
      expect(result.height).toBe(30)
      expect(mockSharpInstance.resize).toHaveBeenCalledWith(
        150,
        150,
        expect.objectContaining({ withoutEnlargement: true })
      )
    })

    it('should throw on invalid image data', async () => {
      mockToBuffer.mockRejectedValue(new Error('Input buffer contains unsupported image format'))

      await expect(generator.generate(Buffer.from('not-an-image'))).rejects.toThrow(
        'Input buffer contains unsupported image format'
      )
    })
  })

  describe('getFormat', () => {
    it('should return the image format', async () => {
      mockMetadata.mockResolvedValue({ format: 'png' })

      const format = await generator.getFormat(Buffer.from('png-data'))
      expect(format).toBe('png')
    })

    it('should return "unknown" for undetectable format', async () => {
      mockMetadata.mockResolvedValue({ format: undefined })

      const format = await generator.getFormat(Buffer.from('unknown-data'))
      expect(format).toBe('unknown')
    })

    it('should throw on corrupt data', async () => {
      mockMetadata.mockRejectedValue(new Error('Input buffer is corrupt'))

      await expect(generator.getFormat(Buffer.from('corrupt'))).rejects.toThrow()
    })
  })
})
