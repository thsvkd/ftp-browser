# 핸드오프: 에이전트 접근 (최소 구성)

이 문서가 `agent-friendly.md`(1단계)와 `agent-operations.md`(2단계)를 **대체**한다. 두 문서가 만든 구현은 23,640줄(실제 코드 9,071줄,
그중 에이전트 기능 약 7,900줄)로 핵심 목표에 비해 지나치게 컸다. 사용자가 R1에서 범위를 다시 정했다.

> 핵심 목표는 "AI 에이전트가 ftp-browser를 활용할 수 있게" 만드는 것이다. 정말로 필요한 기능만 남긴다.
>
> - 위험한 작업의 확인: **표시만 하고, 실행 전 허락은 에이전트 도구(Claude Code·Codex 등의 승인 기능)에 맡긴다.**
> - 접근 통로: **MCP + 얇은 CLI.**

작업 유형(R0): **축소 리팩터링**. 남는 기능은 동작을 바꾸지 않는다(버그 수정 제외). 지운 기능의 코드·테스트·번역·문서는 함께 지운다.

---

## 1. 남기는 것

| #   | 구성                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| K1  | **앱 내장 MCP 서버**(`McpService`): 설정에서 켜야 동작(기본 꺼짐), `127.0.0.1:47821/mcp` Streamable HTTP, Bearer 토큰, Host·Origin 검증, 켜고 끄기, 토큰 재발급. 지금 동작 그대로                                                                                                                                                                                                                                                                                          |
| K2  | **도구 12개**(아래 §2). 도구 정의는 한 파일에 두고, 위험도 하나로 어노테이션과 설명 첫 줄을 함께 만든다                                                                                                                                                                                                                                                                                                                                                                    |
| K3  | **위험도 표시만**: 설명 첫 줄 `[RISK: read-only]` / `[RISK: changes state, no data loss]` / `[RISK: uploads local files to the server]` / `[RISK: DESTRUCTIVE — permanently deletes; FTP has no trash]`와 MCP 어노테이션(`readOnlyHint`·`destructiveHint`·`idempotentHint`·`openWorldHint`). 앱은 묻지 않는다                                                                                                                                                              |
| K4  | **기본 안전장치**: 원격 경로는 정규형 절대경로만(빈·`.`·`..` 세그먼트, CR·LF·NUL 금지), 로컬 경로는 OS 절대경로만(`..`·제어문자 금지), 이름변경은 덮어쓰지 않음, **다운로드는 기존 로컬 파일을 절대 덮어쓰지 않음**(건너뜀 + 큐의 배타적 생성, 자기가 만든 파일만 지움), 호출당 경로 100개 상한, 저장된 비밀번호는 어떤 결과·오류에도 나가지 않음, 전송·파일 작업 중의 `connect`·`disconnect`는 `BUSY`                                                                     |
| K5  | **GUI 동기화 최소**: 에이전트가 연결·해제하면 GUI가 그 서버·폴더를 따라가고(`agent:session`), 원격 변경(`ftp:remoteChanged`)이 보이는 폴더면 새로 고친다. 전송·작업 패널은 원래 에이전트 작업을 보여 준다                                                                                                                                                                                                                                                                  |
| K6  | **얇은 `ftpb` CLI**: 발견 파일(`<userData>/agent/{endpoint.json,token}`, 0600) 또는 `FTPB_URL`/`FTPB_TOKEN`으로 앱을 찾고, `ftpb tools`(목록과 위험도), `ftpb <tool> --param value` / `--args '<json>'` / `--args -`(stdin JSON), `--help`. 출력은 항상 JSON. 미리보기 이미지는 임시 폴더에 파일로 저장하고 경로를 출력. 종료 코드 0 성공·1 도구 오류·2 사용법·4 앱 사용 불가. 죽은 pid의 발견 파일에는 토큰을 보내지 않는다. 빌드는 `out/cli/ftpb.cjs` 단일 파일(asar 밖) |
| K7  | **설정 화면**: 1단계 "Agent access (MCP)" 섹션(토글, 엔드포인트, Claude Code 등록 명령 복사, 토큰 재발급)에 **CLI 실행 명령 복사** 한 줄을 더한다(설치기 없이, 실행 파일·`ftpb.cjs` 절대경로로 만든 명령)                                                                                                                                                                                                                                                                  |
| K8  | 함께 들어간 다른 작업은 그대로 둔다: 썸네일 뷰포트 우선순위, 업로드 진행률, 저장 비밀번호 암호화, GUI 접근성, `AGENTS.md`                                                                                                                                                                                                                                                                                                                                                  |

