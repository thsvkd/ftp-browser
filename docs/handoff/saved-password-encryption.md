# 핸드오프: 저장된 FTP 비밀번호 암호화 (safeStorage)

R1은 사용자가 정한 목표(아래 인용)와 코드·Electron 실측을 근거로 오케스트레이터가 결정했다.
이 문서와 공유 타입 계약(`src/shared/types/ftp.ts`의 `FtpServer`·`FtpServerInput`·`FtpConnectPayload`·`PasswordProtection`,
`src/shared/types/ipc.ts`의 `ErrorCode.SAVED_PASSWORD_UNREADABLE`)이 구현의 유일한 입력이다. 이 문서에 없는 케이스는 범위 밖이다.

> Saved FTP server passwords in FTP Browser are stored in plaintext. Encrypt them at rest with Electron `safeStorage`,
> migrate existing rows without losing any password, and minimise where the plaintext travels.

작업 유형(R0): **보안 결함 수정 + 마이그레이션**. 아래 테스트를 먼저 RED로 세운 뒤 GREEN으로 만든다.

---

## 1. 문제 정의

- `src/main/db/servers.ts`의 `saveServer`와 `recordConnection`이 `server.password`를 `password_enc` 컬럼에 **그대로** 쓴다.
  이름과 달리 암호화는 없다. `toServer`가 그 값을 돌려준다.
- 렌더러는 `ftp:getRecentServers`(그리고 쓰이지 않는 `ftp:getLastServer`)로 **모든 저장 서버의 평문 비밀번호**를 받는다.
  쓰는 곳은 네 군데다: 툴바 초안 채우기(`toDraft`), 주소 입력 시 같은 서버의 비밀번호 이어받기(`useServerStore.setAddress`),
  연결 시 main으로 다시 보내기(`useServerStore.connect`), 서버 편집기 표시(`ServerForm`의 보기 버튼으로 평문 노출 가능).
- main 쪽 평문 사용처: `ftp:connect` 핸들러, 에이전트 `session.connect`(`src/main/agent/services/session.ts`), 그리고
  `FtpConnectionManager`가 보조 연결용으로 메모리에 들고 있는 설정.
- 실측(이 컨테이너, Electron 43, Xvfb, 키링 없음): `safeStorage.getSelectedStorageBackend()`는 `basic_text`,
  `isAsyncEncryptionAvailable()`은 `true`, `encryptStringAsync`는 `v10` 접두사의 19바이트 버퍼, 왕복 복호화 성공,
  임의 바이트 복호화는 예외(`Error while decrypting the ciphertext …`). 동기 API(`isEncryptionAvailable` 등)는 같은 환경에서
  `false`였고, 공식 문서에 따르면 **Electron 46에서 제거**된다.

---

## 2. 핵심 결정

