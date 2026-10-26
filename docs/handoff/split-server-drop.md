# 핸드오프: 서버 드래그로 분할하고 자동 연결하기 (Phase C 이식)

> **출처와 이식(provenance)**: 이 문서는 `feat/feedback-batch` 브랜치(v1.3.0 베이스)의
> `docs/handoff/split-server-drop.md`에서 **Phase C(서버 드래그 → 분할 → 자동 연결)만** 옮긴
> **이식 기록(port record)**이다. 이식 대상은 `origin/main` v1.4.0 + 이 브랜치에 이미 올라간
> 스펙 5개가 깔린 `feat/feedback-v1.5`이며, 원본 스펙의 Phase A·A′·B·M21은 upstream이 **다른
> 이름의 다른 구조로 이미 구현**했으므로 아래 “이식에서 제외”에 남기고 코드·케이스를 옮기지 않는다.
> 테스트 케이스 번호는 `Test-922`~`Test-931` → **`Test-1257`~`Test-1266`**(+335, 순서 그대로).
> 이식 착수 시 이 브랜치의 기준선은 `Test-1244`였고(이후 `shelf-floating-remote.md`가
> `Test-1245`~`1256`을 채워 현재 로컬 최대는 1256), upstream `origin/main`의 최대는 `Test-1201`이다.
>
> 이 문서는 **이 스펙(Phase C)의 테스트 코드 작성과 구현의 유일한 입력**이다. 이 문서에 없는
> 케이스는 완료 범위 밖이다. 새 케이스를 추가하거나 기존 케이스를 재해석하지 말 것.
> 원본 스펙에 있던 Phase A·A′·B의 결정·함정·대상 API는 **원본 브랜치에서만** 유효하다.

작업 유형(R0): **기능 이식 + upstream 적응**. RED 테스트를 먼저 세운 뒤 GREEN으로 만든다.

선행 관계(원본 그대로, 이식 시점의 의미):

- [`shelf-floating-remote.md`](./shelf-floating-remote.md)(6번)는 선반에서 끌 수 있게 하는 것까지만
  정하고, "미연결 서버 탭에 놓으면 2단계로 간다"는 흐름은 **이 스펙의 M19·Test-1264~1266**에 있다.
- [`server-connect-activation.md`](./server-connect-activation.md)(1번): 이 스펙의 "자동 연결"은 그
  규칙(`connectSaved`)을 그대로 쓴다. **연결 로직을 새로 만들지 말 것.**
- [`multi-connection.md`](./multi-connection.md) · [`split-view.md`](./split-view.md): upstream의
  세션(`ConnectionRegistry`·`conn` 인자)과 분할 뷰(`placeInPane`/`unsplit`/`visiblePanes`)가 이
  스펙의 토대다. **되돌리거나 재구현하지 않는다.**

---

## 0. 이식에서 제외 (superseded by upstream)

원본 스펙은 Phase A → A′ → B → C를 순서대로 요구했다. 이식 대상 브랜치에는 아래가 **이미 upstream
방식으로 들어와 있다**. 각 그룹의 케이스는 이식하지 않고 여기에 사유를 남긴다.

