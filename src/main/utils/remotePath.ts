/**
 * 원격 FTP 경로 정규화. trailing slash는 root 외에는 제거.
 * 캐시 키나 invalidation 시 `/foo/` vs `/foo` 같은 비-동등 키가 생기지 않도록
 * cache lookup/store와 mutation invalidation 양쪽에서 동일하게 호출되어야 한다.
 */
export function normalizeRemotePath(p: string): string {
  if (!p) return '/'
  let normalized = p.replace(/\/+$/, '')
  if (!normalized) return '/'
  if (!normalized.startsWith('/')) normalized = '/' + normalized
  return normalized
}

/**
 * `/foo/bar/baz.jpg` → `/foo/bar`
 * `/foo` → `/`
 * `/foo/` → `/`
 * `/` → `/`
 */
export function getParentRemotePath(p: string): string {
  const normalized = normalizeRemotePath(p)
  if (normalized === '/') return '/'
  const idx = normalized.lastIndexOf('/')
  if (idx <= 0) return '/'
  return normalized.substring(0, idx)
}