| #   | 결정                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 근거                                                                                                                                            |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | **새 컬럼 `servers.password_cipher BLOB`**에 `safeStorage.encryptStringAsync` 결과를 저장한다. 기존 `password_enc`(TEXT)는 **레거시 평문 전용**으로 남긴다. 한 행에서 둘 중 하나만 값을 가진다. 마이그레이션은 `003_server_password_cipher.sql` + `database.ts`의 인라인 폴백 SQL 둘 다에 넣는다(빌드에는 인라인만 실린다)                                                                                                                                                        | 접두사로 암호문·평문을 구분하면 `v10…`으로 시작하는 평문 비밀번호와 섞인다. 컬럼 분리가 모호하지 않다. 사용자 데이터는 지우지 않는다(AGENTS.md) |
| E2  | **비동기 API만** 쓴다(`isAsyncEncryptionAvailable`/`encryptStringAsync`/`decryptStringAsync`). `safeStorage`는 주입 가능한 작은 인터페이스 뒤에 두고, 모든 암·복호화는 main의 한 모듈(`src/main/db/passwordVault.ts`)만 한다                                                                                                                                                                                                                                                      | 동기 API는 Electron 46에서 제거된다. 테스트에서 가짜 암호기를 넣는다                                                                            |
| E3  | `servers.ts`는 동기 DB 계층으로 남는다. 비밀번호 쓰기는 `PasswordWrite` 값으로 받는다: `keep`(그대로), `clear`(지움), `cipher`(암호문 저장, 레거시 평문 비움), `plain`(암호화를 쓸 수 없을 때만, 평문 저장). 암호화는 트랜잭션 **밖에서** 먼저 끝낸다                                                                                                                                                                                                                             | better-sqlite3 트랜잭션 안에서는 await할 수 없다                                                                                                |
| E4  | **시작 시 마이그레이션**: DB 초기화 뒤 백그라운드로, `password_enc`가 비어 있지 않고 `password_cipher`가 NULL인 행을 하나씩 암호화한다. 쓰기는 비교 후 교체(`UPDATE … SET password_cipher = ?, password_enc = NULL WHERE id = ? AND password_enc = ? AND password_cipher IS NULL`)라 그 사이 바뀐 행을 덮지 않는다. 두 번 돌려도 바뀌는 것이 없다(멱등)                                                                                                                           | 사용자 요구: 한 번, 멱등, 비밀번호를 잃지 않음                                                                                                  |
| E5  | **실패해도 지우지 않는다**: 암호화 실패 → 평문을 그대로 두고 로그(비밀번호 값은 절대 로그에 남기지 않음)한 뒤 다음 행으로. 복호화 실패 → 암호문을 그대로 두고 `ErrorCode.SAVED_PASSWORD_UNREADABLE`로 알린다. `shouldReEncrypt`가 참이면 다시 암호화해 같은 비교 후 교체로 갱신한다(실패는 무시하고 로그)                                                                                                                                                                         | 사용자 요구. 키가 바뀌거나 DB를 다른 PC로 옮긴 경우 사용자가 다시 입력하면 된다                                                                 |
| E6  | **보호 수준** `PasswordProtection.level`: 비동기 암호화를 쓸 수 있고 Linux 백엔드가 `basic_text`가 아니면 `keyring`, `basic_text`면 `basic`(그래도 암호화한다), 쓸 수 없으면 `none`(평문 저장, 지금과 같음). 새 IPC `ftp:getPasswordProtection` → `IpcResult<PasswordProtection>`                                                                                                                                                                                                 | 문서: `basic_text`는 하드코딩 키라 보호가 아니다. 보호된 척하지 않고 알린다. 그래도 암호화하면 파일을 열거나 grep해도 비밀번호가 보이지 않는다  |
| E7  | **렌더러는 평문 비밀번호를 받지 않는다.** `FtpServer.password`를 없애고 `hasPassword: boolean`을 둔다. `ftp:getRecentServers`·`ftp:getLastServer` 응답 어디에도 비밀번호 값이 없다                                                                                                                                                                                                                                                                                                | 사용자 요구: 평문이 다니는 곳을 줄인다                                                                                                          |
| E8  | **연결**: 렌더러는 저장된 비밀번호를 쓸 때 `password`를 빼고 `savedPasswordOf: <서버 id>`를 보낸다. main이 그 서버의 비밀번호를 읽어(`passwordVault.reveal`) 로그인한다. 저장 비밀번호가 비어 있으면 지금처럼 `'anonymous@'`. 연결에 성공하면 `id` 갱신 시 **저장된 비밀번호를 그대로 둔다**(`keep`). 직접 입력한 비밀번호로 연결하면 그것을 암호화해 저장한다(지금 `recordConnection` 규칙과 같음)                                                                               | `id`(그 서버의 계정을 갱신)와 "누구의 저장 비밀번호를 쓸지"를 분리해야 지금의 계정 규칙(`sameAccount`)을 그대로 지킨다                          |
| E9  | **저장**: `ftp:saveServer`는 `FtpServerInput`을 받는다. `password`가 `undefined`면 유지, `''`면 삭제, 값이면 교체                                                                                                                                                                                                                                                                                                                                                                 | 편집기에서 빈 칸이 "그대로 둠"이 되므로 삭제는 명시적으로만 한다                                                                                |
| E10 | **편집기·툴바 표시**: 초안(`ServerDraft`)에 `savedPassword: boolean`을 더한다. 저장된 비밀번호를 쓰는 중이고 새로 입력하지 않았으면 비밀번호 칸은 **비어 있고** 자리표시 문구 "저장된 비밀번호"를 보인다. 입력하면 그 값이 저장 비밀번호를 대신한다. 서버 편집기에는 "저장된 비밀번호 지우기" 버튼을 두어 `savedPassword: false`로 만든다. 보기 버튼은 입력한 값만 보인다                                                                                                         | 렌더러가 저장 비밀번호를 모르면 보여 줄 수도 없다. 지우기 수단이 없으면 지금 가능한 "칸을 비우고 저장"이 사라진다                               |
| E11 | **경고 표시**: 보호 수준이 `basic`이나 `none`이면 서버 관리자 대화상자의 비밀번호 칸 근처에 경고 한 줄을 보인다(`keyring`이면 아무것도 보이지 않음). 11개 로케일                                                                                                                                                                                                                                                                                                                  | 비밀번호를 입력하는 곳에서 알려야 의미가 있다                                                                                                   |
| E12 | **복호화 실패 UX**: 연결이 `SAVED_PASSWORD_UNREADABLE`로 실패하면 툴바에 "저장된 비밀번호를 이 컴퓨터에서 읽을 수 없습니다. 다시 입력해 주세요." 같은 현지화된 오류를 보인다. 암호문은 지우지 않는다(사용자가 새로 입력해 연결하거나 저장하면 교체된다)                                                                                                                                                                                                                           | E5                                                                                                                                              |
| E13 | **에이전트**: `session.connect`도 `passwordVault.reveal`로 비밀번호를 얻고 기록은 `keep`으로 한다. 에이전트 도구 결과에는 지금처럼 비밀번호가 없다(1단계 M11)                                                                                                                                                                                                                                                                                                                     | 사용자 요구                                                                                                                                     |
| E14 | **디스크 잔여 평문 제거**: 앞으로의 삭제·변경은 `PRAGMA secure_delete = FAST`로 옛 바이트를 지우고, 마이그레이션이 행을 바꾸면 WAL을 체크포인트해 비운다. 업그레이드 **전에** 지우거나 바꾼 비밀번호는 행이 없어 마이그레이션 대상이 아니지만 빈 페이지에 평문으로 남으므로(실측: 300개 삭제 뒤 51개 검출), 평문 행을 모두 옮긴 첫 실행에서 **한 번만** `VACUUM`으로 파일을 다시 쓰고 `settings.passwordsScrubbed = '1'`을 남긴다. 실패한 행이 있으면 다음 시작에서 다시 시도한다 | 암호화해도 예전 평문이 파일에 남으면 "저장 시 암호화"가 아니다. VACUUM은 비용이 있으니 한 번만                                                  |

