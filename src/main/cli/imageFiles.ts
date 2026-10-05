import { lstatSync, mkdirSync, writeFileSync } from 'fs'
import path from 'path'

/**
 * §10 U2: `ftpb` writes the image blocks of a tool result to files and prints their paths, so an
 * agent in a shell can open a preview and its output carries no base64.
 */

export interface SavedImage {
  type: 'image'
  mimeType: string
  /** The remote path the preview shows, when the result maps images to paths */
  path?: string
  savedTo: string
}

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp'
}

/** Names Windows reserves for devices, with any extension. */
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i

/**
 * Remote paths of the image blocks, in order, when the structured result maps them: an array of
 * `{ path, ok }` entries with one image per `ok: true` entry, in the same order (get_image_previews).
 */
function imagePaths(structured: unknown, count: number): string[] | undefined {
  if (typeof structured !== 'object' || structured === null) return undefined
  for (const value of Object.values(structured)) {
    if (!Array.isArray(value)) continue
    const entries = value as Array<{ path?: unknown; ok?: unknown }>
    const mapped = entries.every(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof entry.path === 'string' &&
        typeof entry.ok === 'boolean'
    )
    if (!mapped) continue
    const paths = entries.filter((entry) => entry.ok).map((entry) => entry.path as string)
    if (paths.length === count) return paths
  }
  return undefined
}

/** A file name stem from a remote name: no separators, control or reserved characters, no leading dots. */
function stemOf(remotePath: string | undefined, index: number): string {
  const name = remotePath === undefined ? '' : path.posix.basename(remotePath)
  const stem = Array.from(
    name
      .replace(/\.[^.]*$/, '')
      .replace(/[\p{Cc}\p{Cf}<>:"/\\|?*]/gu, '_')
      .replace(/^[\s.]+|[\s.]+$/g, '')
  )
    .slice(0, 100)
    .join('')
  if (!stem) return `image-${index + 1}`
  return RESERVED.test(stem.split('.')[0]) ? `_${stem}` : stem
}

/** Writes `data` to `<dir>/<stem><ext>`, or `<stem>-2<ext>` and so on: never replaces a file. */
function writeNew(dir: string, stem: string, ext: string, data: Buffer): string {
  for (let n = 1; ; n++) {
    const file = path.join(dir, `${stem}${n === 1 ? '' : `-${n}`}${ext}`)
    try {
      writeFileSync(file, data, { flag: 'wx', mode: 0o600 })
      return file
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  }
}

/**
 * The default folder sits in a temp folder other users may share (/tmp): use it only when it is a
 * real folder of this user, not a link or someone else's folder.
 */
function checkDefaultDir(dir: string): void {
  const stat = lstatSync(dir)
  const owner = process.getuid?.()
  if (!stat.isDirectory() || (owner !== undefined && stat.uid !== owner)) {
    throw new Error(
      `${dir} is not a folder of this user, so ftpb did not save the images there. ` +
        'Pass --save-dir <dir> to choose a folder.'
    )
  }
}

/**
 * Saves the image blocks in `content` under `dir` and returns the content with each image block
 * replaced by `{ type: 'image', mimeType, path?, savedTo }`. Other blocks stay as they are.
 */
export function saveImages(
  content: Array<Record<string, unknown>>,
  structured: unknown,
  dir: string,
  isDefaultDir: boolean
): Array<Record<string, unknown> | SavedImage> {
  const count = content.filter((block) => block.type === 'image').length
  if (count === 0) return content
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (isDefaultDir) checkDefaultDir(dir)
  const paths = imagePaths(structured, count)
  let index = 0
  return content.map((block) => {
    if (block.type !== 'image') return block
    const mimeType = String(block.mimeType ?? '')
    const remotePath = paths?.[index]
    const savedTo = writeNew(
      dir,
      stemOf(remotePath, index++),
      EXTENSIONS[mimeType] ?? '.bin',
      Buffer.from(String(block.data ?? ''), 'base64')
    )
    return {
      type: 'image',
      mimeType,
      ...(remotePath !== undefined ? { path: remotePath } : {}),
      savedTo
    }
  })
}
