import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash, randomBytes } from 'crypto'
import * as fs from 'fs'
import * as net from 'net'
import * as os from 'os'
import * as path from 'path'
import { Client, FTPError } from 'basic-ftp'
import { enterPassiveModeIPv4_forceControlHostIP } from 'basic-ftp/dist/transfer'
import { fastUpload, isFastFlowSuspect, UPLOAD_BUFFER, UPLOAD_BUFFERS } from './fastTransfer'
import {
  startMockFtpServer,
  type MockFtpServer,
  type MockFtpServerOptions
} from '../transfer/__fixtures__/mockFtpServer'

// 업로드 읽기(길이·버퍼·동시 개수·에러)를 보려고 fs.read만 감싼다. 동작은 실제 fs 그대로다.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, read: vi.fn(actual.read) }
})

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

// 빠른 경로는 데이터 연결이 열리면 150을 기다리지 않고 쓴다. 루프백에서는 150이 바로 오므로 서버가 150을
// 늦게 보내게 해야, 빠른 경로를 탔는지("! early data")를 서버 쪽에서 볼 수 있다.
const LATE_150 = { delay150Ms: 30 }

describe('fastUpload against a mock FTP server', () => {
  let server: MockFtpServer
  let client: Client
  let dir: string

  /** 앱(createConfiguredClient)과 같은 설정으로 붙는다 */
  async function connect(options: MockFtpServerOptions = {}): Promise<void> {
    server = await startMockFtpServer(options)
    client = new Client(10_000, { allowSeparateTransferHost: false })
    client.ftp.ipFamily = 4
    await client.access({
      host: '127.0.0.1',
      port: server.port,
      user: 'u',
      password: 'p',
      secure: options.tls,
      secureOptions: options.tls ? { rejectUnauthorized: false } : undefined
    })
  }

  function localFile(name: string, size: number): { path: string; data: Buffer } {
    const data = randomBytes(size)
    const file = path.join(dir, name)
    fs.writeFileSync(file, data)
    return { path: file, data }
  }

  /** 첫 전송(표준 경로)으로 basic-ftp가 수동 모드를 고르게 한다 */
  async function prime(): Promise<void> {
    await fastUpload(client, localFile('prime.bin', 10).path, '/prime.bin')
    expect(client.prepareTransfer).toBe(enterPassiveModeIPv4_forceControlHostIP)
  }

  function earlyDataCount(): number {
    return server.log.filter((line) => line === '! early data').length
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fastup-'))
  })

  afterEach(async () => {
    client.close()
    await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('should use the standard path until basic-ftp has chosen a passive mode, then the fast one', async () => {
    await connect(LATE_150)
    const first = localFile('a.bin', 300_000)
    const second = localFile('b.bin', 300_000)

    await fastUpload(client, first.path, '/a.bin')
    expect(earlyDataCount()).toBe(0)
    await fastUpload(client, second.path, '/b.bin')
    expect(earlyDataCount()).toBe(1)

    expect(sha256(server.stored.get('/a.bin')!)).toBe(sha256(first.data))
    expect(sha256(server.stored.get('/b.bin')!)).toBe(sha256(second.data))
    expect(client.closed).toBe(false)
    expect(await client.pwd()).toBe('/')
  })

  it('should report the uploaded bytes through trackProgress', async () => {
    await connect(LATE_150)
    await prime()
    const file = localFile('c.bin', 200_000)
    const onProgress = vi.fn()

    client.trackProgress(onProgress)
    await fastUpload(client, file.path, '/c.bin')
    client.trackProgress()

    expect(earlyDataCount()).toBe(1)
    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: '/c.bin', type: 'upload', bytesOverall: 200_000 })
    )
  })

  it('should send an empty file through the standard path', async () => {
    await connect(LATE_150)
    await prime()
    const file = localFile('empty.bin', 0)

    await fastUpload(client, file.path, '/empty.bin')

    // 표준 경로는 데이터 연결이 열린 뒤에 STOR를 보낸다
    const last = server.log.slice(server.log.lastIndexOf('< PASV'))
    expect(last.indexOf('! data connected')).toBeGreaterThan(-1)
    expect(last.indexOf('! data connected')).toBeLessThan(last.indexOf('< STOR /empty.bin'))
    expect(earlyDataCount()).toBe(0)
    expect(server.stored.get('/empty.bin')).toEqual(Buffer.alloc(0))
  })

  it('should reject with the 550 and keep the client when the server resets the data connection first', async () => {
    await connect({ rejectStor: 550 })
    client.prepareTransfer = enterPassiveModeIPv4_forceControlHostIP
    const file = localFile('d.bin', 500_000)

    // RST와 550의 도착 순서는 매번 다를 수 있어 여러 번 돌린다
    for (let i = 0; i < 5; i++) {
      const err = await fastUpload(client, file.path, `/d${i}.bin`).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(FTPError)
      expect((err as FTPError).code).toBe(550)
      expect(isFastFlowSuspect(err)).toBe(false)
      expect(client.closed).toBe(false)
      // 제어 연결의 응답 순서가 어긋나지 않았다
      expect(await client.pwd()).toBe('/')
    }
  })

  it('should reject with a suspect 425 when the server refuses data before its 150', async () => {
    await connect({ ...LATE_150, rejectEarlyData: true })
    await prime()
    const file = localFile('e.bin', 100_000)

    const err = await fastUpload(client, file.path, '/e.bin').catch((e: unknown) => e)

    expect(err).toBeInstanceOf(FTPError)
    expect((err as FTPError).code).toBe(425)
    expect(isFastFlowSuspect(err)).toBe(true)
    expect(client.closed).toBe(false)
  })

  it('should close the client with a suspect error when the data connection cannot be opened', async () => {
    await connect({ refuseData: true })
    client.prepareTransfer = enterPassiveModeIPv4_forceControlHostIP
    const file = localFile('f.bin', 1000)

    const err = await fastUpload(client, file.path, '/f.bin').catch((e: unknown) => e)

    expect((err as Error).message).toMatch(/Can't open data connection/)
    expect(isFastFlowSuspect(err)).toBe(true)
    // STOR를 이미 보냈으므로 늦게 올 응답이 다음 명령에 섞이지 않게 닫는다
    expect(client.closed).toBe(true)
  })

  it('should refuse a PASV reply that points to another host, before sending STOR', async () => {
    await connect({ pasvHost: '10,0,0,1' })
    client.prepareTransfer = enterPassiveModeIPv4_forceControlHostIP
    const file = localFile('g.bin', 1000)

    const err = await fastUpload(client, file.path, '/g.bin').catch((e: unknown) => e)

    expect((err as Error).message).toMatch(/PASV returned another host \(10\.0\.0\.1\)/)
    expect(isFastFlowSuspect(err)).toBe(false)
    expect(server.log.some((line) => line.startsWith('< STOR'))).toBe(false)
  })

  describe('read ring', () => {
    const B = UPLOAD_BUFFER
    const read = vi.mocked(fs.read)

    beforeEach(() => {
      read.mockClear()
    })

    /** fastUpload가 부른 fs.read마다 [요청 길이, 버퍼 크기] */
    function readSizes(): Array<[number, number]> {
      return read.mock.calls.map((call) => [
        (call as unknown[])[3] as number,
        ((call as unknown[])[1] as Buffer).length
      ])
    }

    /** 바이트마다 값이 달라 조각 순서가 어긋나면 해시가 달라지는 내용 */
    function patterned(name: string, size: number): { path: string; data: Buffer } {
      const data = Buffer.alloc(size)
      for (let i = 0; i < size; i++) data[i] = (i * 31 + 7) % 251
      const file = path.join(dir, name)
      fs.writeFileSync(file, data)
      return { path: file, data }
    }

    for (const tls of [false, true]) {
      it(`should upload boundary sizes byte-identical on the standard and the fast path (tls=${tls})`, async () => {
        await connect({ ...LATE_150, tls })
        const alloc = vi.spyOn(Buffer, 'allocUnsafeSlow')
        const sizes = [0, 1, B - 1, B, B + 1, 3 * B + 17]

        for (const [i, size] of sizes.entries()) {
          const file = localFile(`r${i}.bin`, size)
          await fastUpload(client, file.path, `/std${i}.bin`, false)
          await fastUpload(client, file.path, `/fast${i}.bin`)
          expect(sha256(server.stored.get(`/std${i}.bin`)!)).toBe(sha256(file.data))
          expect(sha256(server.stored.get(`/fast${i}.bin`)!)).toBe(sha256(file.data))
        }

        // 빈 파일을 뺀 빠른 경로 업로드마다 150 전에 데이터를 보냈다
        expect(earlyDataCount()).toBe(sizes.length - 1)
        // 버퍼는 전송끼리 돌려 쓰므로 한 전송이 쥐는 수 넘게 할당하지 않는다
        expect(alloc.mock.calls.filter(([size]) => size === B).length).toBeLessThanOrEqual(
          UPLOAD_BUFFERS
        )
        alloc.mockRestore()
      })
    }

    it('should read in file order with UPLOAD_BUFFERS reads in flight', async () => {
      await connect()
      const actual = await vi.importActual<typeof import('fs')>('fs')
      let inflight = 0
      let peak = 0
      read.mockImplementation(((...args: Parameters<typeof actual.read>) => {
        inflight++
        peak = Math.max(peak, inflight)
        const cb = args[args.length - 1] as (err: Error | null, n: number, b: Buffer) => void
        const rest = args.slice(0, -1) as unknown[]
        ;(actual.read as (...a: unknown[]) => void)(
          ...rest,
          (err: Error | null, n: number, b: Buffer) => {
            inflight--
            cb(err, n, b)
          }
        )
      }) as never)
      const file = patterned('order.bin', 20 * B + 17)

      try {
        await fastUpload(client, file.path, '/order.bin', false)
      } finally {
        read.mockImplementation(actual.read as never)
      }

      expect(sha256(server.stored.get('/order.bin')!)).toBe(sha256(file.data))
      expect(UPLOAD_BUFFER).toBe(256 * 1024)
      expect(UPLOAD_BUFFERS).toBe(8)
      expect(peak).toBe(UPLOAD_BUFFERS)
      // 버퍼 크기 단위로 읽고, 마지막은 남은 17 바이트 + 파일 끝을 알아챌 1 바이트다
      expect(readSizes()).toEqual([...Array(20).fill([B, B]), [18, B]])
    })

    for (const fast of [false, true]) {
      it(`should keep at most two buffers queued on a slowly read data socket (fast=${fast})`, async () => {
        // 서버가 10 ms마다 32 KiB만 읽는다: 커널 버퍼가 차면 나머지는 소켓의 쓰기 대기열에 쌓인다
        await connect({ storPace: { bytes: 32 * 1024, ms: 10 } })
        if (fast) await prime()
        const file = localFile('slow.bin', 12 * B)
        const original = net.Socket.prototype.write
        let peak = 0
        const write = vi.spyOn(net.Socket.prototype, 'write').mockImplementation(function (
          this: net.Socket,
          ...args: unknown[]
        ) {
          // 제어 명령은 빼고 데이터 버퍼를 넘기기 직전에 이미 쌓여 있던 양만 본다
          if (Buffer.isBuffer(args[0]) && args[0].length > 1024)
            peak = Math.max(peak, this.writableLength)
          return (original as (...a: unknown[]) => boolean).apply(this, args)
        })

        try {
          await fastUpload(client, file.path, '/slow.bin', fast)
        } finally {
          write.mockRestore()
        }

        expect(sha256(server.stored.get('/slow.bin')!)).toBe(sha256(file.data))
        // 진행률(bytesWritten)과 watchdog이 서버보다 링 전체(2 MiB)만큼 앞서지 않게 한다
        expect(peak).toBeLessThan(2 * B)
      }, 20_000)
    }

    it('should read a file smaller than one buffer with a single read into a pooled buffer', async () => {
      await connect()
      const file = localFile('small.bin', 8192)

      await fastUpload(client, file.path, '/small.bin', false)

      expect(readSizes()).toEqual([[8193, B]])
      expect(server.stored.get('/small.bin')).toEqual(file.data)
    })

    it('should size each read to what is left of a file that is a whole number of buffers', async () => {
      await connect()
      const file = patterned('whole.bin', 2 * B)

      await fastUpload(client, file.path, '/whole.bin', false)

      expect(readSizes().map(([length]) => length)).toEqual([B, B, 1])
      expect(sha256(server.stored.get('/whole.bin')!)).toBe(sha256(file.data))
    })

    /** 첫 fs.read 직전에 한 번 action을 실행한다 */
    async function beforeFirstRead(action: () => void): Promise<void> {
      const actual = await vi.importActual<typeof import('fs')>('fs')
      read.mockImplementationOnce(((...args: unknown[]) => {
        action()
        ;(actual.read as (...a: unknown[]) => void)(...args)
      }) as never)
    }

    it('should fail when the local file grows while it is being uploaded', async () => {
      await connect()
      const file = localFile('grow.bin', B + 10)
      await beforeFirstRead(() => fs.appendFileSync(file.path, Buffer.alloc(2 * B, 2)))

      await expect(fastUpload(client, file.path, '/grow.bin', false)).rejects.toThrow(
        /changed while it was being uploaded/
      )
    })

    it('should fail when the local file shrinks while it is being uploaded', async () => {
      await connect()
      const file = localFile('shrink.bin', 4096)
      await beforeFirstRead(() => fs.truncateSync(file.path, 10))

      await expect(fastUpload(client, file.path, '/shrink.bin', false)).rejects.toThrow(
        /changed while it was being uploaded/
      )
    })

    it('should fail the upload with the read error', async () => {
      await connect()
      const file = localFile('eio.bin', 3 * B)
      const eio = Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' })
      read.mockImplementationOnce(((...args: unknown[]) => {
        const cb = args[args.length - 1] as (err: Error) => void
        setImmediate(() => cb(eio))
      }) as never)

      await expect(fastUpload(client, file.path, '/eio.bin', false)).rejects.toThrow('EIO')
    })
  })

  it('should upload over FTPS reusing the control connection TLS session', async () => {
    await connect({ ...LATE_150, tls: true })
    await prime()
    const file = localFile('h.bin', 300_000)

    await fastUpload(client, file.path, '/h.bin')

    expect(earlyDataCount()).toBe(1)
    expect(sha256(server.stored.get('/h.bin')!)).toBe(sha256(file.data))
    const dataHandshakes = server.log.filter((line) => line.startsWith('! data tls'))
    expect(dataHandshakes).toEqual(['! data tls reused=true', '! data tls reused=true'])
  })
})