| 제외 대상                                                                                                                                                              | 원본 케이스      | 왜 upstream의 것인가                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Phase A — 세션화**(M1~M9: `FtpSessionRegistry`, `server` 선택 인자, 이벤트 세션 태그, `sessions` 저장소, 게이트를 세션 기준으로, 시도 단일 플라이 M8, MCP 무변경 M9) | `Test-906`~`917` | upstream [`multi-connection.md`](./multi-connection.md)가 `ConnectionRegistry`·`TransferHub`로 **더 좁은 `ConnKey` 단위**를 구현했다. 채널은 `conn` 선두 인자(`src/shared/connKey.ts`), 렌더러는 `useFtpStore.connections`(`useFtpStore.test.ts`), 게이트는 `MC11`(`Explorer.tsx` `Gate`)로 이미 같은 문제를 풀었다. 원본의 선택 인자 + primary(M3) 전략은 채택되지 않았다 |
| **Phase A′ — 렌더러 세션 인자·세션별 전송 실행·썸네일 키**(A′1~A′5)                                                                                                    | `Test-932`~`936` | upstream의 모든 원격 IPC가 `conn` 선두 인자 + 뷰어 id를 받고(`ftp:list(server, path)` 등), 전송 실행·썸네일 캐시 키·폴더 미리보기도 세션 기준이다(`multi-connection.md` MC·`FileGrid`/`ThumbnailImage`). 이 스펙 Phase C는 연결 결과를 **이미 세션 기준인** `adoptRemote(server, path)`로 받는다                                                                           |
| **Phase B — 분할 레이아웃**(M10~M13: `panes` 배열, 패널별 TabStrip, `closePane`)                                                                                       | `Test-918`~`921` | upstream [`split-view.md`](./split-view.md)가 `split: {leftId, rightId, ratio}` **짝 모델**(한 패널에 탭 하나, P1~P4)과 `placeInPane`/`unsplit`/`swapPanes`/`toggleSplit`/`setSplitRatio`, `visiblePanes`/`activePane`로 구현했다. 원본의 `panes[]`·`closePane`은 그 짝 모델과 맞지 않으므로 이식하지 않는다                                                               |
| **M21 — 패널 닫기控件**(`split.closePane` i18n 키 포함)                                                                                                                | `Test-937`       | upstream에 이미 닫기 트리거가 있다: 탭 메뉴·묶음 알약의 **`split.unsplit`**(“분할 해제”), `Ctrl+\`의 `toggleSplit`, `SplitDivider`. 원본 `closePane`은 짝 모델의 `unsplit`으로 대체되므로 **새 키를 만들지 않는다**                                                                                                                                                        |

원본 문서의 §2 Phase A·A′·B 결정표, §3 함정 A~E·G·H, §4 대상 API, §5 기각안 중 세션·분할 레이아웃
관련 항목은 위와 함께 **제외**다(원본 브랜치 참조). 아래는 이식 범위인 **Phase C만** 남긴다.

---

## 1. 문제 정의 (원본 그대로, Phase C 부분)

사용자 피드백 (5번):

> 서버 탭에서 서버를 드래그앤 드롭하여 스플릿 할 수도 있게 하자. 이 경우 자동으로 연결하는
> 동작을 겸한다. 연결이 바로 되지 않거나 실패하는 경우 uiux를 정한다: 일단 스플릿 뷰를 만들고
> 스플릿된 칸에 스피너가 돌든 플레이스홀더가 있든 연결 시도중이라는 것을 알 수 있게 한다 →
> 타임아웃/연결 실패 시 모달을 띄우고 백그라운드에 있는 스플릿 뷰는 원래대로 돌아간다.

그리고 6번(`shelf-floating-remote.md`)의 후반부 — 선반의 2단계 흐름만 여기로 옮겨 뒀다(M19).

upstream 위에서는 “두 칸에 다른 서버”와 “분할 레이아웃”이 이미 있으므로, 남은 범위는
**(1) 사이드바 서버를 콘텐츠 절반에 끌어 놓으면 분할이 생기고**, **(2) 그 자리에서 자동 연결이
돌아 성공/실패/타임아웃을 처리하며**, **(3) 선반이 미연결 서버 탭에 닿으면 전송 대신 같은 흐름을
시작한다**는 것이다.

---

## 2. 핵심 결정 (원본 M14~M20 + 이식 적응 결정)

### Phase C — 서버 드래그 → 분할 → 자동 연결

| #    | 결정                                                                                                                                                                                                                                                                                                                                                                    | 근거 / 이식 적응                                                                                                                                                                                               |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M14  | **드래그 소스**: 사이드바 저장 서버 행을 끌 수 있다. `useDnd`에 `server: FtpServer \| null`을 추가해 `items`(항목 드래그)·OS 드롭·`fromShelf`와 구분한다. `startServerDrag`는 `startDrag`와 같은 팔(고스트·이벤트 리셋)을 쓴다                                                                                                                                          | `useDnd`는 한 번에 한 종류만 들 수 있다. 항목과 서버가 섞이면 놓기 대상의 판정이 갈린다. upstream의 OS 드롭·선반 판정은 건드리지 않는다                                                                        |
| M15  | **놓는 자리**: 콘텐츠 영역의 **왼쪽/오른쪽 절반**. 서버를 끌고 있는 동안만 `split-zones` 오버레이가 뜨고, 호버한 쪽만 하이라이트 + `split.dropHint`을 보인다. 놓으면 `connectIntoPane(server, side)`. **분할 자리 밖**(탭 알약·장소·폴더 등)에 놓으면 `connectNow(server)` — 기존대로 연결만(전환 + 탭, 모달·패널 없음)                                                 | zone은 한 번에 `over` 하나만 켜진다(기존 `over` 규칙 그대로). 놓기는 **스프링이 아니라 `onDrop`에서** 만든다(원본 함정 F 유지 → Test-1259)                                                                     |
| M16  | **UI/UX 순서(사용자 지정 그대로)**: ① 놓으면 **즉시 분할이 생기고 그 칸에 자리표시자 탭**이 놓이며 게이트가 "연결 시도 중"을 그린다 → ② **성공**하면 `adoptRemote`가 **그 자리표시자 탭**을 해당 서버의 탭(최근 폴더 → 없으면 루트)으로 채운다 → ③ **실패 또는 20초 타임아웃**이면 모달을 띄우고 닫을 때 분할을 드롭 전 상태로 되돌린다                                 | 사용자가 명시한 흐름. 패널이 뒤늦게 생기면 "놓았는데 아무 일도 없다"가 된다(upstream은 분할이 보이려면 활성 탭이 짝의 한쪽이라야 한다 — `splitShown`)                                                          |
| M17  | 타임아웃은 **렌더러가 20초**(`SPLIT_CONNECT_TIMEOUT_MS`)로 재고, 그때 `useServerStore.cancel()`으로 **시도를 취소**한 뒤 모달을 띄운다. 모달의 확인 버튼은 “닫기” 하나(`common.close`)                                                                                                                                                                                  | `cancel`이 시도를 무효화한다(`connectAttempt++` + `ftp:disconnect`). 시도를 백그라운드에 남기면 뒤늦은 성공이 되돌아온 분할을 되살린다                                                                         |
| M18  | **되돌리기의 정의**(upstream 짝 모델로 재정의): ① 드롭 전에 분할이 없었다 → `closeTab(자리표시자)` — 짝의 반쪽을 닫으면 upstream이 분할을 풀고 활성 탭을 나머지 반쪽(= 드롭 전 탭)으로 되돌린다. ② 드롭 전 분할이 있었다 → 먼저 `placeInPane(원래 탭, 그쪽)`으로 원래 탭을 그 패널에 되돌리고(치환됐던 탭 복귀), 자리표시자 탭을 닫은 뒤 드롭 전 활성 탭으로 `activate` | 스플릿 뷰는 "원래대로 돌아간다"는 요구의 정확한 기준. 분할 자체를 잃지 않는 것이 ①과의 차이다                                                                                                                  |
| M19  | **선반의 2단계 흐름**: `fromShelf` 드래그가 **연결되지 않은 원격 탭**(주로 탭 알약)에 닿으면 → 전송하지 않고 ①연결(분할 + 자리표시자) → ②성공 시 그 서버 패널 개설(**선반 항목은 그대로**) → ③사용자가 다시 그 패널로 끬서 폴더를 지정한다. **이미 연결된 탭**이면 현행대로 바로 전송한다                                                                               | 사용자가 "2단계 유지"를 선택했다. 놓기 유효성도 이 경로를 인정한다(`valid`, 동사 `explorer.connectTo`). **upstream의 서버 간 릴레이 복사(MC23)와는 별개** — 선반 드롭의 미연결 목적지는 여전히 전송하지 않는다 |
| M19′ | **분할이 이미 보이는 상태**에서 M19가 붙으면 새 패널을 만들지 않는다(`pane = null`): 짝 모델상 한 패널에 탭 하나라 자리표시자 자리가 없다. 그 탭 자신의 게이트가 "연결 중"을 그리고 성공은 `adoptRemote`가 그 탭을 채운다(실패·타임아웃·모달·복귀는 그대로)                                                                                                             | 원본은 1↔2패널만 다뤘다. 이미 분할된 경우의 "패널 만들기"는 짝을 치환해야 해 다른 탭을 숨기는 부작용이 있다 — 이식에서 새 규칙으로 확정                                                                        |
| M20  | **i18n 새 키 3개만**: `split.dropHint` · `split.connectFailedTitle` · `split.connectFailedBody`. "연결 시도 중"은 **`sidebar.serverConnecting` 재사용**(`ServerOfflinePanel`이 연결 중일 때 본문에 이 문구를 그린다). `split.closePane`은 제외(M21)                                                                                                                     | 키 최소화 — 새 문구가 실제로 렌더링될 때만 키를 만든다. upstream의 `split.splitLeft`/`splitRight`/`replace`는 **탭 드래그** 칩(P15)이라 서버 드롭 힌트로 쓰지 않는다                                           |

### 이식 적응 결정 (R1 대체 — upstream 계약 확인 후 확정)

| #    | 결정                                                                                                                                                                                                                                         | 근거(확인 결과)                                                                                                                                                                                                                   |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P-C1 | **자리표시자는 "그 서버의 원격 탭" 하나다.** `openTab({side:'remote', path:'/', server}, false)`(비활성) → `placeInPane(자리표시자, side)`. `activeId`를 건드리지 않고 `placeInPane`이 짝을 만들며 활성까지 준다                             | `openTab`을 활성으로 쓰면 짝이 이미 보이는 경우 `splitShown`이 깨져 `placeInPane`이 숨은 짝을 통째로 갈아끼운다. `placeInPane(id≠activeId)`는 언제나 `partner = activeId`라 드롭하던 탭이 짝이 된다                               |
| P-C2 | **연결 시도 단일 플라이 유지(M8 그대로).** `useServerStore.connect`는 `connecting`이면 즉시 `false`를 돌려준다(업스트림 `useServerStore.ts:144`, 재진입 가드). 따라서 둘째 드롭은 **앞 시도가 settle할 때까지 기다린다**(`whenAttemptsIdle`) | upstream 멀티 커넥션은 **연결된 세션의 병렬 유지**이지 동시 시도 병렬이 아니다. 반면 자동 연결(`useAutoConnect`→`useFtpStore.connect`, MC12)은 키마다 병렬이고 `useServerStore.connecting`을 쓰지 않는다 — 그래서 P-C3가 필요하다 |
| P-C3 | **`isPendingConnect(key)` 집합**: ① 놓는 순간 자리표시자 키를 표시 → 게이트가 시도가 아직 안 시작된 순간도 `connecting`으로 그린다(“놓자마자 안내” — M16 ①), ② `useAutoConnect`가 그 키의 자동 연결을 건너뛴다(이중 `ftp:connect` 방지)      | 자리표시자 탭이 마운트되는 순간 `ftp:getRecentPaths` 전이라 `connections[key].status`는 아직 `disconnected`다. 자동 연결은 상태 변화에 반응하지 않으므로(재실행 없음) 표시만 없애면 된다                                          |
| P-C4 | **복귀(M18) 스냅샷**: 드롭 시점의 `activeId`·치환된 탭(`displaced`)·패널 위치만 기억한다. `tabs` 배열 전체 스냅샷은 쓰지 않는다                                                                                                              | 시도 중 다른 사용자 조작이 있으면 전체 복원이 되돌린다. 케이스가 요구하는 “원래 상태”는 분할·활성 탭·자리표시자 제거까지만이다                                                                                                    |
| P-C5 | **선반 2단계의 패널 위치**: `visiblePanes`가 2개(분할 보임) → `pane = null`(M19′), 아니면 `'right'`(단일 보기의 `activePane`은 언제나 `'left'`라 반대쪽이 `'right'`). 놓았던 탭이 보이면 그 탭을 활성으로 스쳐 짝으로 남긴다                 | 원본 `startShelfConnect`는 “포커스 패널을 split”했지만 upstream에는 패널이 짝 탭으로만 표현된다. 놓은 탭이 짝이어야 ③ 단계(그 패널 폴더로 끄기)가 자연스럽다                                                                      |
| P-C6 | **선반 2단계는 저장 서버일 때만 분할한다** — 저장 로그인이 없으면 오늘의 주소·비밀번호 경로(`connectToServer`)로만 간다(원본과 동일)                                                                                                         | `canConnectSaved`가 거부하는 서버로는 시도 자체가 없다(원본 `connectIntoPane`의 선행 규칙)                                                                                                                                        |

---

## 3. 구현 함정 (이식 범위)

### 함정 F(원본 유지) — 분할은 스프링이 아니라 놓기에서

호버 하이라이트(`over`)와 놓기는 별개다. `SplitHalf`의 `onDrop`이 `connectIntoPane`을 직접 부른다.
스프링(`springMs`)에 맡기면 놓는 순간 `activeId`·짝이 아직 안 바뀌어 `placeInPane`이 조용히 무시된다
(`tabs.length < 2`·짝 미포함 조건). **Test-1259가 “놓자마자 분할이 DOM에 있다”를 단언한다.**

### 함정 I(신규) — 자리표시자 탭이 곧바로 자동 연결을 부른다

`useAutoConnect`(MC12)는 저장 비밀번호가 있는 저장 서버의 원격 탭이 보이면 ** 상태와 무관하게
한 번 연결**한다(조건: `status === 'disconnected'` + `saved.hasPassword`). 자리표시자 탭은
`connectSaved`의 `ftp:getRecentPaths` 대기 동안 `disconnected`로 남아 있으므로, 표시가 없으면
**자동 연결과 우리의 시도가 두 번 `ftp:connect`를 때린다**(둘 중 하나가 `connectGeneration`에
밀려 무효가 되지만 로그인 두 번이 실제로 간다). P-C3의 표시로만 막는다 — `useAutoConnect`의
계약(상태 변화 무반응)은 건드리지 않는다.

### 함정 J(신규) — 치환된 탭은 짝 밖으로 사라진다

`splitShown` 동안 `placeInPane(새 탭, side)`는 그 패널의 탭을 **짝 밖으로 밀어낸다**(upstream
§3.2-2의 교체). 밀어낸 탭은 `tabs`에는 남지만 안 보인다. 복귀는 M18 ②의
`placeInPane(displaced, side)`가 정확히 제자리(순서 포함)로 되돌린다. Test-1261·1262가 단일
보기(새 분할)를, Test-1263이 둘째 시도를 다룬다.

### 함정 K(신규) — 선반의 미연결 목적지는 지금 놓기가 거부된다

`useDropTarget`의 `valid`는 `planSend`의 `invalid('send.invalidNotConnected')`를 그대로 쓰므로
드롭 자체가 `dropEffect: 'none'`으로 막힌다. M19는 **`fromShelf` + 미연결 원격**일 때만 이
계획을 무효로 보지 않고 `valid`·동사(`explorer.connectTo`)를 인정한다(비선반 드래그의 기존
거부·토스트는 그대로).

---

## 4. 대상 API (이식 대상 — upstream 위의 표면)

```ts
// 신규: src/renderer/src/lib/splitConnect.ts

