# 핸드오프: 같은 호스트·포트의 다른 계정 구별

같은 `host:port`에 서로 다른 사용자로 연결한 두 연결(예: `ra@127.0.0.1:2121`과 `rb2@127.0.0.1:2121`)을 GUI에서 구별할 수 있게 하고, 에이전트가 정확히 지목할 수 있게 한다.
`docs/handoff/multi-connection.md` §14 R3 결과의 관찰 3·4에서 나온 후속이다. 사람의 결정(SH1)은 "두 계정이 GUI에서 구별되고 에이전트가 주소로 고를 수 있게 고친다"이다. 이 문서는 그 결정을 구현 단위로 내린 **유일한 입력**이다.
이 문서에 없는 케이스는 완료 범위 밖이다. 케이스를 추가·병합·재해석하지 말 것.

작업 유형(R0): **버그 수정**(multi-connection R3 관찰 3·4). 렌더러 표시 규칙, main 최근 경로의 저장 키(추가만 하는 마이그레이션), MCP 문구를 고친다. 새 IPC 채널·새 MCP 도구·새 i18n 키는 없다.
슬라이스(§11) S1~S3을 순서대로 진행한다. 슬라이스마다 그 슬라이스의 테스트를 먼저 세워 RED를 본 뒤 GREEN으로 만든다. 끝으로 실제 앱에서 R3 실측(§12)을 한다.

기준 커밋: `feat/explorer-v2`의 `112eb4f`. 번호 범위 **Test-1140~1159**는 이 문서가 예약한다. 쓰기 전에 `grep -rn 'Test-11[45][0-9]' src docs script`로 비어 있음을 확인했다(2026-10-13). 1140~1157을 쓰고 1158·1159는 예비다(쓰지 않는다).

---

## 1. 관찰된 결함 (multi-connection R3, 2026-10-13, macOS)

| #   | 관찰                                                                                                                                                                      | 원인(코드 확인)                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O1  | 사이드바의 `ra`(저장)·`rb2`(저장 안 됨) 행은 이름 "127.0.0.1", 부제·`title` "127.0.0.1:2121", 해제 버튼 `aria-label` "127.0.0.1 연결 해제"가 모두 같다                    | 저장 안 된 행의 이름이 `host`(`Sidebar.tsx:289`), 부제가 `` `${row.host}:${row.port}` ``(`:248`), `title`이 부제(`:178`), 해제 버튼이 `{{name}}`(`:212`)다. 저장 행 이름은 별칭이 없으면 `host`(`:294`, `servers.ts`의 `toServer`) |
| O2  | 두 탭 이름이 모두 "127.0.0.1:2121 최상위"                                                                                                                                 | `sourceLabel`이 키의 사용자를 버리고 `host:port`만 쓴다(`sendItems.ts:45-48`). `locLabel`의 루트 이름 `place.root`가 그것을 쓴다(`:51-58`)                                                                                         |
| O3  | "최근 위치"에 `inbox`가 서버 표시 없이 두 번 보인다                                                                                                                       | 최근 위치 행은 `locLabel(loc)`(마지막 폴더 이름)만 보이고 `title`은 경로뿐이다(`Sidebar.tsx:346-359`)                                                                                                                              |
| O4  | `rb2`로 처음 연결하면 `ra`가 마지막에 연 `/photos`에서 시작한다. 두 서버 행이 같은 최근 폴더를 펼친다                                                                     | 최근 경로가 `host·port` 단위다: 테이블 `server_recent_paths`의 `UNIQUE(server_host, server_port, path)`(`database.ts:58-65`·`:103-114`), `ftp:getRecentPaths(host, port)`(`ftpHandlers.ts:194-203`), 기록(`:221-249`)              |
| O5  | 상태 표시줄이 두 연결 모두 "127.0.0.1 연결됨"                                                                                                                             | `StatusBar.tsx:43`이 `conn.host`만 쓴다                                                                                                                                                                                            |
| O6  | MCP `get_status`가 `rb2`에 `ra`의 저장 행 `serverId: 1`을 붙인다. `AMBIGUOUS` 안내는 "Pass server with an id"인데 `--server 1`은 `ra`로 간다. `rb2`는 키로만 고를 수 있다 | `savedOf`가 사용자가 같은 행이 없으면 host·port만 같은 행으로 물러선다(`agentTarget.ts:7-11`의 `?? at[0]`). `describe`(`:14-18`)·`get_status`(`mcpTools.ts:249-263`)가 그것을 쓴다. 다음 행동 문구는 `mcpTools.ts:93`              |

코드에서 함께 찾은 것(관찰과 같은 원인):

- 서버 간 전송 부분 정리 토스트의 `{{server}}`가 받는 쪽 `host:port`다(`useTransferStore.ts:155-156`). 같은 host·port의 두 계정이면 어느 쪽 파일을 지웠는지 알 수 없다.
- 끊긴 `rb2` 키를 MCP 도구에 넘기면 `NOT_CONNECTED`의 안내가 "Call connect with server 1 first."다(`agentTarget.ts:47-58`이 `savedOf`를 쓴다). 그대로 따르면 `ra`가 연결된다.
- 저장 서버 관리 창(`ServerManagerDialog.tsx:74-91`)과 에이전트 `connect`(`agentOps.ts:158`)도 최근 경로를 `host·port`로 읽는다.

이미 사용자를 보이는 곳은 바꾸지 않는다: 툴바 연결 표시(`ConnectBar`, `serverLabel`), "{서버}에 연결되어 있지 않습니다" 패널(`ExplorerStates.tsx:157-185`, 키 그대로), 활동 팝오버의 목적지 줄(`ActivityPopover.tsx:37-40`, 키 그대로).

---

## 2. 핵심 결정 (R1)

`[사용자]`는 사람이 정한 것이다. 나머지는 이 문서가 그 결정을 코드에 대응시키며 정한 것이다. `미결(권장안 적용)`은 사람이 정하지 않아 권장안으로 진행하되 사람의 확인이 필요한 것이다(§13에도 모았다).

### 표시 (렌더러)

| #   | 결정                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SH1 | `[사용자]` **같은 host·port의 다른 사용자 연결은 GUI에서 구별되고, 에이전트가 정확히 지목할 수 있어야 한다.** §1의 O1~O6을 고친다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| SH2 | **연결 이름표 `connLabel(key)`는 늘 사용자를 보인다**(다른 연결이 있을 때만이 아니다). `src/shared/connKey.ts`에 둔다. 값은 키 그대로 `user@host:port`다. 사용자가 정확히 `anonymous`(대소문자 구분)면 `anonymous@`를 떼고 `host:port`만 보인다. `parseConnKey`가 `null`인 문자열은 그대로 돌려준다. 근거: ① 이름표가 키의 순수 함수라, 다른 연결이 생기거나 사라져도 탭·메뉴의 이름이 바뀌지 않는다. 조건부로 하면 `sourceLabel`을 쓰는 곳(§6, 메뉴·토스트처럼 `getState()`로 읽는 곳 포함)이 모두 연결 목록을 구독해야 한다. ② 툴바·연결 안 됨 패널·활동 팝오버·MCP가 이미 키를 보여 주므로 화면 전체의 이름이 하나가 된다. ③ 익명 연결은 사용자 이름이 정보가 아니다. 테스트 하네스의 기본 서버(`anonymous@example.org:21`, `explorerTestHarness.ts:81`)를 쓰는 기존 단언도 그대로 남는다. 익명과 이름 있는 사용자가 같은 host·port에 있어도 `host:port`와 `user@host:port`로 구별된다 |
| SH3 | **`sourceLabel(loc)`은 원격이면 `connLabel(loc.server)`**(`sendItems.ts:45-48`). `server`가 없으면 지금처럼 `explorer.remote`, 로컬은 `sidebar.thisPc`. `locLabel`·`place.root`는 그대로라 루트 이름이 "ra@127.0.0.1:2121 root"가 된다. 이 한 곳으로 탭 이름·`title`(`TabStrip.tsx:53`·`:88`), 새 탭 메뉴(`:248`), "보내기 ▸"(`Explorer.tsx:609`), 분할 패널 이름(`:853`), 경로 막대 루트(`PathBar.tsx:190-191`), 선반(`Shelf.tsx:62`·`:202`·`:233`), 정보 패널(`InfoPanel.tsx:159`), 속성 창(`PropertiesDialog.tsx:45`)이 함께 바뀐다. **루트가 아닌 폴더의 탭 이름은 지금처럼 폴더 이름**이다(다른 서버의 같은 이름 폴더도 지금 같은 이름이다. 구별은 `title`이 한다)                                                                                                                                                                                                                   |
| SH4 | **사이드바 서버 행**(`Sidebar.tsx:145-261`). 둘째 줄(연결됐을 때)과 행 `title`은 `connLabel(row.key)`. 연결 안 됨·연결 중·끊김의 둘째 줄은 지금처럼 상태 문구다. 해제 버튼의 `sidebar.disconnect` `{{name}}`은 `connLabel(row.key)`다(행 이름은 저장 행끼리도 겹칠 수 있다: 별칭 없는 저장 행의 이름은 `host`라, 같은 호스트의 다른 포트도 이름이 같다. 키는 행마다 다르다). **저장 안 된 행의 이름은 `connLabel(key)`에서 끝의 `:port`를 뗀 것**(`rb2@127.0.0.1`, 익명은 `127.0.0.1`). 저장 행의 이름은 지금 그대로(`name \|\| host`)                                                                                                                                                                                                                                                                                                                                                    |
| SH5 | **사이드바 "최근 위치"**(`Sidebar.tsx:346-359`). 원격 항목은 폴더 이름 뒤에 **출처 줄**(`connLabel(loc.server)`, 작은 고정폭·흐린 글씨, 폴더 이름보다 먼저 잘린다)을 덧붙인다. 버튼의 접근 이름은 `` `${label} · ${connLabel(server)}` ``(`aria-label`), `title`은 `` `${connLabel(server)} · ${loc.path}` ``(탭 `title`과 같은 형식). 로컬 항목과 서버 행 아래 들여쓴 최근 폴더는 지금 그대로다(들여쓴 폴더는 서버 행이 이미 출처다). `Place`에 선택 prop `detail?: string`을 더한다                                                                                                                                                                                                                                                                                                                                                                                                     |
| SH6 | **상태 표시줄**(`StatusBar.tsx:43`·`:100-102`): 활성 탭이 원격이면 `conn.host` 대신 `connLabel(server)`. 로컬 탭의 "N servers connected"는 그대로                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| SH7 | **서버 간 부분 정리 토스트**(`useTransferStore.ts:150-158`): `{{server}}` = `connLabel(job.server)`. multi-connection §10의 "받는 쪽 `host:port`" 규칙을 대체한다. 그때 `sourceLabel`을 피한 이유(`sendItems.ts`가 이 스토어를 가져와 순환 import)는 `connLabel`이 `@shared/connKey`에 있어 사라진다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