/**
 * STOR마다 script가 데이터 연결과 제어 응답을 직접 정하는 최소 FTP 서버. 목 서버로는 만들기 어려운 순서
 * (150 전에 FIN, 150 없는 226 뒤 RST 등)를 재현한다.
 */
function startScriptedServer(
  script: (ctl: net.Socket, data: net.Socket) => void
): Promise<{ port: number; close: () => void }> {
  const sockets = new Set<net.Socket>()
  const track = (s: net.Socket): void => {
    sockets.add(s)
    s.on('error', () => {})
  }
  const server = net.createServer((ctl) => {
    track(ctl)
    let data: Promise<net.Socket> | undefined
    let buffered = ''
    ctl.write('220 ready\r\n')
    ctl.on('data', (chunk) => {
      buffered += chunk.toString()
      let end: number
      while ((end = buffered.indexOf('\r\n')) >= 0) {
        const cmd = buffered.slice(0, end).split(' ')[0].toUpperCase()
        buffered = buffered.slice(end + 2)
        if (cmd === 'USER') ctl.write('331 ok\r\n')
        else if (cmd === 'PASS') ctl.write('230 ok\r\n')
        else if (cmd === 'PWD') ctl.write('257 "/"\r\n')
        else if (cmd === 'PASV') {
          const dataServer = net.createServer()
          data = new Promise((resolve) =>
            dataServer.once('connection', (s) => {
              track(s)
              dataServer.close()
              resolve(s)
            })
          )
          dataServer.listen(0, '127.0.0.1', () => {
            const port = (dataServer.address() as net.AddressInfo).port
            ctl.write(`227 Entering Passive Mode (127,0,0,1,${port >> 8},${port & 255})\r\n`)
          })
        } else if (cmd === 'STOR') void data?.then((s) => script(ctl, s))
        else ctl.write('200 ok\r\n')
      }
    })
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: (server.address() as net.AddressInfo).port,
        close: () => {
          for (const s of sockets) s.destroy()
          server.close()
        }
      })
    )
  )
}

