import { randomBytes } from 'crypto'
import { chmod, rename, stat } from 'fs/promises'
import path from 'path'

const WINDOWS_BUSY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])
const RENAME_ATTEMPTS = 5

/**
 * A sibling path to write into before renaming over `finalPath`. Writing to the
 * final path directly truncates whatever is there the moment the file is opened,
 * so a failed or cancelled write — or a copy whose source *is* the destination —
 * destroys a file the user never meant to lose.
 *
 * The name does not reuse the target's: appending to a name already near the
 * 255-byte limit fails with ENAMETOOLONG. It is a dotfile, so the local panel
 * hides one left behind by a crash; the random part keeps concurrent writes to
 * the same folder apart.
 */
export function partialPathFor(finalPath: string): string {
  return path.join(path.dirname(finalPath), `.ftp-browser-${randomBytes(4).toString('hex')}.part`)
}

/**
 * Move a finished partial file over `finalPath`.
 *
 * It keeps the permission bits of a file it replaces, as writing in place did
 * (a script stays executable). On Windows an antivirus scanner or indexer often
 * holds a just-closed file for a moment; retry briefly rather than fail — and
 * discard — a transfer that already completed.
 */
export async function movePartialIntoPlace(partPath: string, finalPath: string): Promise<void> {
  const existing = await stat(finalPath).catch(() => null)
  if (existing?.isFile()) await chmod(partPath, existing.mode)

  for (let attempt = 1; ; attempt++) {
    try {
      await rename(partPath, finalPath)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      const retry =
        process.platform === 'win32' && WINDOWS_BUSY_CODES.has(code) && attempt < RENAME_ATTEMPTS
      if (!retry) throw err
      await new Promise((resolve) => setTimeout(resolve, attempt * 100))
    }
  }
}