### 최근 경로 (main + 렌더러)

| #    | 결정                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SH8  | **최근 경로는 연결 키(host·port·사용자)마다.** 새 테이블 `remote_recent_paths(id, host, port, username, path, last_visited, UNIQUE(host, port, username, path))` + 색인 `idx_remote_recent_paths_conn(host, port, username)`. `username`은 **키의 사용자**(빈 사용자는 `anonymous`, `connKey`와 같다). 읽기는 호스트 대소문자 무시(지금 `getRecentPaths`와 같다), 사용자는 정확히 같음, 최근 순 20개. 쓰기는 키마다 20개를 남긴다(지금 규칙). 쓰기(같은 경로 갱신·20개 정리, SH11의 옮기기·삭제)도 읽기처럼 호스트 대소문자를 가리지 않는다: 철자만 다른 호스트의 같은 경로는 마지막 기록의 철자 한 행으로 합친다(SH9 복사는 옛 행의 철자를 그대로 둔다). 마이그레이션 `005_remote_recent_paths.sql`(CREATE TABLE·INDEX만) + `database.ts` 인라인 대체 SQL을 **함께** 고친다(빌드된 앱은 인라인만 돈다: `out/main/`에는 `index.js`뿐). **옛 `server_recent_paths` 테이블과 그 행, `cache.db`는 지우지 않는다.** 옛 테이블은 이 뒤로 읽지 않는다. 근거: 옛 테이블의 `UNIQUE(server_host, server_port, path)`는 SQLite에서 바꿀 수 없어, 열을 더하면 두 사용자의 같은 경로(`/`)가 충돌한다(MC9의 `folder_previews`와 같은 이유) |
| SH9  | **미결(권장안 적용) 옛 최근 경로의 이전.** `remote_recent_paths`가 **처음 생길 때 한 번**, 옛 행을 같은 host(대소문자 무시)·port의 **저장 서버 행의 사용자**(`COALESCE(NULLIF(username, ''), 'anonymous')`)로 복사한다(`INSERT OR IGNORE`, `last_visited` 보존). 저장 행이 없는 host·port의 옛 행은 옮기지 않는다(옛 테이블에 남는다). 생성과 복사는 한 트랜잭션이다. 근거: 성공한 연결은 저장 행이 없으면 새로 저장한다(`recordConnection`, `servers.ts:208-222`). 저장 행을 지우면 그 경로도 지운다(`deleteServer`). 그래서 옛 행의 host·port에는 거의 늘 저장 행이 있다. 다른 계정으로 접속해도 저장 행의 계정은 바뀌지 않으므로(`servers.ts:202-207`), 그 행의 사용자가 옛 기록의 주인일 가능성이 가장 높다. 다른 계정으로 연 경로가 섞여 있어도 그 폴더가 없으면 연결이 `/`로 물러선다(MC10). 사람이 고를 수 있는 다른 안: 옮기지 않기(모두 처음부터), 모든 사용자에게 복사(O4가 그대로 남는다)                                                                                                                                                                                                                          |
| SH10 | **`ftp:getRecentPaths(conn: ConnKey)`**(채널 이름·preload 허용 목록 그대로, 인자만 바꾼다). 연결 여부와 무관하게 DB만 읽는다. 문자열이 아니거나 `parseConnKey`가 `null`이면 `{ success: false, error: 'Invalid connection key.' }`(MC3과 같은 문구). DB 오류는 지금처럼 `{ success: true, data: [] }`. 기록은 `ftp:list` 성공 때 `recordRecentPath(db, session.key, path)`(`servers.ts`로 뽑는다)가 한다. main 함수는 `getRecentPaths(db, key: ConnKey)`. 호출부 다섯 곳: `Sidebar.tsx`의 `ServerEntry`(`row.key`), `useServerStore`의 `lastVisitedPath`(연결할 키), `ServerManagerDialog`(고른 저장 행의 `connKey(host, port, username)`), `agentOps.connectSaved`(`key`), `ftpHandlers`의 기록                                                                                                                                                                                                                                                                                                                                                                                                                              |
| SH11 | **저장 서버 수정·삭제는 지금 의미 그대로**, 테이블만 바꾼다. 저장 행의 host·port가 바뀌면 옛 host·port의 **모든 사용자** 행을 새 host·port로 옮긴다(`UPDATE OR REPLACE remote_recent_paths SET host, port`, `servers.ts:148-153`을 대체. 옛 테이블은 더 읽지 않으므로 고치지 않는다). 사용자만 바뀌면 아무것도 옮기지 않는다(옮기면 O4가 다시 생긴다). 저장 행 삭제는 그 host·port의 **모든 사용자** 행을 `remote_recent_paths`에서 지우고, 옛 테이블을 지우는 지금 문장(`servers.ts:353-357`)도 남긴다(서버를 지우면 그 기록이 파일에 남지 않게)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

### MCP (agent-access 갱신)

| #    | 결정                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SH12 | **연결의 저장 행은 사용자까지 같은 행만**(`agentTarget.ts`의 `savedOf`에서 `?? at[0]` 물러서기를 뺀다). 이 함수를 쓰는 세 곳이 함께 바뀐다: `get_status`의 `serverId`·`name`(사용자가 다른 연결에는 두 키가 없다), `AMBIGUOUS` 목록(`describe`), 끊긴 키의 `NOT_CONNECTED` 안내(`refuseDisconnectedKey`: 사용자가 다른 키는 "It is not a saved server; connect to it in FTP Browser first."). `get_status` 설명의 "the saved server serverId and name"을 "serverId and name of the saved server with the same user"로 고친다                                           |
| SH13 | **`AMBIGUOUS`는 넘길 키를 그대로 보인다.** 항목은 키를 앞에: 저장 행(사용자까지 같음)이 있으면 `<key> (<별칭>, id <N>)`, 별칭이 없으면 `<key> (id <N>)`, 저장 안 된 연결은 `<key>`. 다음 행동(`NEXT.AMBIGUOUS`, `mcpTools.ts:93`)은 `Pass server with one of the user@host:port keys listed.` `resolveTarget`(`N servers are connected: …`)과 `connectionOf`(`N connections match <이름>: …`) 모두 같은 항목 형식이다. 예: `AMBIGUOUS: 2 servers are connected: ra@127.0.0.1:2121 (id 1), rb2@127.0.0.1:2121. Pass server with one of the user@host:port keys listed.` |
| SH14 | **대상 고르기 규칙(MC18 ①~④)은 바꾸지 않는다.** 저장 서버 id·별칭·호스트로 고르면 지금처럼 사용자가 같은 연결, 없으면 그 host·port의 유일한 연결이다(`connectionOf`, `[사용자]` MC18). 그래서 `ra`가 끊기고 `rb2`만 연결돼 있으면 `server: 1`은 `rb2`로 간다. 이 물러서기를 없앨지는 사람의 결정이다(§13 후속)                                                                                                                                                                                                                                                         |
| SH15 | **`docs/handoff/agent-access.md` 갱신**(S3에서): §2 표 `get_status` 행에 "serverId·name은 사용자까지 같은 저장 서버일 때만", "대상 연결" 문단의 `AMBIGUOUS` 괄호를 "(연결마다 키·별칭·id + `Pass server with one of the user@host:port keys listed.`)"로. 도구 수(12)·스키마·`INSTRUCTIONS`·`ftpb`는 바뀌지 않는다                                                                                                                                                                                                                                                     |

