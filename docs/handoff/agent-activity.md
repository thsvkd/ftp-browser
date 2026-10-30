# 핸드오프: 에이전트 활동 표시와 MCP 범용 등록

`agent-access.md`(K1–K8)의 후속이다. 두 가지를 더한다.

1. **범용 등록**: 설정의 Agent access에는 "Claude Code 명령 복사"만 있어, 다른 MCP 클라이언트는 URL과 토큰 헤더를
   사용자가 손으로 옮겨야 했다. 토큰은 화면에 나오지 않으므로 사실상 Claude Code만 등록할 수 있었다.
2. **활동 표시**: 앱은 에이전트 호출을 묻지 않고 실행한다(K3). 그런데 지금은 에이전트가 앱을 쓰는 중인지 화면에서
   알 수 없다. Claude in Chrome·Codex·ego의 computer-use / browser-use처럼, 에이전트가 조작하는 동안 창에
   표시하고 그 자리에서 멈출 수 있게 한다.

작업 유형(R0): **기능 추가**. 도구 12개의 동작·입력·결과는 바꾸지 않는다(중지된 호출의 오류 하나만 더한다).

---

## 1. R1 결정

| #   | 결정                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1  | 설정 Agent access에 **클라이언트 선택**(라디오 그룹: Claude Code · Codex · JSON)과 그 클라이언트의 **복사 버튼 하나**, 붙여 넣을 곳을 알리는 **안내 한 줄**을 둔다. 앱은 다른 프로그램의 설정 파일을 쓰지 않는다(사용자 결정: 복사만). CLI 명령 복사·토큰 재발급은 그대로다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| I2  | Codex는 `codex mcp add --url`이 토큰을 환경변수(`--bearer-token-env-var`)로만 받으므로 `~/.codex/config.toml` 조각을 복사한다: `[mcp_servers.ftp-browser]`, `url = "<url>"`, `http_headers = { Authorization = "Bearer <token>" }`. codex-cli 0.164의 `codex mcp get --json`이 이 형태를 `streamable_http` + `http_headers`로 읽는 것을 확인했다                                                                                                                                                                                                                                                                                                                                                                                                            |
| I3  | JSON은 여러 클라이언트(Cursor 등)가 읽는 `mcpServers` 형태: `{"mcpServers":{"ftp-browser":{"type":"http","url":"<url>","headers":{"Authorization":"Bearer <token>"}}}}`(2칸 들여쓰기). 안내 문구가 VS Code는 `servers` 키를 쓴다고 알린다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| I4  | 세 문자열 모두 토큰을 담으므로 화면에 보이지 않고 복사에만 쓴다(Test-253과 같다). `McpState`에 `codexConfig`·`jsonConfig`를 더하고 기존 `command`(Claude Code)는 그대로 둔다. 토큰이 없으면 셋 다 없다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| A1  | main의 `AgentActivity`(`src/main/mcp/agentActivity.ts`)가 진행 중인 도구 호출과 **에이전트가 시작한 작업**(download·upload의 전송, delete의 파일 작업)을 센다. 바뀔 때마다 `agent:activity` 이벤트 `{ active, client?, tool?, target?, stopped? }`를 보낸다. `active`는 호출이 진행 중이거나 그 작업이 pending·active로 남아 있을 때다. `tool`·`target`은 마지막으로 시작한 호출의 것이다                                                                                                                                                                                                                                                                                                                                                                   |
| A2  | **에이전트 이름**: 2026-07-28 요청 envelope의 `clientInfo.name`(예: `ftpb`), 없으면(2025 세대 연결은 요청마다 새 서버라 initialize 정보가 없다) HTTP `User-Agent`에서 알려진 이름만 고른다(`claude` → Claude Code, `codex` → Codex, `cursor` → Cursor). 그 밖은 이름 없이 "에이전트"로 보인다. 40자로 자르고 제어문자를 지운다                                                                                                                                                                                                                                                                                                                                                                                                                              |
| A3  | **대상 요약**: 입력의 `from`·`to`면 `from → to`, 그 밖은 `path`·`paths`·`remotePaths`·`localPaths`의 첫 항목(여럿이면 ` +N`), 그것도 없으면 `server`. 120자로 자르고 제어문자를 지운다. 원격 이름은 신뢰할 수 없는 데이터이므로 텍스트로만 그린다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| A4  | **표시**(사용자 결정: 테두리 글로우 + 상단 pill): 창 가장자리에 에이전트 색(`--agent`) 글로우(클릭을 막지 않음, 활성 중에만 맥동, `prefers-reduced-motion`이면 맥동 없음)와 툴바 아래 가운데에 pill(`role="status"`): 아이콘 · "{에이전트} 조작 중" · 현재 동작(도구별 번역) · 대상 · [중지]. 활성이 끝나도 에이전트는 다음 호출을 생각하는 중일 수 있으므로 **30초**(`AGENT_ACTIVITY_LINGER_MS`) 더 보이고(글로우는 맥동 없이) 그 뒤 사라진다                                                                                                                                                                                                                                                                                                              |
| A5  | **중지**(사용자 결정: MCP는 끄지 않고 에이전트의 동작만 멈춘다): pill의 [중지]가 `agent:stop`을 부른다. 진행 중인 호출은 기다리지 않고 바로 `STOPPED_BY_USER` isError(`The user stopped you in FTP Browser. A change already sent to the server may still complete. Do not retry; tell the user and wait for instructions.`)로 끝나고, 에이전트가 시작해 아직 pending·active인 전송은 취소, 파일 작업은 취소 요청한다. GUI가 시작한 작업과 끝난 작업은 건드리지 않는다. 중지된 호출이 그 뒤에 큐에 넣는 작업(폴더 목록을 읽는 중에 중지)은 넣자마자 취소하고, 재귀 삭제는 명령마다 취소를 확인한다. 이름 변경·폴더 생성·연결처럼 이미 서버에 보낸 명령은 끝까지 갈 수 있어 오류 문구가 그렇게 알린다. 표시는 바로 사라진다(`stopped: true`, 30초 대기 없음) |
| A6  | 중지 뒤의 새 호출은 평소대로 실행된다. MCP 설정·토큰은 바뀌지 않는다. 서버 instructions에 "사용자는 창의 표시로 당신을 보고 멈출 수 있으며, `STOPPED_BY_USER`면 다시 시도하지 말고 사용자에게 물으라"를 더한다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

