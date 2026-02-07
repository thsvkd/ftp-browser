export const IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.bmp',
  '.webp',
  '.tiff',
  '.tif'
])

export const THUMBNAIL_SIZE = 150
export const THUMBNAIL_QUALITY = 80
export const MAX_CACHE_SIZE_BYTES = 500 * 1024 * 1024 // 500MB
export const MAX_PREVIEW_CACHE_SIZE_BYTES = 1024 * 1024 * 1024 // 1GB
export const MAX_IMAGE_SIZE_BYTES = 50 * 1024 * 1024 // 50MB - skip thumbnail for larger files
export const DEFAULT_FTP_PORT = 21

export function isImageFile(filename: string): boolean {
  const ext = filename.substring(filename.lastIndexOf('.')).toLowerCase()
  return IMAGE_EXTENSIONS.has(ext)
}