### 2.1 대체되는 결정

| 문서                  | 항목                                     | 바뀌는 것                                                                                                    |
| --------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `multi-connection.md` | MC3 "서버 무관 채널"                     | `ftp:getRecentPaths(host, port)` → `ftp:getRecentPaths(conn)`(SH10). 서버 무관(연결 여부 무관)인 것은 그대로 |
| `multi-connection.md` | MC14                                     | 서버 행의 최근 폴더가 `ftp:getRecentPaths(row.key)`, 행 둘째 줄·`title`·해제 버튼 이름이 키 이름표(SH4)      |
| `multi-connection.md` | MC18 `AMBIGUOUS` 문구                    | 항목 형식과 다음 행동(SH13). 대상 규칙 자체는 그대로(SH14)                                                   |
| `multi-connection.md` | MC21                                     | `serverId`·`name`은 사용자까지 같은 저장 행일 때만(SH12)                                                     |
| `multi-connection.md` | §10 `toast.relayPartialRemoved`          | `{{server}}` = `connLabel(job.server)`(SH7)                                                                  |
| `multi-connection.md` | §15 위험 "같은 호스트·포트, 다른 사용자" | 표시는 SH2~SH6이 해소. 저장 행이 host·port마다 하나인 것(`idx_servers_host_port`)은 그대로(§9)               |
| `agent-access.md`     | §2 `get_status`·대상 연결 문단           | SH15                                                                                                         |

---

## 3. 상태 모델

```ts
// src/shared/connKey.ts (더함)
/** 화면·안내의 연결 이름. 키 그대로, 사용자가 정확히 'anonymous'면 host:port. 키가 아니면 그대로 */
export function connLabel(key: ConnKey): string

// src/main/db/servers.ts (바뀜)
export function getRecentPaths(db: Database.Database, key: ConnKey): RecentPath[] // 사용자까지, 최근 순 20개
export function recordRecentPath(db: Database.Database, key: ConnKey, path: string): void // 밀리초 시각, 키마다 20개
```

```sql
-- src/main/db/migrations/005_remote_recent_paths.sql (신규) = database.ts 인라인 대체 SQL
CREATE TABLE IF NOT EXISTS remote_recent_paths (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  username TEXT NOT NULL,
  path TEXT NOT NULL,
  last_visited TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(host, port, username, path)
);
CREATE INDEX IF NOT EXISTS idx_remote_recent_paths_conn ON remote_recent_paths(host, port, username);

-- database.ts 코드(파일이 아니다): 위를 실행하기 **전에** 테이블이 없었을 때만, 같은 트랜잭션에서 (SH9)
INSERT OR IGNORE INTO remote_recent_paths (host, port, username, path, last_visited)
  SELECT p.server_host, p.server_port, COALESCE(NULLIF(s.username, ''), 'anonymous'), p.path, p.last_visited
  FROM server_recent_paths p
  JOIN servers s ON lower(s.host) = lower(p.server_host) AND s.port = p.server_port;
```

렌더러 스토어의 상태는 바뀌지 않는다. `Place`(`Sidebar.tsx:65`)에 선택 prop `detail?: string`(SH5)을 더한다.

---

## 4. IPC·MCP 계약

| 채널·도구                    | 지금                                                                                          | 바뀐 뒤                                                                                                     |
| ---------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `ftp:getRecentPaths`         | `(host: string, port: number)` → `IpcResult<RecentPath[]>`                                    | `(conn: ConnKey)` → 같은 결과. 잘못된 키는 `{ success: false, error: 'Invalid connection key.' }`(SH10)     |
| `ftp:list`의 최근 경로 기록  | `server_recent_paths`에 키의 host·port                                                        | `remote_recent_paths`에 키의 host·port·사용자(`recordRecentPath`)                                           |
| MCP `get_status`             | 연결마다 host·port만 같은 저장 행의 `serverId`·`name`                                         | 사용자까지 같은 저장 행일 때만(SH12)                                                                        |
| MCP `AMBIGUOUS`              | `이름 (id N, key)` / `host (key)` + "Pass server with an id, name or host from list_servers." | `key (별칭, id N)` / `key (id N)` / `key` + "Pass server with one of the user@host:port keys listed."(SH13) |
| MCP `NOT_CONNECTED`(끊긴 키) | host·port만 같은 저장 행의 id로 `connect` 안내                                                | 사용자까지 같은 저장 행이 없으면 "It is not a saved server; connect to it in FTP Browser first."(SH12)      |

preload 허용 목록·`InvokeChannel` 유니온은 바뀌지 않는다. 도구 수 12(Test-450)도 그대로다.

---

## 5. 렌더러 대응표

| 파일                                              | 지금                                            | 바뀐 뒤                                                               |
| ------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------- |
| `lib/sendItems.ts:45-48`                          | `loc.server.slice(lastIndexOf('@') + 1)`        | `connLabel(loc.server)`(SH3)                                          |
| `components/layout/Sidebar.tsx:178`·`:212`·`:248` | `title`·해제 이름·둘째 줄이 `host:port`·행 이름 | 모두 `connLabel(row.key)`(SH4)                                        |
| `components/layout/Sidebar.tsx:286-290`           | 저장 안 된 행 이름 `host`                       | `connLabel(key)`에서 `:port`를 뗀 것(SH4)                             |
| `components/layout/Sidebar.tsx:233-241`           | `ftp:getRecentPaths(row.host, row.port)`        | `ftp:getRecentPaths(row.key)`, eslint 예외 주석 삭제(SH10)            |
| `components/layout/Sidebar.tsx:346-359`           | 최근 위치: 폴더 이름, `title` 경로              | 원격이면 `detail`·`aria-label`·`title`(SH5)                           |
| `components/layout/StatusBar.tsx:43`              | `conn.host`                                     | `connLabel(server)`(SH6)                                              |
| `stores/useTransferStore.ts:155-156`              | `parseConnKey` → `host:port`                    | `connLabel(job.server)`(SH7). 쓰지 않게 된 `parseConnKey` import 삭제 |
| `stores/useServerStore.ts:61-72`·`:171`           | `lastVisitedPath({ host, port })`               | `lastVisitedPath(key)`(이미 `:167`에서 만든 `key`)(SH10)              |
| `components/server/ServerManagerDialog.tsx:74-91` | `ftp:getRecentPaths(selHost, selPort)`          | 고른 저장 행의 `connKey(host, port, username)`(SH10)                  |

---

## 6. 구현 함정

1. **빌드된 앱은 인라인 SQL만 돈다**(`out/main/`에 `index.js`뿐, CLAUDE.md). `005` 파일과 인라인 문자열이 같은 모양이어야 한다. Test-1146은 파일을 읽지 못하는 경우도 본다.
2. **복사 SQL은 `005` 파일에 넣지 않는다.** `agentHarness.ts`의 `createTestDb`(`:33-49`)는 `migrations/`의 파일을 모두 실행한 **뒤에** `server_recent_paths`를 만든다. 파일이 옛 테이블을 읽으면 MCP 테스트가 모두 깨진다. 복사는 `database.ts` 코드에 하나만 둔다.
3. **한 번만 복사한다.** 매 시작마다 `INSERT OR IGNORE … SELECT`를 돌리면, 사용자가 서버를 지워 없앤 경로나 저장 행의 계정을 바꾼 뒤의 경로가 옛 테이블에서 되살아난다. `sqlite_master`로 테이블이 없음을 먼저 보고, 생성과 복사를 한 트랜잭션으로 묶는다(중간에 꺼져도 다음 시작에 다시 시도한다). 옛 테이블 생성(`database.ts:103-114`) 뒤, `004` 블록 뒤에 둔다.
4. **사용자 열은 키의 사용자다.** 저장 행은 익명을 `''`로 저장한다(`recordConnection`, `servers.ts:175-176`). 키는 `'anonymous'`다. 복사는 `COALESCE(NULLIF(username, ''), 'anonymous')`. 사용자 비교는 대소문자를 가린다. 그래서 `Anonymous`로 입력해 만든 키는 `anonymous`의 기록을 읽지 않는다(지금 키 규칙 MC2 그대로).
5. **렌더러 테스트는 `window.api` 목이다.** `ftp:getRecentPaths`의 인자 형태가 바뀐 것은 개발 앱과 R3 (d)로만 확인된다. `explorerTestHarness.ts:153`과 `AppShell.test.tsx:42`의 목은 인자를 보지 않으므로 그대로 둔다.
6. **이름표는 구독이 필요 없다.** `connLabel`은 키의 순수 함수라, `sourceLabel`을 `getState()` 문맥(새 탭 메뉴, "보내기 ▸", 토스트)에서 불러도 낡지 않는다. 컴포넌트에 연결 목록 구독을 더하지 않는다.
7. **최근 위치 행의 접근 이름.** 두 `span`을 이어 붙이면 접근 이름이 `inboxrb2@…`가 된다. 원격 항목에만 `aria-label`을 둔다(SH5). 로컬 항목의 접근 이름은 지금 그대로라 Test-820은 바뀌지 않는다.
8. **해제 버튼 이름이 바뀐다.** `Disconnect Office`처럼 행 이름으로 찾는 기존 단언은 키 이름표로 바꾼다(§7).

