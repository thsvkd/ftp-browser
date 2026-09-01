# 핸드오프: Windows 설치판 자동 업데이트

R1에서 인간과 합의한 내용의 고충실도 기록. R2(테스트 코드 작성)·구현의 유일한 입력이다.
이 문서에 없는 케이스는 완료 범위 밖이다. 새 케이스를 추가하거나 기존 케이스를 재해석하지 말 것.

작업 유형(R0): **기능(feature)**.

선행 작업: [`windows-binary-release.md`](./windows-binary-release.md), [`macos-support.md`](./macos-support.md).
두 작업이 만든 릴리스 계약(태그 `v*`, 네이티브 러너별 패키징, 단일 GitHub Release)은 그대로 유효하며
깨뜨리면 안 된다.

---

## 1. 문제 정의

설치 파일을 GitHub Releases에 올리는 파이프라인은 있지만, **이미 설치한 사용자가 새 버전을 알 방법이 없다.**
사용자가 직접 릴리스 페이지를 확인하고 새 설치판을 받아 다시 설치해야 한다.

---

## 2. 핵심 결정 (R1에서 인간이 확정)

| #   | 결정                                                                               | 근거                                                                                                                                            |
| --- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| U1  | **Windows NSIS 설치판만** 자동 업데이트한다                                        | 포터블은 설치 경로가 사용자 임의라 교체가 안전하지 않고, macOS·Linux는 코드 서명·배포 채널이 각각 따로다. 범위를 넓히면 검증할 조합이 배로 는다 |
| U2  | 앱은 **시작할 때 한 번 확인만** 한다. 다운로드와 설치는 사용자가 누른다            | `autoDownload`·`autoInstallOnAppQuit`를 모두 끈다. FTP 전송 중에 앱이 제멋대로 종료되면 전송이 깨진다                                           |
| U3  | `electron-updater`를 renderer에 노출하지 않고 **main의 작은 상태 관리자**로 감싼다 | renderer는 `UpdateState` 하나와 명령 4개만 본다. 네트워크 이벤트를 단위 테스트할 수 있게 되고, preload 화이트리스트도 좁게 유지된다             |
| U4  | 지원되지 않는 빌드에서는 updater를 **주입하지 않는다**(`null`)                     | 분기를 `UpdateManager` 생성 시점 한 곳으로 모은다. 명령이 들어와도 `unsupported` 상태를 돌려줄 뿐 아무 일도 하지 않는다                         |
| U5  | publish provider는 **`github`**(`owner`/`repo`)                                    | 3절 함정 A. `generic` + `releases/latest/download`는 차등 업데이트를 조용히 무력화한다                                                          |
| U6  | 재시작 전에 **진행 중인 전송·파일 작업을 확인**한다                                | 두 큐(`useTransferStore`·`useOperationStore`)를 모두 본다. 한쪽만 보면 나머지 한쪽은 경고 없이 끊긴다                                           |
| U7  | 업데이트 가능·다운로드 완료는 **토스트로 알리고 설정 화면으로 보낸다**             | 설정을 열지 않은 사용자에게 알릴 경로가 그것뿐이다. 토스트가 직접 다운로드를 시작하지는 않는다(U2)                                              |

---

## 3. 구현 함정

### 함정 A — `generic` provider는 차등 업데이트를 조용히 무력화한다

`publish.url`을 `https://github.com/<owner>/<repo>/releases/latest/download`로 두면 최신 버전 파일은
잘 받아진다. 하지만 차등 다운로드는 **이전 버전(지금 설치된 버전)의 `.blockmap`** 도 받아야 한다.
`Provider.getBlockMapFiles()`는 새 파일 URL의 pathname에서 버전 문자열만 치환해 이전 blockmap URL을
만드는데, `latest/download` 경로에는 최신 버전 에셋만 있으므로 그 URL은 항상 404다.

`previousBlockmapBaseUrlOverride`로 고치려는 시도는 **효과가 없다.** 그 값은
`new URL(pathname, base)`의 base로만 쓰이는데, 첫 인자가 `/`로 시작하는 절대 경로라 base의 path가
통째로 버려지고 origin만 남는다. 둘 다 `github.com`이므로 결과 URL이 오버라이드 유무와 동일하다.
설정한 쪽은 "차등 업데이트를 켰다"고 믿지만 실제로는 매번 전체 다운로드로 폴백한다.

`github` provider는 파일 URL이 `releases/download/v<version>/...`이라 버전 치환만으로 이전 blockmap이
맞는 위치를 가리킨다. `Test-206`이 이 계약을 고정한다.

### 함정 B — 실패는 rejection이 아니라 `error` 이벤트로 온다

`electron-updater`는 네트워크 실패 대부분을 `checkForUpdates()`의 rejection이 아니라 `'error'`
이벤트로 알린다. rejection만 처리하면 사용자는 `checking`에서 멈춘 화면을 본다. 게다가
`EventEmitter`의 `'error'`는 리스너가 없으면 그대로 던져진다. `Test-214`가 이벤트 경로를 고정한다.

### 함정 C — `ready`에서 다시 확인하면 받아 둔 업데이트가 날아간다