## 2. 도구 12개

| 도구                 | 위험도              | 동작                                                                                                                |
| -------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `get_status`         | read-only           | 연결 상태(host·port·user·serverId), 진행 중인 전송·파일 작업 수                                                     |
| `list_servers`       | read-only           | 저장된 서버(id·이름·host·port·user·secure). 비밀번호 필드 없음                                                      |
| `list_directory`     | read-only           | 원격 폴더 목록, `kind`·`nameContains`·`modifiedFrom/To` 필터, 페이지(cursor)                                        |
| `get_image_previews` | read-only           | 원격 이미지 썸네일(JPEG, 최대 360px) 1–8개, 부분 실패 허용                                                          |
| `wait_for_jobs`      | read-only           | 전송·작업 id(또는 다운로드·업로드가 돌려준 batch id)를 최대 45초 기다려 상태를 돌려줌                               |
| `connect`            | changes state       | **저장된 서버만**(id·별칭·host). 저장 비밀번호는 main이 읽는다. 마지막 폴더(없으면 `/`)를 연다                      |
| `disconnect`         | changes state       | 연결 해제                                                                                                           |
| `create_directory`   | changes state       | 원격 폴더 생성(부모 포함)                                                                                           |
| `rename`             | changes state       | 원격 이름변경·이동. 대상이 있으면 `TARGET_EXISTS`                                                                   |
| `download`           | changes state       | 원격 파일·폴더(재귀) → 로컬 폴더(없으면 생성). 이름은 `toLocalFileName`으로 정리, 기존 파일은 건너뜀. batch id 반환 |
| `upload`             | uploads local files | 로컬 파일·폴더(재귀) → 원격 폴더. `overwrite`(기본 false)가 아니면 원격에 있는 파일은 건너뜀. batch id 반환         |
| `delete`             | DESTRUCTIVE         | 원격 파일·폴더(재귀) 삭제. 파일 작업 패널에 보이고, 최대 45초 기다린 뒤 결과 또는 작업 id                           |

모든 도구 설명은 원격 이름·내용이 신뢰할 수 없는 데이터라고 밝힌다. 오류는 `CODE: 메시지 + 다음 행동`의 `isError` 결과다.

## 3. 지우는 것

- **앱 안 확인 장치 일체**: 확인 브로커·대화상자·스토어, 정책 엔진(allow/ask/deny)과 설정 UI, `dryRun`, 행동 잠금, 세션 고정, 승인 후 재계획(`PLAN_CHANGED`·`SESSION_CHANGED`), 에이전트 로컬 폴더 규칙, 활동 토스트, `_meta` 정책 키
- **도구 10개**: 로컬 파일 도구 4개(`list_local_directory`·`create_local_directory`·`rename_local`·`delete_local` — 에이전트는 로컬 파일을 직접 다룬다), `read_text_file`, `list_jobs`(→ `get_status`·`wait_for_jobs`), `cancel_jobs`·`clear_finished_jobs`(사용자가 GUI에서 한다), `open_server_editor`·`delete_server`
- **CLI 부가 기능**: stdio 브리지(`mcp-stdio`), 16개 클라이언트 설정 생성기(`agentClients.ts`, `ftpb setup`), Agent Skill 템플릿·설치, 명령줄 도구 설치기(PATH 등록·셔임), `ftpb auth`, 사람용(TTY) 출력, 계약 파일 계층(`AgentServices` 인터페이스 — 도구가 앱 서비스를 직접 부른다)
- **문서**: `agent-friendly.md`, `agent-operations.md`(이 문서로 대체). `AGENTS.md`·README의 에이전트 절은 이 구성에 맞게 줄인다