---

## 7. 기존 테스트 처분

케이스의 의도는 그대로이고, 이 문서의 규칙 때문에 바뀌는 기대 값·준비만 고친다. 아래에 없는 기존 테스트가 이 변경으로 깨지면 멈추고 원인을 본다(의도가 바뀌는 수정이면 이 문서의 범위를 넘는다).

| 테스트                                                                            | 파일                                                                          | 고치는 것                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Test-821                                                                          | `components/layout/Sidebar.test.tsx`                                          | `ftp:getRecentPaths` 인자 `[[OFFICE.host, OFFICE.port]]` → `[[OFFICE_KEY]]`                                                                                                                                                                      |
| Test-1020                                                                         | `components/layout/Sidebar.test.tsx`                                          | 최근 경로 목 처리기를 키로 고르고 인자 단언을 키로. 저장 안 된 행 `^x\.example`·`^w\.example` → `^x@x\.example`·`^w@w\.example`. `Disconnect Office`·`Disconnect Archive` → `Disconnect kim@ftp.office.lan:2121`·`Disconnect arc@archive.lan:21` |
| Test-1034                                                                         | `components/layout/Sidebar.test.tsx`                                          | 행 이름 `^x\.example`·`^y\.example`·`startsWith('z.example')` → `x@x.example`·`y@y.example`·`z@z.example`                                                                                                                                        |
| Test-1039                                                                         | `components/layout/TabStrip.test.tsx`                                         | `^a\.lan:21 › `·`^b\.lan:21 › ` → `^a@a\.lan:21 › `·`^b@b\.lan:21 › `                                                                                                                                                                            |
| Test-1027                                                                         | `stores/useTransferStore.test.ts`                                             | 토스트 `on b.example:2121` → `on you@b.example:2121`(SH7). multi-connection §12의 이 케이스 문구 "받는 쪽 host:port"는 "받는 쪽 `connLabel`"로 읽는다                                                                                            |
| Test-1004                                                                         | `src/main/mcp/mcpTools.test.ts`(+ `agentTarget.test.ts`의 문구 단언이 있으면) | 기대 문구 → `AMBIGUOUS: 2 servers are connected: me@nas.local:21, kim@ftp.office.lan:2121 (Office, id ${office}). Pass server with one of the user@host:port keys listed.`                                                                       |
| Test-970                                                                          | `src/main/ipc/ftpHandlers.test.ts`                                            | `server_recent_paths` 조회 → `remote_recent_paths`의 `{ host: 'b.example', port: 2121, username: 'you', path: '/x' }`                                                                                                                            |
| Test-402                                                                          | `src/main/mcp/agentOps.test.ts`                                               | `addRecentPath`(`:45-51`)가 `remote_recent_paths`에 저장 행의 사용자로 넣는다                                                                                                                                                                    |
| Test-734, "remote channels with two connections"의 준비                           | `src/main/ipc/ftpHandlers.test.ts:344`·`:469`                                 | 직접 만드는 `server_recent_paths`와 함께 `remote_recent_paths`도 만든다(또는 `005` 파일을 실행한다)                                                                                                                                              |
| "updates by id and moves recent paths when the address changes", `paths()` 도우미 | `src/main/db/servers.test.ts:63-70`·`:187-`                                   | 도우미·삽입을 `remote_recent_paths`로(사용자 열 포함). 준비(`:28`)에 `005` 테이블                                                                                                                                                                |
| "opens the folder the server was last left in"                                    | `components/server/ConnectBar.test.tsx:682-`                                  | 인자 단언 `['nas.local', 21]` → 그 저장 서버의 키 한 개                                                                                                                                                                                          |

`agentHarness.ts`의 `createTestDb`는 `005`를 자동으로 실행한다. 옛 테이블 생성 줄은 그대로 둔다.

---

## 8. 테스트 케이스 리스트 (확정)

`Test-1140`부터 신규(예약 범위 1140~1159 중 1140~1157을 쓴다). 각 테스트에 `// covers: Test-N`. **1:1 매핑. 케이스 추가·병합·재해석 금지.**
renderer 컴포넌트 테스트는 첫 줄에 `/** @vitest-environment jsdom */`, `vi.stubGlobal('api', makeApiMock(...))`. 예시의 `RA = 'ra@127.0.0.1:2121'`, `RB2 = 'rb2@127.0.0.1:2121'`.

### A. 표시 (S1)

| #         | 파일                                   | 케이스                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Test-1140 | `src/shared/connKey.test.ts`(node)     | `connLabel(RA)` = `RA`. `connLabel('anonymous@ftp.example.com:21')` = `'ftp.example.com:21'`. `connLabel('Anonymous@h:21')` = `'Anonymous@h:21'`(대소문자 구분). `connLabel('a@b@h:21')` = `'a@b@h:21'`. 키가 아닌 문자열(`'h:21'`, `''`)은 그대로                                                                                                                                                            |
| Test-1141 | `lib/sendItems.test.ts`                | `sourceLabel({ side: 'remote', server: RA })` = `RA`, `RB2`는 `RB2`, `anonymous@example.org:21`은 `example.org:21`, `server` 없음은 `explorer.remote`, 로컬은 `sidebar.thisPc`. `locLabel({ side: 'remote', path: '/', server: RA })`와 `RB2`의 것은 서로 다르고 각각 `t('place.root', { source: RA })`·`RB2`. `/photos`는 둘 다 `photos`                                                                     |
| Test-1142 | `components/layout/TabStrip.test.tsx`  | RA·RB2가 연결되고 두 원격 루트 탭이 열려 있으면 탭 이름이 `ra@127.0.0.1:2121 root`·`rb2@127.0.0.1:2121 root`이고 `title`이 `${RA} · /`·`${RB2} · /`. 새 탭 메뉴의 두 원격 항목이 `^ra@127\.0\.0\.1:2121 › `·`^rb2@127\.0\.0\.1:2121 › `로 시작한다                                                                                                                                                            |
| Test-1143 | `components/layout/StatusBar.test.tsx` | 활성 탭이 RB2의 원격 탭이고 RA·RB2가 연결돼 있으면 상태 표시줄에 `rb2@127.0.0.1:2121`이 있고 `ra@`는 없다. 활성 탭을 RA 탭으로 바꾸면 `ra@127.0.0.1:2121`. `anonymous@example.org:21` 탭이면 `example.org:21`이고 `anonymous@`는 없다                                                                                                                                                                         |
| Test-1144 | `components/layout/Sidebar.test.tsx`   | 저장 서버 RA(별칭 없음, `host: '127.0.0.1'`, `port: 2121`, `username: 'ra'`)와 저장 안 된 RB2가 모두 `connected`. 서버 행 둘의 이름이 `127.0.0.1`·`rb2@127.0.0.1`(저장 안 된 행이 맨 위), 둘째 줄과 `title`이 `RA`·`RB2`. 해제 버튼이 `Disconnect ${RA}`·`Disconnect ${RB2}`로 따로 있고, RB2의 것을 누르면 `ftp:disconnect`가 `[[RB2]]`뿐이다. 저장 안 된 익명 연결 `anonymous@h.lan:21`의 행 이름은 `h.lan` |
| Test-1145 | `components/layout/Sidebar.test.tsx`   | `useTabsStore.recent`가 [RA의 `/inbox`, RB2의 `/inbox`, 로컬 `C:\work\inbox`]이면 최근 위치에 세 행이 있다. 원격 두 행의 접근 이름은 `inbox · ${RA}`·`inbox · ${RB2}`이고 `title`은 `${RA} · /inbox`·`${RB2} · /inbox`, 각 행 안에 출처 줄 텍스트가 있다. 로컬 행의 접근 이름은 `inbox`이고 출처 줄이 없다. RB2 행을 누르면 활성 탭이 `{ side: 'remote', path: '/inbox', server: RB2 }`                       |

### B. 최근 경로 (S2)

