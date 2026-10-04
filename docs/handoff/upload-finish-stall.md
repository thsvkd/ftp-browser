# 핸드오프: 업로드가 100%에서 한동안 멈췄다가 완료로 바뀐다

R1에서 인간과 합의한 내용의 고충실도 기록(오케스트레이터 경유로 D1~D5 확정).
R2(테스트 코드 작성)·구현의 유일한 입력이다. 이 문서에 없는 케이스는 완료 범위 밖이다.
새 케이스를 추가하거나 기존 케이스를 재해석하지 말 것.

작업 유형(R0): **버그 1건(진행률 표시 오류)**. 전송 동작(속도, 명령 순서, 버퍼 튜닝)은 바꾸지 않는다.

---

## 1. 문제 정의

### 증상 (사용자 보고)

> 이미지가 들어있는 여러 개의 폴더를 끌어서 핸드폰(ftp server)에 전송하였는데 100%에서 잠시 머무르다가
> 전송 완료로 전환됨. 뭔가 중간에 걸리는게 있나봐.

### 결론

**중간에 막는 단계는 없다.** 앱은 파일을 보내자마자 OS와 네트워크의 버퍼에 넘기고, 진행률은 넘긴 바이트를
"보낸 것"으로 센다. 바이트가 실제로 폰에 도착하기 전이다. 그래서 배치 막바지에는 화면이 이미 100%인데,
그동안에도 데이터는 아직 Wi-Fi로 폰에 가는 중이다. 폰이 마지막 바이트까지 받은 뒤 파일을 닫고(폰에 따라
미디어 스캔 등) `226 Transfer complete`로 답해야 완료가 된다. 이 꼬리가 "100%에서 머무름"의 정체다.

측정상 전체 소요 시간은 어느 변형에서도 같고(±0.1 s), 서버의 마지막 `226` 뒤 1 ms 안에 배치가 완료된다.
꼬리는 실제로 전송 중인 시간이라 클라이언트가 줄일 수 없다. 고칠 것은 대기 시간이 아니라 **표시**다: 완료 전에는
100%를 보이지 않고(D2), 앱이 아는 만큼만 진행률을 세며(D1), 남은 꼬리는 "마무리 중…"으로 보인다(D3).

### 원인

