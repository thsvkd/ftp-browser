# 핸드오프: 선반을 하단 플로팅 리모컨으로 — 담기 가이드 · 선반 항목 드래그

R1에서 인간과 합의한 내용의 고충실도 기록. R2(테스트 코드 작성)·구현의 유일한 입력이다.
이 문서에 없는 케이스는 완료 범위 밖이다. 새 케이스를 추가하거나 기존 케이스를 재해석하지 말 것.

작업 유형(R0): **기능 추가 + 위치 이동**. RED 테스트를 먼저 세운 뒤 GREEN으로 만든다.

선행 작업: 없음. 단, [`settings-content.md`](./settings-content.md)(2번)의 `showRail`이 이
스펙의 **레일 토글 소스**로 그대로 쓰인다 — 새로 만들지 말 것.
후속 연결: **선반 항목을 "연결 안 된 서버의 탭"에 놓는 2단계 흐름**(프로그레스 → 분할 개설 →
다시 끌어 폴더 지정)은 [`split-server-drop.md`](./split-server-drop.md)(5번)의 범위다.
이 스펙은 **선반에서 끌 수 있고, 기존 놓기 대상에 놓을 수 있다**는 사실까지만 정한다.

---

## 1. 문제 정의

사용자 피드백 (6번):

> 선반이 오른쪽 사이드바에 있는 것이 아니라 아래에 위치한 플로팅 리모컨 카드로 존재하면 좋을 것
> 같다. 파일을 드래그한 상태에서 "이미 이 폴더에 있습니다"와 같은 가이드가 뜨는 것처럼 아래에
> "끌어서 선반에 담기" 같은 가이드가 생겨서 어디로 끌어오면 선반에 담을 수 있는지 명확히 알 수
> 있게 디자인한다. 선반 영역으로 끌어오면 선반 리모컨 카드가 플로팅으로 떠있는다. 선반에 있는
> 파일들도 드래그가 되어서 어떤 디바이스로 보낼 것인지 선택할 수 있게 uiux를 디자인한다.

### 지금 상태

