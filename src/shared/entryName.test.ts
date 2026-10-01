import { describe, it, expect } from 'vitest'
import { isSafeLocalName, isSafeRemoteName, toLocalFileName, uniqueLocalNames } from './entryName'

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

// 원격 이름은 서버가 정한 것이라 사용자가 고칠 기회가 없다. 그래서 거부 대신 FileZilla처럼
// 로컬에서 쓸 수 없는 문자만 '_'로 바꾸고, 바꿔도 쓸 수 없는 이름만 null(건너뜀)로 돌려준다.
describe('toLocalFileName on Windows', () => {
  const win = (name: string): string | null => toLocalFileName(name, 'win32')

  it('replaces separators so a name cannot climb out of the download folder', () => {
    // POSIX 서버에서는 `\`가 평범한 문자지만 Windows에서는 구분자다.
    expect(win('..\\..\\x')).toBe('.._.._x')
    expect(win('a/b')).toBe('a_b')
    expect(win('C:\\Windows\\evil.dll')).toBe('C__Windows_evil.dll')
  })

  it('replaces a colon instead of writing an alternate data stream', () => {
    expect(win('report.txt:hidden')).toBe('report.txt_hidden')
  })

  it('replaces the other characters NTFS refuses, and control characters', () => {
    expect(win('a*b?c"d<e>f|g')).toBe('a_b_c_d_e_f_g')
    expect(win('tab\there\u0001.txt')).toBe('tab_here_.txt')
  })

  it('strips trailing dots and spaces, which Windows drops silently', () => {
    expect(win('name. . ')).toBe('name')
    expect(win('archive.tar.')).toBe('archive.tar')
    // 앞쪽 공백·점은 Windows도 보존하므로 건드리지 않는다.
    expect(win(' .hidden')).toBe(' .hidden')
  })

  it('suffixes reserved device names, with or without an extension', () => {
    expect(win('CON')).toBe('CON_')
    expect(win('con.txt')).toBe('con_.txt')
    expect(win('Aux.tar.gz')).toBe('Aux_.tar.gz')
    expect(win('NUL ')).toBe('NUL_')
    expect(win('prn')).toBe('prn_')
    expect(win('COM1')).toBe('COM1_')
    expect(win('lpt9.log')).toBe('lpt9_.log')
  })

  it('suffixes the less common device names too', () => {
    // COM0/LPT0, 위 첨자 숫자(¹²³), 콘솔 입출력도 모든 폴더에서 장치로 열린다.
    expect(win('COM0')).toBe('COM0_')
    expect(win('lpt0.txt')).toBe('lpt0_.txt')
    expect(win('COM¹')).toBe('COM¹_')
    expect(win('LPT².txt')).toBe('LPT²_.txt')
    expect(win('com³ .log')).toBe('com³_ .log')
    expect(win('CONIN$')).toBe('CONIN$_')
    expect(win('conout$.log')).toBe('conout$_.log')
  })

  it('leaves names that only start like a device name alone', () => {
    expect(win('CONSOLE.txt')).toBe('CONSOLE.txt')
    expect(win('COM10')).toBe('COM10')
    expect(win('COM¹0')).toBe('COM¹0')
    expect(win('CONIN')).toBe('CONIN')
    expect(win('CONIN$x')).toBe('CONIN$x')
    expect(win('auxiliary')).toBe('auxiliary')
    expect(win('my-con.txt')).toBe('my-con.txt')
  })

  it('returns null when nothing usable is left', () => {
    expect(win('')).toBeNull()
    expect(win('.')).toBeNull()
    expect(win('..')).toBeNull()
    expect(win('...')).toBeNull()
    expect(win(' . ')).toBeNull()
  })

  it('keeps an ordinary name unchanged', () => {
    expect(win('photo 01.jpg')).toBe('photo 01.jpg')
    expect(win('.bashrc')).toBe('.bashrc')
    expect(win('사진.png')).toBe('사진.png')
  })
})

describe('toLocalFileName on POSIX', () => {
  for (const platform of ['darwin', 'linux']) {
    const posix = (name: string): string | null => toLocalFileName(name, platform)

    it(`${platform}: replaces only the slash and NUL`, () => {
      expect(posix('a/b')).toBe('a_b')
      expect(posix('a\u0000b')).toBe('a_b')
    })

    it(`${platform}: keeps characters only Windows refuses`, () => {
      // 대조군: Windows 규칙이 새어 들어오면 멀쩡한 이름이 바뀐다.
      expect(posix('back\\slash:colon*?.txt')).toBe('back\\slash:colon*?.txt')
      expect(posix('CON')).toBe('CON')
      expect(posix('trailing. ')).toBe('trailing. ')
    })

    it(`${platform}: returns null for empty, dot and dot-dot`, () => {
      expect(posix('')).toBeNull()
      expect(posix('.')).toBeNull()
      expect(posix('..')).toBeNull()
    })
  }
})

// 고친 이름은 서로 겹칠 수 있다(Windows에서 `a:b`와 `a_b`는 둘 다 `a_b`). 한 번에 받는 묶음 안에서
// 겹치면 뒤의 것이 앞의 것을 소리 없이 덮어쓰므로 확장자 앞에 ` (n)`을 붙인다.
describe('uniqueLocalNames', () => {
  it('keeps the first name and numbers the later ones before the extension', () => {
    expect(uniqueLocalNames(['a_b', 'a_b', 'a_b', 'x_y.txt', 'x_y.txt'], 'win32')).toEqual([
      'a_b',
      'a_b (1)',
      'a_b (2)',
      'x_y.txt',
      'x_y (1).txt'
    ])
  })

  it('never renames a name that does not collide, whatever the order', () => {
    // `a:b`가 `a_b`가 되어도, 원래 이름이 `a_b (1)`인 파일은 그 이름 그대로 받는다
    expect(uniqueLocalNames(['a_b', 'a_b', 'a_b (1)'], 'win32')).toEqual([
      'a_b',
      'a_b (2)',
      'a_b (1)'
    ])
    expect(uniqueLocalNames(['a_b (1)', 'a_b', 'a_b'], 'win32')).toEqual([
      'a_b (1)',
      'a_b',
      'a_b (2)'
    ])
    expect(uniqueLocalNames(['a (1)', 'a', 'a'], 'linux')).toEqual(['a (1)', 'a', 'a (2)'])
  })

  it('numbers a dotfile after the whole name', () => {
    expect(uniqueLocalNames(['.bashrc', '.bashrc'], 'linux')).toEqual(['.bashrc', '.bashrc (1)'])
  })

  it.each(['win32', 'darwin'])(
    'ignores case on %s, where the default file system does too',
    (platform) => {
      expect(uniqueLocalNames(['A_b.TXT', 'a_b.txt', 'a_B (1).txt'], platform)).toEqual([
        'A_b.TXT',
        'a_b (2).txt',
        'a_B (1).txt'
      ])
    }
  )

  it('keeps names that differ only in case on Linux', () => {
    expect(uniqueLocalNames(['A_b.TXT', 'a_b.txt'], 'linux')).toEqual(['A_b.TXT', 'a_b.txt'])
  })
})
