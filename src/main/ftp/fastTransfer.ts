// 파일 하나의 업로드를 basic-ftp 6.2.0 uploadFrom과 같은 Client/FTPContext 위에서 순서만 바꿔 실행한다.
//
//   basic-ftp:  EPSV/PASV → 응답 → 데이터 연결 connect 완료 대기 → STOR → 150 대기 → 데이터 → 226
//   빠른 경로:  EPSV/PASV → 응답 → (데이터 연결 connect ∥ STOR) → 연결되는 즉시 데이터 → 226
//
// vsftpd/ProFTPD/Pure-FTPd처럼 데이터 연결을 accept한 뒤에야 150을 보내는 서버에서 파일마다 1 RTT를 줄인다.
// FileZilla와 같은 순서다(명령과 connect를 함께 보내고, 연결되면 1yz를 기다리지 않고 쓴다). 다운로드는
// 서버가 보내기 전에는 할 일이 없어 이득이 1~3%뿐이라 basic-ftp 경로를 그대로 쓴다.
//
// 결과 규칙은 basic-ftp TransferResolver와 같다: 데이터 전송 완료와 226을 모두 받아야 resolve하고, 응답
// 에러는 FTPError로, 소켓 에러는 closeWithError로 끝난다. 공개되지 않은 basic-ftp 모듈을 직접 가져오므로
// basic-ftp 버전을 올릴 때는 fastTransfer.test.ts의 버전 확인 테스트가 다시 검토하도록 막는다.
import { open as fsOpen } from 'fs/promises'
import { createReadStream } from 'fs'
import type { Socket } from 'net'
import { connect as tlsConnect, TLSSocket } from 'tls'
import { pipeline, type Readable } from 'stream'
import { FTPError, type Client, type FTPContext, type FTPResponse } from 'basic-ftp'
import {
  enterPassiveModeIPv4,
  enterPassiveModeIPv4_forceControlHostIP,
  enterPassiveModeIPv6,
  parseEpsvResponse,
  parsePasvResponse
} from 'basic-ftp/dist/transfer'
import { TransferWatchdog } from 'basic-ftp/dist/TransferWatchdog'
import { ipIsPrivateV4Address, isLoopback } from 'basic-ftp/dist/netUtils'
import type { ProgressTracker } from 'basic-ftp/dist/ProgressTracker'

type PassiveMode = 'EPSV' | 'PASV' | 'PASV_NAT'
type Task = { resolve: (res: FTPResponse) => void; reject: (err: Error) => void }

/** basic-ftp가 Client 안에 두는 진행률 추적기. 공개 타입에는 protected라 여기서만 좁혀 쓴다. */
interface ClientInternals {
  _progressTracker: ProgressTracker
}

/**
 * 빠른 경로의 전송 단계에서 1xx 전에 난 에러. isFastFlowSuspect는 이 에러만 빠른 경로 탓으로 본다.
 * 1xx 뒤의 에러는 표준 경로에서도 똑같이 나는 전송 중 에러라 평소대로 재시도한다.
 */
const fastFlowErrors = new WeakSet<Error>()
/** 1xx 전에 데이터 연결이 끊긴 에러. 순서를 바꾼 탓일 수 있으므로 메시지와 상관없이 빠른 경로 탓으로 본다. */
const earlyDataErrors = new WeakSet<Error>()
/** 메시지에 드러나지 않을 수 있는 연결 끊김 코드(Node는 EPIPE를 code에만 두기도 한다) */
const BROKEN_CONNECTION_CODES = new Set([
  'EPIPE',
  'ECONNRESET',
  'ECONNABORTED',
  'ERR_STREAM_PREMATURE_CLOSE'
])

/**
 * basic-ftp가 이 클라이언트에서 이미 고른 수동 모드. 아직 고르지 않았으면(첫 전송 전) null이고,
 * 그 전송은 표준 경로로 보내 basic-ftp의 EPSV→PASV 탐색과 연결 실패 fallback을 그대로 쓴다.
 * allowSeparateTransferHost=false면 basic-ftp가 forceControlHostIP 전략을 고르므로 'PASV'가 된다.
 */
function knownPassiveMode(client: Client): PassiveMode | null {
  const strategy = client.prepareTransfer
  if (strategy === enterPassiveModeIPv6) return 'EPSV'
  if (strategy === enterPassiveModeIPv4_forceControlHostIP) return 'PASV'
  if (strategy === enterPassiveModeIPv4) return 'PASV_NAT'
  return null
}

function controlHost(ftp: FTPContext): string {
  const host = ftp.socket.remoteAddress
  if (host === undefined)
    throw new Error("Control socket is disconnected, can't get remote address.")
  return host
}