`check()`가 `update-available`을 다시 받으면 상태가 `available`로 되돌아가, 이미 받아 둔 파일을
사용자가 처음부터 다시 받는다. `CHECK_BLOCKING_STATUSES`에 `ready`가 들어가야 하는 이유다.
`Test-211`이 이를 고정한다.

### 함정 D — 자동 확인과 renderer 구독 사이에는 순서 보장이 없다

시작 시 확인은 `did-finish-load`에서 시작하고, `useUpdateListener`의 구독은 React 마운트 이후다.
네트워크 왕복이 훨씬 느려 실무상 문제는 없지만, 토스트를 놓칠 수 있다. 설정 화면이 열릴 때
`update:getState`로 현재 상태를 다시 읽어 복구한다. **토스트를 유일한 전달 경로로 삼지 말 것.**

---

## 4. 대상 API

```ts
// src/shared/types/update.ts
export type UpdateStatus =
  | 'unsupported' // 자동 업데이트 대상이 아닌 빌드
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready' // 다 받았고 재시작만 남았다
  | 'up-to-date'
  | 'error'

export interface UpdateState {
  status: UpdateStatus
  currentVersion: string
  availableVersion?: string
  progressPercent?: number
  message?: string
}
```

```ts
// src/main/update/UpdateManager.ts
export function isAutomaticUpdateSupported(options: {
  isPackaged: boolean
  platform: string
  isPortable: boolean
  isSmokeTest: boolean
}): boolean

export class UpdateManager {
  constructor(
    currentVersion: string,
    /** 지원 대상이 아니면 null(U4). */
    updater: UpdateClient | null,
    emitState: (state: UpdateState) => void
  )
  getState(): UpdateState
  check(): Promise<UpdateState> // checking·downloading·ready에서는 무시(함정 C)
  download(): Promise<UpdateState> // available에서만
  install(): void // ready에서만
}
```

IPC 채널: `update:getState` · `update:check` · `update:download` · `update:install`(invoke),
`update:stateChanged`(event). preload 화이트리스트에 이 다섯 개만 추가한다.

---

## 5. 기각한 대안

- **`autoDownload: true`로 두고 조용히 받아 두기** — 사용자 조작이 줄지만, 종량제 회선에서 동의 없이
  수십 MB를 받는다. U2에서 기각.
- **`autoInstallOnAppQuit: true`** — 재시작 버튼이 필요 없어지지만, 사용자가 앱을 닫는 순간 설치가
  시작돼 "그냥 껐는데 설치가 돌았다"가 된다. U2에서 기각.
- **업데이트 상태를 renderer 스토어에 두기** — updater 이벤트가 renderer로 직접 흐르면
  단위 테스트에 Electron 목이 필요해진다. U3에서 기각.
- **포터블·macOS·Linux까지 자동 업데이트** — U1에서 기각. README에 수동 설치 경로를 명시한다.
- **`generic` provider + `previousBlockmapBaseUrlOverride`** — 함정 A. 동작하지 않는다.

---

## 6. 테스트 케이스 리스트 (확정)

`Test-198`부터 신규. 기존 최대 번호는 `Test-197`.
각 테스트에 `covers: Test-N` 주석을 단다. **1:1 매핑. 케이스 추가·병합·재해석 금지.**

### A. 지원 판정 (`main/update/UpdateManager.test.ts`)

| #        | 케이스                                                 | 기대             |
| -------- | ------------------------------------------------------ | ---------------- |
| Test-198 | packaged·win32·비포터블·비스모크 조합과 그 각각의 반례 | 첫 조합만 `true` |

### B. 상태 머신 (`main/update/UpdateManager.test.ts`)

| #        | 케이스                               | 기대                                                                                                  |
| -------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Test-199 | `check()` 중 `update-available`      | `available` + `availableVersion`, `autoDownload`·`autoInstallOnAppQuit`가 꺼진다                      |
| Test-200 | `update-not-available`               | `up-to-date`                                                                                          |
| Test-201 | 다운로드 진행률 → 완료 → `install()` | `downloading`(percent) → `ready`(100), `quitAndInstall(false, true)`는 install 전까지 호출되지 않는다 |
| Test-202 | `checkForUpdates()` rejection        | `error` + 메시지. 예외가 IPC를 넘지 않는다                                                            |
| Test-211 | `ready`에서 `check()`                | `ready` 유지, `checkForUpdates` 미호출 (함정 C)                                                       |
| Test-213 | updater가 `null`인 빌드              | `unsupported`, 세 명령 모두 무동작, 상태 이벤트 없음                                                  |
| Test-214 | 확인 중 `'error'` **이벤트**         | `error` + 메시지 (함정 B)                                                                             |
| Test-215 | `downloadUpdate()` rejection         | `error`. `downloading`에 갇히지 않는다                                                                |
| Test-216 | `available`이 아닐 때 `download()`   | 무동작, `downloadUpdate` 미호출                                                                       |
| Test-217 | `ready`가 아닐 때 `install()`        | `quitAndInstall` 미호출                                                                               |

Test-216·217이 U2의 방어다. 이게 없으면 "가드 없이 그냥 실행하는" 구현이 나머지를 통과한다.