## 4. 기각한 대안

- **앱이 삭제·업로드를 직접 확인** — 대화상자가 떠 있는 동안의 경쟁 조건을 막는 장치가 수백~천 줄 붙는다. 주요 에이전트 도구가 실행 전 승인을 이미 제공한다. 기각(사용자 결정).
- **CLI만 또는 MCP만** — MCP를 지원하는 에이전트는 바로 붙고, 셸만 쓰는 에이전트는 CLI가 필요하다. 둘 다 남기되 CLI는 같은 엔드포인트의 얇은 클라이언트로(사용자 결정).

## 5. 테스트

남는 기능의 테스트만 남긴다. 기존 테스트 중 남는 기능을 검증하는 것은 ID를 그대로 두고, 지운 기능의 테스트는 지운다. 남는 테스트 ID를 이 절에 한 줄씩 적는다.
필수로 남거나 새로 있어야 하는 검증: HTTP 경계(토큰 401, Host·Origin 403, 127.0.0.1 바인드, 포트 충돌, 켜고 끄기), `tools/list`가 정확히 12개이고 어노테이션·설명 첫 줄이 위험도와 일치,
비밀번호 비노출, 경로 검증, 다운로드 무덮어쓰기(배타적 생성 포함), 이름변경 무덮어쓰기, `connect`의 저장 서버 제한과 BUSY, `wait_for_jobs`, GUI 동기화(session·remoteChanged),
`ftpb`의 발견·인자 변환·stdin·종료 코드·이미지 저장·죽은 pid, 빌드 산출물 단독 실행, 설정 섹션(토글·명령 복사·토큰 비표시).

`agent-friendly.md`·`agent-operations.md`를 지우므로 그 문서에만 있던 남는 테스트의 정의를 여기로 옮긴다(문구는 지금 동작에 맞췄다).
새 테스트는 `Test-750`부터다.

**HTTP 경계와 설정 저장(`McpService.test.ts`, `mcpHandlers.test.ts`)**

- **Test-231** — `Authorization` 헤더가 없으면 401이고 도구가 실행되지 않는다.
- **Test-232** — 토큰이 틀리면 401.
- **Test-233** — `Host` 헤더가 localhost가 아니면 403.
- **Test-234** — `Origin`이 외부 출처면 403.
- **Test-235** — 올바른 토큰으로 SDK 클라이언트가 접속해 `tools/list`를 받으면 12개 도구가 있고, `[RISK: read-only]` 도구는 `readOnlyHint: true`·`destructiveHint: false`를 광고한다.
- **Test-236** — 서버는 `127.0.0.1`에만 바인드한다.
- **Test-237** — 포트가 이미 사용 중이면 시작이 예외로 앱을 멈추지 않고 상태의 `error`에 사유가 담긴다.
- **Test-238** — stop 후에는 접속이 거부되고, 켜고 끄기를 반복해도 누수 없이 다시 listen 된다.
- **Test-249** — `mcpEnabled`가 없으면 기본 꺼짐이고, 켜면 토큰이 생성·저장된다. 재시작(새 인스턴스) 후에도 같은 토큰을 쓴다.
- **Test-250** — 토큰 재발급 후 이전 토큰은 401, 새 토큰은 통과한다.
- **Test-251** — Claude Code 등록 명령 문자열이 URL·토큰을 정확히 담는다(순수 함수).
- **Test-293** — `mcp:getState`·`mcp:setEnabled`·`mcp:regenerateToken`이 실패를 reject 대신 `IpcResult` 실패 값으로 돌려준다.
- **Test-295** — Bearer 스킴은 대소문자를 가리지 않고 토큰만 `timingSafeEqual`로 비교한다.
- **Test-296** — 겹친 켜기는 진행 중인 listen 하나를 함께 쓰고, 같은 틱의 켜기→끄기 뒤에는 서버가 남지 않는다.
- **Test-465** — 발견 파일(`endpoint.json`·`token`)이 listen 시 0600으로 생기고, 토큰 재발급에 바뀌며, stop 시 사라진다.
- **Test-668** — (회귀) 포트 0으로 만든 `McpService`가 OS가 고른 포트를 `getState().url`·`command`에 보이고, 끄고 다시 켜도 그 포트로 연다.
- **Test-750** — CLI 실행 명령이 번들된 `ftpb.cjs`(asar 안이면 `app.asar.unpacked`)를 앱 실행 파일의 Node 모드로 돌린다: macOS·Linux는 `ELECTRON_RUN_AS_NODE=1 '<exe>' '<cli>'`, Windows는 PowerShell `$env:ELECTRON_RUN_AS_NODE=1; & '<exe>' '<cli>'`이고 경로의 작은따옴표를 셸에 맞게 이스케이프한다.
- **Test-751** — `mcp:*` 핸들러가 돌려주는 모든 상태에 `cliCommand`가 있다.