| #         | 파일                                             | 케이스                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Test-1146 | `src/main/db/database.test.ts`                   | 새 `cache.db`를 `initDatabase`로 열면 `remote_recent_paths`의 UNIQUE가 `[host, port, username, path]`이고 `idx_remote_recent_paths_conn`이 있다. 같은 host·port·path에 사용자 둘은 들어가고, 같은 사용자 둘째 행은 UNIQUE로 막힌다. 다시 열어도 경고·오류 없이 행이 남고 `server_recent_paths`도 있다. `005` 파일 읽기가 실패하도록(`fs.readFileSync`를 그 경로에서만 throw) 열어도 같은 모양(인라인 대체)                                                                                                                        |
| Test-1147 | `src/main/db/database.test.ts`                   | 옛 `cache.db`(`server_recent_paths`만 있고 `remote_recent_paths` 없음): 저장 행 `nas.local:21`(`username 'me'`)·`ftp.x:21`(`username ''`), 옛 경로 `NAS.local:21 /photos`·`ftp.x:21 /pub`·`orphan:21 /o`. 열면 `remote_recent_paths`에 `(NAS.local, 21, me, /photos)`·`(ftp.x, 21, anonymous, /pub)`가 `last_visited` 그대로 생기고 `orphan`은 없다. 옛 테이블 행은 3개 그대로. 복사된 행 하나를 지우고 다시 열면 되살아나지 않는다(한 번만 복사)                                                                                 |
| Test-1148 | `src/main/db/servers.test.ts`                    | `recordRecentPath(db, RA, '/photos')`·`(db, RB2, '/inbox')` 뒤 `getRecentPaths(db, RB2)`는 `['/inbox']`만, `getRecentPaths(db, RA)`는 `['/photos']`만. 호스트 대소문자 무시(`me@nas.local:21`로 쓰고 `me@NAS.local:21`로 읽어도 같다), 사용자는 대소문자 구분(`ME@nas.local:21`은 빈 배열). 같은 경로를 다시 기록하면 행이 늘지 않고 맨 앞으로. 호스트 철자만 다르게(`me@NAS.local:21`) 같은 경로를 기록해도 행이 늘지 않고, 철자가 섞인 기록도 한 키로 20개를 센다. RA에 25개를 기록하면 RA는 최근 20개만 남고 RB2의 행은 그대로 |
| Test-1149 | `src/main/db/servers.test.ts`                    | 저장 행 `nas.local:21`(사용자 `me`)에 `me`·`guest`의 최근 경로가 있을 때 `saveServer`로 포트를 2121로 바꾸면 두 사용자의 행이 모두 `nas.local:2121`로 옮겨진다(새 주소에 같은 사용자·경로의 행이 있어도 실패하지 않는다). 사용자만 `me`→`you`로 바꾸면 아무 행도 옮겨지지 않는다. 호스트 철자만 다른 행(`NAS.local`)도 함께 옮기고 지운다. `deleteServer`는 그 host·port의 두 사용자 행과 옛 `server_recent_paths` 행을 지우고 다른 host·port의 행은 남긴다                                                                       |
| Test-1150 | `src/main/ipc/ftpHandlers.test.ts`               | RA·RB2 세션이 연결된 레지스트리에서 `ftp:list(RB2, '/inbox')` 성공 뒤 `ftp:getRecentPaths(RB2)`는 `/inbox`를, `ftp:getRecentPaths(RA)`는 빈 배열을 준다(둘 다 `success: true`). 연결을 끊은 뒤에도 `ftp:getRecentPaths(RB2)`는 `/inbox`. `ftp:getRecentPaths('127.0.0.1', 2121)`·`(42)`는 `{ success: false, error: 'Invalid connection key.' }`                                                                                                                                                                                  |
| Test-1151 | `components/layout/Sidebar.test.tsx`             | 저장 RA와 저장 안 된 RB2가 연결되고, 목 `ftp:getRecentPaths`가 키별로 RA → `['/photos']`, RB2 → `['/inbox']`를 줄 때: 호출 인자가 `[RA]`·`[RB2]`(host·port 인자 없음), RA 행 아래에 `photos`만, RB2 행 아래에 `inbox`만 있다. RB2 아래 `inbox`를 누르면 활성 탭이 `{ side: 'remote', path: '/inbox', server: RB2 }`                                                                                                                                                                                                               |
| Test-1152 | `stores/useServerStore.test.ts`                  | 저장 서버 RA를 고른 툴바에서 사용자를 `rb2`로 바꿔 연결하면 `ftp:getRecentPaths`가 `[RB2]`로 불리고, RB2의 최근 경로가 없으면(RA에는 `/photos`가 있어도) `ftp:connect` 뒤 연 폴더가 `/`다. RB2에 `/inbox`가 있으면 `/inbox`. 저장된 계정 그대로 연결하면 `[RA]`로 묻는다                                                                                                                                                                                                                                                          |
| Test-1153 | `components/server/ServerManagerDialog.test.tsx` | 저장 서버(`host: 'nas.local'`, `port: 21`, `username: 'me'`)를 고르면 `ftp:getRecentPaths`가 `['me@nas.local:21']`로 불린다. 사용자 이름이 빈 저장 서버는 `['anonymous@<host>:<port>']`                                                                                                                                                                                                                                                                                                                                           |
| Test-1154 | `src/main/mcp/agentOps.test.ts`                  | 저장 서버 `nas.local:21`(사용자 `me`)에 `connect`(path 없음): `remote_recent_paths`에 `guest@nas.local:21 /guest`(더 최근)와 `me@nas.local:21 /photos`가 있으면 `/photos`를 연다. `me`의 행이 없고 `guest`의 행만 있으면 `/`를 연다. `agent:session`의 `path`도 같다                                                                                                                                                                                                                                                              |

### C. MCP (S3)

| #         | 파일                               | 케이스                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Test-1155 | `src/main/mcp/mcpTools.test.ts`    | 저장 서버(`host: '127.0.0.1'`, `port: 2121`, `user: 'ra'`, 별칭 `'Lab'`, id는 `addServer`의 반환값)와 연결 RA·RB2: `get_status`의 RA 항목은 `serverId`(그 id)·`name: 'Lab'`을 갖고, RB2 항목에는 `serverId`·`name` 키가 **없다**(`host`·`port`·`user: 'rb2'`·`status`·`lastUsed`는 있다). `tools/list`의 `get_status` 설명에 `saved server with the same user`가 있다                                                                                                                                                  |
| Test-1156 | `src/main/mcp/mcpTools.test.ts`    | 위 저장 서버(별칭 없음으로)와 RA·RB2 연결, 마지막 사용 연결 없음: `list_directory({ path: '/' })`가 정확히 `AMBIGUOUS: 2 servers are connected: ${RA} (id ${id}), ${RB2}. Pass server with one of the user@host:port keys listed.`이고 FTP에 닿지 않는다. 저장 서버 하나에 사용자가 다른 연결 둘(`guest@…`·`other@…`, 저장 행 사용자는 연결 안 됨)이 있을 때 `server: id`는 `AMBIGUOUS: 2 connections match …`로 두 키를 같은 형식으로 보이고 같은 다음 행동이다. 안내에 나온 `RB2`를 `server`로 넘기면 RB2의 목록이다 |
| Test-1157 | `src/main/mcp/agentTarget.test.ts` | 저장 서버 RA(사용자 `ra`)가 있고 RB2가 끊겨(`get_status`에 `disconnected`) 있을 때 `resolveTarget(deps, RB2)`는 `NOT_CONNECTED`, 문구 정확히 `${RB2} is not connected. It is not a saved server; connect to it in FTP Browser first.`(`Call connect with server` 없음). 끊긴 RA 키는 지금처럼 `Call connect with server ${id} first.`                                                                                                                                                                                  |

### R3에서만 확인되는 것

jsdom·가짜 클라이언트로는 다음을 볼 수 없다(§12): preload를 거친 `ftp:getRecentPaths(conn)`의 인자 형태, 빌드된 앱의 인라인 SQL과 실제 옛 `cache.db`의 이전, 좁은 사이드바에서 출처 줄의 잘림, 실제 `ftpb` 출력의 문구.

---

## 9. 기각한 대안

- **다른 연결이 같은 host·port일 때만 사용자를 보이기** — 이름표가 다른 연결의 상태에 따라 바뀐다(두 번째 계정이 연결되는 순간 첫 탭의 이름이 바뀐다). `sourceLabel`을 쓰는 열 곳 남짓과 `getState()` 문맥(메뉴·토스트)이 모두 연결 목록을 알아야 하고, 렌더 중인 컴포넌트는 그 목록을 구독해야 한다. 기각(SH2).
- **익명도 `anonymous@`를 보이기** — 정보가 없는 글자가 거의 모든 익명 서버의 탭·메뉴에 붙는다. 익명과 이름 있는 계정은 접두어 유무로 구별된다. 기각(SH2).
- **활동 팝오버 목적지·연결 안 됨 패널도 `connLabel`로** — 이미 키를 보여 사용자가 구별된다. 익명의 `anonymous@`만 다르다. 바꿀 이유가 표기 통일뿐이라 범위 밖. 기각.
- **루트가 아닌 탭 이름에도 서버를 붙이기** — 다른 서버의 같은 이름 폴더도 지금 같은 이름이고, `title`이 출처를 보인다. 탭이 길어진다. 기각(SH3).
- **저장 서버를 (host, port, user)마다 여러 개 허용** — `idx_servers_host_port`, 저장 비밀번호 주소 규칙(E15), `recordConnection`의 "다른 계정은 시각만"이 모두 바뀐다. 이 결함(구별·지목)은 표시와 키로 풀린다. 범위 밖(§13 후속).
- **`server_recent_paths`에 `username` 열을 더하기** — `UNIQUE(server_host, server_port, path)`를 바꿀 수 없어 두 사용자의 같은 경로가 충돌한다. 테이블을 다시 만들려면 옛 테이블을 지워야 한다(추가만 허용). 기각(SH8, MC9와 같다).
- **새 테이블에 없으면 옛 테이블로 물러서 읽기** — `rb2`의 첫 연결이 다시 `ra`의 폴더에서 시작한다(O4 그대로). 기각.
- **옛 행을 모든 사용자에게 복사 / 옛 행 지우기** — 앞의 것은 O4 그대로, 뒤의 것은 추가만 허용 규칙 위반. 기각(SH9).
- **`ftp:getRecentPaths(host, port, user)` 3인자** — 모든 호출부가 이미 키를 갖고, 원격 채널의 인자가 키라는 MC3과 맞춘다. 기각(SH10).
- **MC18 ①의 host·port 유일 연결 물러서기 없애기** — `[사용자]` 결정(MC18)이다. 이 문서는 표시와 안내만 고친다. 후속(SH14).

