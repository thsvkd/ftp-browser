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

## 6. 완료 기준

- `npm test`, `npm run typecheck`, `npm run lint`, 변경 파일 `prettier --check`, `npm run build` 통과.
- 에이전트 기능의 실제 코드가 **약 2,000줄 이하**(테스트 제외).
- 실제 앱: 같은 블라인드 사용성 하네스에서 코드를 모르는 에이전트가 `ftpb`와 `--help`만으로 사용자 요청을 수행한다(이전 결과 8/8, 실패 호출 0과 비교).