/** EPSV/PASV를 보내고 데이터 연결 대상만 돌려준다. host 검증은 basic-ftp의 같은 전략과 같다. */
async function requestPassive(
  ftp: FTPContext,
  mode: PassiveMode
): Promise<{ host: string; port: number }> {
  if (mode === 'EPSV') {
    const res = await ftp.request('EPSV')
    return { host: controlHost(ftp), port: parseEpsvResponse(res.message) }
  }
  const res = await ftp.request('PASV')
  const target = parsePasvResponse(res.message)
  const control = controlHost(ftp)
  if (mode === 'PASV_NAT') {
    // 사설 IP를 알려 준 NAT 뒤 서버면 제어 연결 IP로 바꾼다
    if (ipIsPrivateV4Address(target.host) && !ipIsPrivateV4Address(control)) target.host = control
    return target
  }
  const normalized = control.replace(/^::ffff:/i, '')
  if (normalized !== target.host && !(isLoopback(normalized) && isLoopback(target.host))) {
    throw new Error(
      `PASV returned another host (${target.host}) for data transfer that you have connected to (${control}).`
    )
  }
  return { host: normalized, port: target.port }
}

/** basic-ftp TransferResolver와 같은 규칙. 공개되지 않은 클래스라 동작을 그대로 옮겼다. */
class Resolver {
  private response: FTPResponse | undefined
  private dataDone = false
  settled = false
  private watchdog = new TransferWatchdog()
  /** 아직 ftp.dataSocket에 넘기지 않은 데이터 소켓(연결 중이거나 1xx 전). 작업이 먼저 끝나면 여기서 닫는다. */
  pending: Socket | undefined

  constructor(
    private ftp: FTPContext,
    private progress: ProgressTracker
  ) {}

  onDataStart(data: Socket, name: string): void {
    this.ftp.socket.setTimeout(0)
    data.setTimeout(0)
    this.watchdog.start(data, 'upload', this.ftp.timeout, () => {
      this.ftp.closeWithError(new Error('Timeout (data socket)'))
    })
    this.progress.start(data, name, 'upload')
  }

  /** 1xx 전에 데이터 쪽이 끊김: 결과는 제어 응답이 정하므로 제어 연결의 timeout 감시만 되돌린다. */
  onDataAbort(): void {
    // 끝난 작업이면 제어 소켓 timeout을 다시 켜지 않는다. 켜 두면 idle 클라이언트가 timeout으로 닫힌다.
    if (this.settled) return
    this.watchdog.stop()
    this.progress.updateAndStop()
    this.ftp.socket.setTimeout(this.ftp.timeout)
  }

  onDataDone(task: Task): void {
    if (this.settled) return
    this.watchdog.stop()
    this.progress.updateAndStop()
    this.ftp.socket.setTimeout(this.ftp.timeout)
    this.dataDone = true
    this.tryResolve(task)
  }

  onControlDone(task: Task, res: FTPResponse): void {
    this.response = res
    this.tryResolve(task)
  }

  onError(task: Task, err: Error): void {
    if (this.settled) return
    this.settled = true
    this.watchdog.stop()
    this.progress.updateAndStop()
    this.ftp.socket.setTimeout(this.ftp.timeout)
    this.ftp.dataSocket = undefined
    this.pending?.destroy()
    task.reject(err)
  }

  private tryResolve(task: Task): void {
    if (this.dataDone && this.response !== undefined) {
      this.settled = true
      this.ftp.dataSocket = undefined
      this.pending?.destroy()
      task.resolve(this.response)
    }
  }
}

/**
 * 수동 모드 응답을 받은 뒤의 업로드 한 건. basic-ftp의 connectForPassiveTransfer + uploadFrom을 한 task
 * 안에서 겹쳐 실행한다.
 *
 * 데이터 소켓은 1xx가 올 때까지 ftp.dataSocket에 넘기지 않는다. basic-ftp는 넘겨받은 소켓의 에러로 제어
 * 연결까지 닫는데, 1xx 전의 에러는 대개 서버가 STOR를 거부하며(550 등) 대기 중이던 데이터 연결을 RST로
 * 닫은 결과다. 그 RST가 550보다 먼저 올 수 있으므로 제어 응답을 기다려 그 FTPError로 끝내야 오류 분류가
 * 맞고 연결도 살아 남는다.
 */
