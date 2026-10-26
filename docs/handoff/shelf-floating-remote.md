# 핸드오프: 선반을 하단 플로팅 리모컨으로 — 담기 가이드 · 선반 항목 드래그

R1에서 인간과 합의한 내용의 고충실도 기록. R2(테스트 코드 작성)·구현의 유일한 입력이다.
이 문서에 없는 케이스는 완료 범위 밖이다. 새 케이스를 추가하거나 기존 케이스를 재해석하지 말 것.

작업 유형(R0): **기능 추가 + 위치 이동**. RED 테스트를 먼저 세운 뒤 GREEN으로 만든다.

> **출처 · 이식 노트**: 원본은 `feat/feedback-batch`(v1.3.0 기준)의 `docs/handoff/shelf-floating-remote.md`
> 및 그 구현(`ShelfDock.tsx` 등)이다. 본 문서는 그 스펙을 **v1.4.0 + 4개 이식 스펙**이 얹힌
> `feat/feedback-v1.5` 위으로 재이식하며, 케이스 번호를 `Test-894~905` → **`Test-1245~1256`**(+351)로
> 옮겼다(이 분기의 기준 최대 번호는 `Test-1244`, upstream origin/main 기준은 1201). 결정 F1~F9는
> 원안 그대로이나, 아래에 표시한 F4·F8과 §3 함정 A·§6 번호 정리는 이 분기의 현실에 맞춰 개정했다.
> 개정·제외된 항목은 모두 §9 "이식에서 제외"에 남겼다.

선행 작업: 없음. 후속 연결: **선반 항목을 "연결 안 된 서버의 탭"에 놓는 2단계 흐름**(프로그레스 →
분할 개설 → 다시 끌어 폴더 지정)은 [`split-server-drop.md`](./split-server-drop.md)(5번)의 범위다.
이 스펙은 **선반에서 끌 수 있고, 기존 놓기 대상에 놓을 수 있다**는 사실까지만 정한다.

---

## 1. 문제 정의

사용자 피드백 (6번):

> 선반이 오른쪽 사이드바에 있는 것이 아니라 아래에 위치한 플로팅 리모컨 카드로 존재하면 좋을 것
> 같다. 파일을 드래그한 상태에서 "이미 이 폴더에 있습니다"와 같은 가이드가 뜨는 것처럼 아래에
> "끌어서 선반에 담기" 같은 가이드가 생겨서 어디로 끌어오면 선반에 담을 수 있는지 명확히 알 수
> 있게 디자인한다. 선반 영역으로 끌어오면 선반 리모컨 카드가 플로팅으로 떠있는다. 선반에 있는
> 파일들도 드래그가 되어서 어떤 디바이스로 보낼 것인지 선택할 수 있게 uiux를 디자인한다.

### 지금 상태 (이 분기)

