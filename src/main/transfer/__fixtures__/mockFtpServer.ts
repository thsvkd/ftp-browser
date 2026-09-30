import * as net from 'net'
import * as tls from 'tls'

/**
 * 전송 통합 테스트용 최소 FTP 서버. basic-ftp가 로그인과 전송에 쓰는 명령만
 * 흉내 낸다(USER/PASS/FEAT/TYPE/SIZE/REST/PASV/RETR/STOR, FTPS의 AUTH TLS/PBSZ/PROT).
 * 연결마다 상태가 따로라 여러 클라이언트가 동시에 붙을 수 있다.
 */
export interface MockFtpServerOptions {
  /** RETR로 내려줄 파일 내용. 경로는 무시한다. */
  file?: Buffer
  /** REST에 350으로 답하지만 RETR는 항상 0부터 보낸다(REST를 무시하는 서버). */
  ignoreRest?: boolean
  /**
   * STOR의 데이터 연결을 accept한 뒤 150을 보내기까지 기다리는 시간. vsftpd처럼 accept 뒤에야 150을
   * 보내는 서버를 루프백에서 흉내 낸다. 그 사이 데이터가 오면 log에 "! early data"를 남긴다.
   */
  delay150Ms?: number
  /** 150 전에 업로드 데이터가 오면 데이터 연결을 끊고 425로 답한다(delay150Ms와 함께 쓴다). */
  rejectEarlyData?: boolean
  /** STOR를 이 코드로 거부한다. 대기 중이던 데이터 연결을 먼저 RST로 끊어 RST가 응답보다 먼저 도착한다. */
  rejectStor?: number
  /** PASV로 아무도 듣지 않는 포트를 알려 데이터 연결이 거부되게 한다. */
  refuseData?: boolean
  /** PASV 응답에 제어 연결과 다른 호스트를 알린다(예: "10,0,0,1"). */
  pasvHost?: string
  /**
   * AUTH TLS를 받는다(TEST_TLS 인증서). PROT P 뒤의 데이터 연결도 TLS이고, 세션 재사용 여부를 log에 남긴다.
   * 클라이언트는 자체 서명 인증서라 rejectUnauthorized: false로 붙어야 한다.
   */
  tls?: boolean
}

export interface MockFtpServer {
  port: number
  /** 받은 명령("< ..."), 보낸 응답("> ..."), 그 밖의 관찰("! ...") */
  log: string[]
  /** STOR로 받은 파일 (경로 → 내용) */
  stored: Map<string, Buffer>
  close(): Promise<void>
}

const CHUNK = 64 * 1024

/** 테스트 전용 자체 서명 인증서(CN=localhost, P-256). 어디에도 신뢰되지 않는다. */
const TEST_TLS = {
  key: `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgRer8MpNk9zIXj4fd
H9Ls/bFb1mHFfagpswan1nHJ372hRANCAASfnlByLe7/+syiolRYWB/9QTQH332k
rS6+Myl9YLsHVi9cdosCIsETPAgJBuJb0PEKcxg8J1D9PDLkuCzTcDNw
-----END PRIVATE KEY-----`,
  cert: `-----BEGIN CERTIFICATE-----
MIIBXzCCAQSgAwIBAgIUEaqnRB8TLhip8gsHYoEGmXyk818wCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MDkzMDAzNTgzOFoYDzIxMjYwOTA2
MDM1ODM4WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAASfnlByLe7/+syiolRYWB/9QTQH332krS6+Myl9YLsHVi9cdosCIsET
PAgJBuJb0PEKcxg8J1D9PDLkuCzTcDNwozIwMDAdBgNVHQ4EFgQUJ/4WzydBZA7/
wz7y4+qXfU4KPi0wDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNJADBGAiEA
zGQCR/1RRn1z5Me1m+H3K/W8TI1ahDFoILJ8mlMUuxsCIQDyItAOoFtNLAtgEmRx
e1dox2NCZT5XZcDCSJM09NHd9w==
-----END CERTIFICATE-----`
}