- 선반은 **오른쪽 레일(288px) 안의 한 탭**이다: `RightRail`가 `선반`/`정보` 세그먼트를 나눠 쓰고,
  `useShelfStore.railTab`이 어느 쪽인지 가진다([`RightRail.tsx:43-90`](../../src/renderer/src/components/layout/RightRail.tsx#L43-L90)).
  선반을 보려면 **화면 오른쪽 288px을 탐색 영역으로부터 빼앗아야 한다.**
- **담기 가이드가 없다.** 놓기 대상이 빛나는 것은 대상 요소 안에서만이고, "어디에 놓아야 담기는지"
  를 한눈에 알 수 없다. 반면 보내기 안내는 있다: 끄는 중 탐색기 하단에 파랑 pill이 뜬다
  ([`Explorer.tsx:827-847`](../../src/renderer/src/components/explorer/Explorer.tsx#L827-L847)).
- **선반 항목은 드래그가 안 된다.** `ItemRow`에 `draggable`/`onDragStart`가 없고
  ([`Shelf.tsx:47-107`](../../src/renderer/src/components/shelf/Shelf.tsx#L47-L107)), `startDrag`를
  부르는 곳은 타일·리스트 행뿐이다. 선반에서 보내려면 **활성 탭을 먼저 찾아야 하는데**, 그게
  "어느 디바이스로 보낼지 고르는" 수요와 정면으로 부딪힌다.
- 선반 항목이 드래그 가능해지면 **놓기 대상은 이미 다 있다**: `useDropTarget`이 탭 pill·사이드바
  장소·서버 행·탐색기 패널·선반까지 다 받는다([`dnd.ts:79-137`](../../src/renderer/src/components/explorer/dnd.ts#L79-L137)).
  **이 스펙의 실질 작업은 "선반을 옮기고, 끌 수 있게 만들고, 담기 가이드를 만드는 것"이다.**

---

## 2. 핵심 결정 (R1에서 인간이 확정)

| #   | 결정                                                                                                                                                                                                | 근거                                                                                                                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| F1  | 선반은 **하단 중앙 고정 플로팅 카드**가 된다. 오른쪽 레일은 **정보만** 남는다                                                                                                                       | 사용자 결정(레일 운명: "정보 탭만 남기기"). 탐색 영역 288px을 되찾는다                                                  |
| F2  | 카드는 **기본 접힘(pill)** 상태: 개수 + 총 용량. 클릭하거나 끄는 중 띠에 호버하면 **펼쳐져 플로팅**된다 (항목 목록 · 활성 탭으로 보내기 · 비우기)                                                   | 펼친 카드가 탐색기 하단 줄을 가리지 않는다. "영역으로 끌어오면 카드가 떠오른다"는 요구와도 같다                         |
| F3  | **선반이 비어 있고 끄는 중이 아니면 카드를 그리지 않는다**. 빈 선반 안내 문구는 띠 안으로 옮긴다                                                                                                    | 플로팅 요소가 늘 떠 있으면 탐색을 방해한다. 지금 레일에 끔찍이 있던 "선반 비어있음"은 끄는 중에만 의미가 있다           |
| F4  | **담기 가이드 = 하단 전폭 띠(56px)**: 앱 안에서 항목을 끄는 동안만 나타나고, 호버하면 띠가 선반 카드로 확장·점등. 띠에 놓으면 선반에 담긴다                                                         | 기존 보내기 pill(`Explorer.tsx:835-846`)과 **같은 언어**(요약 문구 + 색)를 쓴다. 새로 학습할 표현을 만들지 않는다       |
| F5  | 띠의 놓기 대상 키는 **기존 `'shelf'`를 그대로** 쓴다(`useDropTarget('shelf', 'shelf')`, `data-shelf-target`)                                                                                        | 기존 선반·`ShelfSegment`(Test-808)가 쓰던 키를 상속한다. 새 키를 만들면 중복·검색이 갈린다                              |
| F6  | 선반 항목 행은 **`startDrag`를 그대로** 쓰는 드래그 소스가 된다. 놓으면 기존 `sendItems`가 동작한다                                                                                                 | 고스트·`useDnd`·놓기 대상이 이미 있다. 새 DnD 경로를 만들지 않는다                                                      |
| F7  | 선반에서 끌어 놓아 **전송이 시작에 성공하면** 그 항목을 선반에서 뺀다. 실패하거나 선반(자기 자신)에 다시 놓으면 그대로다                                                                            | `dropShelf`의 규칙("시작에 성공한 부분만 뺀다", `sendItems.ts:226-229`)을 그대로 따른다                                 |
| F8  | `useShelfStore.railTab`·`setRailTab`은 **삭제**하고, 대신 `add()`는 **`dockOpen`을 연다.** 툴바 `PathBar`의 패널 버튼과 `Alt+Shift+P`는 **정보 레일 켜기/끄기**로 재정의한다 (`showRail`, 2번 스펙) | 반쪽짜리 상태(`railTab`)를 없애 하나의 소스(`showRail`)로 합친다. 선반이 레일에 없으므로 `railTab`은 존재 근거를 잃는다 |
| F9  | 새 i18n 키 **3개**만: `shelf.expand` · `shelf.collapse` · `shelf.dockHint`. 나머지 문구는 기존(`shelf.dropHere` · `common.itemCount` · `send.toLocation` …) 재사용                                  | 키 11개 로케일 번역 비용을 최소화한다                                                                                   |

### 사용자에게 보이는 동작

| 상황                              | 화면                                                             |
| --------------------------------- | ---------------------------------------------------------------- |
| 선반 비어 있음, 끄는 중 아님      | 아무것도 없다 (탐색기만)                                         |
| 파일을 끈다                       | 탐색기 기존 pill + **하단 담기 띠**가 함께 뜬다                  |
| 띠 위로 커서를 올린다             | 띠가 선반 카드로 **점등·확장**되고 "여기로 끌어오면 선반에 담기" |
| 띠에 놓는다                       | 카드가 담긴 항목으로 바뀌고(접힘 pill), 고스트는 사라진다        |
| 담긴 항목을 끌어 탭/장소에 놓는다 | 기존처럼 전송이 시작되고, **성공하면 그 항목이 선반에서 빠진다** |
| 카드를 클릭한다                   | 펼쳐져 항목 목록 · "활성 탭으로 보내기" · 비우기가 보인다        |

---

## 3. 구현 함정

### 함정 A — `railTab` 삭제의 파급 (F8)

`railTab`은 네 군데에서 읽힌다: `RightRail`(세그먼트), `AppShell`(Alt+Shift+P, L84-88),
**`PathBar.tsx:267,510-512`**(툴바의 정보 버튼), `add()`(담을 때 선반 탭으로 전환).
게다가 테스트가 네 파일에서 이를 단언한다: `useShelfStore.test.ts:33-38`(**Test-786**),
`InfoPanel.test.tsx:80-89`(**Test-835**의 둘째 `it`), `RightRail.test.tsx:31-62`(**Test-808**),
`PathBar.test.tsx:124`. **필드를 그냥 지우면 네 파일이 동시에 깨진다.** §6에 번호 이전·개정
규칙을 따로 적었다 — 케이스를 재해석하지 말고 옮기고 번호를 정리한다.

### 함정 B — 띠와 기존 전송 안내가 겹친다

끄는 중 탐색기 패널에는 이미 하단 pill(전송 요약)이 뜬다. 새 띠는 **창 하단 전폭**이므로
둘은 **서로 다른 자리**다 — 탐색기 안 vs 창 가장자리. 그런데 pill이 `bottom-6`(`Explorer.tsx:836`)
이라 플로팅 카드·띠와 시각적으로 겹칠 수 있다. 띠는 `z`를 pill보다 **위**로 두고, 띠가 뜬 동안
탐색기 pill은 그대로 두되 카드가 가리지 않도록 **카드는 띠 위로만 뜬다**(F2의 확장 동작이 그 역할).

### 함정 C — 고스트의 썸네일 조회가 선반 행에서 빈손이다

`startDrag`는 `[data-path="..."] img`에서 썸네일을 찾는다
([`dnd.ts:34-41`](../../src/renderer/src/components/explorer/dnd.ts#L34-L41)). 선반 행에는
`data-path`가 없어 고스트가 **개수만** 보인다. 선반 행에도 `data-path={entry.path}`를 주면
기존 고스트가 그대로 산다. (`data-path`가 목록 타일과 겹치는 것은 무해하다 — 조회는 썸네일
`img` 하나뿐이고, 선반의 `img`는 이미 있다.)

### 함정 D — `dropShelf`의 `flyTo`가 빈 요소를 찾는다

내려놓기 애니메이션은 `[data-shelf-stack] [data-card]`와 `[data-activity-target]`을 찾는다
([`sendItems.ts:221-225`](../../src/renderer/src/lib/sendItems.ts#L221-L225)). 카드가 **접혀 있으면
`Stack`이 DOM에 없다** → `flyTo`가 빈 배열로 동작한다. 접혀 있는 상태에서 내려놓기가 일어나는
경로(버튼·Ctrl+Enter)가 있으므로, **내려놓기 시작 시 카드를 펼치거나, 접혀 있어도 `Stack`을
감춰 두지 말고 `aria-hidden`으로만 숨길지**를 정해야 한다. **감춰 두는 쪽(뒤집기 쉬운 쪽)**을
택했다: `hidden` 클래스 대신 `opacity`/`pointer-events`로만 감춰 `flyTo`가 요소를 찾게 한다.

### 함정 E — F6 사이클과 `data-region="shelf"`

`AppShell.REGIONS`의 네 번째 지역이 `[data-region="shelf"]` 셀렉터를 쓴다
([`AppShell.tsx:26-29`](../../src/renderer/src/components/layout/AppShell.tsx#L26-L29)). 레일이
정보만 남으면 그 셀렉터는 **정보 패널**을 가리키고, 선반은 도크로 옮겨 `data-region`이 사라진다.
지역 정의를 **도크의 셀렉터**(`[data-region="shelf-dock"]`)로 갱신하고, 띠·카드가 `data-region`을
가지게 해야 F6가 선반에 닿는다.

### 함정 F — 띠가 드래그를 삼킨다

띠는 `fixed` 전폭이라 **그 아래의 탐색기 마지막 줄·상태바 클릭**을 막는다. 띠는 끄는 중에만
`pointer-events-auto`이고, 평소에는 `pointer-events-none`이어야 한다. 또한 `AppShell`의 루트
`onDragOver`가 `over`를 지우는 규칙(`AppShell.tsx:111-114`)과 충돌하지 않도록 **띠는 자기
`onDragOver`에서 `stopPropagation`을 해야 한다** — `useDropTarget`이 이미 그렇게 한다(F5).

---

## 4. 대상 API

```ts
// src/renderer/src/stores/useShelfStore.ts (F8)

interface ShelfStore {
  items: ShelfItem[]
  /** 하단 리모컨 카드를 펼쳤는지. add()가 true로 만든다(기존 railTab의 자리를 잇는다). */
  dockOpen: boolean
  add: (entries: readonly ExplorerEntry[]) => number // 내부에서 dockOpen: true
  remove: (keys: readonly string[]) => void
  clear: () => void
  setDockOpen: (open: boolean) => void
  toggleDock: () => void
  // railTab · setRailTab 삭제
}
```

```tsx
// src/renderer/src/components/shelf/ShelfDock.tsx (신규 — AppShell이 렌더링)

/**
 * 하단 플로팅 리모컨(F1~F3). 안에는 기존 Shelf(본체)와 EmptyShelf의 안내를 그대로 넣는다.
 * 담기 띠(F4·F5)는 여기에 함께 둔다: 끄는 동안에만 보이는 전폭 56px 띠.
 */
export function ShelfDock(): React.JSX.Element | null {
  const items = useShelfStore((s) => s.items)
  const open = useShelfStore((s) => s.dockOpen)
  const dragging = useDnd((s) => s.items !== null)
  const drop = useDropTarget('shelf', 'shelf') // F5: 기존 키
  if (!items.length && !dragging) return null // F3
  return (
    <>
      {/* F4: 담기 띠 — 끄는 동안만, pointer-events는 이때만 켠다 (함정 F) */}
      <div
        data-region="shelf-dock"
        data-shelf-target
        {...drop.handlers}
        className="fixed inset-x-0 bottom-[状态바높이] h-14 z-30"
      >
        {/* 안내: t('shelf.dockHint') — 드롭하면 기존 add()로 담긴다 */}
      </div>
      {/* F1·F2: 카드. 접힘 pill / 펼침 패널. Stack은 감춰도 DOM에 남는다(함정 D) */}
      {items.length > 0 && <ShelfRemoteCard open={open} drop={drop} />}
    </>
  )
}
```

```tsx
// 선반 항목 행 (F6·F7·함정 C)
<li
  data-path={entry.path}
  draggable
  onDragStart={(e) => startDrag(e, [entry])}
  onDragEnd={endDrag}
  ...기존 키보드 처리...
/>

// dnd.ts — 선반에서 온 드래그임을 아는 작은 표시(F7)
interface DndState { /* ...기존 */ fromShelf: boolean }
// onDrop에서: sendItems(...).then((ok) => ok && fromShelf && shelf.remove(keys))
```

```tsx
// PathBar·AppShell (F8) — 기존 railTab 토글의 자리를 잇는다
const showRail = useSettingsStore((s) => s.showRail)
onClick={() => useSettingsStore.getState().setShowRail(!showRail)}
// Alt+Shift+P도 같은 동작
```

새 i18n 키 (**3개뿐**, `en.ts` + 10개 로케일):

| 키               | 예시 (en)                       |
| ---------------- | ------------------------------- |
| `shelf.expand`   | `Open the shelf remote`         |
| `shelf.collapse` | `Close the shelf remote`        |
| `shelf.dockHint` | `Drop here to add to the shelf` |

---

## 5. 기각한 대안

- **선반을 하단에 고정하지 않고 드래그로 떠다니게** — 위치를 매번 찾아야 해 "어디로 끌어오면
  담기는지"라는 요구가 오히려 흐려진다. 하단 고정이 가이드와 한 쌍이다. 기각.
- **선반 항목을 끌면 즉시(드래그 시작 시) 선반에서 제거** — 끄기를 취소하면 항목이 사라진다.
  **시작에 성공했을 때만** 뺀다(F7). 기각.
- **OS에서 끌어온 파일도 선반에 담기** — `ShelfItem`은 `ExplorerEntry`를 담고, OS 파일은
  `File`이라 경로 확보·경로 키·미리보기 요청이 전부 새로 필요하다. 범위 밖. 기각.
- **카드를 늘 펼친 채 두기** — 탐색기 하단을 계속 가려 놓기 대상과 겹친다. 접힘이 기본이다(F2). 기각.
- **`railTab`을 남겨두고 세그먼트만 숨기기** — 쓰이지 않는 상태 필드와 `setRailTab` 호출이 남아
  "언제 선반이 레일로 돌아올지"를 애매하게 만든다. F8에서 기각.
- **담기 띠를 탐색기 패널 안(bottom pill 자리)에 통합** — pill은 **보낼 곳**의 요약이고, 띠는
  **담을 곳**이다. 같은 자리에 두면 무엇을 가리키는지 모호해진다. 기각(함정 B).
- **선반을 새 사이드바(왼쪽 아래)로 옮기기** — 사용자가 명시히 "아래"를 요구했다. 기각.

---

## 6. 테스트 케이스 리스트 (확정)

`Test-894`부터 신규. 기존 최대 번호는 `Test-893`([`settings-content.md`](./settings-content.md)).
각 테스트에 `covers: Test-N` 주석을 단다. **1:1 매핑. 케이스 추가·병합·재해석 금지.**

### 기존 번호의 정리 (함정 A — **반드시 이대로**)

| 기존 케이스                                                   | 위치                                         | 처리                                                                                                               |
| ------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `Test-786`의 "switches the rail" 어서션                       | `stores/useShelfStore.test.ts:33`            | **어서션 제거**. 케이스의 나머지(중복·remove·clear)는 그대로. "담으면 연다"는 **Test-894**로 이전                  |
| `Test-835`의 둘째 `it` "Alt+Shift+P로 선반↔정보 전환"         | `components/shelf/InfoPanel.test.tsx:80-89`  | **번호 회수**, 기대는 **Test-904**(레일 켜기/끄기)로 이전                                                          |
| `Test-808` "정보를 보는 중에도 선반 세그먼트가 놓기를 받는다" | `components/layout/RightRail.test.tsx:27-62` | **번호 회수**. 세그먼트가 사라졌으므로, 같은 기대("어느 탭에 있든 선반으로 놓는다")는 **Test-898**(담기 띠)로 이전 |
| `PathBar.test.tsx:124`의 `railTab` 단언                       | `components/explorer/PathBar.test.tsx`       | **어서션 갱신**: `showRail`로 바꾼다(케이스 번호는 그대로)                                                         |

### A. 스토어 (`stores/useShelfStore.test.ts`)

| #        | 케이스                                                                              | 기대                                    |
| -------- | ----------------------------------------------------------------------------------- | --------------------------------------- |
| Test-894 | 항목을 담으면 `dockOpen`이 `true`가 된다 (기존 `Test-786`에서 옮겨온 케이스)        | F8. `add`가 화면을 드러내는 유일한 경로 |
| Test-895 | `toggleDock`·`setDockOpen` 동작, `clear()`로 항목을 비워도 `dockOpen` 값은 유지된다 | F2·F3 — 비워도 상태가 튕기지 않는다     |

### B. 도크 (`components/shelf/ShelfDock.test.tsx` 신규)

| #        | 케이스                                                                                             | 기대                                                                    |
| -------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Test-896 | 선반이 비어 있고 끄는 중이 **아니면** 도크가 하나도 그려지지 않는다                                | F3                                                                      |
| Test-897 | 항목이 있으면 접힌 카드(개수·용량)가 보이고, 열면 기존 본체(항목 목록·보내기 버튼·비우기)가 나온다 | F1·F2 — 본체는 기존 `Shelf`를 재사용한다                                |
| Test-898 | **끄는 동안 하단 담기 띠**가 보이고, 띠에 놓으면 선반에 담긴다 — 기존 `Test-808`의 기대를 잇는다   | F4·F5. 띠는 `data-shelf-target`·`useDropTarget('shelf','shelf')`를 쓴다 |
| Test-899 | 띠를 지나 **다른 곳**에 놓으면 띠가 사라지고 선반은 비어 있던 그대로다                             | F4의 취소 경로                                                          |
| Test-900 | 선반 항목 행을 끌면 `useDnd.items`에 그 항목이 들어가고 고스트가 뜬다 (`data-path`로 썸네일 포함)  | F6·함정 C                                                               |
| Test-901 | 선반에서 끌어 **다른 위치**에 놓아 전송이 시작되면 그 항목이 선반에서 빠진다                       | F7                                                                      |
| Test-902 | 선반에서 끌어 **띠(선반)로 다시** 놓으면 중복 없이 그대로다                                        | F7의 예외 + 기존 `add` 중복 규칙                                        |

### C. 레일 · 툴바 · 단축키

| #        | 케이스                                                                                   | 기대      |
| -------- | ---------------------------------------------------------------------------------------- | --------- |
| Test-903 | 레일에는 선반 세그먼트가 없고 정보가 레일 전체를 쓴다 (기존 `Test-808` 번호 회수)        | F1        |
| Test-904 | `PathBar`의 패널 버튼과 `Alt+Shift+P`가 **정보 레일을 켜고 끈다** (기존 `Test-835` 이전) | F8·함정 A |

### D. 배선 (`components/explorer/Explorer.test.tsx`)

| #        | 케이스                                                                                      | 기대                                                        |
| -------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Test-905 | 탐색기에서 끄는 동안 **기존 하단 안내 pill과 새 담기 띠가 함께** 보이고, 띠에 놓으면 담긴다 | 함정 B — 기존 전송 안내가 죽지 않았음 + 새 띠가 함께 성립함 |

- 기존 `Test-806`·`807`·`838`·`839`(선반 본체·전송·충돌)과 `Test-786`의 나머지·`Test-835`의 첫째
  `it`은 **그대로 GREEN이어야 한다.**
- E2E가 전담할 것: 실제로 끌어서 띠에 놓고, 놓은 항목을 탭으로 끌어 보내는 흐름(§8 표).

---

## 7. 관련 코드 포인터

| 파일                                                                                                                                                                                                                                                                                                                                                                        | 역할                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [`components/shelf/Shelf.tsx`](../../src/renderer/src/components/shelf/Shelf.tsx)                                                                                                                                                                                                                                                                                           | 본체 `Shelf` L152-255(**재사용**), `Stack` L24-45(함정 D), `ItemRow` L47-107(F6·함정 C 대상) |
| [`stores/useShelfStore.ts`](../../src/renderer/src/stores/useShelfStore.ts)                                                                                                                                                                                                                                                                                                 | `railTab` L11·17·22·33·44 삭제, `dockOpen` 신규(F8)                                          |
| [`components/layout/RightRail.tsx`](../../src/renderer/src/components/layout/RightRail.tsx)                                                                                                                                                                                                                                                                                 | 세그먼트 제거(L13-40·43-90), 정보만 남긴다(F1)                                               |
| [`components/layout/AppShell.tsx`](../../src/renderer/src/components/layout/AppShell.tsx)                                                                                                                                                                                                                                                                                   | `REGIONS` L21-30(함정 E), Alt+Shift+P L84-88(F8), 도크 렌더 자리 L117-124                    |
| [`components/explorer/PathBar.tsx`](../../src/renderer/src/components/explorer/PathBar.tsx)                                                                                                                                                                                                                                                                                 | 툴바 패널 버튼 L267·L510-512 → `showRail`(F8)                                                |
| [`components/explorer/dnd.ts`](../../src/renderer/src/components/explorer/dnd.ts)                                                                                                                                                                                                                                                                                           | `startDrag` L33-58(F6·함정 C), `useDropTarget` L79-137(F5·F7의 분기점)                       |
| [`components/explorer/Explorer.tsx`](../../src/renderer/src/components/explorer/Explorer.tsx)                                                                                                                                                                                                                                                                               | 기존 드롭 안내 pill L827-847(함정 B, **무변경**)                                             |
| [`lib/sendItems.ts`](../../src/renderer/src/lib/sendItems.ts)                                                                                                                                                                                                                                                                                                               | `dropShelfOnce` L210-231(F7·flyTo 근거), `sendItems` L184-191                                |
| [`components/shelf/Shelf.test.tsx`](../../src/renderer/src/components/shelf/Shelf.test.tsx) · [`layout/RightRail.test.tsx`](../../src/renderer/src/components/layout/RightRail.test.tsx) · [`shelf/InfoPanel.test.tsx`](../../src/renderer/src/components/shelf/InfoPanel.test.tsx) · [`stores/useShelfStore.test.ts`](../../src/renderer/src/stores/useShelfStore.test.ts) | 기존 하네스와 번호 이전 대상(함정 A)                                                         |

---

## 8. 완료 기준

1. `Test-894`~`Test-905`가 모두 GREEN (실행 출력으로 확인).
2. **기존 `Test-806`·`807`·`838`·`839`·`826`·`827`·`828`가 계속 GREEN.** `Test-786`·`Test-835`는
   §6의 정리대로 어서션이 갱신된 뒤 GREEN.
3. §6의 번호 정리(회수 2개 · 이전 3개 · 어서션 갱신 1개)를 그대로 수행하고, 회수된 번호가
   다른 테스트에 재사용되지 않았는지 확인한다.
4. 새 i18n 키 **3개**가 `en.ts`와 10개 로케일에 있고 `i18n.test.ts`·typecheck가 GREEN.
5. `railTab`·`setRailTab`이 코드와 테스트 어디에도 남지 않았는지
   (`graft grep railTab` → 결과 없음) 확인한다.
6. 뮤테이션: `git diff --unified=0 -- src/renderer/src/components/shelf/Shelf.tsx src/renderer/src/stores/useShelfStore.ts src/renderer/src/components/layout/RightRail.tsx src/renderer/src/components/layout/AppShell.tsx src/renderer/src/components/explorer/dnd.ts src/renderer/src/components/explorer/PathBar.tsx | grep '^@@'`로
   변경 라인을 확인해 `stryker.config.json`의 `mutate`를 갱신하고 `break: 70` 통과.
7. `npm run typecheck` · `npm run lint` · `npx prettier --check <변경 파일>` · `npm test` 통과.
8. E2E 실측 (실기기 R3):

   | 항목 | 확인 내용                                                                                           |
   | ---- | --------------------------------------------------------------------------------------------------- |
   | (a)  | 파일을 끌면 하단 담기 띠가 뜨고, 띠에 호버하면 선반 카드가 점등·확장되며 놓으면 담긴다              |
   | (b)  | 선반이 비어 있고 끄는 중이 아니면 화면에 선반 흔적이 없다                                           |
   | (c)  | 담긴 항목을 끌어 탭·사이드바 장소·탐색기 패널에 놓으면 전송이 시작되고 **성공하면 선반에서 빠진다** |
   | (d)  | 전송이 실패하면(막힌 대상) 선반 항목이 남아 있다                                                    |
   | (e)  | 카드의 보내기 버튼·Ctrl+Enter 내려놓기가 기존과 같은 결과를 낸다(접힌 상태에서도 `flyTo`가 동작)    |
   | (f)  | 툴바 정보 버튼과 Alt+Shift+P가 정보 레일을 켜고 끈다. 레일에 선반 세그먼트는 없다                   |
   | (g)  | 288px을 되찾은 탐색기가 넓어지고, F6 사이클이 선반 카드·담기 띠에 닿는다                            |