- 선반은 **오른쪽 레일(288px) 안의 한 탭**이다: `RightRail`가 `선반`/`정보` 세그먼트를 나눠 쓰고,
  `useShelfStore.railTab`이 어느 쪽인지 가진다([`RightRail.tsx:43-90`](../../src/renderer/src/components/layout/RightRail.tsx#L43-L90)).
  선반을 보려면 **화면 오른쪽 288px을 탐색 영역으로부터 빼앗아야 한다.** 단, 레일의 켬/끊음 자체는
  이미 `useLayoutStore`(`left`/`right` 패널) + 툴바 `PaneToggle` + `Ctrl+Alt+B`로 배선돼 있다(§9).
- **담기 가이드가 없다.** 놓기 대상이 빛나는 것은 대상 요소 안에서만이고, "어디에 놓아야 담기는지"
  를 한눈에 알 수 없다. 반면 보내기 안내는 있다: 끄는 중 탐색기 하단에 알약이 뜬다
  ([`Explorer.tsx:1035-1058`](../../src/renderer/src/components/explorer/Explorer.tsx#L1035-L1058)).
- **선반 항목은 드래그가 안 된다.** `ItemRow`에 `draggable`/`onDragStart`가 없고
  ([`Shelf.tsx:48-108`](../../src/renderer/src/components/shelf/Shelf.tsx#L48-L108)), `startDrag`를
  부르는 곳은 타일·리스트 행뿐이다. 선반에서 보내려면 **활성 탭을 먼저 찾아야 하는데**, 그게
  "어느 디바이스로 보낼지 고르는" 수요와 정면으로 부딪힌다.
- 선반 항목이 드래그 가능해지면 **놓기 대상은 이미 다 있다**: `useDropTarget`이 탭 pill·사이드바
  장소·서버 행·탐색기 패널·선반까지 다 받는다([`dnd.ts:82-142`](../../src/renderer/src/components/explorer/dnd.ts#L82-L142)).
  다만 **OS 파일 드롭**(`shelf-os-drop.md` 스펙)이 이 분기에 추가로 얹어져 있어, 선반의 놓기 대상은
  OS 파일도 받아야 한다 — 새 도크가 그 대상을 물려받는다(F4·§9-3).
  **이 스펙의 실질 작업은 "선반을 옮기고, 끌 수 있게 만들고, 담기 가이드를 만드는 것"이다.**

---

## 2. 핵심 결정 (R1에서 인간이 확정)

| #   | 결정                                                                                                                                                                                                                                             | 근거                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | 선반은 **하단 중앙 고정 플로팅 카드**가 된다. 오른쪽 레일은 **정보만** 남는다                                                                                                                                                                    | 사용자 결정(레일 운명: "정보 탭만 남기기"). 탐색 영역 288px을 되찾는다                                                                            |
| F2  | 카드는 **기본 접힘(pill)** 상태: 개수 + 총 용량. 클릭하거나 끄는 중 띠에 호버하면 **펼쳐져 플로팅**된다 (항목 목록 · 활성 탭으로 보내기 · 비우기)                                                                                                | 펼친 카드가 탐색기 하단 줄을 가리지 않는다. "영역으로 끌어오면 카드가 떠오른다"는 요구와도 같다                                                   |
| F3  | **선반이 비어 있고 끄는 중이 아니면 카드를 그리지 않는다**. 빈 선반 안내 문구는 띠 안으로 옮긴다                                                                                                                                                 | 플로팅 요소가 늘 떠 있으면 탐색을 방해한다. 지금 레일에 끔찍이 있던 "선반 비어있음"은 끄는 중에만 의미가 있다                                     |
| F4  | **담기 가이드 = 하단 전폭 띠(56px)**: 앱 안에서 항목을 끄는 동안만 나타나고, 호버하면 띠가 선반 카드로 확장·점등. 띠에 놓으면 선반에 담긴다.<br>**이 분기 개정**: OS 파일 드래그 중에도 띠가 뜬다(§9-3)                                          | 기존 보내기 알약(`Explorer.tsx:1043-1056`)과 **같은 언어**(요약 문구 + 색)을 쓴다. OS 드래그는 shelf-os-drop 보존 필수                            |
| F5  | 띠의 놓기 대상 키는 **기존 `'shelf'`를 그대로** 쓴다(`useDropTarget('shelf', 'shelf')`, `data-shelf-target`)                                                                                                                                     | 기존 선반·`ShelfSegment`(Test-808)가 쓰던 키를 상속한다. 새 키를 만들면 중복·검색이 갈린다                                                        |
| F6  | 선반 항목 행은 **`startDrag`를 그대로** 쓰는 드래그 소스가 된다. 놓으면 기존 `sendItems`가 동작한다                                                                                                                                              | 고스트·`useDnd`·놓기 대상이 이미 있다. 새 DnD 경로를 만들지 않는다                                                                                |
| F7  | 선반에서 끌어 놓아 **전송이 시작에 성공하면** 그 항목을 선반에서 뺀다. 실패하거나 선반(자기 자신)에 다시 놓으면 그대로다                                                                                                                         | `dropShelfOnce`의 규칙("시작에 성공한 부분만 뺀다", `sendItems.ts:297-300`)을 그대로 따른다                                                       |
| F8  | `useShelfStore.railTab`·`setRailTab`은 **삭제**하고, 대신 `add()`는 **`dockOpen`을 연다.** 툴바 `PathBar`의 `explorer.details` 패널 버튼과 `Alt+Shift+P`는 **오른쪽 정보 패널 켜기/끄기**로 재정의한다 — 소스는 `useLayoutStore.toggle('right')` | 반쪽짜리 상태(`railTab`)를 없애 하나의 소스로 합친다. 원안의 토글 소스 `showRail`는 이 분기에 없다(§9-1: superseded by upstream `useLayoutStore`) |
| F9  | 새 i18n 키 **3개**만: `shelf.expand` · `shelf.collapse` · `shelf.dockHint`. 나머지 문구는 기존(`shelf.dropHere` · `common.itemCount` · `send.toLocation` …) 재사용                                                                               | 키 11개 로케일 번역 비용을 최소화한다                                                                                                             |

### 사용자에게 보이는 동작

| 상황                              | 화면                                                             |
| --------------------------------- | ---------------------------------------------------------------- |
| 선반 비어 있음, 끄는 중 아님      | 아무것도 없다 (탐색기만)                                         |
| 파일을 끈다                       | 탐색기 기존 알약 + **하단 담기 띠**가 함께 뜬다                  |
| 띠 위로 커서를 올린다             | 띠가 선반 카드로 **점등·확장**되고 "여기로 끌어오면 선반에 담기" |
| 띠에 놓는다                       | 카드가 담긴 항목으로 바뀌고(접힘 pill), 고스트는 사라진다        |
| 담긴 항목을 끌어 탭/장소에 놓는다 | 기존처럼 전송이 시작되고, **성공하면 그 항목이 선반에서 빠진다** |
| 카드를 클릭한다                   | 펼쳐져 항목 목록 · "활성 탭으로 보내기" · 비우기가 보인다        |

---

## 3. 구현 함정

### 함정 A — `railTab` 삭제의 파급 (F8)

`railTab`은 **이 분기에서 여섯 군데**에서 읽힌다: `RightRail`(세그먼트), `AppShell`(Alt+Shift+P,
L117-121), **`PathBar.tsx:308,439-440,500,729-730`(툴바 details 버튼과 ⋯ 메뉴)**, `add()`(담을 때
선반 탭으로 전환). 게다가 테스트가 여러 파일에서 이를 단언한다:
`useShelfStore.test.ts:33-38`(**Test-786**), `InfoPanel.test.tsx:80-91`(**Test-835**의 둘째 `it`),
`RightRail.test.tsx`(**Test-808**·**Test-879**), `PathBar.test.tsx:158·289`(**Test-828**·**Test-1166**),
`AppShell.test.tsx:532·558`(**Test-1084**), `sendItems.test.ts`(**Test-874·875·876**),
`explorerTestHarness.ts:181`(매 테스트 리셋). **필드를 그냥 지우면 여섯 파일이 동시에 깨진다.**
§6에 번호 이전·개정 규칙을 따로 적었다 — 케이스를 재해석하지 말고 옮기고 번호를 정리한다.

### 함정 B — 띠와 기존 전송 안내가 겹친다

끄는 중 탐색기 패널에는 이미 하단 알약(전송 요약)이 뜬다. 새 띠는 **창 하단 전폭**이므로 둘은
**서로 다른 자리**다 — 탐색기 안 vs 창 가장자리. 그런데 알약이 `bottom-6`(`Explorer.tsx:1044`)이라
플로팅 카드·띠와 시각적으로 겹칠 수 있다. 띠는 `z`를 알약보다 **위**로 두고, 띠가 뜬 동안
탐색기 알약은 그대로 두되 카드가 가리지 않도록 **카드는 띠 위로만 뜬다**(F2의 확장 동작이 그 역할).

### 함정 C — 고스트의 썸네일 조회가 선반 행에서 빈손이다

`startDrag`는 `[data-path="..."] img`에서 썸네일을 찾는다
([`dnd.ts:34-43`](../../src/renderer/src/components/explorer/dnd.ts#L34-L43)). 선반 행에는
`data-path`가 없어 고스트가 **개수만** 보인다. 선반 행에도 `data-path={entry.path}`를 주면
기존 고스트가 그대로 산다. (`data-path`가 목록 타일과 겹치는 것은 무해하다 — 조회는 썸네일 `img`
하나뿐이고, 선반의 `img`는 이미 있다. 선반 밖의 행이라 `[data-tab-pane]` 조상이 없으면 루트가
`document`가 되므로 조회는 그대로 동작한다.)

### 함정 D — `dropShelf`의 `flyTo`가 빈 요소를 찾는다

내려놓기 애니메이션은 `[data-shelf-stack] [data-card]`와 `[data-activity-target]`을 찾는다
([`sendItems.ts:292-296`](../../src/renderer/src/lib/sendItems.ts#L292-L296)). 카드가 **접혀 있으면
`aria-hidden`이라 접근성 트리에서는 빠진다** → flyTo는 DOM에서 요소를 찾아야 한다. **감춰 두는 쪽
(뒤집기 쉬운 쪽)** 을 택했다: `hidden` 클래스 대신 `opacity`/`pointer-events`/`aria-hidden`으로만
숨겨 `flyTo`가 요소를 찾게 한다. 내려놓기 시작 시 카드를 펼치지 않아도 된다.

### 함정 E — F6 사이클과 `data-region="shelf"`

`AppShell.REGIONS`의 다섯 번째 지역이 `[data-region="shelf"]` 셀렉터를 쓴다
([`AppShell.tsx:31-41`](../../src/renderer/src/components/layout/AppShell.tsx#L31-L41)). 레일이
정보만 남으면 그 셀렉터가 **정보 패널**(`data-region="info"`)을 가리키게 되고, 선반은 도크로
옮겨 `data-region`이 사라진다. 지역 정의를 **도크의 셀렉터**(`[data-region="shelf-dock"]`)로
갱신하고, 띠·카드가 `data-region`을 가지게 해야 F6가 선반에 닿는다. 레일이 F6 순환에서 빠지는
대신, 정보 패널의 버튼은 마우스 전용이 된다(원 스펙과 동일한 결과 — §9-4).

### 함정 F — 띠가 드래그를 삼킨다

띠는 `fixed` 전폭이라 **그 아래의 탐색기 마지막 줄·상태바 클릭**을 막는다. 띠는 **그려져 있을
동안에만**(앱 안 드래그·OS 파일 드래그 중) `pointer-events`가 켜져 있고, 평소에는 아예 DOM에
없다(F3). 또한 `AppShell`의 루트 `onDragOver`가 `over`를 지우는 규칙(`AppShell.tsx:144`)과
충돌하지 않도록 **띠는 자기 `onDragOver`에서 `stopPropagation`을 해야 한다** — `useDropTarget`이
이미 그렇게 한다(F5).

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
 * 하단 플로팅 리모컨(F1~F3). 안에는 기존 Shelf(본체)를 그대로 넣는다.
 * 담기 띠(F4·F5)는 여기에 함께 둔다: 앱 안 드래그·OS 파일 드래그 동안에만 보이는 전폭 56px 띠.
 */
export function ShelfDock(): React.JSX.Element | null {
  const items = useShelfStore((s) => s.items)
  const open = useShelfStore((s) => s.dockOpen)
  const dragging = useDnd((s) => s.items !== null) // 앱 안 드래그
  const osDrag = useOsDrag() // OS 파일 드래그(F4 개정, §9-3)
  const drop = useDropTarget('shelf', 'shelf') // F5: 기존 키
  if (!items.length && !dragging && !osDrag) return null // F3
  return (
    <>
      {/* F4·함정 F: 띠는 끄는 동안에만, pointer-events는 이때만 켠다 */}
      <div
        data-region="shelf-dock"
        data-shelf-target
        {...drop.handlers}
        className="fixed inset-x-0 bottom-8 h-14 z-30 …"
      >
        {/* 안내: t('shelf.dockHint') — 드롭하면 기존 add()로 담긴다(OS 드롭은 shelveOsFiles) */}
      </div>
      {/* F1·F2: 카드. 접힘 pill / 펼침 패널. Stack은 감춰도 DOM에 남는다(함정 D) */}
      {items.length > 0 && <ShelfRemoteCard open={open || (dragging && drop.over)} drop={drop} />}
    </>
  )
}
```

```tsx
// 선반 항목 행 (F6·F7·함정 C)
<li
  data-path={entry.path}
  draggable
  onDragStart={(e) => startDrag(e, [entry], true)}
  onDragEnd={endDrag}
  ...기존 키보드 처리...
/>

// dnd.ts — 선반에서 온 드래그임을 아는 작은 표시(F7)
interface DndState { /* ...기존 */ fromShelf: boolean }
export function startDrag(e: DragEvent, items: ExplorerEntry[], fromShelf = false): void
// onDrop에서: endDrag() 전에 fromShelf를 빼앗고,
// void sendItems(dragged, dest).then((ok) => ok && fromShelf && shelf.remove(dragged.map(locKey)))
```

```tsx
// PathBar·AppShell (F8) — 오른쪽 정보 패널의 단일 소스(useLayoutStore)로 재정의
const infoOpen = useLayoutStore((s) => !s.right.collapsed) // PathBar: aria-pressed·Check
const toggleInfo = (): void => useLayoutStore.getState().toggle('right')
// AppShell Alt+Shift+P도 같은 동작 (기존 Ctrl+Alt+B 단축키는 그대로)
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
- **OS에서 끌어온 파일도 선반에 담기** — 원 스펙 시점엔 범위 밖이었으나, 이 분기에는 upstream
  `shelf-os-drop.md`가 이미 그 기능과 테스트(Test-874~883)를 실었다. **기각을 번복**: 도크가 OS
  드롭을 잇는다(F4 개정·§9-3).
- **카드를 늘 펼친 채 두기** — 탐색기 하단을 계속 가려 놓기 대상과 겹친다. 접힘이 기본이다(F2). 기각.
- **`railTab`을 남겨두고 세그먼트만 숨기기** — 쓰이지 않는 상태 필드와 `setRailTab` 호출이 남아
  "언제 선반이 레일로 돌아올지"를 애매하게 만든다. F8에서 기각.
- **담기 띠를 탐색기 패널 안(bottom 알약 자리)에 통합** — 알약은 **보낼 곳**의 요약이고, 띠는
  **담을 곳**이다. 같은 자리에 두면 무엇을 가리키는지 모호해진다. 기각(함정 B).
- **선반을 새 사이드바(왼쪽 아래)로 옮기기** — 사용자가 명시히 "아래"를 요구했다. 기각.

---

## 6. 테스트 케이스 리스트 (확정)

`Test-1245`부터 신규(원 번호 `Test-894~905`의 +351 이식). 기존 최대 번호는 `Test-1244`
(upstream origin/main 기준은 1201). 각 테스트에 `covers: Test-N` 주석을 단다.
**1:1 매핑. 케이스 추가·병합·재해석 금지.**

### 기존 번호의 정리 (함정 A — **반드시 이대로**)

| 기존 케이스                                                            | 위치                                                                                                       | 처리                                                                                                                                                                |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Test-786`의 "switches the rail" 어서션                                | `stores/useShelfStore.test.ts:33-38`                                                                       | **어서션 제거 → `dockOpen` 단언으로 교체**. 케이스의 나머지(중복·remove·clear)는 그대로. "담으면 연다"는 **Test-1245**로 이전                                       |
| `Test-835`의 둘째 `it` "Alt+Shift+P로 선반↔정보 전환"                  | `components/shelf/InfoPanel.test.tsx:80-91`                                                                | **번호 회수**, 기대는 **Test-1255**(오른쪽 정보 패널 켜기/끊기)로 이전                                                                                              |
| `Test-808` "정보를 보는 중에도 선반 세그먼트가 놓기를 받는다"          | `components/layout/RightRail.test.tsx:35-74`                                                               | **번호 회수**. 세그먼트가 사라졌으므로, 같은 기대("어느 자리에 놓든 선반에 담긴다")는 **Test-1249**(담기 띠)로 이전                                                 |
| `Test-879`(upstream `shelf-os-drop.md`) OS 파일을 선반 세그먼트에 놓기 | `components/layout/RightRail.test.tsx:76-119`                                                              | **번호 유지**. 세그먼트 소멸이 F1이 깬 것이므로, 테스트를 `ShelfDock.test.tsx`로 옮겨 **담기 띠에 재조준**(OS 드롭 수용 유지). "정보 본문은 대상이 아니다"는 그대로 |
| `Test-877`(upstream) 마지막 단언 — AppShell + 문서 가드                | `components/shelf/Shelf.test.tsx:421-433`                                                                  | **번호 유지**. AppShell의 선반 놓기 대상이 이제 담기 띠이므로, OS 드래그 진입 후 띠에 대해 같은 단언(가드가 `none`으로 못 덮음)                                     |
| `PathBar.test.tsx:158·289`의 `railTab` 단언                            | `components/explorer/PathBar.test.tsx` (**Test-828**·**Test-1166**)                                        | **어서션 갱신**: `useLayoutStore.right.collapsed` 토글로 바꾼다(케이스 번호는 그대로)                                                                               |
| `shelfTab`·레일 region 단언                                            | `components/layout/AppShell.test.tsx` (**Test-834**·**Test-914**·**Test-915**·**Test-1082**·**Test-1084**) | **단언 갱신**: F6 지역·레일 region을 도크/`data-region="info"`로 교체. 번호 유지                                                                                    |
| `Test-807`의 레일 region 대기 줄                                       | `components/shelf/Shelf.test.tsx:113`                                                                      | 대기를 `listbox`로 교체(케이스 기대는 무변경). 도크가 그 자리를 이어받음                                                                                            |
| `railTab` 단언                                                         | `lib/sendItems.test.ts` (**Test-874**·**Test-875**·**Test-876**)                                           | **어서션 갱신**: `railTab` → `dockOpen`(담으면 열림 / 전부 중복이면 안 열림). 번호 유지                                                                             |
| 리셋                                                                   | `explorerTestHarness.ts:181`                                                                               | `setState({ items: [], dockOpen: false })`로 교체                                                                                                                   |

회수는 **Test-808·Test-835 두 개뿐**이고, 두 번호 모두 다른 테스트에 재사용하지 않는다
(§8-3). 나머지는 번호를 지킨 채 어서션만 갱신한다.

### A. 스토어 (`stores/useShelfStore.test.ts`)

| #         | 케이스                                                                              | 기대                                    |
| --------- | ----------------------------------------------------------------------------------- | --------------------------------------- |
| Test-1245 | 항목을 담으면 `dockOpen`이 `true`가 된다 (기존 `Test-786`에서 옮겨온 케이스)        | F8. `add`가 화면을 드러내는 유일한 경로 |
| Test-1246 | `toggleDock`·`setDockOpen` 동작, `clear()`로 항목을 비워도 `dockOpen` 값은 유지된다 | F2·F3 — 비워도 상태가 튕기지 않는다     |

### B. 도크 (`components/shelf/ShelfDock.test.tsx` 신규)

| #         | 케이스                                                                                             | 기대                                                                    |
| --------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Test-1247 | 선반이 비어 있고 끄는 중이 **아니면** 도크가 하나도 그려지지 않는다                                | F3                                                                      |
| Test-1248 | 항목이 있으면 접힌 카드(개수·용량)가 보이고, 열면 기존 본체(항목 목록·보내기 버튼·비우기)가 나온다 | F1·F2 — 본체는 기존 `Shelf`를 재사용한다                                |
| Test-1249 | **끄는 동안 하단 담기 띠**가 보이고, 띠에 놓으면 선반에 담긴다 — 기존 `Test-808`의 기대를 잇는다   | F4·F5. 띠는 `data-shelf-target`·`useDropTarget('shelf','shelf')`를 쓴다 |
| Test-1250 | 띠를 지나 **다른 곳**에 놓으면 띠가 사라지고 선반은 비어 있던 그대로다                             | F4의 취소 경로                                                          |
| Test-1251 | 선반 항목 행을 끌면 `useDnd.items`에 그 항목이 들어가고 고스트가 뜬다 (`data-path`로 썸네일 포함)  | F6·함정 C                                                               |
| Test-1252 | 선반에서 끌어 **다른 위치**에 놓아 전송이 시작되면 그 항목이 선반에서 빠진다                       | F7                                                                      |
| Test-1253 | 선반에서 끌어 **띠(선반)로 다시** 놓으면 중복 없이 그대로다                                        | F7의 예외 + 기존 `add` 중복 규칙                                        |

(이 파일에는 기존 `Test-879`를 재조준해 옮겨 심는다 — §6 정리 표 참고.)

### C. 레일 · 툴바 · 단축키

| #         | 케이스                                                                                             | 기대                                                                                                                 |
| --------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Test-1254 | 레일에는 선반 세그먼트가 없고 정보가 레일 전체를 쓴다 (기존 `Test-808` 번호 회수 자리)             | F1. `data-region="info"`, `role=tab` 없음                                                                            |
| Test-1255 | `PathBar`의 details 버튼과 `Alt+Shift+P`가 **오른쪽 정보 패널을 켜고 끈다** (기존 `Test-835` 이전) | F8·함정 A. `useLayoutStore.right.collapsed` 토글 + region 가시성. **Test-913(Ctrl+Alt+B)과는 다른 제어**라 중복 아님 |

### D. 배선 (`components/explorer/Explorer.test.tsx`)

| #         | 케이스                                                                                      | 기대                                                        |
| --------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Test-1256 | 탐색기에서 끄는 동안 **기존 하단 안내 알약과 새 담기 띠가 함께** 보이고, 띠에 놓으면 담긴다 | 함정 B — 기존 전송 안내가 죽지 않았음 + 새 띠가 함께 성립함 |

- 기존 `Test-806`·`807`·`838`·`839`(선반 본체·전송·충돌)·`Test-874~879`·`881`과 `Test-786`의 나머지·
  `Test-835`의 첫째 `it`은 **§6 정리대로 갱신된 뒤 GREEN이어야 한다.**
- E2E가 전담할 것: 실제로 끌어서 띠에 놓고, 놓은 항목을 탭으로 끌어 보내는 흐름(§8 표).

---

## 7. 관련 코드 포인터

| 파일                                                                                                                                                                                                                                                                                                                                                                        | 역할                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [`components/shelf/Shelf.tsx`](../../src/renderer/src/components/shelf/Shelf.tsx)                                                                                                                                                                                                                                                                                           | 본체 `Shelf` L153-256(**재사용**), `Stack` L25-46(함정 D), `ItemRow` L48-108(F6·함정 C 대상) |
| [`stores/useShelfStore.ts`](../../src/renderer/src/stores/useShelfStore.ts)                                                                                                                                                                                                                                                                                                 | `railTab` L11·17·22·33·44 삭제, `dockOpen` 신규(F8)                                          |
| [`components/shelf/ShelfDock.tsx`](../../src/renderer/src/components/shelf/ShelfDock.tsx)                                                                                                                                                                                                                                                                                   | 신규: 띠·카드·pill·OS 드래그 감지(F4 개정)                                                   |
| [`components/layout/RightRail.tsx`](../../src/renderer/src/components/layout/RightRail.tsx)                                                                                                                                                                                                                                                                                 | 세그먼트 제거(전체), 정보만 남긴다, `data-region="info"`(F1·함정 E)                          |
| [`components/layout/AppShell.tsx`](../../src/renderer/src/components/layout/AppShell.tsx)                                                                                                                                                                                                                                                                                   | `REGIONS` 5번째 지역(함정 E), Alt+Shift+P L117-121(F8), 도크 렌더 자리 L162-165              |
| [`components/explorer/PathBar.tsx`](../../src/renderer/src/components/explorer/PathBar.tsx)                                                                                                                                                                                                                                                                                 | details 버튼 L727-737·⋯ 메뉴 L496-504·`toggleInfo` L439-440 → `useLayoutStore`(F8)           |
| [`components/explorer/dnd.ts`](../../src/renderer/src/components/explorer/dnd.ts)                                                                                                                                                                                                                                                                                           | `startDrag` L34-61(F6·함정 C), `useDropTarget` L82-142(F5·F7의 분기점), `fromShelf` 신규     |
| [`components/explorer/Explorer.tsx`](../../src/renderer/src/components/explorer/Explorer.tsx)                                                                                                                                                                                                                                                                               | 기존 드롭 안내 알약 L1035-1058(함정 B, **무변경**)                                           |
| [`lib/sendItems.ts`](../../src/renderer/src/lib/sendItems.ts)                                                                                                                                                                                                                                                                                                               | `dropShelfOnce` L281-302(F7·flyTo 근거), `sendItems` L255-262                                |
| [`components/shelf/Shelf.test.tsx`](../../src/renderer/src/components/shelf/Shelf.test.tsx) · [`layout/RightRail.test.tsx`](../../src/renderer/src/components/layout/RightRail.test.tsx) · [`shelf/InfoPanel.test.tsx`](../../src/renderer/src/components/shelf/InfoPanel.test.tsx) · [`stores/useShelfStore.test.ts`](../../src/renderer/src/stores/useShelfStore.test.ts) | 기존 하네스와 번호 이전 대상(함정 A)                                                         |

---

## 8. 완료 기준

1. `Test-1245`~`Test-1256`가 모두 GREEN (실행 출력으로 확인).
2. **기존 `Test-806`·`807`·`838`·`839`·`874~879`·`881`가 §6 정리대로 갱신된 뒤 GREEN.**
   `Test-786`·`Test-828`·`Test-835`·`Test-877`·`Test-879`·`Test-1166`·`Test-834`·`Test-914`·`Test-915`·
   `Test-1082`·`Test-1084`·`Test-874~876`는 §6의 정리대로 어서션이 갱신된 뒤 GREEN.
3. §6의 번호 정리(회수 2개 · 신규 이식 12개 · 어서션 갱신 다수)를 그대로 수행하고, 회수된 번호
   `Test-808`·`Test-835`가 다른 테스트에 재사용되지 않았는지 확인한다.
4. 새 i18n 키 **3개**가 `en.ts`와 10개 로케일에 있고 `i18n.test.ts`·typecheck가 GREEN.
5. `railTab`·`setRailTab`이 **코드와 테스트**(`git grep railTab -- src script`) 어디에도 남지 않았는지
   확인한다. 타 스펙 문서(`explorer-shelf.md`·`explorer-ux-polish.md`·`shelf-os-drop.md`)의 `railTab`
   서술과 그에 얹힌 케이스 텍스트는 해당 스펙의 역사라 **원문 그대로** 남긴다(§9-6) — 갱신된 기대는
   §6 정리 표에 기록한다.
6. 뮤테이션 검사(`stryker.config.json`의 `mutate` 갱신·`break: 70`)는 **오케스트레이터에 위임**
   (이 포트 작업 범위 밖).
7. `npm run typecheck` · `npm run lint` · `npx prettier --check <변경 파일>` · `npx vitest run` 통과.
8. E2E 실측 (실기기 R3):

   | 항목 | 확인 내용                                                                                           |
   | ---- | --------------------------------------------------------------------------------------------------- |
   | (a)  | 파일을 끌면 하단 담기 띠가 뜨고, 띠에 호버하면 선반 카드가 점등·확장되며 놓으면 담긴다              |
   | (b)  | 선반이 비어 있고 끄는 중이 아니면 화면에 선반 흔적이 없다                                           |
   | (c)  | 담긴 항목을 끌어 탭·사이드바 장소·탐색기 패널에 놓으면 전송이 시작되고 **성공하면 선반에서 빠진다** |
   | (d)  | 전송이 실패하면(막힌 대상) 선반 항목이 남아 있다                                                    |
   | (e)  | 카드의 보내기 버튼·Ctrl+Enter 내려놓기가 기존과 같은 결과를 낸다(접힌 상태에서도 `flyTo`가 동작)    |
   | (f)  | 툴바 details 버튼과 Alt+Shift+P가 오른쪽 정보 패널을 켜고 끈다. 레일에 선반 세그먼트는 없다         |
   | (g)  | 288px을 되찾은 탐색기가 넓어지고, F6 사이클이 선반 카드·담기 띠에 닿는다                            |
   | (h)  | OS에서 파일을 끌면 담기 띠가 뜨고, 띠에 놓으면 선반에 담긴다(shelf-os-drop 회귀 없음)               |

---

## 9. 이식에서 제외 (superseded by upstream …)

원 스펙(v1.3.0 기준)의 내용 중 이 분기의 upstream 변경으로 이미 대체·소멸한 것. 삭제하지 않고
남긴다.

1. **F8의 토글 소스 `showRail`(원안: `settings-content.md` 2번) — superseded by upstream
   `useLayoutStore`.** 이 분기에는 `showRail`이 없다(원안의 형제 스펙 설정 내용 일부가 이미
   `useLayoutStore`으로 대체되어 스펙에서 빠졌다). upstream이 이미 툴바 `PaneToggle`(좌·우)과
   `Ctrl+B`/`Ctrl+Alt+B` 단축키, `SidePane`/`ResizeHandle`로 패널 접힘을 실었다. 따라서 **오른쪽
   패널의 켬/끊음 소스는 `useLayoutStore.right.collapsed` 하나**로 하고, F8이 지목한 두 제어
   (`PathBar` details 버튼 · `Alt+Shift+P`)를 그 소스로 재배선한다. `showRail` 신규 구현·설정 항목
   추가는 하지 않는다. 케이스 **Test-1255**가 이 재배선을 단언한다.
2. **`PathBar` 재작성(upstream) — 도구가 도구 줄 + `⋯` 메뉴로 접혔다.** 원안의 "패널 버튼
   L267·L510-512" 좌표는 없고, 현재 터치 포인트는 도구 줄의 `explorer.details` 버튼
   (L727-737)과 ⋯ 메뉴 항목(L496-504)이다. 둘 다 위 1과 같이 재배선한다(기존 테스트
   Test-828·Test-1165·Test-1166의 구조는 유지, `railTab` 단언만 갱신).
3. **OS 파일 드롭(upstream `shelf-os-drop.md`) — 잇는다, 단 띠는 OS 드래그 중에도 뜬다.**
   원 스펙의 F4는 "앱 안에서 항목을 끄는 동안만"이었지만, 이 분기에는 선반의 OS 드롭 수용
   (Test-874~883)과 문서 가드가 이미 실려 있다. 레일 세그먼트를 없애면 OS 드롭의 대상이
   소멸하므로, **담기 띠는 OS 파일 드래그 중에도 나타난다**(ShelfDock의 문서 레벨
   dragenter/dragleave/drop 추적). 이는 F4의 범위 확장이며 R3 (h)·Test-877·Test-879가 고정한다.
   `shelveOsFiles`·`osDropGuard` 자체는 무변경.
4. **F6 지역 목록(upstream 분할 보기) — 대부분 무변경.** `REGIONS`는 이미 패널별
   (좌/우 콘텐츠) 지역으로 갈라져 있다. 수정하는 것은 5번째 지역(선반 → 도크)뿐이며, 레일이
   순환에서 빠진다(원 스펙과 동일한 결과). `data-region="shelf"`(레일)는 `data-region="info"`로
   바뀐다.
5. **레일 폭·토글(upstream `SidePane`) — 무변경.** 레일의 폭(288px)·접힘·`inert`는 `SidePane`이
   맡는다. `RightRail`은 헤더(세그먼트 바)만 제거하고 본문을 `InfoPanel`로 채운다.
6. **타 스펙 문서의 `railTab` 서술 — 역사로 유지.** `explorer-shelf.md`(스토어 정의)·
   `explorer-ux-polish.md`(Test-1166의 "정보 → `railTab`이 `info`")·`shelf-os-drop.md`(Test-874·875·879
   의 `railTab` 단언)은 원문을 고치지 않는다. 해당 테스트의 단언은 §6 정리 표대로 `dockOpen`·
   `useLayoutStore`으로 갱신되었고, 그 사실이 이 문서에 기록된 것이 곧 정리다.