/** M17: 분할 연결 시도의 타임아웃. 지나면 시도를 취소하고 모달을 띄운다. */
export const SPLIT_CONNECT_TIMEOUT_MS = 20000

/** P-C3: “연결하려는 키” 표시 — 자리표시자 게이트와 자동 연결 억제가 이걸 읽는다. */
export function isPendingConnect(server: string | undefined): boolean

/** M15: 콘텐츠 절반에 놓았을 때 — 분할을 만들고 시도를 시작한다. pane이 null이면 분할은 건드리지 않는다(M19′). */
export function connectIntoPane(server: FtpServer, pane: PaneId | null): void

/** M15의 바깥 경로: 분할 자리가 아니면 기존대로 연결만 한다(모달·패널 없음). */
export function connectNow(server: FtpServer): void

/** M19: 선반이 미연결 서버 탭에 닿았을 때 — 전송 없이 연결(분할 + 자리표시자)부터 시작한다. */
export function startShelfConnect(dest: Loc): void
```

```ts
// useTabsStore (upstream — 그대로 쓴다, 재구현 금지)
const id = s.openTab({ side: 'remote', path: '/', server: key }, false) // 자리표시자, 비활성
s.placeInPane(id, 'left' | 'right') // 드롭: 짝 만들기(또는 그쪽 교체) + activeId = id
visiblePanes(s) / activePane(s) // 보이는 패널 판정(M19′, 테스트 단언)
s.closeTab(placeholder) // M18 ①: 짝 반쪽 닫기 → split = null + 활성 복귀
```

```ts
// 연결 시도(M16~M18)의 한 흐름
connectIntoPane(server, pane):
  if (!canConnectSaved(server)) return connectToServer(key)   // 1번 스펙 경로, 분할 안 함
  snap = { activeId, displaced }                              // M18용
  isPendingConnect → mark(key)                                // P-C3 (탭 생성보다 먼저)
  placeholder = openTab(remote '/', key, false); placeInPane(placeholder, pane)
  void runConnect(...):                                       // M8 대기 → 20초 타이머 → connectSaved
    timeout → useServerStore.cancel() → clearPending → 모달 → 닫으면 revert(snap)
    실패    → clearPending → 모달 → 닫으면 revert(snap)
    성공    → clearPending (자리표시자는 adoptRemote가 제자리에서 채움)
