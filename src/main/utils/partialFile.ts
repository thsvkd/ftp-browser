import { randomBytes } from 'crypto'

/**
 * A sibling path to write into before renaming over `finalPath`. Writing to the
 * final path directly truncates whatever is there the moment the file is opened,
 * so a failed or cancelled write — or a copy whose source *is* the destination —
 * destroys a file the user never meant to lose. The random part keeps it from
 * colliding with a real file or another write to the same target.
 */
export function partialPathFor(finalPath: string): string {
  return `${finalPath}.${randomBytes(4).toString('hex')}.part`
}
