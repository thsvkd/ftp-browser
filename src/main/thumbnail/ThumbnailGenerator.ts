import sharp from 'sharp'
import { THUMBNAIL_SIZE, THUMBNAIL_QUALITY } from '@shared/constants'

export interface GeneratedThumbnail {
  buffer: Buffer
  width: number
  height: number
  format: string
}

export class ThumbnailGenerator {
  async generate(imageBuffer: Buffer): Promise<GeneratedThumbnail> {
    const result = await sharp(imageBuffer)
      .rotate() // Auto-rotate based on EXIF orientation
      .resize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, {
        fit: 'inside',
        withoutEnlargement: true
      })
      .jpeg({ quality: THUMBNAIL_QUALITY })
      .toBuffer({ resolveWithObject: true })

    return {
      buffer: result.data,
      width: result.info.width,
      height: result.info.height,
      format: 'jpeg'
    }
  }

  async getFormat(imageBuffer: Buffer): Promise<string> {
    const metadata = await sharp(imageBuffer).metadata()
    return metadata.format ?? 'unknown'
  }
}