```

**i18n(3개, `en.ts` + 10개 로케일)**

| 키                         | 예시 (en)                                         |
| -------------------------- | ------------------------------------------------- |
| `split.dropHint`           | `Drop here to open this side`                     |
| `split.connectFailedTitle` | `Could not connect to {{name}}`                   |
| `split.connectFailedBody`  | `Check the address and password, then try again.` |

(연결 시도 중 안내는 기존 `sidebar.serverConnecting` — `ServerOfflinePanel`의 연결 중 본문.)

**새 IPC 채널: 0개.** 모든 동작은 렌더러 저장소 + 기존 `ftp:connect`·`ftp:list`·`ftp:getRecentPaths`
위에서만 돈다.

---

## 5. 기각한 대안 (이식 시점)

- **upstream `placeInPane`을 패널 배열(`panes[]`)로 되돌리기** — split-view의 짝 모델(P1~P4)을
  깨는 재구현이다. 기각(upstream 유지가 이식의 전제).
- **연결 시도도 병렬로(각 드롭이 즉시 `ftp:connect`)** — `useServerStore.connect`의 재진입
  가드·`connectAttempt` 취소 규칙(`cancel`이 뒤늦은 성공을 무효화)이 전역 단일 시도를 전제로
  설계돼 있다. 병렬화하면 M17의 “시도 취소”가 다른 시도를 건드린다. **M8 유지**(P-C2).
- **자동 연결(`useAutoConnect`)으로 자리표시자 채우기** — `adopt: false`라 시도 결과·실패 모달·
  20초 취소가 없다. 우리 흐름은 `connectSaved`(1번 스펙 경로)만 쓴다(함정 I의 억제와는 별개).
- **선반 2단계에서 자동으로 루트 전송** — R1에서 “분할 개설까지 하고, 그 다음 끬서 폴더 지정”
  (2단계)를 선택했다. 기각(원본 그대로).
- **`split.dropHint` 대신 `split.splitLeft`/`splitRight` 재사용** — 그 키들은 P15의 **탭 드래그**
  칩("Split left · {탭이름}")이라 서버 드롭 힌트의 의미(어디에 놓을지)와 다르다. 기각.
- **콘텐츠 가운데 = 전환 경로** — 절반 존 두 개가 영역을 100% 덮는다(원본과 동일). 전환은
  분할 자리 밖(탭 알약·장소 등)에서만 일어난다(`connectNow`).

---

## 6. 테스트 케이스 리스트 (확정 — 이식 후 번호)

원본 `Test-922`~`Test-931`을 **`Test-1257`~`Test-1266`**으로 **+335** 재번호한다. 순서·의미는 그대로.
각 테스트에 `// covers: Test-N` 주석을 단다. **1:1 매핑. 케이스 추가·병합·재해석 금지.**

