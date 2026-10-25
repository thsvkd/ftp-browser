# 핸드오프: 멀티 커넥션 기반 스플릿 — 서버 드래그로 분할하고 자동 연결하기

R1에서 인간과 합의한 내용의 고충실도 기록. R2(테스트 코드 작성)·구현의 유일한 입력이다.
이 문서에 없는 케이스는 완료 범위 밖이다. 새 케이스를 추가하거나 기존 케이스를 재해석하지 말 것.

작업 유형(R0): **구조 변경 + 기능 추가**. RED 테스트를 먼저 세운 뒤 GREEN으로 만든다.

선행 작업: **없다.** 구현 순서는 1 → 4 → 3 → 2 → 6 → 5로 이 스펙이 마지막이다. 다만 다음 관계를 지킬 것.

- [`shelf-floating-remote.md`](./shelf-floating-remote.md)(6번)은 **선반에서 끌 수 있게 하는 것까지만**
  정하고, "미연결 서버 탭에 놓으면 2단계로 간다"는 흐름은 **이 스펙의 M19·Test-929~931로 옮겨 뒀다.**
  6번이 먼저 구현돼도 그 플로우는 여기서 열린다.
- [`server-connect-activation.md`](./server-connect-activation.md)(1번): 이 스펙의 "자동 연결"은 그
  규칙(`connectSaved`)을 그대로 쓴다. **연결 로직을 새로 만들지 말 것.**

**작업량 경고:** R1에서 인간이 "멀티 커넥션 구축"을 선택하며 스펙 3~5개 분량이라는 전제를
받아들였다. 이 문서는 그 **한 스펙**이지만 §2의 Phase A→A′→B→C를 순서대로 GREEN으로 만들어야 한다.
Phase A 없이는 A′·B·C가 성립하지 않는다.

---

## 1. 문제 정의

사용자 피드백 (5번):

> 서버 탭에서 서버를 드래그앤 드롭하여 스플릿 할 수도 있게 하자. 이 경우 자동으로 연결하는
> 동작을 겸한다. 연결이 바로 되지 않거나 실패하는 경우 uiux를 정한다: 일단 스플릿 뷰를 만들고
> 스플릿된 칸에 스피너가 돌든 플레이스홀더가 있든 연결 시도중이라는 것을 알 수 있게 한다 →
> 타임아웃/연결 실패 시 모달을 띄우고 백그라운드에 있는 스플릿 뷰는 원래대로 돌아간다.

그리고 6번의 후반부:

> 항목들을 위쪽 탭으로 끌어오는 경우 프로그레스바가 떠서 다 차면 다른 스플릿 영역이 해당
> 디바이스의 것으로 열리고 다시 아래로 끌어와서 어떤 폴더로 복사할 것인지 결정할 수 있게.

### 이 요청을 지금 구조로는 못 만든다 (두 가지)

