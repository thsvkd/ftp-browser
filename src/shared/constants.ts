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

/**
 * Chromium이 실제로 재생할 수 있는 영상 확장자(P1). 카테고리 `video` 목록
 * (mkv·avi·wmv·mts·3gp 포함)의 부분 집합이다 — IMAGE_EXTENSIONS가 카테고리 image보다
 * 좁은 것과 같은 구조.
 */
export const VIDEO_EXTENSIONS = new Set(['.webm', '.mp4', '.mov', '.m4v'])

// Generated thumbnails are sized to the maximum gallery zoom so they stay crisp
// when zoomed all the way in (the gallery max thumbnail size derives from this).
export const THUMBNAIL_SIZE = 360
export const THUMBNAIL_QUALITY = 80
export const MAX_CACHE_SIZE_BYTES = 500 * 1024 * 1024 // 500MB
export const MAX_PREVIEW_CACHE_SIZE_BYTES = 1024 * 1024 * 1024 // 1GB
export const MAX_IMAGE_SIZE_BYTES = 50 * 1024 * 1024 // 50MB - skip thumbnail for larger files
export const MAX_VIDEO_SIZE_BYTES = 100 * 1024 * 1024 // 100MB (P5)
export const DEFAULT_FTP_PORT = 21

// 내장 MCP 서버(127.0.0.1 전용). 고정 포트라 Claude Code 등록 명령이 실행마다 바뀌지 않는다.
export const MCP_PORT = 47821

// Window title and the label of the macOS application menu. A packaged build is
// titled from electron-builder's `productName`; this is the in-source name so
// the two places that need it during development cannot drift apart.
export const APP_NAME = 'FTP Browser'

export function isImageFile(filename: string): boolean {
  const ext = filename.substring(filename.lastIndexOf('.')).toLowerCase()
  return IMAGE_EXTENSIONS.has(ext)
}

export function isVideoFile(filename: string): boolean {
  const ext = filename.substring(filename.lastIndexOf('.')).toLowerCase()
  return VIDEO_EXTENSIONS.has(ext)
}

/** 앱 테마. `system`은 OS 설정을 따른다(Electron `nativeTheme.themeSource`와 같은 값). */
export const THEME_SETTINGS = ['system', 'light', 'dark'] as const
export type ThemeSetting = (typeof THEME_SETTINGS)[number]