**RC1 — 업로드 진행률은 서버가 받은 바이트가 아니라 소켓에 넘긴 바이트다.**
basic-ftp `ProgressTracker`는 500 ms마다 `socket.bytesRead + socket.bytesWritten`을 보고한다
(`node_modules/basic-ftp/dist/ProgressTracker.js:30`). 업로드 데이터 소켓은
[`fastTransfer.ts:307`](../../src/main/ftp/fastTransfer.ts#L307) `this.progress.start(data, name, 'upload')`로
그대로 넘어간다. Node의 `bytesWritten`은 아직 Node 쓰기 대기열에 있는 바이트까지 센다. 그 뒤에는 OS 송신 버퍼,
네트워크(AP 큐), 폰의 수신 버퍼가 더 있다. 한 연결이 앞서 세는 양은

- Node 쓰기 대기열: `RingSource.pump`가 `writableLength`가 `UPLOAD_QUEUED_MAX`(512 KiB) 미만이면 256 KiB를 더
  넘기므로 최대 약 768 KiB ([`fastTransfer.ts:41-45`](../../src/main/ftp/fastTransfer.ts#L41-L45),
  [`fastTransfer.ts:198-208`](../../src/main/ftp/fastTransfer.ts#L198-L208)). 주석이 이미 이 앞섬을 인정한다.
- OS 송신 버퍼 + 경로 + 폰 수신 버퍼: OS가 자동 조절한다. Node에는 이를 읽거나 줄일 API가 없다
  (TCP 소켓의 `SO_SNDBUF`·`TCP_NOTSENT_LOWAT`·`TCP_INFO` 미노출).

이것이 동시 전송 수(기본 16)만큼 곱해진다. 파일 하나가 이 합보다 작으면 시작 직후 100%가 되어 전송 내내
100%로 보인다. 배치 막바지에는 남은 파일이 모두 100%라 배치도 100%다.

데이터 소켓이 `finish`하면 `Resolver.onDataDone`이 `updateAndStop()`으로 전체 크기를 보고하고, 작업은
서버의 `226`을 기다린다([`fastTransfer.ts:319-351`](../../src/main/ftp/fastTransfer.ts#L319-L351)).
서버는 남은 데이터를 다 읽고 파일을 닫은 뒤에야 `226`을 보내므로(폰이면 미디어 스캔 등이 더해질 수 있다),
그 사이 "100%인데 진행 중"이 된다. `226`을 기다리는 것 자체는 basic-ftp와 같은 정상 규칙이다.

**RC2 — 배치 퍼센트가 반올림이라 99.5%부터 100%로 보인다.**
[`TransferPanel.tsx:29-32`](../../src/renderer/src/components/transfer/TransferPanel.tsx#L29-L32)
`Math.round`. 1 GB 배치면 마지막 5 MB가 100%로 보인다.

### 측정으로 기각한 가설

| 가설                                                                  | 결과                                                                                                                                                                     |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 업로드 뒤 클라이언트 쪽 단계(SIZE 검증, MFMT, 목록 새로고침)가 막는다 | 업로드 경로에 없다. `mutation`은 폴더 미리보기 캐시 무효화뿐([`galleryHandlers.ts:66`](../../src/main/ipc/galleryHandlers.ts#L66)). 서버 마지막 `226` → 배치 완료 0~1 ms |
| 100 ms 변경 묶음이나 풀 정리가 완료 알림을 늦춘다                     | 큐가 비면 바로 flush한다([`TransferQueue.ts:290-295`](../../src/main/transfer/TransferQueue.ts#L290-L295)). 풀 idle close는 완료 뒤 10초 타이머                          |
| 렌더러가 상태를 늦게 바꾼다                                           | `batchStatus`는 받은 상태 그대로다. 완료는 위 0~1 ms 안에 도착                                                                                                           |

### 측정

하네스(커밋하지 않음): 실제 `TransferQueue`/`TransferClientPool`/`fastUpload`를 esbuild로 묶어 Node 22에서 돌리고,
pyftpdlib 서버가 모든 데이터 연결에 **하나의** 수신 한도(Wi-Fi 링크 흉내, 4 MiB/s)를 건다. 서버는 앱이 읽은 바이트
누계·EOF·`226` 시각을, 클라이언트는 `transfer:updated`와 같은 변경분으로 `TransferPanel`과 같은 식의 배치 퍼센트를
기록한다. "멈춤"은 배치가 100%로 보인 때부터 완료까지, "앞섬"은 그 순간 화면 바이트 − 서버가 읽은 바이트.

| 시나리오 (4 MiB/s, 연결 16)               | 전체   | 100%에서 멈춤 | 100% 순간 앞섬 | Node 대기열 최대(합)            |
| ----------------------------------------- | ------ | ------------- | -------------- | ------------------------------- |
| 1.5~4 MB × 30, 루프백 기본 버퍼           | 20.3 s | **7.7 s**     | 30 MB          | —                               |
| 같은 파일, MSS 1460 + 서버 SO_RCVBUF 256K | 20.5 s | **4.9 s**     | 19 MB          | 7.3 MB                          |
| 2행 + 서버 `226` 0.5 s 지연               | 20.9 s | 6.8 s         | 25 MB          | 7.8 MB                          |
| 0.2~0.8 MB × 120                          | 15.7 s | 1.2 s         | 4.5 MB         | ≈0 (파일이 OS 버퍼에 다 들어감) |
| 1.5~4 MB × 30, 연결 4                     | 20.3 s | 1.7 s         | 6.8 MB         | 1.8 MB                          |

- 2행 이하는 모두 MSS 1460 + 서버 SO_RCVBUF 256K다.
- 모든 시나리오에서 파일 하나가 100%로 보이는 시간은 그 파일 전송 시간의 98~100%(중앙값)다.

구현 뒤 같은 하네스로 2행 조건을 수정 전/후 번들로 3회씩 번갈아 쟀다(화면 값은 새 `TransferPanel` 규칙으로 계산).

|                     | 전체          | 완료 전 화면 최대 | 옛 화면이 100%로 머문 시간 | 새 화면 "마무리 중…" 시간 | 최대 앞섬    |
| ------------------- | ------------- | ----------------- | -------------------------- | ------------------------- | ------------ |
| 수정 전 코드        | 20.45~20.55 s | 100%              | 3.8~6.4 s                  | —                         | 37.3~37.6 MB |
| 수정 후 코드(D1~D3) | 20.44~20.50 s | **99%**           | (100%를 보이지 않음)       | 2.4~4.6 s                 | 34.1~35.0 MB |

- D1은 최대 앞섬을 Node 대기열 몫(약 3 MB)만큼 줄였다. 꼬리 시간 차이는 루프백에서는 오차 범위 안이다
  (OS 버퍼 몫이 커서). 실제 Wi-Fi에서는 이 몫의 비중이 더 크다(아래 주석).
- 사용자에게 보이는 변화는 D2·D3이다: 완료 전에는 100%가 나오지 않고, 남은 꼬리는 "마무리 중…"으로 보인다.
- **루프백은 OS 버퍼 몫을 부풀린다**(MSS 64 KiB·손실 없음이라 송신 버퍼가 4 MiB까지 자란다). 실제 Wi-Fi에서는 OS 몫이
  훨씬 작아 Node 대기열 몫(연결당 최대 768 KiB, 16연결이면 최대 12 MiB ≈ 4 MiB/s에서 3 s)의 비중이 커진다.
  Windows(사용자 환경)는 여기서 잴 수 없다. 남는 OS 몫은 클라이언트가 알 수 없으므로 D2·D3이 표시로 다룬다.

---

## 2. 핵심 결정 (R1에서 확정)

| #   | 결정                                                                                                                                                                                                                                                                                                                                 | 근거                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | 업로드 진행률은 **OS가 받아 간 바이트만** 센다. `Resolver.onDataStart`가 ProgressTracker에 넘기는 소켓을 `bytesRead`는 그대로, `bytesWritten`은 `socket.bytesWritten - socket.writableLength`로 돌려주는 얇은 객체로 바꾼다. watchdog에는 원래 소켓을 그대로 넘긴다                                                                  | 클라이언트가 아는 유일한 정직한 값. 표준·빠른·메인 클라이언트 경로가 모두 이 `Resolver`를 지나므로 한 곳. 전송 경로는 무변경이라 LAN 속도 회귀 위험이 없다              |
| D2  | 전송 패널은 **완료 전에는 100%를 보이지 않는다.** `percent()`는 반올림을 유지하되 진행 중 행(파일 행, 배치 행)에서 최대 99                                                                                                                                                                                                           | 100% = 완료. 반올림을 내림으로 바꾸면 기존 단언(37.5% → 38)까지 바뀐다                                                                                                  |
| D3  | 모든 바이트를 넘겼는데 `226`을 기다리는 동안 상태 글자를 `job.finishing`(en "Finishing…", ko "마무리 중…")으로 보인다. 파일 행(단일·중첩 `JobRow`): `active`이고 `transferredBytes >= totalBytes`. 배치 행: `pending` 작업이 없고 모든 `active` 작업이 `transferredBytes >= totalBytes`. 새 i18n 키 1개 × 11 로케일, IPC·타입 무변경 | 남는 꼬리(OS 버퍼 배출 + 폰의 파일 마무리)는 클라이언트가 줄이거나 잴 수 없다. 99%에서 멈춘 것처럼 보이는 대신 무엇을 기다리는지 말한다. "99%로만 표시"(D3 없음)는 기각 |
| D4  | 기본 동시 전송 수(16), `UPLOAD_BUFFER`·`UPLOAD_BUFFERS`·`UPLOAD_QUEUED_MAX`, 명령 순서는 바꾸지 않는다                                                                                                                                                                                                                               | 5a37fc0·730c6dc의 LAN/WAN 속도. D1 뒤에는 Node 대기열 크기가 표시에 영향을 주지 않는다                                                                                  |
| D5  | 꼬리의 길이 자체는 줄지 않는다. 이를 수용한다                                                                                                                                                                                                                                                                                        | 남은 데이터가 폰에 가는 시간과 폰의 파일 마무리는 실제 작업이다. 사용자 보고("뭔가 걸리는 것 같다")에는 정직한 표시와 설명이 맞는 답이다                                |

---

## 3. 구현 메모

- D1의 값은 단조 증가다. `write()` 때 `bytesWritten`과 `writableLength`가 같이 늘고, 쓰기 콜백 때 `writableLength`만
  준다. `finish` 뒤에는 `writableLength`가 0이라 `updateAndStop()`의 마지막 보고는 파일 크기 그대로다.
- TLS 데이터 소켓(`TLSSocket`)도 `bytesWritten`·`writableLength`가 같은 평문 기준이라 그대로 쓴다.
- `ProgressTracker.start`의 타입은 `Socket`이다. 필요한 두 속성만 가진 객체를 넘기고 타입은 그 자리에서만 좁힌다
  (`ClientInternals`와 같은 방식). `any` 금지.
- `TransferPanel`의 `percent()`는 진행 중 행에서만 쓰인다(완료 행은 막대를 그리지 않는다). 상한은 행의 상태를 보고
  건다. 배치 행은 `isLive`, 파일 행은 `status === 'active'`.
- D3 문자열은 `en.ts`에 넣고 10개 로케일에 번역해 넣는다(`satisfies LocaleMessages`가 빠진 키를 잡는다).

---

## 4. 기각한 대안

- **`UPLOAD_QUEUED_MAX`·링을 줄여 앞섬을 줄인다** — D1 뒤에는 표시와 무관하다. 송신 경로를 건드리면 5a37fc0의
  LAN 속도(512 MB 0.12 s)를 다시 재야 하고 Windows는 여기서 잴 수 없다. 기각(D4).
- **OS 송신 버퍼를 줄인다** — Node TCP 소켓에 `SO_SNDBUF`/`TCP_NOTSENT_LOWAT` API가 없다. koffi는 Windows 전용이고
  Windows의 Node 소켓은 핸들을 내주지 않는다. 기각.
- **OS가 아직 확인받지 못한 바이트를 읽는다**(`/proc/net/tcp` tx_queue, `SIO_TCP_INFO`, `GetPerTcpConnectionEStats`) —
  플랫폼마다 다르고 Windows는 관리자 권한·핸들이 필요하다. 기각.
- **연결별 배출 시간을 학습하거나 속도로 꼬리를 추정해 진행률을 깎는다** — 추정이 틀리면 또 거짓말이 되고 코드가 커진다. 기각.
- **`226`을 기다리지 않고 다음 PASV/STOR를 먼저 보낸다(파이프라이닝)** — 많은 서버가 응답 전 명령을 다루지 못한다.
  16연결이면 `226` 대기는 이미 다른 연결의 전송과 겹친다. 이득은 배치 끝의 마지막 `226` 하나뿐. 기각.
- **동시 전송 수를 줄여 앞섬을 줄인다** — 앞섬은 줄지만 작은 파일 처리량이 730c6dc 이전으로 돌아간다. 기각(D4).
- **퍼센트를 내림으로** — D2의 상한과 효과가 같고 기존 단언(38%)을 바꾼다. 기각(D2).
- **새 작업 상태 `'finishing'`을 `TransferStatus`에 추가** — 메인·IPC·`batchStatus`·`clearCompleted`가 모두 영향받는다.
  렌더러가 `transferredBytes >= totalBytes`로 알 수 있으므로 표시만 바꾼다. 기각(D3).

---

## 5. 테스트 케이스 리스트

`Test-300`부터. (동시에 작성 중인 썸네일 스펙이 Test-262부터 쓰므로 번호를 띄웠다.)
각 테스트 코드에 `covers: Test-N` 주석을 단다. **1:1 매핑. 케이스 추가·병합·재해석 금지.**

### A. 업로드 진행률 (`src/main/ftp/fastTransfer.test.ts`)

기존 `connect({ storPace })`·`prime()`·`localFile()` 헬퍼를 쓴다. 보고를 촘촘히 받도록 테스트에서
`client`의 ProgressTracker `intervalMs`를 줄여도 된다. 데이터 소켓은 기존 "two buffers queued" 테스트처럼
`net.Socket.prototype.write`를 엿봐 1 KiB 넘는 Buffer를 쓰는 소켓으로 잡는다.

| #        | 케이스                                                                                                                                                                                                        | 기대                                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Test-300 | 서버가 느리게 읽는(`storPace`) 업로드에서 `client.trackProgress`로 받은 모든 보고의 `bytes`를 그 순간 데이터 소켓의 `bytesWritten - writableLength`와 비교. 표준 경로·빠른 경로 둘 다(`fast` 루프, 한 케이스) | 모든 보고가 같다. **그리고** `writableLength > 0`인 순간의 보고가 적어도 하나 있다(없으면 공허한 통과라 실패시킨다) |
| Test-301 | 같은 조건에서 마지막 보고                                                                                                                                                                                     | `bytes`가 파일 크기와 같다 (D1이 최종값을 깎지 않음)                                                                |

현재 코드에서 Test-300은 `writableLength > 0`인 보고에서 `bytes === bytesWritten`이라 RED다.

### B. 100% 표시 (`src/renderer/src/components/transfer/TransferPanel.test.tsx`)

| #        | 케이스                                                                             | 기대                                                |
| -------- | ---------------------------------------------------------------------------------- | --------------------------------------------------- |
| Test-302 | 단일 파일 `active`, `transferredBytes === totalBytes`                              | 파일 막대 `aria-valuenow === '99'`, 글자 `99%`      |
| Test-303 | 배치: `completed`(total 996) + `active`(total 4, transferred 2) → 998/1000 = 99.8% | 전체 막대 `aria-valuenow === '99'` (반올림이면 100) |

기존 "shows one overall bar and one current-file bar…"(37.5% → `38`, 25% → `25`)는 그대로 GREEN이어야 한다(D2의 반올림 유지 회귀 고정).

### C. 마무리 중 표시 — D3 (`TransferPanel.test.tsx`)

| #        | 케이스                                                              | 기대                                                                    |
| -------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Test-304 | 배치: `completed` + `active`(transferred === total), `pending` 없음 | 배치 행 상태 글자 `Finishing…`, `In progress` 없음                      |
| Test-305 | 배치: `active`(transferred === total) + `pending` 하나              | 배치 행 `In progress`, `Finishing…` 없음                                |
| Test-306 | 배치: `active` 둘 중 하나만 transferred === total, `pending` 없음   | 배치 행 `In progress`                                                   |
| Test-307 | 단일 파일 `active`, transferred === total                           | 파일 행 `Finishing…`. 같은 파일이 transferred < total이면 `In progress` |
| Test-308 | 완료된 단일 파일 행과 완료된 배치 행(transferred === total)         | 두 행 모두 `Completed`, `Finishing…` 없음                               |

Test-305·306이 없으면 "active이면 항상 Finishing" 구현이 304를 통과한다. Test-308이 없으면 `status === 'active'` 조건을 뺀 구현(완료 행이 "Finishing…"으로 보임)이 통과한다(R2 뮤테이션 생존자 2개).

---

## 6. 관련 코드 포인터

| 파일                                                                                                                     | 역할                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| [`src/main/ftp/fastTransfer.ts`](../../src/main/ftp/fastTransfer.ts)                                                     | L301-308 `Resolver.onDataStart`(D1 변경 지점), L319-326 `onDataDone`, L344-351 `tryResolve`(`226` 대기), L41-45·L198-208 대기열 한도(무변경) |
| `node_modules/basic-ftp/dist/ProgressTracker.js`                                                                         | L30 `bytesRead + bytesWritten`, 500 ms 주기                                                                                                  |
| [`src/main/ftp/FtpFileOperations.ts`](../../src/main/ftp/FtpFileOperations.ts)                                           | L140-161 `upload`: `trackProgress` → `fastUpload` → `mutation`                                                                               |
| [`src/main/transfer/TransferQueue.ts`](../../src/main/transfer/TransferQueue.ts)                                         | L437-440 진행률 → `job.transferredBytes`, L400-406 완료, L290-295 비면 바로 flush (무변경)                                                   |
| [`src/renderer/src/components/transfer/TransferPanel.tsx`](../../src/renderer/src/components/transfer/TransferPanel.tsx) | L29-32 `percent`, L76-121 `JobRow`, L123-191 `BatchRows`(D2·D3)                                                                              |
| `src/renderer/src/i18n/locales/*.ts`                                                                                     | `job.*` 상태 글자. D3의 `job.finishing` 추가                                                                                                 |
| [`src/main/transfer/__fixtures__/mockFtpServer.ts`](../../src/main/transfer/__fixtures__/mockFtpServer.ts)               | `storPace`: 서버가 느리게 읽어 클라이언트 대기열이 찬다                                                                                      |

---

## 7. 완료 기준

1. Test-300~308이 GREEN, 기존 테스트 전체 GREEN (`npx vitest run` 출력으로 확인).
2. `npm run typecheck` · `npm run lint` · `npx prettier --check <바꾼 파일>` 통과.
3. 뮤테이션: 썸네일 작업이 `stryker.config.json`을 동시에 바꾸므로 **이 파일은 건드리지 않는다.** 대신 scratchpad에
   그 설정의 사본을 두고 `mutate`를 이번 변경 라인(`fastTransfer.ts`, `TransferPanel.tsx`)으로, `tempDirName`을 따로 두어
   돌리고 점수(`break: 70` 기준)를 보고한다.
4. R3 실측(별도 worktree 빌드, 느린 서버 4 MiB/s·연결 16에 폴더 3개 끌어 올리기):

| 항목     | 확인 내용                                                       |
| -------- | --------------------------------------------------------------- |
| 100%     | 배치·파일 행이 완료 전에는 100%를 보이지 않는다                 |
| 꼬리     | 마지막 구간에 99%(D3이면 "마무리 중…")로 보이다가 완료로 바뀐다 |
| 속도     | 같은 배치의 전체 시간이 수정 전과 같다(±5%)                     |
| 다운로드 | 다운로드 진행률·완료는 이전과 같다                              |