### Phase C — 드롭 플로우 (`components/layout/Sidebar.test.tsx` · `components/explorer/Explorer.test.tsx` · 신규 `components/layout/SplitConnect.test.tsx`)

| #         | 원본 | 케이스                                                                                                             | 기대         | 파일                                 |
| --------- | ---- | ------------------------------------------------------------------------------------------------------------------ | ------------ | ------------------------------------ |
| Test-1257 | 922  | 사이드바 서버 행을 끌면 `useDnd.server`가 세팅되고 고스트가 뜬다(항목 드래그와 구분된다)                           | M14          | `layout/Sidebar.test.tsx`            |
| Test-1258 | 923  | 콘텐츠 영역 **왼쪽/오른쪽 절반**에 호버하면 그쪽 절반만 하이라이트되고 `split.dropHint`이 보인다                   | M15·M20      | `explorer/Explorer.test.tsx`         |
| Test-1259 | 924  | 놓으면 **연결 결과와 무관하게 먼저 분할이 DOM에** 생기고 그 칸에 연결 시도 안내(`sidebar.serverConnecting`)가 뜬다 | M16 ①·함정 F | `layout/SplitConnect.test.tsx`(신규) |
| Test-1260 | 925  | 연결 **성공** → 자리표시자 자리에 그 서버의 탭이 채워진다(최근 폴더 → 없으면 루트, 탭은 하나 더 생기지 않는다)     | M16 ②        | `layout/SplitConnect.test.tsx`       |
| Test-1261 | 926  | 연결 **실패** → `split.connectFailedTitle` 모달이 뜨고, 닫으면 **분할이 사라져 원래 상태**로 간다                  | M16 ③·M18 ①  | `layout/SplitConnect.test.tsx`       |
| Test-1262 | 927  | **타임아웃(20초)** → 모달이 뜨고 연결 시도가 **취소**(`cancel` 호출)되며 분할이 원래대로 간다                      | M16 ③·M17    | `layout/SplitConnect.test.tsx`       |
| Test-1263 | 928  | 연결 시도 중에 다른 서버를 더 끌어도 **시도는 하나씩** 처리된다(둘째 시도는 앞 시도가 settle한 뒤 시작)            | M8(P-C2)     | `layout/SplitConnect.test.tsx`       |

