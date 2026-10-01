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

// Windows가 파일명에 허용하지 않는 문자. 제어 문자(0x00-0x1F)도 NTFS가 거부한다.
// eslint-disable-next-line no-control-regex
const WINDOWS_INVALID_CHARS = /[\\/:*?"<>|\x00-\x1f]/g
// eslint-disable-next-line no-control-regex
const POSIX_INVALID_CHARS = /[/\x00]/g
// 확장자가 붙어도(`con.txt`), 확장자 앞에 공백이 있어도 장치로 열린다. COM/LPT는 0과 위 첨자 ¹²³도,
// 콘솔 입출력(CONIN$·CONOUT$)도 모든 폴더에서 장치다.
const WINDOWS_RESERVED_NAME =
  /^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[0-9¹²³]|LPT[0-9¹²³])(?=\s*(\.|$))/i

/**
 * Map a remote (FTP) entry name to a name that can be saved in a local folder,
 * or `null` when nothing usable is left and the entry must be skipped.
 *
 * The server picks remote names, so unlike {@link isSafeLocalName} there is no
 * user to ask: like FileZilla, characters the local OS refuses become `_`. On
 * Windows a POSIX server can legally serve `..\..\x` (backslash is a separator
 * there, so the download would land outside the chosen folder), `a:b` (an NTFS
 * alternate data stream of `a`), trailing dots/spaces (dropped silently) and
 * device names such as `CON` or `nul.txt` (open the device, not a file).
 */
export function toLocalFileName(remoteName: string, platform: string): string | null {
  let name: string
  if (platform === 'win32') {
    name = remoteName
      .replace(WINDOWS_INVALID_CHARS, '_')
      .replace(/[. ]+$/, '')
      .replace(WINDOWS_RESERVED_NAME, '$1_')
  } else {
    name = remoteName.replace(POSIX_INVALID_CHARS, '_')
  }
  // 문자 치환 뒤에는 구분자가 남지 않으므로 '.'·'..'·빈 이름만 막으면 폴더를 벗어날 수 없다.
  return name === '' || name === '.' || name === '..' ? null : name
}

/**
 * Make sanitised names unique within one batch, keeping their order. The
 * first occurrence of a name keeps it; later repeats are numbered before the
 * extension (`a_b (1)`, `x_y (1).txt`), skipping every name the batch already
 * holds, so a genuine remote `a_b (1)` is never renamed and the result does
 * not depend on the order of names that do not collide.
 *
 * Sanitised names can collide (`a:b` and `a_b` both become `a_b` on Windows),
 * and the later download would silently overwrite the earlier one. Windows
 * and macOS file systems compare names case-insensitively by default, so the
 * comparison does too there.
 */
export function uniqueLocalNames(names: readonly string[], platform: string): string[] {
  const ignoreCase = platform === 'win32' || platform === 'darwin'
  const key = (n: string): string => (ignoreCase ? n.toLowerCase() : n)
  // 1차: 모든 이름을 먼저 잡아 둔다. 번호 붙인 이름이 뒤에 오는 실제 이름을 빼앗지 않게 한다.
  const reserved = new Set(names.map(key))
  const used = new Set<string>()
  return names.map((name) => {
    if (!used.has(key(name))) {
      used.add(key(name))
      return name
    }
    // 2차: 두 번째부터의 중복만 번호를 붙인다. 앞의 점은 확장자가 아니다(`.bashrc`).
    const dot = name.lastIndexOf('.')
    const stem = dot > 0 ? name.slice(0, dot) : name
    const ext = dot > 0 ? name.slice(dot) : ''
    let candidate = name
    for (let n = 1; reserved.has(key(candidate)) || used.has(key(candidate)); n++) {
      candidate = `${stem} (${n})${ext}`
    }
    used.add(key(candidate))
    return candidate
  })
}