---

## 10. i18n

**변경 없음.** 새 키도, 지우는 키도, 자리표시자 변경도 없다. 바뀌는 것은 기존 키에 넣는 값이다: `place.root`의 `{{source}}`, `sidebar.disconnect`의 `{{name}}`, `split.paneLeft/Right`의 `{{name}}`, `shelf.itemLabel`의 `{{source}}`, `toast.relayPartialRemoved`의 `{{server}}`가 `connLabel`을 받는다. 최근 위치의 `aria-label`(`` `${label} · ${connLabel}` ``)과 `title`은 탭 `title`(`TabStrip.tsx:88`)처럼 번역 없는 조합이다. 11개 로캘 파일은 고치지 않는다.

---

## 11. 구현 슬라이스

각 슬라이스는 커밋 하나 이상이고, 끝에 `npm run typecheck && npm run lint && npm test`가 통과하며 앱이 그대로 동작한다.

| 슬라이스         | 맡는 파일                                                                                                                                                                                                                                                                                                                                                   | 맡는 테스트                                                             | 끝 확인                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **S1 이름표**    | `src/shared/connKey.ts`(`connLabel`), `lib/sendItems.ts`(`sourceLabel`), `components/layout/Sidebar.tsx`(행 이름·둘째 줄·`title`·해제 이름, `Place.detail`, 최근 위치), `components/layout/StatusBar.tsx`, `stores/useTransferStore.ts`(토스트)                                                                                                             | 1140~1145, §7의 1020(행 이름·해제 이름)·1034·1039·1027                  | 개발 앱에서 같은 서버 두 계정의 사이드바 행·탭 이름·상태 표시줄이 다르다       |
| **S2 최근 경로** | `migrations/005_remote_recent_paths.sql`(신규), `src/main/db/database.ts`(인라인 + 한 번 복사), `src/main/db/servers.ts`(`getRecentPaths(key)`·`recordRecentPath`·`saveServer`·`deleteServer`), `src/main/ipc/ftpHandlers.ts`(채널 인자·기록), `src/main/mcp/agentOps.ts:158`, `Sidebar.tsx`(`ServerEntry`), `useServerStore.ts`, `ServerManagerDialog.tsx` | 1146~1154, §7의 821·1020(인자)·970·402·734 준비·servers.test·ConnectBar | 개발 앱에서 `rb2` 첫 연결이 `/`에서 시작, 두 서버 행이 각자의 최근 폴더        |
| **S3 MCP**       | `src/main/mcp/agentTarget.ts`(`savedOf`·`describe`), `src/main/mcp/mcpTools.ts`(`NEXT.AMBIGUOUS`·`get_status` 설명), `docs/handoff/agent-access.md`(SH15)                                                                                                                                                                                                   | 1155~1157, §7의 1004                                                    | `ftpb get-status`에서 `rb2`에 `serverId` 없음, `AMBIGUOUS`가 키 목록과 새 안내 |

---

## 12. 완료 기준

1. Test-1140~1157과 §7의 고친 테스트가 GREEN이고 기존 스위트 전체가 GREEN이다(실행 출력으로 확인). Test-1158·1159는 어디에도 쓰이지 않는다.
2. 각 테스트에 `// covers: Test-N`. `test.skip`·`.only`·빈 테스트 없음.
3. `npm run typecheck` · `npm run lint` 통과, 바꾼 파일에 `npx prettier --check` 통과. `npm run build:unpack` 뒤 `npm run smoke:packaged` 통과.
4. `stryker.config.json`의 `mutate`를 이번 변경분으로 다시 정하고 `break: 70` 통과. 이미 통째로 들어 있는 `src/shared/connKey.ts`·`src/main/mcp/agentTarget.ts`는 그대로 둔다. 바뀐 범위만(`git diff --unified=0 <merge-base> -- <file> | grep '^@@'`, import·타입 선언 제외) 더한다: `src/main/db/servers.ts`(`getRecentPaths`·`recordRecentPath`·`saveServer`의 경로 이동·`deleteServer`), `src/main/db/database.ts`(`005` 블록과 복사), `src/main/ipc/ftpHandlers.ts`(`ftp:getRecentPaths`·`ftp:list` 기록), `src/renderer/src/lib/sendItems.ts`(`sourceLabel`), `src/renderer/src/stores/useServerStore.ts`(`lastVisitedPath`), `src/renderer/src/stores/useTransferStore.ts`(토스트 줄). 컴포넌트(`Sidebar`·`StatusBar`·`ServerManagerDialog`)는 넣지 않는다(shelf 스펙 §14-4 방침). 이 변경으로 밀린 기존 항목의 줄 범위도 옮기고, `_comment_scope`에 "(7) 같은 호스트 다른 계정(docs/handoff/same-host-accounts.md §12-4)"을 더한다(다른 스펙의 항목은 남긴다).
5. R3 실측(아래)을 하고 결과 표를 이 문서 끝에 붙인다.
6. `docs/handoff/agent-access.md`가 SH15대로 고쳐졌다. `multi-connection.md`의 MC3·MC14·MC18·MC21과 §10 `toast.relayPartialRemoved` 행 앞에 `[same-host-accounts.md SHn이 고침: …]` 표시를 단다(explorer-shelf D1의 방식).
7. §13의 미결(SH9)에 사람의 답을 받았고, 답이 권장안과 다르면 그 결정·Test-1147을 고친 뒤 완료한다.

### R3 실측 계획

환경은 multi-connection R3(§14 결과)와 같다: 저장소 밖 venv의 pyftpdlib 2.2.0, A `127.0.0.1:2121`에 사용자 `ra`(홈 `remoteA/`)와 `rb2`(홈 `remoteA2/`), 두 홈에 `inbox/`·`photos/`. `npm run build:unpack` 뒤 패키지 앱 바이너리를 `--remote-debugging-port`·스크래치 `--user-data-dir`로 띄우고 CDP(`Runtime.evaluate`, 실제 입력 이벤트)로 조작·확인한다. 창이 가려질 때를 대비해 `--disable-renderer-backgrounding --disable-backgrounding-occluded-windows --disable-background-timer-throttling`. 스크린숏은 스크래치에만 둔다.

| 항목               | 확인 내용                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) 사이드바 행    | `ra`를 저장하고(비밀번호 저장) `rb2`는 툴바에서 다른 계정으로 연결. 두 행의 이름(`127.0.0.1`·`rb2@127.0.0.1`), 둘째 줄·`title`(`ra@…`·`rb2@…`), 해제 버튼 `aria-label`이 서로 다르다. `rb2` 행 해제 → `rb2`만 `disconnected`                                                                                                                                                                            |
| (b) 탭·메뉴·표시줄 | 두 루트 탭 이름이 "ra@127.0.0.1:2121 최상위"·"rb2@127.0.0.1:2121 최상위". 새 탭 메뉴·"보내기 ▸"·경로 막대 루트·상태 표시줄이 각 계정을 보인다. 사이드바를 가장 좁게 줄여도 겹치지 않는다                                                                                                                                                                                                                |
| (c) 최근 위치      | 두 계정에서 `/inbox`를 열면 "최근 위치"에 `inbox` 두 행이 각자 출처 줄(`ra@…`·`rb2@…`)과 함께 보이고, 누르면 그 계정의 탭으로 간다. 좁은 사이드바에서 폴더 이름보다 출처 줄이 먼저 잘린다                                                                                                                                                                                                               |
| (d) 최근 경로      | 새 userData에서 `ra`로 `/photos`를 연 뒤 `rb2`로 처음 연결 → `/`에서 시작한다. 두 서버 행 아래 최근 폴더가 각자 것이다. 앱을 다시 띄우고 각 계정으로 연결하면 각자 마지막 폴더에서 연다. DevTools `window.api.invoke('ftp:getRecentPaths', 'rb2@127.0.0.1:2121')`가 `rb2`의 경로                                                                                                                        |
| (e) 이전           | v1.3.0(`670eb0f`) 빌드로 `ra` 저장·여러 폴더 방문 → 그 userData를 복사해 새 빌드로 연다. `ra` 연결이 옛 마지막 폴더에서 시작하고, `sqlite3 cache.db 'select count(*) from server_recent_paths'`가 열기 전후 같다. 두 번째 실행에서 `remote_recent_paths` 행 수가 늘지 않는다                                                                                                                            |
| (f) 에이전트       | MCP를 켜고 `ra`·`rb2` 연결: `ftpb get-status`에서 `rb2`에 `serverId`·`name`이 없다. `ftpb list-directory --path /` → `AMBIGUOUS: 2 servers are connected: ra@127.0.0.1:2121 (id 1), rb2@127.0.0.1:2121. Pass server with one of the user@host:port keys listed.`(종료 코드 1). `--server rb2@127.0.0.1:2121` → `rb2` 목록. GUI에서 `rb2`를 끊고 같은 명령 → `NOT_CONNECTED … It is not a saved server…` |
| (g) 기존 기능      | 익명 서버 하나만 쓰는 흐름: 탭 이름·메뉴·토스트가 지금처럼 `host:port`. 저장 서버 하나·한 계정의 연결·마지막 폴더 열기·저장 서버 관리 창의 최근 경로가 그대로                                                                                                                                                                                                                                           |