### Phase C — 선반 2단계 (`components/shelf/Shelf.test.tsx`)

| #         | 원본 | 케이스                                                                                                              | 기대                                                  | 파일                   |
| --------- | ---- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------- |
| Test-1264 | 929  | 선반 항목을 **미연결 서버의 탭**에 놓으면 전송이 시작되지 않고 **연결(분할 + 시도)이 시작**되며 **선반은 그대로**다 | M19·P-C5                                              | `shelf/Shelf.test.tsx` |
| Test-1265 | 930  | 그 연결이 성공해 그 서버 패널이 열린 뒤, 선반 항목을 **그 패널의 폴더**에 놓으면 기존처럼 전송된다                  | M19 ②③                                                | `shelf/Shelf.test.tsx` |
| Test-1266 | 931  | **이미 연결된** 서버의 탭에 놓으면 분할 없이 **현행대로 바로 전송**된다                                             | M19의 예외 — **회귀 방어**(이식 전에도 통과해야 한다) | `shelf/Shelf.test.tsx` |

- **제외 케이스**: `Test-906`~`921`(Phase A·B), `Test-932`~`937`(Phase A′·M21) — §0의 표 참조.
- **회귀 방어**: 기존 케이스가 전부 GREEN이어야 한다. 특히 선반(`Test-806`·`807`), 사이드바
  (`Test-820`·`821`, `Test-1214`~`1218`), 자동 연결(`Test-1019`·`Test-1034`), 분할 뷰 전 케이스,
  MCP 계약(`Test-450`) — 이식이 upstream 동작을 건드리지 않았다는 증거다.