---

## 3. 기각한 대안

- **편집기에서 저장된 비밀번호를 보여 주는 보기 버튼 유지** — 렌더러로 평문을 보내야 한다. 비밀번호 관리자처럼 OS 인증을 거쳐 보여 주는 기능은 범위 밖. 기각(E7·E10).
- **기존 `password_enc`에 접두사(`enc:`)로 암호문 저장** — 같은 접두사로 시작하는 평문 비밀번호와 구분할 수 없다. 기각(E1).
- **레거시 컬럼 삭제** — SQLite 컬럼 삭제는 테이블 재작성이 필요하고, 마이그레이션은 추가만 한다는 저장소 규칙에 어긋난다. 비우기만 한다. 기각.
- **동기 API** — Electron 46에서 제거된다. 기각(E2).
- **`basic_text`이면 암호화하지 않고 평문 유지** — 경고는 같지만, 암호화하면 DB 파일을 열거나 검색해도 비밀번호가 바로 보이지 않는다. 기각(E6).
- **복호화 실패 시 자동으로 비밀번호 입력 대화상자 열기** — 새 UI 흐름이 필요하다. 오류 문구와 기존 비밀번호 칸으로 충분하다. 기각(E12).
- **마스터 비밀번호** — 사용자가 요구하지 않았고 UX 부담이 크다. 범위 밖.