**1) 앱은 서버를 하나만 연결한다.**
`registerFtpHandlers`는 **`FtpConnectionManager`를 하나 만들어** 그대로 붙잡고 있다
([`ftpHandlers.ts:48`](../../src/main/ipc/ftpHandlers.ts#L48)). 전송 큐·클라이언트 풀
(`transferHandlers.ts:41-42`), 썸네일 큐(`ThumbnailQueue`가 `ftpManager.getHost()`로 캐시 키를 만든다),
프리뷰 핸들러, 에이전트(`agentOps`)까지 **전부 그 하나의 매니저**를 쓴다.
렌더러도 마찬가지다: `useServerStore.connect`는 **새 서버에 연결하기 전 반드시 기존 연결을 끊는다**
([`useServerStore.ts:160`](../../src/renderer/src/stores/useServerStore.ts#L160)).

그래서 "두 칸에 서로 다른 서버"는 애초에 불가능하다. 한 칸을 다른 서버로 바꾸면 나머지 칸의
목록은 [`gate: 'other'`](../../src/renderer/src/components/explorer/Explorer.tsx#L129) 패널로
죽는다. 6번의 "선반 항목을 어떤 디바이스로 보낼지"도 같은 벽에 부딪힌다:
`planSend`가 `send.invalidOtherServer`(연결이 아닌 다른 서버)로 거부한다
([`sendPlan.ts:69-70`](../../src/renderer/src/lib/sendPlan.ts#L69-L70)).

**2) 스플릿 레이아웃 자체가 없다.**
`<main>` 안에는 TabStrip과 Explorer 하나씩뿐이다([`AppShell.tsx:119-122`](../../src/renderer/src/components/layout/AppShell.tsx#L119-L122)),
탭은 전역 `tabs` 배열 하나에 `activeId` 하나로 관리된다(`useTabsStore`).

따라서 이 스펙은 **(A) 세션화 → (B) 분할 레이아웃 → (C) 드롭 플로우**의 순서로 간다.

---

## 2. 핵심 결정 (R1에서 인간이 확정)

### Phase A — 세션화 (메인 + 렌더러 저장소)

| #   | 결정                                                                                                                                                                                                                                                             | 근거                                                                                                                                                                              |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | **세션 키 = 서버 키** `"user@host:port"`(렌더러 `serverKey`와 같은 형식). 로컬은 세션이 없다                                                                                                                                                                     | `Loc.server`·썸네일 캐시 키·목록 캐시 키가 이미 이 형식이다(`explorerEntry.ts:69`)                                                                                                |
| M2  | 메인에 **`FtpSessionRegistry`**: `Map<세션키, FtpConnectionManager>`. `ftp:connect`는 **로그인 정보에서 세션 키를 뽑아** 그 세션의 매니저를 쓴다                                                                                                                 | 채널 인자를 늘리지 않고도 connect를 세션화할 수 있다. 저장 비밀번호·DB 기록 경로는 그대로다                                                                                       |
| M3  | **기존 채널에는 `server` 인자를 덧붙이고, 생략되면 `primary` 세션을 쓴다.** `primary`는 가장 최근에 연결을 시도/성공한 세션                                                                                                                                      | 새 채널을 만들면 핸들러·허용목록·유니언 3곳을 등록해야 한다(AGENTS의 3곳 규칙). 인자 추가는 등록이 필요 없다. **MCP·아직 세션 인자를 안 넣은 호출부는 primary로 그대로 동작**한다 |
| M4  | FTP·전송·썸네일·프리뷰 채널에 `server` 인자를 붙인다: `ftp:list`, `ftp:downloadPreview`, `ftp:rename`, `ftp:deleteBatch`, `ftp:mkdir`, `thumbnail:request`/`requestBatch`, `gallery:remoteFolderPreview`, `transfer:send`, `transfer:enqueue*`, `transfer:retry` | 목록·미리보기·전송이 세션마다 다르게 돌아야 두 칸이 각기 다른 서버를 읽는다. `local:*`·`cache:*`·`update:*`·`mcp:*`는 세션 무관이라 **건드리지 않는다**                           |
| M5  | 이벤트에 **세션 태그**를 넣는다: `ftp:connectionStatus`, `ftp:remoteChanged`, `transfer:updated`의 페이로드에 `server` 필드 추가                                                                                                                                 | 하나의 창이 여러 세션의 알림을 받는다. 태그가 없으면 한 칸의 상태가 다른 칸을 덮는다                                                                                              |
| M6  | 렌더러 `useFtpStore`는 **`sessions: Record<세션키, FtpConnectionState>`**를 갖고, 기존 `connectionStatus`·`host`·`port`·`username`은 **`primary` 세션의 투영**으로 남긴다                                                                                        | 기존 소비자(툴바·상태바·사이드바)가 깨지지 않는다. 게이트·전송 계획만 세션 기준으로 바꾼다                                                                                        |
| M7  | **원격 탭의 게이트는 `loc.server`의 세션 상태를 본다** — "지금 활성 세션과 같은가"가 아니라 "그 서버가 연결돼 있는가"                                                                                                                                            | 두 칸이 동시에 `live`가 되는 유일한 길이다. `SendConnection`·`currentConnection()`도 이 의미로 바꾼다                                                                             |
| M8  | **연결 시도(시도 자체)는 한 번에 하나.** 연결된 세션은 여러 개가 공존한다                                                                                                                                                                                        | `useServerStore.connect`의 단일 플라이·`connectAttempt` 취소 규칙(`L141,151,161`)을 그대로 살린다. 시도 경합까지 풀면 취소·중복 방지 로직을 다시 써야 한다                        |
| M9  | **에이전트(MCP)는 건드리지 않는다.** 서버 인자를 안 주는 호출은 전부 `primary`를 쓴다(M3)                                                                                                                                                                        | MCP 계약(`agent-access.md`)·테스트 450개 체계를 건드리는 것은 이 스펙의 목적이 아니다                                                                                             |

### Phase A′ — R2에서 발견한 두 공백 (R1 정정)

Phase A를 RED→GREEN으로 끝낸 구현자가 보고했다. **메인은 세션 인자를 받지만 렌더러가 아직 그
인자를 보내지 않고**, **전송 실행(큐·풀)이 primary에 묶여 있다.** 둘 다 그대로 두면 두 패널이
모두 primary의 목록을 읽고, primary가 아닌 서버로 파일이 **잘못 전송**된다. Phase B·C가 성립하려면
먼저 메워야 하므로 케이스를 새로 잡는다(기존 `Test-906`~`931`은 그대로 유효하다).

| #   | 결정                                                                                                                                                                                                                            | 근거                                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A′1 | **렌더러가 세션 귀속 IPC에 세션 키를 보낸다**: `ftp:list`, `ftp:downloadPreview`, `ftp:rename`·`ftp:deleteBatch`·`ftp:mkdir`, `thumbnail:*`, `gallery:remoteFolderPreview`, `transfer:send`. 세션이 없는 호출은 인자를 생략한다 | M4의 "선택 인자 + primary" 계약은 메인만으로는 끝나지 않는다. 렌더러가 안 보내면 **모든 탭이 primary를 읽는다** — 두 칸 동시 보기라는 목적이 그대로 깨진다                                                                                                   |
| A′2 | 전송 **실행**도 그 세션의 매니저·풀로 간다. `transfer:enqueue`·`retry`·`cancel`를 포함하고, 작업은 세션을 싣고 다닌다 (M4의 "그 세션의 매니저·풀"이 실행까지 뜻함)                                                              | 계획만 세션 분리돼 있으면 **다른 서버로 파일이 올라간다.** 데이터가 틀린 곳으로 가는 것은 "안 되는 것"보다 나쁘다                                                                                                                                            |
| A′3 | 렌더러가 보내는 세션 키는 **`loc.server`(탭) 또는 항목의 `server`** 에서 나온다. 활성(.primary) 세션을 대신 쓰지 않는다                                                                                                         | 활성 세션 기반의 판정은 함정 E가 이미 없앤 것이다                                                                                                                                                                                                            |
| A′4 | 세션 키를 못 고르는 호출(로컬 항목, 임시·에이전트 발주)은 **인자를 생략해 primary로** 간다                                                                                                                                      | M3의 하위 호환 경로가 그대로다. 새 분기를 만들 필요가 없다                                                                                                                                                                                                   |
| A′5 | **렌더러 썸네일 캐시 키도 탭의 세션 기준**으로 만든다: `FileGrid`·`ThumbnailImage`·**`RemoteFolderThumbnail`(폴더 미리보기)**가 `useFtpStore`의 host·port(= primary 투영)를 쓰던 것을 `loc.server`/항목의 세션에서 뽑는다       | main은 세션의 host·port로 키를 만들고(`Test-911`), 렌더러가 primary로 키를 만들면 **비-primary 패널의 썸네일이 영영 도착하지 않는다**(요청은 되지만 답을 못 찾음). 두 칸 동시 보기의 기본기. **세 곳 모두**가 대상이다 — 한 곳이라도 남으면 그 종류만 깨진다 |

새 케이스 (`Test-932`~`937`, §6의 Phase A′·Phase C 절에 배치한다):

| #        | 위치                                    | 케이스                                                                                                   |
| -------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Test-932 | `stores/useListingStore.test.ts`        | 원격 탭의 목록 요청이 **그 탭의 세션 키**를 인자로 보낸다 — 비-primary 세션이 primary 목록을 읽지 않는다 |
| Test-933 | `stores/useTransferStore.test.ts`       | 전송·원격 삭제·썸네일 요청에도 **세션 키**가 간다 (항목/목적지의 `server`에서)                           |
| Test-934 | `src/main/ipc/transferHandlers.test.ts` | 비-primary 세션에서 enqueue한 전송이 **그 세션의 풀**으로 실행된다 (두 가짜 매니저로 분리 검증)          |

### Phase B — 분할 레이아웃

| #   | 결정                                                                                                                         | 근거                                                                                                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| M10 | 패널은 **1 또는 2개**. `panes: [{ id, tabIds, activeTabId }]`, 탭은 기존 `tabs` 배열에 **`paneId`** 하나만 추가              | 탭 전체를 새 구조로 옮기면 `navigate`·`cycleTab`·`adoptRemote`·`recent`가 전부 갈린다. 탭은 그대로 두고 소속만 표시한다 |
| M11 | **각 패널이 자기 TabStrip을 가진다.** 활성 탭도 패널마다 따로, `useTabsStore.activeId`는 "지금 포커스가 있는 패널의 활성 탭" | 한 줄짜리 공통 탭 스트립으로는 두 칸의 탭을 구분할 수 없다. F6·단축키는 기존 `activeId`를 그대로 쓴다                   |
| M12 | **패널을 닫으면 그 패널의 탭은 남은 패널로 옮긴다**(탭을 잃지 않는다). 마지막 패널은 닫지 않는다                             | 기존 "마지막 탭은 닫지 않는다" 규칙과 방향이 같다. 패널을 닫는 행위가 파일 위치 기억을 지우는 건 바람직하지 않다        |
| M13 | 새 패널은 **분할된 쪽에 새 탭을 하나** 만든다 (연결이 끝나면 채운다 — Phase C의 pending 칸)                                  | 분할 = "그쪽 자리에 하나의 탭이 더 생긴다"가 가장 단순한 해석이다                                                       |

### Phase C — 서버 드래그 → 분할 → 자동 연결

| #   | 결정                                                                                                                                                                                                                                                                    | 근거                                                                                                                                                  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| M14 | **드래그 소스**: 사이드바 서버 행을 끌 수 있다. `useDnd`에 `server: FtpServer \| null` 필드를 추가해 `items`(항목 드래그)와 구분한다                                                                                                                                    | `useDnd`는 한 번에 한 종류만 들 수 있다. 항목과 서버가 섞이면 놓기 대상의 판정이 갈린다                                                               |
| M15 | **놓는 자리**: 메인 콘텐츠 영역의 **왼쪽/오른쪽 절반**. 호버한 쪽의 절반이 하이라이트되고 그쪽에 새 패널이 생길 것을 예고한다. 그냥 본 영역 중앙에 놓으면 **기존대로 전환 + 탭**                                                                                        | "어디에 놓아야 분할인가"를 한눈에 알게 한다. 분할이 아닌 전환 경로는 지금과 같다                                                                      |
| M16 | **UI/UX 순서(사용자 지정 그대로)**: ① 놓으면 **즉시 패널이 생기고 그 안에 연결 시도 중 스피너·플레이스홀더**가 뜬다 → ② **성공**하면 그 패널에 서버 탭이 열린다 → ③ **실패 또는 20초 타임아웃**이면 **모달을 띄우고 패널을 드롭 전 상태로 되돌린다**                    | 사용자가 명시한 흐름. 패널이 뒤늦게 생기면 "놓았는데 아무 일도 없다"가 된다                                                                           |
| M17 | 타임아웃은 **렌더러가 20초**로 재고, 그때 `useServerStore.cancel()`로 **시도를 취소**한다. 모달의 확인 버튼은 "닫기" 하나                                                                                                                                               | `cancel`이 이미 시도를 무효화한다(`connectAttempt++`, `useServerStore.ts:207-210`). 시도를 백그라운드에 남기면 뒤늦은 성공이 되돌아온 패널을 되살린다 |
| M18 | **되돌리기의 정의**: 드롭으로 새로 만든 패널이었다면 **패널 자체를 제거**하고, 이미 있던 패널이었다면 **활성 탭만 원래 탭으로** 되돌린다                                                                                                                                | 스플릿 뷰는 "원래대로 돌아간다"는 요구의 정확한 기준이다                                                                                              |
| M19 | **선반의 2단계 흐름**: 선반 항목을 **연결되지 않은 서버의 탭**에 놓으면 → 전송하지 않고 ①연결(분할 + 스피너) → ②성공 시 그 서버 패널 개설(**선반 항목은 그대로**) → ③사용자가 다시 그 패널로 끌어 폴더를 지정한다. **이미 연결된 서버의 탭**이면 현행대로 바로 전송한다 | 사용자가 "2단계 유지"를 선택했다. 목적 폴더를 못 보는 상태에서 보내는 것은 불가능하므로 2단계는 연결 전에만 존재한다                                  |
| M20 | 새 i18n 키 **4개**만: `split.dropHint` · `split.connectFailedTitle` · `split.connectFailedBody` · `split.closePane`. "연결 시도 중" 안내는 기존 `sidebar.serverConnecting` 재사용                                                                                       | 키 최소화 — 새 문구가 실제로 렌더링될 때만 키를 만든다                                                                                                |
| M21 | **분할을 닫을 방법을 제품에 반드시 둔다**: 두 패널 사이 구분선(또는 두 번째 패널의 탭 스트립)에 닫기控件을 두고 `closePane`을 부른다                                                                                                                                    | M12의 `closePane`이 **테스트에서만 호출**되면 사용자는 두 번째 패널로 영영 돌아갈 수 없다. 결정에 트리거가 없는 것은 구멍이다                         |

---

## 3. 구현 함정

### 함정 A — 썸네일 큐가 "그 매니저의 호스트"로 캐시 키를 만든다

`ThumbnailQueue.cacheKeyOf`는 `this.ftpManager.getHost()`/`getPort()`를 쓴다
([`ThumbnailQueue.ts:69-76`](../../src/main/thumbnail/ThumbnailQueue.ts#L69-L76)) 그리고 요청에
**host/port가 없다.** 두 세션의 목록을 동시에 띄우면 **한쪽 파일이 다른 쪽 호스트의 키로 캐시**된다 —
조용한 오염이다. 요청에 세션을 식별시키거나(인자 추가, M4), 큐를 세션마다 하나씩 만들어야 한다.
`Test-911`이 이를 고정한다. 프리뷰 핸들러(`previewHandlers.ts:58-60`)도 `ftpManager.getHost()`를
쓰므로 같은 문제가 있다(`Test-910`).

### 함정 B — 전송 계획이 `manager.list` 하나를 본다

`transfer:send`의 `planDeps.list = (dir) => manager.list(dir)`(`transferHandlers.ts:76-80`) —
세션을 무시한다. 두 세션에서 동시에 보내기를 하면 **다른 서버의 목록으로 충돌을 판단**한다.
`server` 인자로 그 세션의 매니저를 넘겨야 하고, 연결 확인(`manager.isConnected()`, L85)도 그
세션이어야 한다(`Test-912`).

### 함정 C — `connect`가 기존 세션을 끊는다

`useServerStore.connect`의 `if (ftp.connectionStatus === 'connected') await ftp.disconnect()`
(`L160`)은 단일 연결 시대의 코드다. 그대로 두면 **두 번째 세션에 연결하는 순간 첫 칸이 죽는다.**
세션화의 시금석이며 `Test-916`이 먼저 레드여야 한다. 반대로 **같은 세션에 다시 연결**할 때는
이전 매니저를 정리해야 한다(중복 매니저 누수) — `FtpSessionRegistry`가 그 세션의 기존 매니저를
닫고 갈아끼운다.

### 함정 D — 이벤트 태그 없는 알림이 칸을 덮는다

`ftp:connectionStatus`는 `{ status, host?, error? }`뿐이라 **어느 서버의 상태인지 모른다**
([`ftp.ts:106-110`](../../src/shared/types/ftp.ts#L106-L110)). 태그를 빼먹으면 세션 B의
연결 실패가 세션 A의 칸에 `error`로 표시된다. `useFtpStore`는 `server`로 `sessions`를 갱신하고,
primary 투영도 그때그때 다시 계산해야 한다(`Test-913`·`Test-914`).

### 함정 E — `planSend`의 "다른 서버" 판정이 활성 세션 기준이다

`SendConnection`은 `{ connected, server }` 두 값이라 **목적지 세션을 표현할 수 없다.**
`useDropTarget`·`Shelf`·`Explorer`가 `currentConnection()`을 만들어 넣고 있으므로 이 셋이 같이
바뀌어야 한다. 빠뜨리면 6번의 M19(선반 2단계)가 동작하지 않는다 — **연결돼 있는데도
`invalidOtherServer`로 거부된다.** `Test-917`이 레드여야 하는 이유다.

### 함정 F — 패널 전환 시 `over` 상태와 스프링이 남는다

분할 미리보기(호버 하이라이트)는 `useDnd.over`를 새 키로 쓰는데, 놓은 순간 패널이 생기면서
렌더 트리가 갈린다. 기존 `TabPill`·`Place`의 스프링(`springMs` 후 `activate`)은 **패널이 새로
만들어지는 순간 `spring`이 아직 등록되지 않은 상태**일 수 있다. 분할 생성은 스프링이 아니라
**놓기(`onDrop`)에서 직접** 해야 한다. (`Test-924`가 "놓자마자 패널이DOM에 있다"를 단언한다.)

### 함정 G — F6 사이클과 `data-region="content"`

`REGIONS`의 셋째 지역이 `[data-region="content"] [id^="explorer-list-"]`다. 두 패널이 되면
**첫 번째만** 잡힌다(첫 일치). 패널별 `data-region="content-{paneId}"`로 바꾸거나, F6이 현재
활성 패널을 먼저 찾도록 해야 한다. 이 스펙의 테스트는 아우르지 않으므로 **§8의 E2E 표에 남긴다**
(단독 테스트 케이스를 만들지 않는 것은, 포커스 이동을 jsdom에서 신뢰성 있게 재현하기 어렵기 때문이다).

### 함정 H — `adoptRemote`가 "첫 원격 탭"을 고른다

연결 성공 시 원격 탭을 옮기는 `adoptRemote`는 `current()`가 원격이 아니면 **첫 원격 탭**을
고른다(`useTabsStore.ts:175-187`). 두 패널에 원격 탭이 여러 개면 **다른 패널의 탭**을 옮길 수
있다. 세션(서버)이 같은 탭만 고르도록 `server` 조건을 추가해야 한다.

---

## 4. 대상 API

```ts
// src/main/ftp/FtpSessionRegistry.ts (신규)

/**
 * 서버 키("user@host:port")별 FTP 매니저. 없이 요청하면 `primary`를 쓴다(M3).
 * 같은 키는 같은 매니저를 쓰고, connect가 다시 들어오면 기존 매니저를 닫고 갈아낀다(함정 C).
 */
export class FtpSessionRegistry {
  private sessions = new Map<string, FtpConnectionManager>()
  private primary: FtpConnectionManager

  /** M3: 인자가 없으면 primary. 있으면 그 세션(없으면 새로 만든다). */
  get(server?: string): FtpConnectionManager
  /** M2: 로그인 페이로드에서 세션 키를 뽑아 등록하고 primary로 지정한다. */
  put(login: FtpConnectPayload, manager: FtpConnectionManager): string
  /** M5: 이벤트를 보내기 위한 세션 키 ↔ 매니저 대응. */
  keyOf(manager: FtpConnectionManager): string | undefined
  disconnect(server?: string): Promise<void>
}
```

```ts
// 채널 인자 추가 (M4) — 기존 채널이라 허용목록·유니언은 바뀌지 않는다
'ftp:list'(server: string | undefined, path: string)
'ftp:downloadPreview'(server: string | undefined, req: PreviewRequest)
'thumbnail:request'(server: string | undefined, req: ThumbnailRequest)     // + requestBatch
'transfer:send'(server: string | undefined, req: TransferSendRequest)
'ftp:deleteBatch' | 'ftp:rename' | 'ftp:mkdir' | ... (server 선두 인자)

// 이벤트 페이로드 (M5)
interface FtpConnectionState { status; host?; port?; username?; server?: string; error? }
interface TransferUpdate { upserts; removedIds; server?: string }
```

```ts
// src/renderer/src/stores/useFtpStore.ts (M6·M7)

interface FtpStore {
  /** 세션별 상태. 키는 서버 키(M1). */
  sessions: Record<string, FtpConnectionState>
  /** 가장 최근에 시도/성공한 세션의 투영 — 기존 필드는 그대로 둔다. */
  connectionStatus: ConnectionStatus
  host: string
  port: number
  username?: string
  error?: string
  // 기존 connect/disconnect 는 server 인자를 받는다: connect(server?, payload)
}
/** M7: 그 서버(또는 로컬)가 연결돼 있는가. 게이트·전송 계획이 이것을 쓴다. */
export function isConnectedServer(server: string | null | undefined): boolean
export function useConnectionFor(loc: Pick<Loc, 'side' | 'server'>): { connected: boolean }
```

```ts
// src/renderer/src/stores/useTabsStore.ts (M10~M13)

interface Pane {
  id: string
  tabIds: string[]
  activeTabId: string
}
interface TabsStore {
  tabs: Tab[] // Tab에 paneId 추가
  panes: Pane[] // 길이 1~2
  activeId: string // 활성 패널의 활성 탭(기존과 같은 의미)
  split: (paneId: string, opts?: { pending?: PendingConnect }) => string // 새 패널 id
  closePane: (paneId: string) => void // M12: 탭은 이전
  activatePane: (paneId: string) => void
  // openTab·closeTab·navigate·cycleTab 은 자기 패널 범위에서만 돈다
}
```

```ts
// 드래그 소스 (M14) — src/renderer/src/components/explorer/dnd.ts
interface DndState {
  /* ... */ server: FtpServer | null
}
export function startServerDrag(e: DragEvent, server: FtpServer): void

// 놓기 대상 (M15) — Explorer의 콘텐츠 영역
const half = useSplitDropTarget(`split:${paneId}`, paneId, side /* 'left' | 'right' */)
// 놓으면: tabs.split(paneId, { pending: { server, side } }) + void connectSaved(server)
```

**연결 시도(M16~M18)의 한 흐름:**

```ts
async function connectIntoPane(
  paneId: string,
  server: FtpServer,
  revert: () => void
): Promise<void> {
  const timer = setTimeout(() => useServerStore.getState().cancel(), SPLIT_CONNECT_TIMEOUT_MS) // 20s
  try {
    const ok = await connectSaved(server) // 1번 스펙의 규칙을 그대로 쓴다
    if (ok)
      useTabsStore
        .getState()
        .openInPane(paneId, { side: 'remote', path: '/', server: serverKey(server) })
    else showConnectFailed() // M18: 모달 → 닫으면 revert()
  } finally {
    clearTimeout(timer)
  }
}
```

새 i18n 키 (**4개**, `en.ts` + 10개 로케일):

| 키                         | 예시 (en)                                         |
| -------------------------- | ------------------------------------------------- |
| `split.dropHint`           | `Drop here to open this side`                     |
| `split.connectFailedTitle` | `Could not connect to {{name}}`                   |
| `split.connectFailedBody`  | `Check the address and password, then try again.` |
| `split.closePane`          | `Close this half`                                 |

(`연결 시도 중` 안내는 기존 `sidebar.serverConnecting`을 쓴다 — 새 키를 만들지 않는다.)

---

## 5. 기각한 대안

- **단일 연결 유지 + 스플릿은 보기만(축 B)** — 한 칸이 `other` 패널로 죽기 때문에 "두 서버 동시
  보기"라는 목적을 이루지 못한다. R1에서 기각.
- **스플릿 없이 전환 + 새 탭(축 C)** — 1번 규칙 통일은 되지만 5·6번 요구(스피너·복귀·디바이스
  분할)가 전부 빠진다. 기각.
- **모든 IPC 채널에 `server`를 필수로** — 호출부·테스트 100곳 이상을 한 번에 바꿔야 하고,
  세션 무관 채널(`local:*` 등)까지 늘어난다. **선택 인자 + primary 기본값(M3)**이 하위 호환을 지킨다.
- **세션마다 창을 달리 만들기(BrowserWindow 분리)** — 창·메뉴·업데이트·단축키를 전부 공유해야
  해 범위가 앱 전체가 된다. 기각.
- **연결 시도도 세션마다 병렬** — 취소(`connectAttempt`)·중복 방지·툴바 초안이 전역이라
  병렬 시도는 상태를 다시 설계해야 한다. M8에서 기각(연결된 세션만 병렬).
- **패널 3개 이상** — 탭 스트립 배치·포커스 이동·F6이 기하급수로 복잡해진다. 2개로 고정(M10). 기각.
- **분할 위치를 자유 드래그(비율 조절)로** — 핸들을 만들고 키보드 접근성까지 새로 정해야 한다.
  지금은 좌/우 반반(M15)이면 충분하다. 기각.
- **선반 2단계에서 자동으로 루트 전송** — R1에서 "분할 개설까지 하고, 그 다음 끌어 폴더 지정"
  (2단계)를 선택했다. 기각.
- **`FtpConnectionManager` 하나를 공유하며 동시 명령만 허용** — 다른 서버의 명령을 한 매니저에서
  돌릴 수 없다. 세션 = 매니저가 정답이다. 기각.

---

## 6. 테스트 케이스 리스트 (확정)

`Test-906`부터 신규. 기존 최대 번호는 `Test-905`([`shelf-floating-remote.md`](./shelf-floating-remote.md)).
각 테스트에 `covers: Test-N` 주석을 단다. **1:1 매핑. 케이스 추가·병합·재해석 금지.**

### Phase A

#### A. 세션 레지스트리 (`src/main/ftp/FtpSessionRegistry.test.ts` 신규)

| #        | 케이스                                                                             | 기대                                                    |
| -------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Test-906 | 같은 서버 키로 두 번 등록하면 **같은 매니저**를 쓰고, 다른 키는 다른 매니저를 쓴다 | M2                                                      |
| Test-907 | `get()`을 인자 없이 부르면 **primary** 세션을 돌려준다 (기존 호출부·MCP의 경로)    | M3·M9 — 인자를 안 주는 호출이 새 매니저를 만들지 않는다 |
| Test-908 | `disconnect(server)`는 **그 세션만** 닫고 나머지 세션은 살아 있다                  | M1/M3의 분리                                            |

#### B. 채널 라우팅 (`src/main/ipc/ftpHandlers.test.ts` · `transferHandlers.test.ts` · 신규 `thumbnailHandlers` 케이스)

| #        | 케이스                                                                                             | 기대                                                       |
| -------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Test-909 | 두 세션의 `ftp:list`가 **각자의 매니저**로 목록을 읽는다 (한쪽이 다른 쪽의 결과를 받지 않는다)     | M4·함정 B의 첫 부분                                        |
| Test-910 | `ftp:downloadPreview`가 **세션의 host/port**로 프리뷰 캐시 키를 만든다                             | 함정 A — 한쪽 파일이 다른 쪽 호스트의 키로 캐시되지 않는다 |
| Test-911 | `thumbnail:request`가 **세션의 host/port**로 썸네일 캐시 키를 만든다                               | 함정 A의 썸네일 쪽                                         |
| Test-912 | `transfer:send`가 **그 세션의 매니저·풀**로 계획하고, 그 세션이 안 열려 있으면 `FTP_NOT_CONNECTED` | 함정 B                                                     |
| Test-913 | `ftp:connectionStatus`·`ftp:remoteChanged`·`transfer:updated`가 **세션 태그**를 싣고 온다          | M5·함정 D                                                  |

#### C. 렌더러 세션 상태 (`stores/useFtpStore.test.ts` · `components/explorer/Explorer.test.tsx` · `lib/sendPlan.test.ts`)

| #        | 케이스                                                                                                                  | 기대                                           |
| -------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Test-914 | 두 서버가 연결되면 `sessions`에 **둘 다 `connected`**로 남는다 (하나가 다른 하나를 덮지 않는다)                         | M6·함정 D                                      |
| Test-915 | 원격 탭의 게이트가 **그 탭의 서버 세션** 기준으로 정해진다 — 다른 세션의 연결·해제가 게이트를 바꾸지 않는다             | M7의 핵심                                      |
| Test-916 | 새 서버에 연결해도 **기존 세션을 끊지 않는다**                                                                          | 함정 C — 이 테스트가 이 스펙의 레드 출발점이다 |
| Test-917 | 전송 계획·드롭이 **목적지 세션의 연결** 기준으로 통과/거부된다 (`send.invalidOtherServer`는 "그 서버가 안 열렸을 때"만) | 함정 E · M19의 전제                            |

### Phase A′ — 렌더러 세션 인자 · 세션별 전송 실행 (R1 정정)

| #        | 위치                                       | 케이스                                                                                                   |
| -------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Test-932 | `stores/useListingStore.test.ts`           | 원격 탭의 목록 요청이 **그 탭의 세션 키**를 인자로 보낸다 — 비-primary 세션이 primary 목록을 읽지 않는다 |
| Test-933 | `stores/useTransferStore.test.ts`          | 전송(`transfer:send`)·원격 삭제·썸네일 요청에도 **세션 키**가 간다 (항목·목적지의 `server`에서)          |
| Test-934 | `src/main/ipc/transferHandlers.test.ts`    | 비-primary 세션에서 enqueue한 전송이 **그 세션의 풀**으로 실행된다 (두 가짜 매니저로 분리 검증)          |
| Test-935 | `components/explorer/FileGrid.test.tsx`    | **비-primary 탭의 썸네일 캐시 키**가 그 탭의 host·port로 만들어진다 — primary 투영을 쓰지 않는다 (A′5)   |
| Test-936 | `components/thumbnail/EntryThumb.test.tsx` | 폴더 미리보기(`RemoteFolderThumbnail`)도 **세션 기준 host·port**로 키를 만든다 (A′5의 남은 한 곳)        |

### Phase B — 분할 레이아웃 (`stores/useTabsStore.test.ts` · `components/layout/TabStrip.test.tsx`)

| #        | 케이스                                                                                      | 기대                     |
| -------- | ------------------------------------------------------------------------------------------- | ------------------------ |
| Test-918 | `split()`이 두 패널을 만들고 각 패널이 **자기 탭 목록과 자기 활성 탭**을 가진다             | M10·M11                  |
| Test-919 | `closePane()`가 남은 패널에 **그 패널의 탭을 옮기고** 한 패널로 돌아간다 (탭을 잃지 않는다) | M12                      |
| Test-920 | 탭 스트립은 **자기 패널의 탭만** 보여주고, 활성 탭 선택이 패널마다 갈린다                   | M11                      |
| Test-921 | 마지막 패널은 닫히지 않고, 패널이 하나일 때 `split()`·`closePane()`의 불변식이 유지된다     | M10·M12 — 1↔2패널의 경계 |

### Phase C — 드롭 플로우 (`components/layout/Sidebar.test.tsx` · `components/explorer/Explorer.test.tsx` · 신규 `components/layout/SplitConnect.test.tsx`)

| #        | 케이스                                                                                            | 기대                                            |
| -------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Test-922 | 사이드바 서버 행을 끌면 `useDnd.server`가 세팅되고 고스트가 뜬다 (항목 드래그와 구분된다)         | M14                                             |
| Test-923 | 콘텐츠 영역 **왼쪽/오른쪽 절반**에 호버하면 그쪽 절반만 하이라이트되고 `split.dropHint`이 보인다  | M15·M20                                         |
| Test-924 | 놓으면 **연결 결과와 무관하게 먼저 패널이 DOM에** 생기고 그 안에 연결 시도 안내가 뜬다            | M16 ①·함정 F                                    |
| Test-925 | 연결 **성공** → 스피너 자리에 그 서버의 탭이 열린다 (최근 폴더 → 없으면 루트)                     | M16 ②                                           |
| Test-926 | 연결 **실패** → `split.connectFailedTitle` 모달이 뜨고, 닫으면 **패널이 사라져 원래 상태**로 간다 | M16 ③·M18의 "새 패널이었다면 제거"              |
| Test-927 | **타임아웃** → 모달이 뜨고 연결 시도가 **취소**되며 패널이 원래대로 간다                          | M16 ③·M17 — `cancel`이 실제로 불렸음을 단언한다 |
| Test-928 | 연결 시도 중에 다른 서버를 더 끌어도 **시도는 하나씩** 처리된다 (둘째 시도는 기다린다)            | M8                                              |

### Phase C — 선반 2단계 (`components/shelf/Shelf.test.tsx` · `lib/sendPlan.test.ts`)

| #        | 케이스                                                                                                            | 기대                                           |
| -------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Test-929 | 선반 항목을 **미연결 서버의 탭**에 놓으면 전송이 시작되지 않고 **연결(패널+시도)이 시작**되며 **선반은 그대로**다 | M19                                            |
| Test-930 | 그 연결이 성공해 그 서버 패널이 열린 뒤, 선반 항목을 **그 패널의 폴더**에 놓으면 기존처럼 전송된다                | M19 ②③ — 6번이 이 위에서 놀 수 있음을 보장한다 |
| Test-931 | **이미 연결된** 서버의 탭에 놓으면 분할 없이 **현행대로 바로 전송**된다                                           | M19의 예외 — 회귀 방어                         |

### Phase C — 패널 닫기 (M21)

| #        | 케이스                                                                                                    | 기대                                   |
| -------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Test-937 | 두 패널 상태에서 **닫기控件을 누르면 `closePane`이 불리고 한 패널로 돌아가며**, 남은 패널의 탭은 그대로다 | M12의 결정이 제품 안에 트리거를 가진다 |

- **함정 H의 확정 (R2 중 결정):** `Test-785`·`Test-829`(연결 시 원격 탭을 빼앗는 D3)는 **케이스를
  재해석하지 않고 그대로 유지**한다. 함정 H가 막으려는 해(다른 패널·다른 세션의 탭을 건드리는 것)만
  없앤다 — 같은 세션 탭 우선 → (다른 패널의) 같은 세션 탭 → **포커스 패널 안의 첫 원격 탭(D3)** → 새 탭.
  D3의 "첫 원격 탭 빼앗기"가 레거시 케이스로 고정돼 있으므로, 그 범위를 넓히는 재해석은 스펙 밖이다.

- 기존 `Test-820`~`821`(사이드바)·`Test-789`~`790`(배치)·선반·충돌 시트 케이스는 **그대로 GREEN이어야 한다.**
- **E2E 전담(테스트 케이스로 만들지 않는 것)**: F6 사이클이 두 패널에서의 포커스 이동(함정 G),
  분할 비율 유지, 상태바가 활성 패널의 연결을 보여주는 것. §8 표에 남긴다.
- Phase A·A′가 먼저 GREEN 되기 전에 B·C의 테스트를 추가하지 말 것(의존 순서).

---

## 7. 관련 코드 포인터

| 파일                                                                                                                                 | 역할                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| [`main/ipc/ftpHandlers.ts`](../../src/main/ipc/ftpHandlers.ts)                                                                       | L48 `new FtpConnectionManager()`(세션화 대상), `ftp:connect` L75-130(M2), `ftp:list` 등(L4 인자) |
| [`main/ipc/transferHandlers.ts`](../../src/main/ipc/transferHandlers.ts)                                                             | L41-42 큐·풀 생성, `planDeps` L76-80(함정 B), `transfer:send` L91-85의 연결 확인                 |
| [`main/thumbnail/ThumbnailQueue.ts`](../../src/main/thumbnail/ThumbnailQueue.ts)                                                     | `cacheKeyOf` L69-76(함정 A)                                                                      |
| [`main/ipc/previewHandlers.ts`](../../src/main/ipc/previewHandlers.ts)                                                               | L58-60 같은 키 문제(함정 A)                                                                      |
| [`main/mcp/agentOps.ts`](../../src/main/mcp/agentOps.ts) · [`main/mcp/McpService.ts`](../../src/main/mcp/McpService.ts)              | **무변경**(M9). `deps.ftpManager`는 primary를 받는다                                             |
| [`renderer/stores/useFtpStore.ts`](../../src/renderer/src/stores/useFtpStore.ts)                                                     | M6·M7의 대상                                                                                     |
| [`renderer/stores/useServerStore.ts`](../../src/renderer/src/stores/useServerStore.ts)                                               | `connect` L140-204(함정 C·M8), `cancel` L206-211(M17)                                            |
| [`renderer/stores/useTabsStore.ts`](../../src/renderer/src/stores/useTabsStore.ts)                                                   | M10~M13·함정 H(`adoptRemote` L175-187)                                                           |
| [`renderer/lib/sendPlan.ts`](../../src/renderer/src/lib/sendPlan.ts) · [`lib/sendItems.ts`](../../src/renderer/src/lib/sendItems.ts) | `SendConnection`(함정 E) · `currentConnection` L37-46                                            |
| [`renderer/components/explorer/Explorer.tsx`](../../src/renderer/src/components/explorer/Explorer.tsx)                               | 게이트 L124-131(M7), 드롭 영역 L827-847(M15의 자리)                                              |
| [`renderer/components/explorer/dnd.ts`](../../src/renderer/src/components/explorer/dnd.ts)                                           | M14의 `server` 필드와 `startServerDrag`                                                          |
| [`renderer/components/layout/Sidebar.tsx`](../../src/renderer/src/components/layout/Sidebar.tsx)                                     | 서버 행 `ServerRow` L142-203(드래그 소스)                                                        |
| [`shared/types/ftp.ts`](../../src/shared/types/ftp.ts)                                                                               | `FtpConnectionState` L106-110(M5의 태그)                                                         |

---

## 8. 완료 기준

1. **Phase A → A′ → B → C 순서**로, 각 단계의 `Test-906`~`Test-937`가 전부 GREEN
   (실행 출력으로 확인). Phase가 밀리면 뒤 단계 테스트를 먼저 쓰지 말 것.
2. **기존 케이스가 계속 GREEN**: 특히 `Test-820`·`821`, `Test-789`·`790`, 선반(`806`~`807`),
   충돌(`812`~`814`, `842`), 썸네일·프리뷰 관련 케이스. **MCP 계약 테스트(`Test-450` 등)도 그대로.**
3. **새 IPC 채널 0개.** `src/preload/index.ts`의 허용목록과 `index.d.ts`의 유니언이 바뀌지 않았는지
   확인한다 (M3·M4의 "인자 추가" 전략이 지켜졌다는 증거). 바뀌었다면 허용목록·유니언·계약 테스트
   세 곳을 함께 고쳤는지 재확인한다.
4. 각 신규 테스트에 `covers: Test-N` 주석.
5. 새 i18n 키 **4개**가 `en.ts`와 10개 로케일에 있고 `i18n.test.ts`·typecheck가 GREEN.
6. 뮤테이션: 신규 파일(`FtpSessionRegistry.ts`)은 `stryker.config.json`에 통째로 추가하고,
   수정한 파일의 라인은 `git diff --unified=0 -- <file> | grep '^@@'`로 재확인해 갱신,
   `break: 70` 통과.
7. `npm run typecheck` · `npm run lint` · `npx prettier --check <변경 파일>` · `npm test` 통과.
8. E2E 실측 (실기기 R3):

   | 항목 | 확인 내용                                                                                                    |
   | ---- | ------------------------------------------------------------------------------------------------------------ |
   | (a)  | 사이드바 서버를 끌어 콘텐츠 **오른쪽 절반**에 놓으면 → 오른쪽 패널 + 연결 스피너 → 그 서버 탭이 열린다       |
   | (b)  | 비밀번호가 틀린 서버로 (a)를 반복 → 모달이 뜨고 **패널이 사라져 원래 화면**으로 돌아간다                     |
   | (c)  | 접속 불가 주소로 (a)를 반복 → **20초 뒤** 모달 + 시도 취소 + 패널 복귀                                       |
   | (d)  | (a) 성공 뒤에도 **왼쪽 칸의 원격 탭이 계속 살아** 있고(게이트가 `live`), 각 칸이 자기 서버 목록을 보여준다   |
   | (e)  | 두 칸에서 각각 업로드·다운로드를 동시에 돌려도 **서로 섞이지 않고** 충돌 시트·진행률이 각 세션 것을 보여준다 |
   | (f)  | 선반 항목을 미연결 서버 탭에 놓으면 → 연결·패널 개설(선반 유지) → 그 패널 폴더로 끌어 전송된다               |
   | (g)  | 이미 연결된 서버 탭에 놓으면 분할 없이 바로 전송된다 (기존 동작 회귀 없음)                                   |
   | (h)  | **함정 G**: 두 패널에서 F6을 눌러 포커스가 사이드바 → 탭 → 목록 → 선반 순으로 정상 순환한다                  |
   | (i)  | 에이전트 접근(MCP)이 이전과 **완전히 같다** (M9 — primary 세션 경로)                                         |