- **E2E 전담(테스트 케이스로 만들지 않는 것)**: F6가 두 패널에서의 포커스 순환(원본 함정 G),
  분할 비율 유지, 상태바가 활성 패널의 연결을 보여주는 것, **`connectNow`(M15의 바깥 경로)의
  실제 드롭**, 위치·비밀번호 입력 경로로만 연결되는 저장 없는 서버의 서버 드래그. §8 표에 남긴다.

---

## 7. 관련 코드 포인터 (이식 시점)

| 파일                                                                                           | 역할                                                                                                  |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [`lib/splitConnect.ts`](../../src/renderer/src/lib/splitConnect.ts)(신규)                      | M15~M19의 흐름: `connectIntoPane`·`connectNow`·`startShelfConnect`·`isPendingConnect`·타임아웃·복귀   |
| [`explorer/dnd.ts`](../../src/renderer/src/components/explorer/dnd.ts)                         | `useDnd.server`(M14)·`startServerDrag`·`useSplitDropTarget`(M15)·선반 2단계 훅(M19)·`connectNow` 경로 |
| [`explorer/Explorer.tsx`](../../src/renderer/src/components/explorer/Explorer.tsx)             | `SplitZones` 렌더(M15), 게이트의 pending 반영(M16 ①), `useAutoConnect`의 pending 가드(함정 I)         |
| [`explorer/DragGhost.tsx`](../../src/renderer/src/components/explorer/DragGhost.tsx)           | 서버 행 고스트(M14, 이름 + `host:port`)                                                               |
| [`explorer/ExplorerStates.tsx`](../../src/renderer/src/components/explorer/ExplorerStates.tsx) | `ServerOfflinePanel` 연결 중 본문 = `sidebar.serverConnecting`(M20)                                   |
| [`layout/Sidebar.tsx`](../../src/renderer/src/components/layout/Sidebar.tsx)                   | `ServerRow`의 `draggable`/`onDragStart`/`onDragEnd`(M14)                                              |
| [`stores/useServerStore.ts`](../../src/renderer/src/stores/useServerStore.ts)                  | 단일 플라이 가드(L144)·`cancel`(L212) — 이식하지 않고 그대로 쓴다(P-C2·M17)                           |
| [`stores/useFtpStore.ts`](../../src/renderer/src/stores/useFtpStore.ts)                        | `connect`가 성공하면 `adoptRemote(server, path)`(M16 ②의 채우기) — 무변경                             |
| [`stores/useTabsStore.ts`](../../src/renderer/src/stores/useTabsStore.ts)                      | `openTab`·`placeInPane`·`closeTab`·`visiblePanes`(P-C1·M18) — 무변경                                  |
| [`lib/sendItems.ts`](../../src/renderer/src/lib/sendItems.ts)                                  | `connectSaved`(1번 스펙의 유일 활성화 진입점) — 무변경                                                |