---

## 4. 테스트 케이스

`Test-701`부터. 각 테스트에 `covers: Test-N`. 1:1.

### 4.1 Main (Test-701 … Test-719)

- **Test-701** — `saveServer`에 `cipher` 쓰기를 주면 `password_cipher`에 그 바이트가, `password_enc`는 NULL이고, 돌려준 `FtpServer`는 `hasPassword: true`이며 비밀번호 필드가 없다.
- **Test-702** — `saveServer`의 `keep`은 기존 암호문(또는 레거시 평문)을 그대로 두고, `clear`는 두 컬럼을 모두 비워 `hasPassword: false`.
- **Test-703** — `recordConnection`이 `id` 갱신에서 `keep`이면 저장 비밀번호를 그대로 두고, `cipher`면 교체한다. 익명 기본값(`anonymous`/`anonymous@`)은 지금처럼 저장하지 않는다.
- **Test-704** — 마이그레이션이 평문 행을 모두 암호화하고(`password_enc` NULL, `password_cipher` 채움), 두 번째 실행은 아무것도 바꾸지 않는다(멱등).
- **Test-705** — 마이그레이션 중 한 행의 암호화가 실패하면 그 행의 평문은 그대로 남고, 나머지 행은 암호화되며, 로그에 비밀번호 값이 없다.
- **Test-706** — 마이그레이션이 읽은 뒤 쓰기 전에 행이 바뀌면(사용자가 새 비밀번호 저장) 그 행을 덮지 않는다(비교 후 교체).
- **Test-707** — `reveal(id)`가 암호문을 복호화해 돌려주고, 레거시 평문 행은 평문을, 비밀번호 없는 행은 `''`를 돌려준다.
- **Test-708** — 복호화가 실패하면 `reveal`이 `SAVED_PASSWORD_UNREADABLE` 코드의 오류를 던지고 암호문은 그대로다.
- **Test-709** — 복호화 결과가 `shouldReEncrypt: true`면 다시 암호화해 저장한다.
- **Test-710** — 암호화를 쓸 수 없으면(`isAsyncEncryptionAvailable` false) 쓰기는 `plain`, 마이그레이션은 아무것도 하지 않고, 보호 수준은 `none`.
- **Test-711** — Linux 백엔드가 `basic_text`면 보호 수준은 `basic`이고 그래도 암호화한다. 그 밖의 백엔드와 macOS·Windows는 `keyring`.
- **Test-712** — `ftp:getRecentServers`·`ftp:getLastServer` 응답 JSON 어디에도 저장된 비밀번호 문자열이 없다.
- **Test-713** — `ftp:connect`가 `savedPasswordOf`면 복호화한 비밀번호로 `manager.connect`를 부르고, 성공 기록은 `keep`이다. 입력한 비밀번호면 그것으로 연결하고 암호화해 저장한다.
- **Test-714** — `ftp:connect`의 `savedPasswordOf` 복호화가 실패하면 연결을 시도하지 않고 `{ success: false, code: SAVED_PASSWORD_UNREADABLE }`.
- **Test-715** — `ftp:saveServer`가 `password` `undefined`·`''`·값을 각각 유지·삭제·교체로 처리한다.
- **Test-716** — `ftp:getPasswordProtection`이 보호 수준을 `IpcResult`로 돌려준다.
- **Test-717** — 저장과 마이그레이션 뒤 **디스크의 SQLite 파일 바이트**(WAL 포함, 체크포인트 후)에 비밀번호 평문이 없다.
- **Test-718** — 에이전트 `session.connect`가 복호화한 비밀번호로 로그인하고 저장 비밀번호를 바꾸지 않으며, `list_servers` 결과에 비밀번호가 없다.
- **Test-719** — 업그레이드 전에 지운 서버의 평문 비밀번호가 빈 페이지(freelist)에 남아 있어도, 첫 마이그레이션 뒤 DB 파일·WAL 어디에도 없다. 파일 재작성(VACUUM)은 한 번만 한다(`settings.passwordsScrubbed`).

