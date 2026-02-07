export function generateCacheKey(
  host: string,
  port: number,
  remotePath: string,
  fileSize: number,
  modifiedAt: string
): string {
  return `${host}:${port}:${remotePath}:${fileSize}:${modifiedAt}`
}