### 검토 후속 결정

적대적 리뷰에서 나온 결함을 고치며 정했다. A5와 겹치는 부분은 이것이 우선한다.

| #   | 결정                                                                                                                                                                                                                                                                                                                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A7  | 호출마다 중지 여부(`AgentDeps.stopped()`)를 넣는다. 중지된 호출은 남은 폴더 목록 읽기, 서버 명령(RNFR, 삭제, 연결), 로컬 폴더 만들기, 큐 넣기를 하지 않는다. 삭제는 대상을 확인하는 중에 중지되면 작업을 만들지 않고, 지우는 중에는 명령마다 중지를 확인한다. 중지 시점에 이미 보낸 명령만 끝까지 갈 수 있다(A5의 오류 문구) |
| A8  | 중지는 전송을 `TransferHub.cancelMany`로 한 번에 취소한다(작업 목록을 한 번만 훑는다). 취소가 듣지 않는 전송(메인 연결로 도는 것)은 끝날 때까지 표시를 활성으로 남기고, 끝나면 30초 대기 없이 사라진다(`stopped: true`). 파일 작업 하나의 취소 요청이 실패해도 나머지는 요청한다                                             |
| A9  | 에이전트 이름은 앞뒤 공백을 지우고, 공백·제어문자뿐이면 이름이 없는 것으로 본다(User-Agent로 넘어간다). pill에서 이름은 14rem에서 말줄임해 [중지]가 늘 보인다                                                                                                                                                                |
| A10 | `agent:getActivity`(invoke)가 마지막으로 알린 상태를 돌려준다. 새로 고친 창은 그것이 활성일 때만 그리고, 그사이 이벤트가 오면 이벤트를 따른다. `agent:activity`는 모든 창에 보낸다                                                                                                                                           |
| A11 | pill은 활성 중에만 대화상자 위(`z-[71]`)에 두고, 30초 동안 남는 동안은 대화상자 아래(`z-40`)에 둔다. [중지]는 모든 에이전트를 멈추므로 레이블이 "Stop all agents"다                                                                                                                                                          |
| A12 | 설정의 클라이언트 라디오 그룹은 탭 정지 하나(선택된 것)에 화살표로 고른다. Codex TOML 값은 JSON 문자열로 적어 따옴표·역슬래시를 이스케이프한다. 복사 실패 토스트와 `wait_for_jobs` 동작 문구는 어느 복사·작업에도 맞는 말로 바꾼다                                                                                           |

## 2. 기각한 대안