**도구(`mcpTools.test.ts`, `agentOps.test.ts`, `jobTracker.test.ts`, `thumbnailPreviews.test.ts`)**

- **Test-450** — `tools/list`가 정확히 §2의 12개 도구이고, 각 어노테이션(`readOnlyHint`·`destructiveHint`·`idempotentHint`·`openWorldHint`)이 위험도와 일치한다(표 기반). `_meta`는 없다.
- **Test-451** — 모든 설명 첫 줄이 위험도 문구(K3)와 정확히 같고, 모든 설명과 서버 instructions가 원격 이름·내용을 신뢰할 수 없는 데이터라고 밝힌다. instructions는 앱이 묻지 않고 실행한다고 알린다.
- **Test-239** — 미연결 상태에서 `list_directory`는 `NOT_CONNECTED` isError이고 `connect` 안내가 있으며 FTP에 닿지 않는다.
- **Test-240** — `get_status`는 연결 상태·저장 서버 id·host·port·user를 주고, 결과 어디에도 `password` 키나 비밀번호 값이 없다.
- **Test-469** — `get_status`가 전송과 파일 작업을 합쳐 상태별로 세고, 연결이 없으면 상태만 준다.
- **Test-241** — `list_directory`는 폴더 먼저·이름순으로 정렬하고, `limit`과 `nextCursor`로 끝까지 순회하면 모든 항목을 중복 없이 한 번씩 얻는다.
- **Test-242** — `kind: 'images'`와 `nameContains`가 필터로 동작하고 `total`은 필터 후 개수다.
- **Test-243** — 상대경로·빈 경로는 거절되고 isError에 절대경로 안내가 있다.
- **Test-244** — 다른 경로·조건에서 받은 cursor나 깨진 cursor는 거절되고 재시작 안내가 있다.
- **Test-245** — FTP 오류(예: 550)는 `classifyError`의 code를 담은 isError 결과가 되고, 예외가 프로토콜 에러로 새지 않는다.
- **Test-246** — `get_image_previews`는 성공 항목마다 `image/jpeg` 블록을 주고, 없는 파일·비이미지·목록을 읽지 못한 부모의 항목은 `ok: false`로 표시하되 호출 전체는 성공한다. 크기·수정시각은 부모 목록에서 얻어 미리보기 파이프라인에 넘긴다.
- **Test-248** — 원격 파일명에 개행·지시문이 섞여 있어도 결과 텍스트는 JSON으로 인코딩되어 원문 개행이 그대로 나오지 않는다.
- **Test-290** — 경로 입력의 CR·LF·NUL은 스키마에서 거절되고(안내에 "CR, LF or NUL") FTP 클라이언트·미리보기에 닿지 않는다.
- **Test-291** — `FtpConnectionManager.list`가 CR·LF·NUL이 든 경로를 클라이언트에 닿기 전에 거절한다(GUI 포함).
- **Test-292** — isError 문구에 섞인 서버 메시지의 제어문자는 공백으로 바뀐다.
- **Test-297** — 목록 실패가 `FTP_SERVER_ERROR`(pyftpdlib의 501)면 부모 폴더로 경로를 확인하라고 안내한다.
- **Test-689** — `modifiedFrom`·`modifiedTo`가 페이지를 나누기 전에 거른다: 날짜는 UTC 하루 전체, 시각은 Z·오프셋 포함, 양끝 포함, 시각 없는 항목은 뺀다. cursor는 조건을 담고, 없는 날짜·오프셋 없는 시각은 스키마 오류다.
- **Test-460** — `AgentError` 코드가 `CODE: 메시지 다음 행동` isError로 바뀐다(`BUSY` → `wait_for_jobs` 안내 등).
- **Test-461** — 저장된 비밀번호가 `tools/list`와 12개 도구의 어떤 결과·오류에도 나오지 않는다(연결에는 쓰인다).
- **Test-615** — 원격 경로를 받는 모든 도구 입력이 `//x`·`/a/`·`/./a`·`/a/..`·`/a//b`·`/..`를 "Use a normalized absolute path"로 거절하고 서버에 닿지 않는다.
- **Test-471** — 로컬 경로 입력의 상대경로·제어문자를 스키마에서 거절하고 디스크·FTP에 닿지 않는다.
- **Test-617** — 로컬 경로의 `..` 세그먼트(`/`·`\` 모두)를 스키마에서 거절한다.
- **Test-462** — `wait_for_jobs`의 `timeoutSec`이 45를 넘으면 기다리지 않고 스키마 오류다.
- **Test-400** — `list_servers` 결과는 id·name·host·port·user·secure뿐이고 비밀번호 키나 값이 없다.
- **Test-401** — `connect`가 저장 서버를 id·별칭·호스트·`host:port`(대소문자 무시)·숫자 문자열 id로 찾고, 없으면 `NOT_FOUND` 메시지에 저장된 서버들을 담는다.
- **Test-402** — `connect`가 `path` 없이 마지막 방문 폴더를 열고, 그 폴더가 없으면 `/`로 간다. `agent:session`이 serverId·host·port·user·path를 담고, `disconnect`는 `{ status: 'disconnected' }`를 보낸다.
- **Test-403** — 전송이나 파일 작업이 진행 중이면 `connect`가 `BUSY`이고 연결하지 않는다.
- **Test-618** — (회귀) 전송이나 파일 작업이 진행 중이면 `disconnect`가 `BUSY`이고 끊지 않으며, 끝나면 끊는다.
- **Test-718**, **Test-733** — 저장 비밀번호 연결(정의는 `saved-password-encryption.md`). 에이전트 `connect`도 풀어 쓴 비밀번호를 그 행의 주소·계정으로만 보낸다.
- **Test-404** — `rename`은 대상이 있으면 `TARGET_EXISTS`이고 서버에 RNFR을 보내지 않는다. 다른 폴더로의 이동은 된다.
- **Test-417** — `create_directory`는 MKD 뒤에 폴더가 없으면(서버가 조용히 거부) 실패하고, 같은 이름의 파일이 있으면 `TARGET_EXISTS`.
- **Test-405** — `delete`는 대상을 모두 확인한 뒤(하나라도 없으면 `NOT_FOUND`, 루트는 `INVALID_PATH`, 아무것도 지우지 않음) `OperationManager` 작업으로 폴더는 재귀로, 중복·하위 대상은 한 번만 지운다.
- **Test-468** — `delete`가 정해진 시간까지만 기다려, 안 끝났으면 operationId·진행 상태·`wait_for_jobs` 안내를, 실패면 `JOB_FAILED` isError(제어문자 제거)를 준다.
- **Test-406** — `download`가 원격 폴더를 재귀로 펼치고 로컬 폴더를 만들며, 이름은 `toLocalFileName`으로 고치고 쓸 수 없는 이름·심링크는 `skipped`다. 큐에는 `{ exclusive: true }`로 넣는다.
- **Test-407** — `download`는 기존 로컬 파일을 건너뛰고 같은 이름의 로컬 폴더에는 합쳐 받으며, 어떤 경우에도 기존 파일 경로를 큐에 넣지 않는다.
- **Test-408** — `upload`가 로컬 폴더를 펼쳐 사이 원격 폴더를 큐에 넘기고(GUI 업로드와 같다), 원격에 있는 파일은 `overwrite`가 아니면 건너뛰며 `overwrite`면 그 수를 `overwrites`로 센다. 없는 로컬 경로는 `NOT_FOUND`.
- **Test-470** — 여러 파일 전송은 큐의 묶음 id(`batchId`) 하나를 돌려주고, `wait_for_jobs`가 그것을 소속 전송의 요약(진행 바이트·끝난 수·실패)으로 기다린다.
- **Test-410** — `wait`가 모든 id가 끝나면 즉시, 아니면 타임아웃에 돌려준다. 전송 id와 작업 id를 함께 받고, 모르는 id는 `unknown`·`done: true`다.
- **Test-418** — 끝난 전송·작업이 큐나 작업 패널에서 빠진 뒤에도 `wait`가 마지막 상태를 돌려준다.
- **Test-464** — `get_image_previews`의 MCP 큐가 동시 호출에서도 보조 연결을 1개만 쓴다.
- **Test-474** — FTP 연결 상태가 바뀌면 MCP 미리보기 큐를 비우고, 기다리던 미리보기를 실패로 끝내며 보조 연결을 닫는다.

**GUI 동기화(`windowBridges.test.ts`, `useAgentSync.test.tsx`, `index.test.ts`)**

- **Test-412** — FTP `mutation`이 `ftp:remoteChanged`로 전달되고, 창이 파괴된 뒤에는 보내지 않는다.
- **Test-634** — 창이 파괴된 뒤 `ftp:connectionStatus`·`transfer:updated`·`operation:updated`·`operation:progress` 브리지가 `send`하지 않고 던지지도 않는다.
- **Test-500** — `ftp:remoteChanged`가 현재 폴더의 자식이면 디바운스 후 `refresh()` 1회, 무관한 경로면 0회.
- **Test-501** — 현재 폴더(또는 그 위)가 지워지거나 이름이 바뀌면 상위 폴더로 이동한다.
- **Test-503** — `agent:session` connected → 서버 목록 다시 읽기, 툴바가 그 서버, `path`로 이동(다시 연결하지 않음). disconnected → GUI의 해제와 같은 초기화.
- **Test-516** — GUI가 직접 연결 중일 때 온 `agent:session`은 무시한다.
- **Test-519** — 동기화가 시작한 새로 고침이 끝나기 전에 사용자가 다른 원격 폴더로 옮기면 늦게 온 이전 폴더 목록을 버린다.
- **Test-513** — `mcp:*` 호출 채널과 `ftp:remoteChanged`·`agent:session` 이벤트 채널이 preload 허용 목록에 있다.

**설정 화면(`SettingsDialog.test.tsx`)**

- **Test-252** — MCP 토글을 켜면 `mcp:setEnabled(true)`가 호출되고 엔드포인트 URL이 보인다. 상태에 `error`가 있으면 그 문구가 보인다.
- **Test-253** — "Claude Code 명령 복사"가 등록 명령을 클립보드에 쓴다. 토큰 원문은 화면 텍스트에 나타나지 않는다.
- **Test-294** — 토글 실패(실패 값·reject)와 클립보드 쓰기 실패가 오류 토스트로 알려진다.
- **Test-752** — "CLI 명령 복사"가 `cliCommand`를 클립보드에 쓰고 토스트로 알린다. 토큰은 화면에 없다.

**`ftpb`(`ftpb.test.ts`, `toolArgs.test.ts`, `discovery.test.ts`, `build-cli.test.mjs`, `releaseArtifacts.test.ts`)**

- **Test-550** — 발견: `FTPB_URL`·`FTPB_TOKEN`이 우선하고, 없으면 OS별 userData의 `agent/endpoint.json`·`token`. 둘 다 없으면 exit 4와 앱을 켜라는 안내.
- **Test-563** — `writeDiscovery`가 `agent/`(0700)에 `endpoint.json`·`token`(0600)을 원자적으로 쓰고, `readDiscovery`가 되읽으며(없거나 깨졌으면 null), `removeDiscovery`는 자기 pid의 파일만 지운다.
- **Test-564** — `defaultUserDataDir`가 OS별 Electron userData(`<appData>/ftp-browser`, Linux는 `XDG_CONFIG_HOME` 반영)를 돌려준다.
- **Test-551** — `ftpb tools`가 도구마다 이름·위험도 줄·설명·입력 스키마를 JSON으로 준다. `ftpb <tool> --help`는 설명과 스키마에서 만든 플래그 줄을 보인다.
- **Test-552** — `--args '<json>'`과 타입 플래그(숫자·불리언·`--no-x`·반복·JSON 배열·객체)가 같은 인자를 만들고, 도구 이름은 kebab·snake 모두 받는다.
- **Test-690** — (회귀) `connect --server "Pixel phone"`은 문자열, `--server 1`은 정수를 보낸다(`anyOf` 정수∣문자열). `--help`는 `<integer|string>`을 보인다.
- **Test-691** — 유니언 플래그는 값이 읽히는 허용 타입의 JSON 값이 되고, 아니면 문자열이다(`007`·` 1`은 문자열). 배열 항목도 같다.
- **Test-692** — 변환 사용법 오류(exit 2)가 허용되는 형태와 `--args -` 대안을 말하고, 앱에 요청을 보내지 않는다.
- **Test-637** — `--args -`·`--args=-`가 stdin의 JSON 객체(BOM 허용)를 인자로 쓰고 뒤의 플래그가 덮어쓴다. 따옴표·`&`·`|`·`%`·줄바꿈이 든 이름이 그대로 도착한다.
- **Test-638** — `--args -`의 stdin이 JSON 객체가 아니거나 비었으면 exit 2(내용을 되풀이하지 않음), stdin이 터미널이면 기다리지 않고 exit 2.
- **Test-553** — exit code: 성공 0, 도구 오류 1, 사용법(모르는 도구·파라미터, 스키마가 거절한 값) 2, 앱 없음·토큰 거절 4.
- **Test-554** — 출력은 항상 한 줄 JSON이고, 오류는 stderr의 `{"error":{"code","message"}}`뿐이다.
- **Test-639** — `--help`가 용도·Agent access·사용법·위험도·신뢰할 수 없는 이름은 `--args -`(특히 Windows)·종료 코드 0/1/2/4를 밝히고, 도구 `--help`와 README "에이전트 연동"도 `--args -`를 안내한다.
- **Test-697** — `--help`의 예제가 `list-servers` → 이름으로 `connect` → `list-directory`(날짜 필터) → stdin JSON으로 `download` → `wait-for-jobs` 순서다.
- **Test-643** — (회귀) `endpoint.json`의 pid가 살아 있지 않으면 토큰을 보내지 않고 exit 4 "Stale discovery file". pid가 살아 있거나 `kill`이 EPERM이면 보낸다.
- **Test-644** — `FTPB_URL`이 있으면 pid를 확인하지 않는다. `FTPB_TOKEN`만 있으면 URL이 발견 파일에서 오므로 확인한다.
- **Test-693** — 미리보기 이미지 블록을 `<tmpdir>/ftpb-previews/`에 원격 이름의 JPEG 파일로 저장하고, 출력에는 base64 없이 각 `ok` 미리보기에 `savedTo`를 붙인다.
- **Test-694** — 대응이 없으면 `image-<n>` 이름이다. 구분자·제어·서식 문자는 `_`, 앞뒤 점·공백은 지우고, Windows 예약 이름은 `_`를 앞에 붙이며, 기존 파일을 덮어쓰지 않는다(`-2` 접미사).
- **Test-695** — 저장 폴더는 0700으로 만들고, 그 폴더가 심볼릭 링크이거나 다른 사용자의 것이면 쓰지 않는다(exit 1).
- **Test-696** — 결과는 structuredContent 한 번만 출력한다(같은 내용의 텍스트·base64 없음). `--help`와 README가 출력과 `ftpb-previews`를 설명한다.
- **Test-557** — 빌드 산출물 `out/cli/ftpb.cjs`가 Node 내장 모듈만 require하고, 임시 폴더로 복사해도 `--help`가 돈다.
- **Test-562** — `electron-builder.yml`의 `asarUnpack`에 `out/cli/**`가 있다.

**함께 남는 다른 작업(K8, 정의를 옮김)**

- **Test-254** — `ImagePreviewModal`의 닫기 버튼을 이름으로 찾을 수 있다.
- **Test-255** — 원격·로컬 Properties 대화상자가 `dialog` role과 이름으로 잡히고 닫기 버튼에 이름이 있다.
- **Test-256** — `SettingsDialog`가 `dialog` role과 설정 제목으로 잡힌다.
- **Test-257** — `OperationPanel`의 취소 버튼이 이름으로 찾아진다.
- **Test-258** — 원격·로컬 브레드크럼의 뒤로/앞으로 버튼이 `aria-label`로 이름을 갖는다.
- **Test-259** — `StatusBar`의 캐시 비우기 버튼이 이름으로 찾아진다.
- **Test-260** — 원격·로컬 컨텍스트 메뉴가 `menu` role이고 항목은 `menuitem` role이다.
- **Test-298** — 파일 작업마다 취소 버튼 이름에 그 작업 요약이 들어간다(`operation.cancel`).
- **Test-299** — 두 탐색기의 같은 이름 컨트롤이 이름 있는 `region`(원격·로컬) 안에 있다.
- **Test-625** — (회귀) 배타적 다운로드가 큐에 들어간 뒤 그 로컬 경로에 파일이 생기면, 한 스트림 경로에서 그 작업만 "File already exists."로 실패하고 그 파일은 내용 그대로 남는다.
- **Test-626** — (회귀) 같은 상황이 분할 경로에서도 같다: 그 작업만 실패하고 그 파일은 잘리거나 지워지지 않는다.
- **Test-627** — 대상 경로가 비어 있으면 배타적 다운로드가 한 스트림·분할 경로 모두 완료되고 원본과 해시가 같다.
- **Test-628** — 서버가 REST를 무시해 분할 다운로드가 한 스트림으로 다시 받을 때, 배타적 다운로드는 구간이 만든 자기 파일을 다시 열어 완료한다.
- **Test-629** — `FtpFileOperations.download`에 소유 표시(claim)를 주면 아직 만들지 않은 경로는 `'wx'`로 열어 남의 파일에는 EEXIST로 실패하고, 받다 끊긴 자기 파일은 다음 시도가 다시 연다.
- **Test-630** — 배타적 다운로드의 재시도는 첫 시도와 같은 소유 표시를 받아 완료하고, GUI 다운로드는 소유 표시 없이 돈다.
- **Test-631** — 배타적 다운로드를 취소하면 자기가 만든 받다 만 파일은 지운다(분할·한 스트림 모두).
- **Test-632** — (회귀) 배타적 다운로드가 자기 파일을 만들기 전에 그 경로에 파일이 생기고 작업이 취소되면, 그 파일을 자르거나 지우지 않는다.
- **Test-633** — GUI 다운로드는 그대로다: 대상에 있던 파일을 한 스트림·분할 경로 모두 덮어써 완료한다.

## 6. 완료 기준

- `npm test`, `npm run typecheck`, `npm run lint`, 변경 파일 `prettier --check`, `npm run build` 통과.
- 에이전트 기능의 실제 코드가 **약 2,000줄 이하**(테스트 제외).
- 실제 앱: 같은 블라인드 사용성 하네스에서 코드를 모르는 에이전트가 `ftpb`와 `--help`만으로 사용자 요청을 수행한다(이전 결과 8/8, 실패 호출 0과 비교).