function run(
  client: Client,
  target: { host: string; port: number },
  command: string,
  name: string,
  source: Readable
): Promise<FTPResponse> {
  const ftp = client.ftp
  const r = new Resolver(ftp, (client as unknown as ClientInternals)._progressTracker)
  let preliminary = false
  let started = false
  /** 2xx를 이미 받음: 이후의 데이터 에러는 제어 응답을 기다리지 않고 바로 돌려준다 */
  let controlDone = false
  /** 로컬 파일 읽기 에러. 서버 탓이 아니므로 빠른 경로 탓으로도 보지 않는다. */
  let sourceError: Error | undefined
  /** 연결이 끝난 데이터 소켓 (TLS면 TLSSocket) */
  let socket: Socket | undefined
  let handedOver = false
  /** 1xx 전에 난 데이터 쪽 에러. 제어 응답을 본 뒤에 처리한다. */
  let dataError: Error | undefined

  const onEarlyDataError = (err: Error): void => {
    if (handedOver || dataError || r.settled) return
    dataError = err
    if (!sourceError) earlyDataErrors.add(err)
    socket?.destroy()
    // 1xx 없이 2xx가 먼저 왔으면 더 올 제어 응답이 없다
    if (controlDone && task) r.onError(task, err)
    else if (started) r.onDataAbort()
  }
  // 서버가 읽지 않고 FIN으로 닫으면 쓰기가 에러 없이 멈춘다. watchdog을 기다리지 않고 끊김으로 본다.
  // 파일을 끝까지 넘긴 뒤(writableEnded) 서버가 닫는 것은 정상이다.
  const onDataClosed = (): void => {
    if (socket && !socket.writableEnded)
      onEarlyDataError(new Error('Data connection closed by the server before the upload finished'))
  }

  // 로컬 파일 에러는 basic-ftp처럼 연결을 닫는다: 1xx 뒤에 데이터가 끊기면 서버의 426이 다음 응답에 섞인다.
  // 1xx 전에는 pipeline이 데이터 소켓의 에러(550 거부의 RST 등)를 source로 전파한 것일 수 있으므로
  // 닫지 않는다. 그 에러는 pipeline 콜백이 onEarlyDataError로 넘겨 제어 응답이 결과를 정한다.
  source.on('error', (err) => {
    sourceError ??= err
    if (handedOver) ftp.closeWithError(err)
  })

  const handOver = (): void => {
    if (!socket || handedOver) return
    handedOver = true
    socket.removeListener('error', onEarlyDataError)
    socket.removeListener('end', onDataClosed)
    socket.removeListener('close', onDataClosed)
    r.pending = undefined
    ftp.dataSocket = socket
  }

  const maybeStart = (task: Task): void => {
    if (started || r.settled || !socket || dataError) return
    started = true
    const data = socket
    const go = (): void => {
      if (r.settled || dataError) return
      r.onDataStart(data, name)
      pipeline(source, data, (err) => {
        if (!err) r.onDataDone(task)
        else if (handedOver) r.onError(task, err)
        else onEarlyDataError(err)
      })
    }
    // TLS면 handshake가 끝나야 쓸 수 있다(basic-ftp uploadFrom과 같은 조건)
    if (data instanceof TLSSocket && data.getCipher() === undefined) data.once('secureConnect', go)
    else go()
  }

  const handled = ftp.handle(undefined, (res, task) => {
    if (res instanceof Error) {
      r.onError(task, res)
    } else if (res.code === 150 || res.code === 125) {
      // RFC 959상 둘 중 하나만 오지만, 두 번째 1xx로 다시 시작하면 원격 파일이 망가진다
      if (preliminary) return
      preliminary = true
      // 서버는 전송을 시작했는데 데이터 연결이 이미 깨짐: basic-ftp의 전송 중 소켓 에러와 같이 닫는다
      if (dataError) return ftp.closeWithError(dataError)
      handOver()
      maybeStart(task)
    } else if (res.code >= 200 && res.code < 300) {
      // 1xx 없이 완료를 보내는 서버도 있다. 제어 응답은 끝났으므로 데이터 에러는 연결을 닫지 않고 돌려준다.
      controlDone = true
      if (dataError) r.onError(task, dataError)
      else r.onControlDone(task, res)
    } else if (res.code >= 300 && res.code < 400) {
      ftp.closeWithError(
        new Error(`Unexpected FTP response is requesting an answer: ${res.message}`)
      )
    }
  })
  const result = handled.catch((err: unknown) => {
    if (err instanceof Error && !preliminary) fastFlowErrors.add(err)
    throw err
  })
  // handle()은 executor 안에서 _task를 동기로 만든다. 이미 닫힌 context면 거기서 바로 reject된다.
  const task = (ftp as unknown as { _task?: { resolver: Task } })._task?.resolver
  if (!task || r.settled) return result

  const raw = ftp._newSocket()
  r.pending = raw
  const failConnect = (err: Error): void => {
    if (r.settled) return
    err.message = "Can't open data connection in passive mode: " + err.message
    // STOR를 이미 보냈으므로 서버의 늦은 425가 다음 작업의 응답으로 섞인다. 제어 연결까지 닫는다.
    ftp.closeWithError(err)
  }
  raw.setTimeout(ftp.timeout)
  raw.on('error', failConnect)
  raw.on('timeout', () => {
    raw.destroy()
    failConnect(
      new Error(`Timeout when trying to open data connection to ${target.host}:${target.port}`)
    )
  })
  raw.connect({ port: target.port, host: target.host, family: ftp.ipFamily }, () => {
    if (r.settled) {
      raw.destroy()
      return
    }
    let data: Socket = raw
    if (ftp.socket instanceof TLSSocket) {
      // 제어 연결의 TLS 세션을 재사용한다. 서버 정책(vsftpd require_ssl_reuse, ProFTPD 기본값)이 요구한다
      const tlsSocket = tlsConnect({
        ...ftp.tlsOptions,
        socket: raw,
        session: ftp.tlsSessionStore ?? ftp.socket.getSession()
      })
      tlsSocket.on('session', (session: Buffer) => {
        ftp.tlsSessionStore = session
      })
      data = tlsSocket
    }
    raw.setTimeout(0)
    raw.removeListener('error', failConnect)
    raw.removeAllListeners('timeout')
    data.on('error', onEarlyDataError)
    data.on('end', onDataClosed)
    data.on('close', onDataClosed)
    // TLS면 아래 raw 소켓의 에러도 받아 둔다. 리스너 없는 'error'는 프로세스를 죽인다.
    if (data !== raw) raw.on('error', onEarlyDataError)
    socket = data
    r.pending = data
    if (preliminary) handOver()
    maybeStart(task)
  })
  ftp.send(command)
  return result
}