### 4.2 Renderer (Test-720 … Test-739)

- **Test-720** — `toDraft`가 비밀번호를 `''`로, `savedPassword`를 `hasPassword`로 채우고, `sameFields`는 새로 입력하지 않은 저장 비밀번호를 "바뀌지 않음"으로 본다.
- **Test-721** — `setAddress`가 같은 서버·같은 계정이면 `savedPassword`를 이어받고, 다른 사용자를 적거나 주소에 비밀번호를 적으면 이어받지 않는다(지금 규칙).
- **Test-722** — 저장된 비밀번호를 쓰는 연결은 `password` 없이 `savedPasswordOf: <id>`를 보내고, 입력한 비밀번호가 있으면 그것을 보내며 `savedPasswordOf`는 없다.
- **Test-723** — 저장은 `password`를 입력값·`undefined`(유지)·`''`(지우기 버튼)로 보낸다.
- **Test-724** — 툴바와 편집기의 비밀번호 칸은 저장된 비밀번호를 쓰는 동안 값이 비어 있고 "저장된 비밀번호" 자리표시를 보인다. 입력하면 그 값이 쓰인다.
- **Test-725** — 편집기의 "저장된 비밀번호 지우기" 버튼이 `savedPassword`를 끄고, 저장하면 `password: ''`가 간다.
- **Test-726** — 연결이 `SAVED_PASSWORD_UNREADABLE`로 실패하면 현지화된 재입력 안내가 보인다.
- **Test-727** — 보호 수준이 `basic`·`none`이면 서버 관리자에 경고가 보이고 `keyring`이면 없다.
- **Test-728** — `ftp:getPasswordProtection`이 preload 허용 목록에 있다(`src/preload/index.test.ts`).
- **Test-729** — 툴바의 저장된 서버를 지우면 초안은 `savedPassword: false`가 되고 툴바 비밀번호 칸에 "저장된 비밀번호" 자리표시가 없다(저장 안 된 새 서버는 저장된 비밀번호를 쓰지 않는다).
- 접근성: 새 버튼은 이름을 갖는다(Test-261 유지).

---

## 5. 관련 코드 포인터

| 파일                                                                                       | 역할                                                                      |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| [`main/db/servers.ts`](../../src/main/db/servers.ts)                                       | `saveServer`·`recordConnection`·`toServer`·`listServers`·`getServerById`  |
| [`main/db/database.ts`](../../src/main/db/database.ts)                                     | 추가형 마이그레이션 패턴(002 `max_transfers`와 같은 방식)                 |
| [`main/ipc/ftpHandlers.ts`](../../src/main/ipc/ftpHandlers.ts)                             | `ftp:connect`·`ftp:saveServer`·`ftp:getRecentServers`·`ftp:getLastServer` |
| [`main/agent/services/session.ts`](../../src/main/agent/services/session.ts)               | 에이전트 연결(E13)                                                        |
| [`renderer/.../stores/useServerStore.ts`](../../src/renderer/src/stores/useServerStore.ts) | `setAddress`·`connect`·`save`                                             |
| [`renderer/.../lib/serverAddress.ts`](../../src/renderer/src/lib/serverAddress.ts)         | `ServerDraft`·`toDraft`·`sameFields`·`resolveDraft`                       |
| [`renderer/.../components/server/*`](../../src/renderer/src/components/server/)            | `ServerForm`(`PasswordInput`)·`ConnectBar`·`ServerManagerDialog`          |

### 주의점