### C. IPC (`main/ipc/updateHandlers.test.ts`, `preload/index.test.ts`)

| #        | 케이스                                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------------------------ |
| Test-203 | 네 채널이 등록되고, 각 명령의 결과가 `IpcResult`로 감싸이며, `update:install`이 매니저에 도달한다                  |
| Test-208 | preload가 네 invoke 채널을 **모두** 허용하고, `update:stateChanged`를 구독·해제하며, 선언되지 않은 채널은 거부한다 |

### D. 릴리스 계약 (`shared/releaseArtifacts.test.ts`)

| #        | 케이스                                                                                                                            |
| -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Test-206 | `publish`가 `github`/`owner`/`repo`이고 `releases/latest/download`를 쓰지 않는다. `nsis.differentialPackage`가 켜져 있다 (함정 A) |
| Test-207 | 릴리스 업로드 목록에 `*-setup.exe.blockmap`과 `latest.yml`이 들어간다                                                             |

### E. renderer (`settings/SettingsDialog.test.tsx`, `hooks/useUpdateListener.test.tsx`)

| #        | 케이스                                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------ |
| Test-204 | 현재 버전을 보여주고 직접 확인할 수 있다                                                                                 |
| Test-205 | `available`에서만 다운로드 버튼, `ready`에서만 재시작 버튼이 나온다                                                      |
| Test-209 | `available`·`ready`에서만 토스트가 뜨고, 액션이 설정 화면을 연다. 다른 상태는 조용하다                                   |
| Test-210 | 진행 중 **전송**이 있으면 확인을 거치고, 거절하면 재시작하지 않는다                                                      |
| Test-212 | 각 상태의 설명 문구 (idle·checking·available·downloading·ready·up-to-date·error(메시지 유/무)·unsupported(메시지 유/무)) |
| Test-218 | 진행 중 **파일 작업**(전송이 아닌)도 같은 확인을 거친다 (U6)                                                             |
| Test-219 | main이 밀어주는 `update:stateChanged`가 열려 있는 다이얼로그에 반영된다                                                  |

Test-218이 U6의 방어다. 전송만 검증하면 파일 작업 가드를 지워도 아무 테스트가 깨지지 않는다.

### F. E2E (자동화 불가 — 8절에서 실측)

실제 GitHub Release·설치판·네트워크가 있어야만 검증되는 경로다.

---

## 7. 관련 코드 포인터

| 파일                                                                                               | 역할                                                        |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| [`main/update/UpdateManager.ts`](../../src/main/update/UpdateManager.ts)                           | 상태 머신, `electron-updater` 래핑                          |
| [`main/ipc/updateHandlers.ts`](../../src/main/ipc/updateHandlers.ts)                               | 명령 4개를 `IpcResult`로 감싼다                             |
| [`main/index.ts`](../../src/main/index.ts)                                                         | 지원 판정·주입·`did-finish-load` 최초 확인·상태 이벤트 송신 |
| [`preload/index.ts`](../../src/preload/index.ts)                                                   | 채널 화이트리스트                                           |
| [`renderer/.../SettingsDialog.tsx`](../../src/renderer/src/components/settings/SettingsDialog.tsx) | Updates 절, 재시작 가드(U6)                                 |
| [`renderer/.../useUpdateListener.ts`](../../src/renderer/src/hooks/useUpdateListener.ts)           | 토스트 알림(U7)                                             |
| [`electron-builder.yml`](../../electron-builder.yml)                                               | `publish`, `nsis.differentialPackage`                       |
| [`.github/workflows/release.yml`](../../.github/workflows/release.yml)                             | `latest.yml`·blockmap 업로드                                |

---

## 8. 완료 기준

1. Test-198~219가 모두 GREEN (실행 출력으로 확인).
2. 선행 작업의 기존 테스트가 계속 GREEN.
3. 각 테스트에 `covers: Test-N` 주석.
4. 뮤테이션 스코어 임계값 이상. `stryker.config.json`의 `mutate`를 이번 변경분으로 갱신하고,
   수정한 기존 파일의 라인 범위를 `git diff --unified=0 -- <file> | grep '^@@'`로 재확인해 갱신한다.
5. `npm run typecheck` · `npm run lint` 통과.
6. Windows 패키징에서 `latest.yml`·`.blockmap`·패키지 내부 `app-update.yml`이 생성되고,
   `latest.yml`의 SHA-512가 실제 installer 해시와 일치한다.
7. E2E 실측 (실제 GitHub Release 2개 필요):

| 항목 | 확인 내용                                                                    |
| ---- | ---------------------------------------------------------------------------- |
| (a)  | 이전 버전 설치판을 설치해 실행하면 새 버전을 감지한다                        |
| (b)  | 설정의 Updates에서 다운로드가 진행률과 함께 끝나고 `ready`가 된다            |
| (c)  | Restart and update로 실제 버전이 올라간다                                    |
| (d)  | 진행 중 파일 작업이 있으면 재시작 전에 확인을 받는다                         |
| (e)  | 포터블 실행 파일에서는 `unsupported`로 표시되고 명령이 아무 일도 하지 않는다 |