/** client.uploadFrom(localPath, remotePath)와 같은 결과를 빠른 경로로 낸다. */
async function uploadFile(
  client: Client,
  localPath: string,
  remotePath: string,
  mode: PassiveMode,
  expected: number,
  fd: number
): Promise<FTPResponse> {
  const validPath = await client.protectWhitespace(remotePath)
  const target = await requestPassive(client.ftp, mode)
  const source = createReadStream('', { fd, autoClose: false })
  const res = await run(client, target, `STOR ${validPath}`, validPath, source)
  // basic-ftp _uploadLocalFile: 읽는 도중 로컬 파일이 바뀌어 덜 보냈으면 성공으로 치지 않는다
  if (source.bytesRead !== expected) {
    throw new Error(
      `Local file "${localPath}" changed while it was being uploaded to "${remotePath}": expected to send ${expected} bytes but sent ${source.bytesRead}. The remote file is incomplete.`
    )
  }
  return res
}

/**
 * `client.uploadFrom(localPath, remotePath)`와 같은 결과. 이 클라이언트에서 아직 수동 모드를 고르지
 * 않았으면 표준 경로로 보낸다. 빈 파일도 표준 경로로 보낸다: FTPS에서 명령과 연결 순서가 표준과 다르면
 * handshake 직후 close_notify만 받은 서버(pyftpdlib)가 decode_error로 끊는다.
 */
export async function fastUpload(
  client: Client,
  localPath: string,
  remotePath: string
): Promise<FTPResponse> {
  const mode = knownPassiveMode(client)
  if (!mode) return client.uploadFrom(localPath, remotePath)

  const fd = await fsOpen(localPath, 'r')
  try {
    const expected = (await fd.stat()).size
    if (expected === 0) return await client.uploadFrom(localPath, remotePath)
    return await uploadFile(client, localPath, remotePath, mode, expected, fd.fd)
  } finally {
    await fd.close().catch(() => {})
  }
}

/**
 * 빠른 경로 자체가 원인일 수 있는 실패인가. 참이면 호출자는 이 서버 연결에서 빠른 경로를 끄고
 * 같은 작업을 표준 경로로 한 번 다시 시도한다. 빠른 경로의 전송 단계에서 1xx 전에 난 에러만 해당하고,
 * 550/553/521 같은 파일 단위 거부는 표준 경로에서도 같으므로 제외한다.
 */
export function isFastFlowSuspect(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (earlyDataErrors.has(err)) return true
  if (!fastFlowErrors.has(err)) return false
  if (err instanceof FTPError) return err.code === 425 || err.code === 426 || err.code === 503
  const code = (err as NodeJS.ErrnoException).code
  if (code !== undefined && BROKEN_CONNECTION_CODES.has(code)) return true
  return /data connection|data socket|ECONNRESET|EPIPE|Timeout/i.test(err.message)
}
