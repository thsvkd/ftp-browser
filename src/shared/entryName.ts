// 거부 사유 문구는 renderer 카탈로그의 name.invalidLocal / name.invalidRemote에 있다.
// 아래 규칙을 바꾸면 그 문구도 함께 고칠 것 — 거부 형태 하나를 빠뜨린 안내는 버그로 읽힌다.

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

/**
 * Whether a file name the FTP server listed can be used as the last component
 * of a local download path on `platform`.
 *
 * Unlike the predicates above this judges a name the *server* chose, so it is
 * the line between a malicious listing and the user's disk: `../.zshrc` or
 * `Library/LaunchAgents/x.plist` would otherwise land outside the folder the
 * user picked. It is not trimmed — the name is used exactly as listed.
 *
 * Backslashes and colons only count on Windows, where they are a separator and
 * a drive/stream marker; on POSIX they are ordinary characters and a server
 * file carrying them downloads fine. Windows also strips trailing dots and
 * spaces, which would turn `.. ` into `..`.
 */
export function isSafeDownloadName(name: string, platform: string): boolean {
  if (!name || name === '.' || name === '..' || /[/\0]/.test(name)) return false
  return platform !== 'win32' || !/[\\:]|[. ]$/.test(name)
}
