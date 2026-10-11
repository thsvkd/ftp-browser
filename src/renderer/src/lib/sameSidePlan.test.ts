import { describe, expect, it } from 'vitest'
import { planSameSide, type SameSideItem } from './sameSidePlan'

const T1 = '2024-05-01T10:00:00.000Z'
const T2 = '2024-05-02T10:00:00.000Z'

function item(path: string, opts: Partial<SameSideItem> = {}): SameSideItem {
  return {
    path,
    name: path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1),
    type: 'file',
    size: 10,
    modifiedAt: T1,
    ...opts
  }
}

const REMOTE = { side: 'remote', path: '/dst' } as const
const LOCAL = { side: 'local', path: 'C:\\dst' } as const

describe('planSameSide — conflicts', () => {
  it('flags only top-level names that exist in the destination, folder when either side is one, and drops items already there', () => {
    // covers: Test-836
    const plan = planSameSide(
      [
        item('/a/x.jpg', { size: 20, modifiedAt: T2 }),
        item('/a/new.jpg'),
        item('/a/X.JPG'),
        item('/a/sub', { type: 'directory', size: 0 }),
        item('/dst/here.jpg')
      ],
      [item('/dst/x.jpg'), item('/dst/sub'), item('/dst/here.jpg')],
      REMOTE,
      'win32'
    )
    // 원격은 대소문자를 구분한다: X.JPG는 겹치지 않는다.
    expect(plan.ops).toEqual([
      { source: '/a/new.jpg', name: 'new.jpg', overwrite: false },
      { source: '/a/X.JPG', name: 'X.JPG', overwrite: false }
    ])
    expect(plan.conflicts).toEqual([
      {
        target: '/dst/x.jpg',
        source: '/a/x.jpg',
        name: 'x.jpg',
        incoming: { size: 20, modifiedAt: T2 },
        existing: { size: 10, modifiedAt: T1 },
        folder: false
      },
      {
        target: '/dst/sub',
        source: '/a/sub',
        name: 'sub',
        incoming: { size: 0, modifiedAt: T1 },
        existing: { size: 10, modifiedAt: T1 },
        folder: true
      }
    ])

    // 로컬 win32·darwin은 대소문자를 무시하고, linux는 구분한다.
    const sent = [item('C:\\a\\X.JPG')]
    const there = [item('C:\\dst\\x.jpg')]
    expect(planSameSide(sent, there, LOCAL, 'win32').conflicts.map((c) => c.target)).toEqual([
      'C:\\dst\\X.JPG'
    ])
    expect(planSameSide(sent, there, LOCAL, 'darwin').conflicts).toHaveLength(1)
    expect(planSameSide(sent, there, LOCAL, 'linux').conflicts).toEqual([])
  })

  it('numbers repeated names within one send instead of letting them replace each other, and drops an item already there by the case rule', () => {
    // covers: Test-836
    const remote = planSameSide(
      [item('/a/x.txt'), item('/b/x.txt'), item('/c/X.txt')],
      [],
      REMOTE,
      'win32'
    )
    expect(remote.ops.map((o) => o.name)).toEqual(['x.txt', 'x (1).txt', 'X.txt'])

    // 앞의 것만 충돌로 묻고, 뒤의 같은 이름은 번호를 붙인다(결정과 상관없이).
    const there = [item('C:\\dst\\x.txt')]
    const sent = [item('C:\\a\\x.txt'), item('C:\\b\\X.TXT')]
    const first = planSameSide(sent, there, LOCAL, 'win32')
    expect(first.conflicts.map((c) => c.source)).toEqual(['C:\\a\\x.txt'])
    expect(
      planSameSide(sent, there, LOCAL, 'win32', { 'C:\\dst\\x.txt': 'overwrite' }).ops
    ).toEqual([
      { source: 'C:\\a\\x.txt', name: 'x.txt', overwrite: true },
      { source: 'C:\\b\\X.TXT', name: 'X (1).TXT', overwrite: false }
    ])

    // Windows는 경로의 대소문자가 달라도 같은 파일이다: 자기 자신과 충돌하지 않는다.
    expect(planSameSide([item('c:\\DST\\x.txt')], there, LOCAL, 'win32')).toEqual({
      ops: [],
      conflicts: []
    })
  })
})

describe('planSameSide — decisions', () => {
  it('maps overwrite, skip, rename and newer like transfers, and only rename or skip for folders', () => {
    // covers: Test-837
    const sent = [
      item('/a/o.jpg'),
      item('/a/s.jpg', { modifiedAt: T2 }),
      item('/a/r.jpg'),
      item('/a/r (1).jpg'),
      item('/a/late.jpg', { modifiedAt: T2 }),
      item('/a/same.jpg'),
      item('/a/bad.jpg', { modifiedAt: 'unknown' }),
      item('/a/dir', { type: 'directory' }),
      item('/a/dir2', { type: 'directory' })
    ]
    const there = [
      ...['o.jpg', 's.jpg', 'r.jpg', 'r (2).jpg', 'late.jpg', 'same.jpg', 'bad.jpg'].map((n) =>
        item(`/dst/${n}`)
      ),
      item('/dst/dir', { type: 'directory' }),
      item('/dst/dir2')
    ]
    const plan = planSameSide(sent, there, REMOTE, 'win32', {
      '/dst/o.jpg': 'overwrite',
      '/dst/s.jpg': 'skip',
      '/dst/r.jpg': 'rename',
      '/dst/late.jpg': 'newer',
      '/dst/same.jpg': 'newer',
      '/dst/bad.jpg': 'newer',
      '/dst/dir': 'rename',
      '/dst/dir2': 'overwrite'
    })
    expect(plan.conflicts).toEqual([])
    expect(plan.ops).toEqual([
      { source: '/a/o.jpg', name: 'o.jpg', overwrite: true },
      // r (1)은 같이 보내는 이름, r (2)는 대상에 있다
      { source: '/a/r.jpg', name: 'r (3).jpg', overwrite: false },
      { source: '/a/r (1).jpg', name: 'r (1).jpg', overwrite: false },
      { source: '/a/late.jpg', name: 'late.jpg', overwrite: true },
      { source: '/a/dir', name: 'dir (1)', overwrite: false }
    ])

    // 둘 다 두기를 여럿 고르면 서로의 새 이름도 피한다. 로컬 win32는 대소문자를 무시한다.
    const both = planSameSide(
      [item('C:\\a\\p.txt'), item('C:\\b\\P.txt')],
      [item('C:\\dst\\p.txt'), item('C:\\dst\\p (1).TXT')],
      LOCAL,
      'win32',
      { 'C:\\dst\\p.txt': 'rename', 'C:\\dst\\P.txt': 'rename' }
    )
    expect(both.ops.map((o) => o.name)).toEqual(['p (2).txt', 'P (3).txt'])
  })
})
