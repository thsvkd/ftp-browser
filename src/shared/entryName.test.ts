import { describe, it, expect } from 'vitest'
import { isSafeDownloadName, isSafeLocalName, isSafeRemoteName } from './entryName'

// 이 술어들은 이름이 디렉터리를 벗어나는 것을 막는 핵심 방어다. Test-82/83·90은
// 렌더러를 경유한 간접 검증이라 술어 자체의 경계 조건을 고정하지 못한다.
//
// 로컬과 원격이 분리된 이유: 콜론은 NTFS에서 `foo:bar`가 `foo`의 대체 데이터 스트림이
// 되어 만들려던 항목이 목록에 나타나지 않는다. 반대로 `\`와 `:`는 POSIX·FTP 파일명에서
// 합법이라, 하나로 묶으면 원격에서 서버가 받아줄 이름을 거부하게 된다.
describe('isSafeLocalName', () => {
  it('rejects separators, colons, dot, dot-dot and whitespace-only names', () => {
    // covers: Test-88
    expect(isSafeLocalName('..\\other')).toBe(false)
    expect(isSafeLocalName('sub/child')).toBe(false)
    expect(isSafeLocalName('/abs')).toBe(false)
    expect(isSafeLocalName('C:\\elsewhere\\x')).toBe(false)

    // NTFS 대체 데이터 스트림. 조용히 다른 것이 만들어지므로 막는다.
    expect(isSafeLocalName('foo:bar')).toBe(false)

    // 자기 자신·상위 디렉터리를 가리키는 이름.
    expect(isSafeLocalName('.')).toBe(false)
    expect(isSafeLocalName('..')).toBe(false)

    // 빈 이름과 공백뿐인 이름. 앞뒤 공백을 잘라낸 뒤 판정하므로
    // 공백에 둘러싸인 '..'도 같게 취급되어야 한다.
    expect(isSafeLocalName('')).toBe(false)
    expect(isSafeLocalName('   ')).toBe(false)
    expect(isSafeLocalName('  ..  ')).toBe(false)
  })

  it('accepts an ordinary local name', () => {
    // covers: Test-88
    // 이 대조군이 없으면 "무조건 false"로 만드는 뮤테이션이 그대로 살아남는다.
    expect(isSafeLocalName('notes.txt')).toBe(true)
    expect(isSafeLocalName('New Docs')).toBe(true)

    // 점으로 시작할 뿐인 이름은 '.'/'..'과 달리 정상이다.
    expect(isSafeLocalName('.hidden')).toBe(true)
    expect(isSafeLocalName('..leading-dots.txt')).toBe(true)

    // 앞뒤 공백은 잘라낸 뒤 판정한다.
    expect(isSafeLocalName('  ok.txt  ')).toBe(true)
  })
})

describe('isSafeRemoteName', () => {
  it('rejects slashes, dot, dot-dot and whitespace-only names', () => {
    // covers: Test-88
    expect(isSafeRemoteName('sub/child')).toBe(false)
    expect(isSafeRemoteName('/abs')).toBe(false)
    expect(isSafeRemoteName('.')).toBe(false)
    expect(isSafeRemoteName('..')).toBe(false)
    expect(isSafeRemoteName('')).toBe(false)
    expect(isSafeRemoteName('   ')).toBe(false)
    expect(isSafeRemoteName('  ..  ')).toBe(false)
  })

  it('accepts backslashes and colons, which are legal in POSIX and FTP names', () => {
    // covers: Test-88
    // 두 술어를 다시 하나로 합치는 회귀는 여기서 잡힌다 — 로컬 규칙을 원격에 적용하면
    // 서버가 받아줄 이름을 거부하게 된다.
    expect(isSafeRemoteName('back\\slash.txt')).toBe(true)
    expect(isSafeRemoteName('foo:bar')).toBe(true)

    expect(isSafeRemoteName('notes.txt')).toBe(true)
    expect(isSafeRemoteName('New Docs')).toBe(true)
    expect(isSafeRemoteName('  ok.txt  ')).toBe(true)
  })
})

// 다운로드 파일명은 사용자가 아니라 FTP 서버가 정한다. 악성 서버가 `../`나 하위 경로를
// 담은 이름을 LIST에 실으면 다운로드 폴더 밖(자동 실행 위치 등)에 파일이 써진다.
describe('isSafeDownloadName', () => {
  it('rejects names that are not a single path component on any platform', () => {
    for (const platform of ['darwin', 'linux', 'win32']) {
      expect(isSafeDownloadName('../.zshrc', platform)).toBe(false)
      expect(isSafeDownloadName('Library/LaunchAgents/x.plist', platform)).toBe(false)
      expect(isSafeDownloadName('/etc/passwd', platform)).toBe(false)
      expect(isSafeDownloadName('a\0b', platform)).toBe(false)
      expect(isSafeDownloadName('.', platform)).toBe(false)
      expect(isSafeDownloadName('..', platform)).toBe(false)
      expect(isSafeDownloadName('', platform)).toBe(false)
    }
  })

  it('rejects Windows separators, drive colons and trailing dots or spaces on Windows', () => {
    expect(isSafeDownloadName('..\\..\\Startup\\x.bat', 'win32')).toBe(false)
    expect(isSafeDownloadName('C:x.bat', 'win32')).toBe(false)
    expect(isSafeDownloadName('.. ', 'win32')).toBe(false)
    expect(isSafeDownloadName('...', 'win32')).toBe(false)
  })

  it('accepts backslashes and colons where they are ordinary characters', () => {
    // 로컬 규칙(isSafeLocalName)을 그대로 쓰면 POSIX에서 합법적인 다운로드를 막게 된다.
    expect(isSafeDownloadName('..\\..\\x.bat', 'darwin')).toBe(true)
    expect(isSafeDownloadName('Photo: 2024.jpg', 'linux')).toBe(true)
  })

  it('accepts an ordinary name', () => {
    for (const platform of ['darwin', 'linux', 'win32']) {
      expect(isSafeDownloadName('photo.jpg', platform)).toBe(true)
      expect(isSafeDownloadName('.hidden', platform)).toBe(true)
      expect(isSafeDownloadName('..leading-dots.txt', platform)).toBe(true)
    }
  })
})