1. 비밀번호 값(평문·암호문 모두)을 로그·오류 메시지·토스트에 넣지 않는다.
2. `FtpConnectionManager`가 보조 연결을 위해 메모리에 평문을 들고 있는 것은 그대로 둔다(main 프로세스 안).
3. preload 허용 목록 누락은 RTL 테스트가 잡지 못한다. 실제 앱에서 확인한다.
4. `releaseArtifacts.test.ts`·`runtimeStack.test.ts` 계약은 바꾸지 않는다.

---

## 6. 완료 기준

- `npm test`, `npm run typecheck`, `npm run lint` 통과, 변경 파일 `prettier --check` 통과.
- 실제 앱(E2E): 평문 비밀번호가 든 기존 `cache.db`로 시작하면 마이그레이션 뒤 DB 파일에 평문이 없고, 저장된 서버로 연결된다.
  렌더러가 받는 IPC 응답에 비밀번호가 없다. 이 컨테이너(`basic_text`)에서 경고가 보인다.

---

## 7. 근거 출처

- Electron `safeStorage`(비동기 API, `basic_text`, Electron 46 동기 API 제거): https://raw.githubusercontent.com/electron/electron/main/docs/api/safe-storage.md
- Electron 43 타입 정의 `node_modules/electron/electron.d.ts`의 `SafeStorage`·`DecryptStringAsyncReturnValue`

---

## 8. 리뷰·E2E 후속 결정

65cf8b5를 실제 앱으로 돌린 E2E와 적대적 보안 리뷰의 결과로 오케스트레이터가 정했다. 테스트 번호는 **Test-730 … Test-749**
(4.2가 예약했지만 쓰지 않은 730–739를 포함한다).