- **앱이 다른 클라이언트의 설정 파일을 직접 고쳐 쓰는 원클릭 설치** — 클라이언트마다 경로·형식이 다르고 자주 바뀐다.
  `agent-access.md`가 16개 클라이언트 설정 생성기를 지운 것과 같은 이유. 기각(사용자 결정: 복사 3종).
- **중지 = MCP 서버 끄기** — 사용자가 "MCP는 끄지 않고 에이전트의 동작만 멈춘다"로 정했다. 기각.
- **중지 뒤 일정 시간 호출 거부** — 에이전트를 구별할 수 없어 다른 에이전트까지 막는다. 오류 문구로 다시 시도하지 말라고
  알리는 데서 그친다. 기각.
- **에이전트가 건드린 항목을 목록에서 강조** — 범위 밖.

## 3. 테스트

번호는 `Test-1340`부터다(작업 트리의 다른 작업이 `Test-1330`–`1333`을 예약했다).

**등록(`McpService.test.ts`, `SettingsDialog.test.tsx`)**

- **Test-1340** — `buildCodexConfig(url, token)`이 I2의 세 줄 TOML이고, `buildJsonConfig(url, token)`을 `JSON.parse`하면 I3의 객체다(순수 함수).
- **Test-1341** — `getState()`는 토큰이 있으면 `codexConfig`·`jsonConfig`를 그 URL·토큰으로 담고, 토큰 재발급 뒤에는 새 토큰을 담는다.
- **Test-1342** — 설정에서 Codex를 고르면 버튼이 "Codex 설정 복사"가 되어 `codexConfig`를 클립보드에 쓰고 토스트로 알린다. JSON은 `jsonConfig`. 고른 클라이언트의 안내 문구가 보이고, 토큰 원문은 화면 텍스트에 없다. 기본 선택은 Claude Code다.

**활동(`agentActivity.test.ts`, `mcpTools.test.ts`)**

- **Test-1343** — 도구 호출이 시작되면 `active: true`와 그 도구·대상·에이전트 이름이, 끝나면(도구가 던져도) `active: false`가 나간다. 두 호출이 겹치면 둘 다 끝나야 비활성이다.
- **Test-1344** — 대상 요약(A3): `path`, `paths`의 첫 항목 ` +N`, `from → to`, `server`, 입력 없음은 없음. 120자 자르기(서로게이트 쌍을 가르지 않음)와 제어·서식 문자(방향 바꾸기 포함) 제거.
- **Test-1345** — 에이전트 이름(A2): envelope `clientInfo.name`이 먼저, 없으면 `User-Agent`의 알려진 이름, 모르는 `User-Agent`(`node`)는 없음. 40자 자르기.
- **Test-1346** — 에이전트가 시작한 전송·파일 작업이 pending·active인 동안은 호출이 끝나도 `active: true`이고, 모두 끝나면 `active: false`가 나간다. 추적하지 않은 작업은 영향이 없다.
- **Test-1347** — `stop()`하면 진행 중인 호출이 밑의 작업을 기다리지 않고 `STOPPED_BY_USER` isError(다시 시도하지 말라는 안내 포함)로 끝나며 프로토콜 오류가 아니다.
- **Test-1348** — `stop()`은 에이전트가 시작해 pending·active인 전송을 `cancel`하고 파일 작업을 `requestCancel`하며, 추적하지 않은(GUI) 작업과 끝난 작업은 건드리지 않는다. `active: false, stopped: true`가 나간다.
- **Test-1354** — (회귀, A7) 폴더를 읽어 계획하는 중에 `stop()`하면 그 호출은 바로 `STOPPED_BY_USER`로 끝나고, 붙잡힌 목록이 풀려도 더 읽지 않으며 로컬 폴더를 만들거나 큐에 넣지 않는다. 그래도 중지된 호출이 넘긴 작업 id는 받자마자 취소한다. 표시는 다시 켜지지 않는다.
- **Test-1355** — (회귀) 재귀 삭제는 명령마다 취소를 확인해 남은 항목을 지우지 않는다. 폴더 하나를 지우는 `delete`를 중지하면 그 작업은 `completed`가 아니라 `cancelled`로 끝난다.
- **Test-1349** — `stop()` 뒤의 새 호출은 평소대로 결과를 돌려준다.
- **Test-1356** — (A8) `TransferHub.cancelMany`는 여러 큐의 작업을 각 큐의 목록을 한 번씩만 읽어 취소하고 모르는 id는 무시한다.
- **Test-1358** — (A7) 파일·폴더 `delete`가 대상을 확인하는(목록을 읽는) 중에 중지되면 아무것도 지우지 않고 파일 작업도 만들지 않는다.
- **Test-1359** — (A7) `rename`이 대상을 확인하는 중에 중지되면 이름 바꾸기 명령을 보내지 않는다.
- **Test-1360** — (A8) 중지가 취소하지 못한 전송(메인 연결)이 남으면 표시는 활성으로 남고, 그 전송이 끝나면 `stopped: true`로 바로 사라진다. `current()`는 마지막으로 알린 상태다.
- **Test-1361** — (A9) 공백·제어문자뿐인 envelope 이름은 이름이 없는 것이고, 앞뒤 공백은 지운다.
- **Test-1362** — (A2) 2026-07-28 `_meta` envelope 하나로 부른 호출(ftpb처럼)의 이벤트에 그 `clientInfo.name`이 실린다.
- **Test-1367** — (A12) Codex 조각의 URL·토큰에 든 따옴표와 역슬래시가 TOML 이스케이프된다.
- **Test-1350** — `TOOLS`의 모든 도구 이름에 영어 메시지 `agent.action.<name>`이 있다. instructions가 `STOPPED_BY_USER`를 안내한다.