---

## 13. 위험·미결·후속 과제

**미결(권장안 적용) — 사람 확인 필요**

- **SH9 옛 최근 경로의 이전**: 처음 한 번, 옛 행을 그 host·port의 저장 행 사용자에게 복사한다. 저장 행이 없는 host·port의 옛 행은 옮기지 않는다(옛 테이블에 남는다). 다른 안: 옮기지 않기(모두 `/`에서 다시 시작), 모든 사용자에게 복사(O4가 남아 기각).

**위험**

- **IPC 인자 형태는 렌더러 테스트가 잡지 못한다**(목 `window.api`). `ftp:getRecentPaths`의 호출부 누락은 개발 앱과 R3 (d)로만 걸러진다. 예전 형태로 부르면 `Invalid connection key.`로 실패하고, 호출부들은 실패를 빈 목록·`/`로 받는다(조용히 최근 폴더가 사라지는 모양).
- **이름표가 길어진다.** `user@host:port`는 사이드바 둘째 줄·탭 이름(루트)·메뉴에서 잘릴 수 있다. 잘려도 `title`에 전체가 있다.
- **옛 기록의 주인 추정**(SH9): 다른 계정으로 연 경로가 저장 계정의 기록으로 옮겨질 수 있다. 그 폴더가 없으면 `/`로 물러선다.
- **`server: <저장 id>`는 여전히 다른 사용자 연결로 갈 수 있다**(SH14). `get_status`가 그 연결에 `serverId`를 붙이지 않으므로 에이전트가 보는 정보와는 어긋나지 않지만, id를 넘긴 에이전트는 `rb2`를 받을 수 있다.

**후속 과제(이번 범위 밖)**: 같은 host·port의 계정마다 저장 서버를 두기(`idx_servers_host_port` 재설계), MC18 ①의 host·port 유일 연결 물러서기를 없앨지(사람 결정), 옛 `server_recent_paths` 테이블 정리, 에이전트 `list_directory`가 최근 경로를 기록할지(지금은 GUI의 `ftp:list`만 기록한다).

---

## 14. 관련 코드 포인터

| 파일                                                                                                                           | 역할                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`shared/connKey.ts`](../../src/shared/connKey.ts)                                                                             | `connKey`(빈 사용자 → `anonymous`), `parseConnKey`. `connLabel`을 더한다(SH2)                                                                                                                                       |
| [`renderer/.../lib/sendItems.ts`](../../src/renderer/src/lib/sendItems.ts)                                                     | `sourceLabel`(:45-48), `locLabel`(:51-58), `connectToServer`(:368)                                                                                                                                                  |
| [`renderer/.../components/layout/Sidebar.tsx`](../../src/renderer/src/components/layout/Sidebar.tsx)                           | `serverKey`(:53), `Place`(:65), `ServerRow`(:145, `title` :178, 해제 이름 :212), `ServerEntry`(:224, 최근 경로 :233-241, 둘째 줄 :248), `Servers`(:275, 저장 안 된 행 이름 :289, 저장 행 :294), 최근 위치(:346-359) |
| [`renderer/.../components/layout/TabStrip.tsx`](../../src/renderer/src/components/layout/TabStrip.tsx)                         | 탭 이름(:53), `title`(:88), 새 탭 메뉴(:248)                                                                                                                                                                        |
| [`renderer/.../components/layout/StatusBar.tsx`](../../src/renderer/src/components/layout/StatusBar.tsx)                       | 호스트(:43), 표시(:100-102)                                                                                                                                                                                         |
| [`renderer/.../stores/useTransferStore.ts`](../../src/renderer/src/stores/useTransferStore.ts)                                 | 부분 정리 토스트(:150-158)                                                                                                                                                                                          |
| [`renderer/.../stores/useServerStore.ts`](../../src/renderer/src/stores/useServerStore.ts)                                     | `lastVisitedPath`(:61-72), 연결 키(:166-167), 시작 폴더(:171)                                                                                                                                                       |
| [`renderer/.../components/server/ServerManagerDialog.tsx`](../../src/renderer/src/components/server/ServerManagerDialog.tsx)   | 저장 서버의 최근 경로(:74-91)                                                                                                                                                                                       |
| 다른 `sourceLabel` 사용처                                                                                                      | `Explorer.tsx`(:609 보내기 메뉴, :853 분할 패널), `PathBar.tsx`(:190-191), `Shelf.tsx`(:62, :202, :233), `InfoPanel.tsx`(:159), `PropertiesDialog.tsx`(:45), `SplitOverlay.tsx`(`locLabel` :59, :96)                |
| [`main/db/database.ts`](../../src/main/db/database.ts) · `migrations/`                                                         | 인라인 `server_recent_paths`(:58-65), 옛 DB용 생성(:103-114), `004` 블록 패턴(:199-226). `005`는 그 뒤                                                                                                              |
| [`main/db/servers.ts`](../../src/main/db/servers.ts)                                                                           | 주소 변경 시 경로 이동(:148-153), `recordConnection`(:170-223, 익명 `''` :175-176, 다른 계정은 시각만 :202-207), `deleteServer`(:349-361), `getRecentPaths`(:363-370)                                               |
| [`main/ipc/ftpHandlers.ts`](../../src/main/ipc/ftpHandlers.ts)                                                                 | `ftp:getRecentPaths`(:194-203), `ftp:list`의 최근 경로 기록(:221-249)                                                                                                                                               |
| [`main/mcp/agentTarget.ts`](../../src/main/mcp/agentTarget.ts)                                                                 | `savedOf`(:7-11, `?? at[0]`), `describe`(:14-18), `connectionOf`(:21-44), `refuseDisconnectedKey`(:47-58), `resolveTarget`의 `AMBIGUOUS`(:81-86)                                                                    |
| [`main/mcp/mcpTools.ts`](../../src/main/mcp/mcpTools.ts)                                                                       | `NEXT.AMBIGUOUS`(:93), `get_status` 설명(:243-247)·결과(:249-263)                                                                                                                                                   |
| [`main/mcp/agentOps.ts`](../../src/main/mcp/agentOps.ts)                                                                       | `connectSaved`의 마지막 폴더(:158)                                                                                                                                                                                  |
| [`main/mcp/__fixtures__/agentHarness.ts`](../../src/main/mcp/__fixtures__/agentHarness.ts)                                     | `createTestDb`(:33-49, 마이그레이션 파일 전부 → 옛 테이블), `addServer`(:332)                                                                                                                                       |
| [`renderer/.../components/explorer/explorerTestHarness.ts`](../../src/renderer/src/components/explorer/explorerTestHarness.ts) | 기본 서버 `anonymous@example.org:21`(:81), 최근 경로 목(:153)                                                                                                                                                       |

---

## 15. R3 결과 (2026-10-13, macOS)

환경: macOS 27.0.1, 이 워크트리의 S3 커밋(`8583d19`)을 `npm run build:unpack`으로 빌드했다. 서버는 저장소 밖 venv(`$TMPDIR/accounts-r3/venv`)의 pyftpdlib 2.2.0이다. A는 `ra`(홈 `remoteA/`)·`rb2`(홈 `remoteA2/`), 두 홈에 `inbox/`·`photos/`·`docs/`가 있고, B는 익명 전용이다. **포트는 계획의 2121·2122 대신 2141·2142**를 썼다(같은 시각 다른 작업의 R3 서버가 2121·2122를 쓰고 있었다). 그래서 키는 `ra@127.0.0.1:2141`·`rb2@127.0.0.1:2141`다.
앱은 `--remote-debugging-port=9332`·스크래치 `--user-data-dir`·`--disable-renderer-backgrounding --disable-backgrounding-occluded-windows --disable-background-timer-throttling`로 띄우고 CDP(`Runtime.evaluate`, `Input.dispatchMouseEvent`·`insertText`·`dispatchKeyEvent`)로 조작했다. 패키지 앱(`dist/mac-arm64/FTP Browser.app`)은 저장된 비밀번호를 풀 때 macOS가 '로그인' 키체인 암호를 묻는 창을 띄워(개발 서명 앱의 `ftp-browser Safe Storage` 항목) 거기서 멈췄다. 키체인 암호는 넣지 않고 앱을 강제 종료했다. 그래서 (a)~(g)는 같은 빌드 산출물(`out/`, `out/main`에는 `index.js`뿐이라 인라인 SQL 경로)을 `node_modules/electron`의 Electron 43 바이너리로 띄워 확인했다. v1.3.0은 `670eb0f`를 `git archive`로 풀어 `electron-vite build`한 것을 같은 바이너리로 띄웠다. 스크린숏은 스크래치 `accounts-r3/shots/`에만 있다.

