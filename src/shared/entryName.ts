/**
 * Rejection reasons shown to the user. Each lives next to its rule so the two
 * cannot drift — a message that omits one of the rejected shapes reads as a bug.
 */
export const INVALID_LOCAL_NAME_MESSAGE = 'A name cannot contain \\ / or :, or be "." or "..".'
export const INVALID_REMOTE_NAME_MESSAGE = 'A name cannot contain /, or be "." or "..".'

/** Shapes that escape the current directory on any filesystem. */
function escapesDirectory(trimmed: string): boolean {
  return !trimmed || trimmed === '.' || trimmed === '..' || trimmed.includes('/')
}

/**
 * Whether a user-typed name is safe to append to a local directory path.
 *
 * Path joining is plain string concatenation, so a name carrying a separator
 * escapes the directory the user is looking at: renaming to `..\other` moves the
 * file out of view and `fs.rename` reports success. The "target already exists"
 * guard cannot catch it either, since it only inspects the final path.
 *
 * Colons are rejected on top of that: on NTFS `foo:bar` writes an alternate data
 * stream of `foo` rather than a file named `foo:bar`, so the entry the user meant
 * to create simply never appears in the listing.
 */
export function isSafeLocalName(name: string): boolean {
  const trimmed = name.trim()
  if (escapesDirectory(trimmed)) return false
  return !/[\\:]/.test(trimmed)
}

/**
 * Whether a user-typed name is safe to append to a remote (FTP) directory path.
 *
 * Only `/` is a separator here. Backslashes and colons are legal characters in
 * POSIX and FTP filenames, so rejecting them would refuse names the server would
 * have accepted.
 */
export function isSafeRemoteName(name: string): boolean {
  return !escapesDirectory(name.trim())
}