**표시(`AgentActivityIndicator.test.tsx`, `index.test.ts`)**

- **Test-1351** — 처음에는 아무것도 없다. `agent:activity` 활성이면 글로우와 `status` pill에 에이전트 이름(없으면 "에이전트")·동작 번역·대상이 보인다. 비활성이 오면 30초 동안 남고 그 뒤 사라진다. `stopped`면 바로 사라진다.
- **Test-1352** — [중지]가 `agent:stop`을 부르고, 실패(실패 값·reject)는 오류 토스트로 알린다.
- **Test-1353** — `agent:stop` 호출 채널과 `agent:activity` 이벤트 채널이 preload 허용 목록에 있다.
- **Test-1357** — (A10) `agent:getActivity` 호출 채널이 preload 허용 목록에 있다.
- **Test-1363** — (A10) 창을 열 때 `agent:getActivity`가 활성이면 바로 pill을 그린다. 그사이 이벤트가 왔거나 비활성이면 그리지 않는다.
- **Test-1364** — (A11) 활성이면 글로우가 맥동하고(`data-active="true"`) pill이 `z-[71]`, 남아 있는 동안은 맥동하지 않고 `z-40`이다. 남아 있는 중에 새 활성이 오면 30초 타이머가 풀려 사라지지 않는다.
- **Test-1365** — (A9) 긴 에이전트 이름은 14rem에서 말줄임되고 [중지]는 줄어들지 않는다.
- **Test-1366** — (A12) 클라이언트 라디오 그룹은 선택된 것만 탭 정지이고, 화살표로 선택과 포커스가 함께 옮겨 간다.

## 4. 코드 위치

- `src/main/mcp/McpService.ts` — `buildClaudeCodeCommand` 옆에 `buildCodexConfig`·`buildJsonConfig`, `getState()`.
- `src/shared/types/mcp.ts` — `McpState`의 두 필드, `AgentActivityEvent`.
- `src/main/mcp/agentActivity.ts`(새 파일) — 추적·요약·이름·중지. `mcpTools.ts`의 `registerTool` 감싸개가 부르고,
  download·upload·delete가 시작한 작업 id를 넘긴다.
- `src/main/index.ts` — `AgentActivity`를 만들어 `agent:activity`를 보내고, `src/main/ipc/mcpHandlers.ts`에 `agent:stop`.
- `src/preload/index.ts`·`index.d.ts` — 채널 둘.
- `src/renderer/src/components/layout/AgentActivityIndicator.tsx`(새 파일) — `AppShell`에 단다. `globals.css`에 `--agent`.
- `src/renderer/src/components/settings/SettingsDialog.tsx` — I1.
- i18n 11개 언어, `README.md` 에이전트 연동 절, `CLAUDE.md`·`AGENTS.md` Agent access 절.

## 5. 완료 기준

- 위 테스트를 먼저 쓰고 실패를 본 뒤(RED) 구현해 통과(GREEN).
- `npm test`, `npm run typecheck`, `npm run lint`, 변경 파일 `prettier --check`, `npm run build` 통과.
- 실제 앱(R3): MCP를 켜고 Claude Code·Codex(복사한 설정)로 등록해 도구를 부르면 글로우와 pill이 그 에이전트 이름·동작과 함께
  보이고, 다운로드 중 [중지]를 누르면 전송이 취소되고 에이전트가 `STOPPED_BY_USER`를 받는다. MCP 토글은 켜진 채다.