| #   | 결정                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 근거                                                                                                                                                                                                                             |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E15 | **저장된 비밀번호는 저장한 주소에 묶인다(차단).** `ftp:connect`에 `savedPasswordOf`가 있으면 그 행을 읽어, 행이 있고 호스트가 같고(앞뒤 공백·대소문자 무시) 포트가 같고 사용자가 같고(`''`와 대소문자 무관 `anonymous`는 같은 익명) `id`가 없거나 `savedPasswordOf`와 같을 때만 쓴다. 아니면 복호화·연결 시도·DB 쓰기 없이 `{ success: false, error: 'The saved password can only be used for the server it was saved for. Enter the password.' }`(새 코드 없음, GUI는 이런 요청을 보내지 않는다). 에이전트 `session.connect`는 주소를 받지 않고 저장된 행 그대로 연결하므로 이미 묶여 있고, Test-733이 그것을 지킨다                                                                                                                                                                                                         | E2E: `savedPasswordOf: 1`을 같은 호스트의 다른 포트로 보내자 서버 1의 비밀번호가 다른 서버로 가고 새 행에 저장됐다. `id: A, savedPasswordOf: B`는 A의 비밀번호를 B의 것으로 덮었고, 지운 id는 `'anonymous@'`로 로그인해 저장됐다 |
| E16 | **주소를 옮기면 비밀번호는 따라가지 않는다.** `ftp:saveServer`가 `password: undefined`(유지)로 저장된 비밀번호가 있는 서버의 호스트(대소문자 무시)나 포트를 바꾸면 새 `ErrorCode.SAVED_PASSWORD_ADDRESS_CHANGED`로 거절하고 아무것도 쓰지 않는다(비밀번호가 없는 서버는 유지가 곧 없음이라 그대로 옮긴다). 서버 관리자는 초안의 호스트·포트가 저장된 행과 다르고 저장된 비밀번호를 쓰는 중이며 새로 입력하지 않았으면 비밀번호 칸 아래에 `servers.passwordAddressChanged`("Enter the password again for the new address, or remove it.", 11개 로케일)를 보이고, 입력하거나 지우기 전에는 저장(연결 전 저장 포함)을 부르지 않는다. main의 오류 코드도 같은 문장으로 바꾼다. 별칭·사용자·FTPS·동시 전송 수만 바꾸면 지금처럼 유지한다. 툴바는 사용자 이름이 바뀌면 저장된 비밀번호를 이어받지 않는 규칙(Test-721)을 그대로 둔다 | E15와 같은 이유. 편집기에서 주소를 바꾸고 저장하면 저장된 비밀번호가 새 주소로 갔다                                                                                                                                              |
| E17 | **암호화를 쓸 수 있을 때만 파일을 다시 쓴다.** VACUUM과 `passwordsScrubbed`는 `isAsyncEncryptionAvailable()`도 참이어야 한다(새로 설치한 앱은 첫 실행에서 키 저장소에 한 번 묻는다). 행을 바꾼 마이그레이션 뒤의 WAL 체크포인트는 `finally`에서 하므로 VACUUM이 실패해도 한다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 리뷰 실측: 암호화를 못 쓰는 동안 플래그가 선 뒤 평문으로 저장·삭제한 비밀번호가 나중 마이그레이션 뒤에도 300개 중 136개 남았다(`secure_delete = FAST`는 빈 페이지를 지우지 않는다)                                               |
| E18 | **받침 네 줄을 테스트로 고정한다**: `database.ts`의 `secure_delete = FAST`, 마이그레이션 뒤 체크포인트, `replaceCipher`의 비교 후 교체, `recordConnection` INSERT 분기의 `writePassword`. 각 줄을 지우면 해당 테스트(Test-737·738·739·740)가 실패하는 것을 확인했다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 지워도 모든 테스트가 통과하던 줄이다                                                                                                                                                                                             |
| E19 | **보호 수준은 보수적으로**(E6 대체): Linux 백엔드 `basic_text`·`unknown`은 `basic`, `gnome_libsecret`·`kwallet*`과 그 밖의 이름 있는 백엔드는 `keyring`, macOS·Windows(백엔드 함수 없음)는 비동기 암호화를 쓸 수 있으면 `keyring`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 모르는 것을 보호된다고 말하지 않는다                                                                                                                                                                                             |
| E20 | **툴바 자리표시는 칸에 맞춘다.** 툴바 비밀번호 칸(`w-[118px]`)에서만, 저장된 비밀번호를 쓰는 동안 자리표시를 언어와 상관없는 `••••••••`로 두고 현지화된 "저장된 비밀번호"는 칸의 접근 가능한 이름(`aria-label`)과 툴팁(`title`)으로 둔다. 편집기는 전체 자리표시를 그대로 둔다. Test-724·726의 툴바 확인은 자리표시에서 이름·툴팁으로 바뀐다. Test-261 유지                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | "Saved password"가 잘리고 de("Gespeichertes Passwort")는 더 잘린다                                                                                                                                                               |

**남은 위험(E15):** FTPS 여부(`secure`)는 묶지 않는다. 사용자가 일부러 FTPS를 끌 수 있어야 하기 때문이다(FTPS를 끈 연결도 받는 것을 Test-732가 고정한다).
그래서 렌더러가 손상되면 저장된 주소로 `secure: false`를 보내 저장된 비밀번호를 **같은 서버에** 평문 FTP로 보내게 할 수 있고, 그 경로를 엿보는
네트워크 공격자가 볼 수 있다. 비밀번호가 다른 서버로 가지는 않는다.

### 8.1 테스트 케이스