| 항목               | 결과                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| (a) 사이드바 행    | 통과. 툴바로 `ra`(비밀번호 저장, 저장 행 id 1) 뒤 `rb2`를 연결했다. 행은 위에서부터 `rb2@127.0.0.1`(둘째 줄·`title` `rb2@127.0.0.1:2141`)과 `127.0.0.1`(둘째 줄·`title` `ra@127.0.0.1:2141`), 해제 버튼 `aria-label`은 `rb2@127.0.0.1:2141 연결 해제`·`ra@127.0.0.1:2141 연결 해제`. `rb2` 행의 해제 버튼을 누르자 `ftp:getStatus`가 `ra:connected`·`rb2:disconnected`                                                                                                                                                                                                         |
| (b) 탭·메뉴·표시줄 | 통과. 두 루트 탭 이름 `ra@127.0.0.1:2141 최상위`·`rb2@127.0.0.1:2141 최상위`, `title` `… · /`. 새 탭 메뉴 `ra@127.0.0.1:2141 › ra@127.0.0.1:2141 최상위`·`rb2@127.0.0.1:2141 › rb2@127.0.0.1:2141 최상위`. "보내기 ▸"는 `rb2@127.0.0.1:2141 › inbox`·`ra@127.0.0.1:2141 › inbox`처럼 계정을 보인다. 경로 막대 루트 `aria-label` `rb2@127.0.0.1:2141 최상위`. 상태 표시줄은 활성 탭에 따라 `rb2@127.0.0.1:2141 연결됨`·`ra@127.0.0.1:2141 연결됨`. 사이드바 최소 폭(180px)에서 행 이름·둘째 줄은 말줄임으로 잘리고 겹치지 않는다                                                |
| (c) 최근 위치      | 통과. 두 계정에서 `/inbox`를 열고 나오자 `inbox · rb2@127.0.0.1:2141`(`title` `rb2@127.0.0.1:2141 · /inbox`)과 `inbox · ra@127.0.0.1:2141` 두 행이 출처 줄과 함께 보였다. `rb2`의 것을 누르자 활성 탭이 `rb2@127.0.0.1:2141 · /inbox`(파일 `rb2-note.txt`). 180px에서 폴더 이름(`inbox` 32px)은 그대로이고 출처 줄만 73px로 잘렸다                                                                                                                                                                                                                                             |
| (d) 최근 경로      | 통과. 새 userData에서 `ra`로 `/photos`를 연 뒤 `rb2`로 처음 연결하자 `rb2@127.0.0.1:2141 최상위`(`/`) 탭으로 열렸고 `ftp:getRecentPaths('rb2@127.0.0.1:2141')`는 처음에 빈 목록이었다. `ra`를 `/photos`, `rb2`를 `/inbox`에 두고 앱을 다시 띄운 뒤 저장 행(`ra`)과 툴바(`rb2`)로 연결하자 각각 `/photos`·`/inbox` 탭으로 열렸고, `ra` 행 아래 `photos`·`ra@… 최상위`·`inbox`, `rb2` 행 아래 `inbox`·`rb2@… 최상위`가 따로 보였다. DevTools의 `window.api.invoke('ftp:getRecentPaths', 'rb2@127.0.0.1:2141')`는 `[/inbox, /]`                                                   |
| (e) 이전           | 통과. v1.3.0으로 `ra`를 저장하고 `/inbox`→`/`→`/docs`→`/`→`/photos`를 열었다(옛 `server_recent_paths` 4행, `remote_recent_paths` 없음). 그 userData 사본을 새 빌드로 열자 `remote_recent_paths`에 `ra`의 4행이 `last_visited` 그대로 생겼고 옛 테이블은 4행 그대로였다(멈추기 전의 패키지 앱도 같은 결과). 저장 행을 눌러 연결하자 옛 마지막 폴더 `/photos` 탭으로 열렸다. 두 번째 실행 뒤에도 `server_recent_paths` 4행·`remote_recent_paths` 4행                                                                                                                             |
| (f) 에이전트       | 통과. MCP를 켜고 `ra`·`rb2`가 연결된 상태에서 `ftpb get-status`는 `ra`에만 `serverId: 1`이 있고 `rb2`에는 `serverId`·`name`이 없다. `ftpb list-directory --path /`는 `AMBIGUOUS: 2 servers are connected: ra@127.0.0.1:2141 (id 1), rb2@127.0.0.1:2141. Pass server with one of the user@host:port keys listed.`(종료 코드 1). `--server rb2@127.0.0.1:2141`는 `rb2`의 목록(`/inbox`에 `rb2-note.txt`). GUI에서 `rb2`를 끊은 뒤 같은 명령은 `NOT_CONNECTED: rb2@127.0.0.1:2141 is not connected. It is not a saved server; connect to it in FTP Browser first. …`(종료 코드 1) |
| (g) 기존 기능      | 통과(토스트 제외). 익명 서버 B만 쓰는 새 userData: 행 이름 `127.0.0.1`·둘째 줄 `127.0.0.1:2142`·해제 버튼 `127.0.0.1:2142 연결 해제`, 새 탭 메뉴 `127.0.0.1:2142 › 127.0.0.1:2142 최상위`, 탭 `127.0.0.1:2142 최상위`, 상태 표시줄 `127.0.0.1:2142 연결됨`(`anonymous@` 없음). 끊고 원격 탭을 모두 닫은 뒤 저장 행을 골라 연결하자 마지막 폴더 `/docs` 탭으로 열렸다. 서버 관리자에서 그 서버의 시작 폴더 후보가 `/`·`/docs`. 부분 정리 토스트는 실제 앱에서 띄우지 않았다(Test-1027이 문구를 본다)                                                                            |

관찰(이 문서의 범위 밖, 고치지 않았다):

1. 최근 위치의 원격 **루트** 항목은 이름이 이미 `ra@127.0.0.1:2141 최상위`라 출처 줄이 같은 키를 한 번 더 보이고, 폭이 모자라면 출처 줄은 0폭으로 사라진다(SH5대로이고 `title`에 전체가 있다).
2. 끊긴 비저장 키의 `NOT_CONNECTED` 뒤에 공통 다음 행동 "Call connect with a saved server from list_servers, then retry."가 붙는다(`NEXT.NOT_CONNECTED`). "It is not a saved server"와 함께 읽으면 어색하다.
3. 패키지 앱이 저장된 비밀번호를 풀 때 키체인 암호 창을 띄운다(개발 서명 빌드와 키체인 항목의 접근 목록 문제로 보인다). 앱 코드 변경과 무관하다. 그 창은 앱을 종료한 뒤에도 화면에 남았다.
4. `npm run smoke:packaged`는 이 Mac에서 `[smoke] renderer ready` 뒤 30초 시간 초과로 실패했다. 리뷰 수정 뒤 다시 확인했다: 이 브랜치(호스트 대소문자 수정 포함)와 기준 커밋 `112eb4f`(`git archive`로 풀어 같은 `node_modules`로 `npm run build:unpack`)가 모두 `[smoke] renderer ready` 뒤 `Packaged app smoke test timed out after 30000ms`로 같게 실패한다. 렌더러 준비는 통과하고 앱 종료에서만 멈추므로 이 변경의 회귀가 아니다. 이 브랜치의 CI 실행은 아직 없다: 병합 전 PR의 CI(macOS arm64/x64 포함) `smoke:packaged` 통과를 확인한다.
5. §13의 미결 SH9(옛 최근 경로 이전)는 권장안으로 구현했고 사람의 답을 아직 받지 않았다. 완료 기준 7이 남아 있다: 병합 전에 답을 받고, 권장안과 다르면 SH9·Test-1147·`migrateRemoteRecentPaths`를 고친다.

R3 뒤 리뷰 수정: `remote_recent_paths`의 쓰기가 호스트 대소문자를 가렸다. SH9 복사는 옛 행의 철자(`NAS.local`)를 두는데 저장 행은 `nas.local`이면, `deleteServer`·주소 변경이 그 행을 놓치고 읽기(대소문자 무시)는 되살렸으며, 같은 폴더를 `nas.local`로 다시 열면 두 행이 생겼다. SH8대로 쓰기도 대소문자를 가리지 않게 고쳤고 Test-1148·1149에 그 경우를 더했다. 앱에서 다시 실측하지는 않았다(단위 테스트로 확인).