export function startMockFtpServer(options: MockFtpServerOptions): Promise<MockFtpServer> {
  const { file = Buffer.alloc(0), ignoreRest = false } = options
  const log: string[] = []
  const stored = new Map<string, Buffer>()
  const secureContext = options.tls ? tls.createSecureContext(TEST_TLS) : undefined
  const pasvHost = options.pasvHost ?? '127,0,0,1'
  const sockets = new Set<net.Socket>()
  const dataServers = new Set<net.Server>()

  const track = (socket: net.Socket): void => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
  }

  const server = net.createServer((ctl) => {
    track(ctl)
    let rest = 0
    let pasv: { server: net.Server; socket: Promise<net.Socket> } | null = null
    let buf = ''
    /** 제어 연결. AUTH TLS 뒤에는 그 위의 TLSSocket이다. */
    let io: net.Socket = ctl
    /** PROT P: 데이터 연결도 TLS */
    let prot = false

    const send = (line: string): void => {
      log.push('> ' + line)
      if (!io.destroyed) io.write(line + '\r\n')
    }

    /** PROT P면 accept한 데이터 연결을 TLS로 감싸고, handshake가 끝나면 세션 재사용 여부를 남긴다. */
    const secureData = (raw: net.Socket): net.Socket => {
      if (!prot || !secureContext) return raw
      const secure = new tls.TLSSocket(raw, { isServer: true, secureContext })
      track(secure)
      secure.once('secure', () => log.push(`! data tls reused=${secure.isSessionReused()}`))
      return secure
    }

    const openPassive = (): void => {
      const dataServer = net.createServer()
      dataServers.add(dataServer)
      if (options.refuseData) {
        // 포트만 얻고 바로 닫는다: 클라이언트의 connect는 ECONNREFUSED로 끝난다
        dataServer.listen(0, '127.0.0.1', () => {
          const port = (dataServer.address() as net.AddressInfo).port
          dataServer.close(() => {
            send(`227 Entering Passive Mode (${pasvHost},${port >> 8},${port & 255})`)
          })
        })
        pasv = { server: dataServer, socket: new Promise(() => {}) }
        return
      }
      const socket = new Promise<net.Socket>((resolve) => {
        dataServer.once('connection', (s) => {
          track(s)
          resolve(s)
        })
      })
      dataServer.listen(0, '127.0.0.1', () => {
        const port = (dataServer.address() as net.AddressInfo).port
        send(`227 Entering Passive Mode (${pasvHost},${port >> 8},${port & 255})`)
      })
      pasv = { server: dataServer, socket }
    }

    const retr = async (): Promise<void> => {
      const current = pasv
      pasv = null
      const offset = ignoreRest ? 0 : rest
      rest = 0
      if (!current) return send('425 Use PASV first')
      const data = secureData(await current.socket)
      const closeData = (): void => {
        current.server.close()
        dataServers.delete(current.server)
      }
      send('150 Opening data connection')

      // 클라이언트가 중간에 데이터 연결을 끊으면(분할 구간의 의도적 종료) 426으로 답한다.
      let pos = offset
      let aborted = false
      data.on('close', () => {
        aborted = pos < file.length
      })
      const tick = (): void => {
        if (aborted || data.destroyed) {
          closeData()
          send('426 Connection closed; transfer aborted')
          return
        }
        if (pos >= file.length) {
          data.end(() => {
            closeData()
            send('226 Transfer complete')
          })
          return
        }
        const end = Math.min(pos + CHUNK, file.length)
        const ok = data.write(file.subarray(pos, end))
        pos = end
        if (ok) setImmediate(tick)
        else data.once('drain', tick)
      }
      tick()
    }

    const stor = async (name: string): Promise<void> => {
      const current = pasv
      pasv = null
      if (!current) return send('425 Use PASV first')
      const closeData = (): void => {
        current.server.close()
        dataServers.delete(current.server)
      }
      if (options.rejectStor) {
        // 대기 중이던 데이터 연결을 RST로 끊고 거부 응답은 그 뒤에 보낸다: RST가 응답보다 먼저 도착한다.
        // 실제 네트워크에서는 클라이언트의 connect 완료와 서버의 RST 사이에 1 RTT가 있으므로, 루프백에서도
        // RST를 조금 늦춰 클라이언트가 연결을 마친 뒤(빠른 경로면 데이터를 쓰기 시작한 뒤) 끊는다.
        const data = await current.socket
        await new Promise((r) => setTimeout(r, 10))
        data.resetAndDestroy()
        closeData()
        setTimeout(() => send(`${options.rejectStor} Permission denied`), 20)
        return
      }
      const data = secureData(await current.socket)
      const chunks: Buffer[] = []
      let sent150 = false
      let early = false
      const ended = new Promise<void>((resolve) => {
        data.once('end', resolve)
        data.once('close', resolve)
      })
      data.on('data', (chunk: Buffer) => {
        if (!sent150) early = true
        chunks.push(chunk)
      })
      if (options.delay150Ms) await new Promise((r) => setTimeout(r, options.delay150Ms))
      if (early) {
        log.push('! early data')
        if (options.rejectEarlyData) {
          data.destroy()
          closeData()
          return send("425 Can't open data connection")
        }
      }
      sent150 = true
      send('150 Ok to send data')
      await ended
      closeData()
      stored.set(name, Buffer.concat(chunks))
      send('226 Transfer complete')
    }

    const handle = (line: string): void => {
      log.push('< ' + line)
      const [cmd, ...args] = line.split(' ')
      const arg = args.join(' ')
      switch (cmd.toUpperCase()) {
        case 'USER':
          return send('331 Password required')
        case 'PASS':
          return send('230 Logged in')
        case 'FEAT':
          return send('211-Features:\r\n REST STREAM\r\n SIZE\r\n211 End')
        case 'TYPE':
        case 'STRU':
        case 'OPTS':
          return send('200 OK')
        case 'AUTH':
          if (!secureContext) return send('502 Command not implemented')
          send('234 AUTH TLS ok')
          ctl.removeListener('data', onData)
          io = new tls.TLSSocket(ctl, { isServer: true, secureContext })
          track(io)
          io.on('data', onData)
          return
        case 'PBSZ':
          return send('200 PBSZ=0')
        case 'PROT':
          prot = arg.toUpperCase() === 'P'
          return send('200 PROT ok')
        case 'NOOP':
          return send('200 NOOP ok')
        case 'PWD':
          return send('257 "/" is the current directory')
        case 'SIZE':
          return send('213 ' + file.length)
        case 'REST':
          rest = parseInt(arg, 10)
          return send(`350 Restarting at ${rest}`)
        case 'EPSV':
          return send('500 EPSV not supported')
        case 'PASV':
          return openPassive()
        case 'RETR':
          void retr()
          return
        case 'STOR':
          void stor(arg)
          return
        case 'QUIT':
          send('221 Bye')
          io.end()
          return
        default:
          return send('502 Command not implemented')
      }
    }

    const onData = (chunk: Buffer): void => {
      buf += chunk.toString('utf8')
      let i: number
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 2)
        handle(line)
      }
    }

    send('220 mock ftp')
    ctl.on('data', onData)
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as net.AddressInfo).port,
        log,
        stored,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy()
            for (const dataServer of dataServers) dataServer.close()
            server.close(() => done())
          })
      })
    })
  })
}