- **Test-730** — `ftp:connect`가 다른 호스트·포트·사용자(익명 포함)에 대한 `savedPasswordOf`를 거절한다. 복호화·연결 시도가 없고 DB는 그대로다.
- **Test-731** — `id`가 `savedPasswordOf`와 다르거나 `savedPasswordOf`의 서버가 지워졌으면 거절한다. 연결이 없고 DB는 그대로다(덮어쓰기·새 행 없음).
- **Test-732** — 저장된 주소면 받는다: 호스트 대소문자·앞뒤 공백, `id` 없음, `''`와 `ANONYMOUS`, FTPS를 끈 연결. 저장된 비밀번호로 로그인하고 비밀번호는 바뀌지 않는다.
- **Test-733** — 에이전트 `session.connect`는 저장된 비밀번호를 그 행의 호스트·포트·사용자로만 보낸다(같은 호스트의 다른 포트, 대소문자만 다른 호스트).
- **Test-734** — `ftp:saveServer`가 비밀번호를 유지한 채 호스트·포트를 옮기면 `SAVED_PASSWORD_ADDRESS_CHANGED`로 거절하고 아무것도 쓰지 않는다. 호스트 대소문자·별칭·사용자·FTPS·동시 전송 수만 바꾸면 유지하고, 새 비밀번호나 `''`이면 옮기며, 비밀번호 없는 서버는 유지로도 옮긴다.
- **Test-735** — 암호화를 쓸 수 없으면 옮길 행이 없어도 VACUUM하지 않고 `passwordsScrubbed`를 남기지 않는다. 그동안 평문으로 저장·삭제한 비밀번호(빈 페이지 포함)는 암호화를 쓸 수 있게 된 첫 마이그레이션이 파일을 한 번 다시 써서 없앤다.
- **Test-736** — VACUUM이 실패해도 행을 바꾼 마이그레이션 뒤 `-wal`에 평문이 없고, 플래그를 남기지 않아 다음 시작에서 다시 시도한다.
- **Test-737** — 이미 `passwordsScrubbed`인 DB에서(VACUUM 없음) 마이그레이션이 바꾼 행의 옛 평문이 DB 파일에 남지 않는다(`secure_delete = FAST`).
- **Test-738** — 같은 상황에서 마이그레이션 직후 `-wal`에 평문이 없다(마이그레이션의 체크포인트).
- **Test-739** — 재암호화하는 사이 사용자가 저장하거나 지운 비밀번호를 재암호화가 덮지 않는다(`replaceCipher`의 비교 후 교체).
- **Test-740** — 새 호스트에 비밀번호를 입력해 빠른 연결하면 그 암호문이 저장된다(`recordConnection` INSERT 분기).
- **Test-741** — 보호 수준: `basic_text`·`unknown` → `basic`, 이름 있는 백엔드 → `keyring`, macOS·Windows → 쓸 수 있으면 `keyring`·없으면 `none`.
- **Test-742** — 서버 관리자에서 저장된 비밀번호를 쓰는 서버의 호스트나 포트를 바꾸면 비밀번호 칸 아래에 안내가 보이고 저장·연결을 부르지 않는다. 입력하면 그 비밀번호로, 지우면 `''`로 저장한다. 별칭·사용자·FTPS·호스트 대소문자만 바꾸면 안내가 없다.
- **Test-743** — main이 `SAVED_PASSWORD_ADDRESS_CHANGED`로 거절하면 main의 문장이 아니라 현지화된 안내를 보인다.
- **Test-744** — 툴바 비밀번호 칸은 저장된 비밀번호를 쓰는 동안 자리표시가 `••••••••`이고 이름·툴팁이 현지화된 "저장된 비밀번호"다(de 포함). 편집기는 전체 자리표시를 보인다. 저장된 비밀번호가 없으면 자리표시가 "Password"이고 툴팁이 없다.
- **Test-745** — 저장된 서버의 `id`와 함께 **다른 주소**로 입력한 비밀번호로 연결해도 그 서버의 계정·비밀번호는 바뀌지 않고, 접속한 주소는 그 주소의 서버로 따로 기록된다(E15를 갱신 대상에도 적용).
- Test-746 … Test-749는 예약만 한다.

### 8.2 완료 기준

- 6장의 명령이 모두 통과한다.
- 실제 앱(E2E): 이전 시나리오가 모두 통과한다. 다른 포트로 보낸 `savedPasswordOf` invoke가 거절되고 그 서버에는 로그인 시도가 없다.
  서버 관리자에서 저장된 서버의 호스트를 비밀번호 없이 바꾸면 안내가 보이고 저장되지 않는다.