describe('fastUpload when the data connection breaks', () => {
  // 서버가 읽지 않는 동안 커널 버퍼에 다 들어가지 않을 크기라 쓰기가 끝나지 않고 걸려 있다
  const BIG = 16 * 1024 * 1024
  let server: { port: number; close: () => void }
  let client: Client
  let dir: string

  /** 데이터 연결을 accept한 뒤의 서버 동작을 정하고, 빠른 경로로 큰 파일을 올려 결과를 돌려준다 */
  async function upload(
    script: (ctl: net.Socket, data: net.Socket) => void,
    file = path.join(dir, 'big.bin')
  ): Promise<{ err: unknown; ms: number }> {
    server = await startScriptedServer(script)
    // 제어 timeout보다 훨씬 먼저 끝나야 한다(ms로 확인)
    client = new Client(3000, { allowSeparateTransferHost: false })
    client.ftp.ipFamily = 4
    await client.access({ host: '127.0.0.1', port: server.port, user: 'u', password: 'p' })
    client.prepareTransfer = enterPassiveModeIPv4_forceControlHostIP
    const started = Date.now()
    const err = await fastUpload(client, file, '/big.bin').then(
      () => undefined,
      (e: unknown) => e
    )
    return { err, ms: Date.now() - started }
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fastup-break-'))
    fs.writeFileSync(path.join(dir, 'big.bin'), Buffer.alloc(BIG, 1))
  })

  afterEach(() => {
    client.close()
    server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  // FIN과 쓰기 실패의 순서가 매번 달라(Premature close 등) 여러 번 돌린다
  it(
    'should fail at once as suspect when the server closes the data connection before 150, then sends 150 and 426',
    { repeats: 5 },
    async () => {
      const { err, ms } = await upload((ctl, data) => {
        setTimeout(() => {
          data.end()
          setTimeout(() => {
            ctl.write('150 go\r\n')
            setTimeout(() => ctl.write('426 aborted\r\n'), 50)
          }, 50)
        }, 20)
      })

      expect(err).toBeInstanceOf(Error)
      expect(isFastFlowSuspect(err)).toBe(true)
      expect(ms).toBeLessThan(1000)
    }
  )

  it('should fail at once as suspect when the server closes the data connection before 150, then sends 150 and 226', async () => {
    const { err, ms } = await upload((ctl, data) => {
      setTimeout(() => {
        data.end()
        setTimeout(() => {
          ctl.write('150 go\r\n')
          setTimeout(() => ctl.write('226 ok\r\n'), 50)
        }, 50)
      }, 20)
    })

    expect(err).toBeInstanceOf(Error)
    expect(isFastFlowSuspect(err)).toBe(true)
    // 데이터 watchdog(ftp.timeout)을 기다리지 않는다
    expect(ms).toBeLessThan(1000)
  })

  it('should reject at once as suspect when the data connection resets after a 226 that came without 150', async () => {
    const { err, ms } = await upload((ctl, data) => {
      ctl.write('226 ok\r\n')
      setTimeout(() => data.resetAndDestroy(), 50)
    })

    expect(err).toBeInstanceOf(Error)
    expect(isFastFlowSuspect(err)).toBe(true)
    // 제어 timeout을 기다리지 않고, 226을 이미 받았으므로 제어 연결도 어긋나지 않았다
    expect(ms).toBeLessThan(1000)
    expect(client.closed).toBe(false)
    expect(await client.pwd()).toBe('/')
  })

  it('should not blame the fast flow for a reset after 150: that is an ordinary transfer error', async () => {
    const { err } = await upload((ctl, data) => {
      ctl.write('150 go\r\n')
      setTimeout(() => data.resetAndDestroy(), 50)
    })

    expect((err as NodeJS.ErrnoException).code).toMatch(/ECONNRESET|EPIPE/)
    expect(isFastFlowSuspect(err)).toBe(false)
  })

  it('should not blame the fast flow for a local read error before 150', async () => {
    // 디렉터리는 열리고 크기도 0이 아니지만 읽으면 EISDIR이 난다
    const unreadable = path.join(dir, 'folder')
    fs.mkdirSync(unreadable)
    const { err } = await upload((ctl) => {
      setTimeout(() => {
        ctl.write('150 go\r\n')
        setTimeout(() => ctl.write('426 aborted\r\n'), 50)
      }, 50)
    }, unreadable)

    expect((err as NodeJS.ErrnoException).code).toBe('EISDIR')
    expect(isFastFlowSuspect(err)).toBe(false)
  })
})

describe('isFastFlowSuspect', () => {
  it('should not blame the fast flow for errors it did not raise', () => {
    expect(isFastFlowSuspect(new Error('read ECONNRESET'))).toBe(false)
    expect(isFastFlowSuspect(new FTPError({ code: 425, message: '425 no data' }))).toBe(false)
    expect(isFastFlowSuspect('Timeout')).toBe(false)
  })
})

describe('basic-ftp version', () => {
  // fastTransfer는 basic-ftp의 공개되지 않은 모듈(dist/transfer 등)과 전략 함수의 동일성에 기대므로,
  // 버전을 올리면 이 테스트가 fastTransfer를 새 버전의 uploadFrom/TransferResolver와 다시 맞춰 보게 한다.
  it('should be the 6.2 line that fastTransfer was written against', () => {
    const pkg = JSON.parse(fs.readFileSync(require.resolve('basic-ftp/package.json'), 'utf8')) as {
      version: string
    }
    expect(pkg.version).toMatch(/^6\.2\./)
  })
})