---

## 8. 완료 기준

1. **`Test-1257`~`Test-1266` 10개가 RED(회귀 방어 `Test-1266` 제외) → GREEN**으로 전환(실행 출력으로
   확인). 각 테스트에 `// covers: Test-N` 주석 1:1.
2. **기존 케이스가 계속 GREEN** — 특히 자동 연결(`Test-1019`·`1034`), 선반, 사이드바, 분할 뷰,
   MCP 계약(`Test-450`).
3. **새 IPC 채널 0개**: `src/preload/index.ts` 허용목록과 `src/preload/index.d.ts` 유니언 불변.
4. 새 i18n 키 **3개**(`split.dropHint`·`split.connectFailedTitle`·`split.connectFailedBody`)가
   `en.ts`와 10개 로케일에 있고 `i18n.test.ts`·typecheck GREEN.
5. `npm run typecheck` · `npm run lint` · `npx vitest run` · `npx prettier --check <변경 파일>`
   통과. 뮤테이션(`stryker`)은 이 이식 범위 밖(오케스트레이터 판단).
6. E2E 실측 (실기기 R3):

   | 항목 | 확인 내용                                                                                                  |
   | ---- | ---------------------------------------------------------------------------------------------------------- |
   | (a)  | 사이드바 서버를 끌어 콘텐츠 **오른쪽 절반**에 놓으면 → 오른쪽 패널 + 연결 안내 → 그 서버 탭이 열린다       |
   | (b)  | 비밀번호가 틀린 서버로 (a)를 반복 → 모달이 뜨고 **분할이 사라져 원래 화면**으로 돌아간다                   |
   | (c)  | 접속 불가 주소로 (a)를 반복 → **20초 뒤** 모달 + 시도 취소 + 분할 복귀                                     |
   | (d)  | 분할된 상태에서 다른 서버도 끌어도 **시도가 하나씩**이고, 각 성공이 자기 패널만 채운다                     |
   | (f)  | 선반 항목을 미연결 서버 탭에 놓으면 → 연결·패널 개설(선반 유지) → 그 패널 폴더로 끌어 전송된다             |
   | (g)  | 이미 연결된 서버 탭에 놓으면 분할 없이 바로 전송된다 (기존 동작 회귀 없음)                                 |
   | (h)  | **함정 G**: 두 패널에서 F6를 눌러 포커스가 사이드바 → 탭 → 왼쪽 목록 → 오른쪽 목록 → 선반 순으로 정상 순환 |
   | (i)  | 에이전트 접근(MCP)이 이전과 **완전히 같다**(upstream primary/`conn` 경로 무변경)                           |
