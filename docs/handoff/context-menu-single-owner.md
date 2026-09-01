# 핸드오프: 컨텍스트 메뉴는 언제나 하나만

R1에서 인간과 합의한 내용의 고충실도 기록. R2(테스트 코드 작성)·구현의 유일한 입력이다.
이 문서에 없는 케이스는 완료 범위 밖이다. 새 케이스를 추가하거나 기존 케이스를 재해석하지 말 것.

작업 유형(R0): **버그**. 재현하는 RED 회귀 테스트를 먼저 세운 뒤 GREEN으로 만든다.

선행 작업: [`context-menu-viewport-and-dismiss.md`](./context-menu-viewport-and-dismiss.md) (커밋 `8ff1488`).
그 작업의 결정 D1~D9와 함정 1~4는 **그대로 유효하며 깨뜨리면 안 된다.**

---

## 1. 문제 정의

로컬 패널에서 파일을 우클릭해 메뉴를 연 뒤, 원격 패널에서 파일을 우클릭하면
**두 메뉴가 동시에 화면에 남는다.** E2E 실측에서 발견됐다.

### 원인

각 뷰가 자기 `contextPos`를 로컬 state로 들고 있고, 서로의 존재를 모른다.
닫힘은 오직 `document` 리스너를 통해서만 전파되는데, 파일 행·셀에는 `e.stopPropagation()`이 걸려 있다:

```tsx
onContextMenu={(e) => {
  e.stopPropagation()
  handleContextMenu(e, entry)
}}
```

([`LocalFileList.tsx:161-164`](../../src/renderer/src/components/local/LocalFileList.tsx#L161-L164),
[`LocalFileGridView.tsx:284-287`](../../src/renderer/src/components/local/LocalFileGridView.tsx#L284-L287),
[`FileListView.tsx:181-184`](../../src/renderer/src/components/remote/FileListView.tsx#L181-L184),
[`FileGridView.tsx:320-323`](../../src/renderer/src/components/remote/FileGridView.tsx#L320-L323))

React의 `stopPropagation`은 native 이벤트의 `stopPropagation`도 호출하므로, 행 우클릭은
`#root`에서 전파가 끊겨 `document`에 도달하지 않는다. 반대편 메뉴의 닫기 리스너는 그 우클릭을
아예 보지 못한다.

그 `stopPropagation`의 원래 목적은 **컨테이너 핸들러가 `entry=null`로 덮어쓰는 것**을 막는 것이고,
native 전파까지 끊는 것은 부수효과다.

> **빈 공간** 우클릭에는 `stopPropagation`이 없어(`onContextMenu={(e) => handleContextMenu(e, null)}`)
> 반대편 메뉴가 정상적으로 닫힌다. 행·셀 우클릭에서만 나타나는 이유다.

---

## 2. 핵심 결정 (R1에서 인간이 확정)

| #   | 결정                                                                                        | 근거                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | **소유권만 전역화**한다. `contextEntry`·`contextPos`는 지금처럼 각 뷰의 로컬 state로 남긴다 | `contextEntry`의 타입이 패널마다 다르다(`FtpFileEntry` vs `LocalFileEntry`). 스토어에 담으면 유니온 타입과 분기가 생긴다. 소유권은 타입이 없는 순수 식별자라 전역화 비용이 없다 |
| E2  | 뷰마다 **고유 id 상수**. 4개를 한 곳에 모아 export                                          | 리터럴을 각 뷰에 흩으면 오타가 조용한 버그가 된다(AGENTS.md 「하드코딩 금지」)                                                                                                  |
| E3  | `close(id)`는 **현재 소유자일 때만** 해제한다                                               | 뒤늦게 정리되는 뷰가 이미 소유권을 가져간 뷰를 닫아버리는 경쟁 조건을 막는다                                                                                                    |
| E4  | 같은 id가 소유권을 다시 주장하는 것은 **자기 메뉴를 닫지 않는다**                           | 같은 패널에서 연속 우클릭할 때 메뉴는 닫히지 않고 이동해야 한다                                                                                                                 |
| E5  | 스토어는 `stores/`의 기존 Zustand 패턴을 따른다                                             | [`useLocalSelectionStore.ts`](../../src/renderer/src/stores/useLocalSelectionStore.ts)가 레퍼런스                                                                               |
| E6  | 호출부 4개 뷰만 수정. **두 메뉴 컴포넌트는 무변경**                                         | 메뉴는 자기가 어느 패널 소속인지 알 필요가 없다. `position`이 null이 되면 닫히는 기존 계약으로 충분하다                                                                         |

---

## 3. 구현 함정

### 함정 A — 소유권 감시 effect가 자기 자신을 닫는다

각 뷰는 "소유권이 남에게 넘어갔으면 내 메뉴를 닫는다"를 effect로 구현하게 된다.
조건을 잘못 쓰면(`ownerId !== null`처럼) 자기가 방금 주장한 소유권에도 반응해
**우클릭이 통째로 먹통**이 된다. 반드시 `ownerId !== MY_ID` 여야 한다. `Test-227`가 이를 고정한다.

### 함정 B — 선행 작업의 sentinel을 깨뜨리지 말 것

`8ff1488`의 함정 1 해결은 **호출부가 우클릭마다 새 `{x, y}` 객체를 만든다**는 데 의존한다
(그래야 메뉴의 effect가 갈아끼워지며 sentinel이 초기화된다).
소유권 로직을 넣으면서 `position`을 memo화하거나 같은 좌표에서 객체를 재사용하면
그 경로가 깨진다. `setContextPos({ x: e.clientX, y: e.clientY })` 형태를 유지할 것.

### 함정 C — 스토어 테스트는 배선을 검증하지 못한다

스토어 단위 테스트(A절)만으로는 **뷰가 그 스토어를 실제로 쓰는지** 알 수 없다.
배선을 통째로 빼먹어도 A절은 전부 통과한다. B절(Test-225~229)이 4개 뷰 전부에서 그 공백을 메우며,
E2E가 전담하는 것은 **두 패널이 동시에 떠 있는 상태의 상호작용**뿐이다.

---

## 4. 대상 API

```ts
// src/renderer/src/stores/useContextMenuStore.ts

/** 컨텍스트 메뉴를 띄울 수 있는 뷰의 식별자. 리터럴 흩뿌림을 막는다(E2). */
export const CONTEXT_MENU_OWNERS = {
  localList: 'local-list',
  localGrid: 'local-grid',
  remoteList: 'remote-list',
  remoteGrid: 'remote-grid'
} as const

export type ContextMenuOwner = (typeof CONTEXT_MENU_OWNERS)[keyof typeof CONTEXT_MENU_OWNERS]

interface ContextMenuStore {
  /** 지금 메뉴를 띄우고 있는 뷰. 없으면 null. */
  ownerId: ContextMenuOwner | null
  /** 소유권을 가져온다. 이전 소유자는 자기 effect에서 자기 메뉴를 닫는다. */
  open: (id: ContextMenuOwner) => void
  /** 소유자일 때만 해제한다(E3). 아니면 아무 일도 하지 않는다. */
  close: (id: ContextMenuOwner) => void
}
```

각 뷰의 사용 형태:

```tsx
const ownerId = useContextMenuStore((s) => s.ownerId)
const claimMenu = useContextMenuStore((s) => s.open)
const releaseMenu = useContextMenuStore((s) => s.close)

// 우클릭 시: 소유권을 주장하고 기존 로컬 state는 그대로 세팅
claimMenu(MY_ID)
setContextEntry(entry)
setContextPos({ x: e.clientX, y: e.clientY })

// 소유권을 뺏기면 내 메뉴를 닫는다 (함정 A: 반드시 !== MY_ID)
useEffect(() => {
  if (ownerId !== MY_ID) setContextPos(null)
}, [ownerId])

// 메뉴 자신이 닫힐 때
onClose={() => {
  setContextPos(null)
  releaseMenu(MY_ID)
}}
```

---

## 5. 기각한 대안

- **행의 `stopPropagation` 제거** — 근본 원인을 없애지만, 컨테이너 핸들러가 `entry=null`로 덮어쓰는 문제를 다른 방법으로 막아야 하고 기존 선택·마퀴 동작에 회귀 위험이 있다. 무엇보다 닫힘이 계속 이벤트 전파 순서에 의존한다. 기각.
- **`contextEntry`·`contextPos`까지 전부 스토어로** — "하나만"을 상태 구조로 강제하는 가장 강한 형태지만, entry 타입이 갈려 유니온과 분기가 생긴다. E1에서 기각.
- **메뉴 컴포넌트가 직접 서로를 닫기(커스텀 DOM 이벤트)** — 변경은 작지만 이 코드베이스에 없는 새 패턴이고(AGENTS.md 「새 패턴 도입 금지」), Zustand라는 기존 수단이 이미 있다. 기각.
- ~~원격 뷰 테스트 인프라 신설~~ — **정정**: 기각 사유(스토어 목 인프라를 새로 세워야 해 작업량이 크게 는다)가 사실이 아니었다. `FileListView.test.tsx`·`FileGridView.test.tsx`가 macOS 지원 작업(D7)에서 이미 만들어져 있었고, 재사용만으로 파일당 십여 줄이면 됐다(Test-228·229). 처음 판단이 틀렸던 이유: 인접 작업(D7)의 산출물을 확인하지 않고 "원격 뷰에 테스트 파일이 없다"고 가정했다.

---

## 6. 테스트 케이스 리스트 (확정)

`Test-220`부터 신규. 기존 최대 번호는 `Test-219`.
(`Test-117`~`124`는 macOS 지원 작업(`appMenu.test.ts`)이 이미 쓰고 있어 충돌하므로 옮겼다.)
각 테스트에 `covers: Test-N` 주석을 단다. **1:1 매핑. 케이스 추가·병합·재해석 금지.**

### A. 스토어 규칙 (`stores/useContextMenuStore.test.ts`)

| #        | 케이스                                               | 기대                                        |
| -------- | ---------------------------------------------------- | ------------------------------------------- |
| Test-220 | 초기 상태                                            | `ownerId === null`                          |
| Test-221 | `open('local-list')`                                 | `ownerId === 'local-list'`                  |
| Test-222 | `open('local-list')` 뒤 `open('remote-list')`        | `ownerId === 'remote-list'` (하나만 남는다) |
| Test-223 | 소유자가 `close('local-list')`                       | `ownerId === null`                          |
| Test-224 | `'remote-list'`가 소유 중일 때 `close('local-list')` | `ownerId === 'remote-list'` — **유지**      |

Test-224가 E3의 경쟁 조건 방어다. 이게 없으면 "무조건 null로 만드는" 구현이 Test-223을 통과한다.

### B. 뷰 배선 (`LocalFileList.test.tsx`, `LocalFileGridView.test.tsx`, `FileListView.test.tsx`, `FileGridView.test.tsx`)

| #        | 케이스                                                                   |
| -------- | ------------------------------------------------------------------------ |
| Test-225 | 리스트 뷰에서 메뉴를 연 뒤 소유권이 **다른 id로** 넘어가면 메뉴가 닫힌다 |
| Test-226 | 그리드 뷰에서 동일                                                       |
| Test-227 | **같은 뷰에서 연속 우클릭 시 메뉴가 닫히지 않고 유지된다** (함정 A)      |
| Test-228 | 원격 리스트 뷰에서 소유권이 다른 id로 넘어가면 메뉴가 닫힌다             |
| Test-229 | 원격 그리드 뷰에서 동일                                                  |

- Test-225·226·228·229는 스토어의 `open`을 다른 id로 직접 호출해 소유권 이동을 만든다.
  그 직전에 **우클릭이 소유권을 주장했는지도 함께 단언한다.** 이게 없으면 뷰에서
  `claimMenu` 호출을 통째로 지워도 네 테스트가 모두 통과한다 — `ownerId`가 계속 null이라
  뒤이은 소유권 이동이 여전히 "내 id가 아님"을 만들어 메뉴가 닫히기 때문이다.
- Test-227는 리스트 뷰·그리드 뷰 **양쪽**에서 검증한다. 파일 A를 우클릭한 뒤 파일 B를 우클릭하고,
  메뉴가 여전히 열려 있는지 본다([`rendererTestUtils.ts`](../../src/renderer/src/test/rendererTestUtils.ts)의 `queryMenu`).
- 4개 뷰(로컬 리스트·그리드, 원격 리스트·그리드) 전부 배선이 단위 테스트로 검증된다.
  원격 뷰의 render 헬퍼·스토어 목은 `FileListView.test.tsx`·`FileGridView.test.tsx`에
  macOS 지원 작업(D7)이 이미 갖춰 두었다.

### C. E2E (자동화 불가 — §8에서 실측)

각 뷰의 배선은 이제 Test-225~229가 단위로 덮는다. E2E가 전담하는 것은
**두 패널이 동시에 떠 있는 상태의 교차 상호작용**뿐이다(로컬↔원격이 그런 상태가 되는 유일한 경로).

---

## 7. 관련 코드 포인터

| 파일                                                                                                                                                                                                | 역할                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| [`local/LocalFileList.tsx`](../../src/renderer/src/components/local/LocalFileList.tsx)                                                                                                              | L37-38 state, L82-91 `handleContextMenu`, L191-199 메뉴 렌더 |
| [`local/LocalFileGridView.tsx`](../../src/renderer/src/components/local/LocalFileGridView.tsx)                                                                                                      | L55-56, L168-177, L328-336                                   |
| [`remote/FileListView.tsx`](../../src/renderer/src/components/remote/FileListView.tsx)                                                                                                              | L43-44, L86-95, L212-220                                     |
| [`remote/FileGridView.tsx`](../../src/renderer/src/components/remote/FileGridView.tsx)                                                                                                              | L78-79, L182-191, L359-367                                   |
| [`stores/useLocalSelectionStore.ts`](../../src/renderer/src/stores/useLocalSelectionStore.ts)                                                                                                       | Zustand 스토어 작성 패턴(E5)                                 |
| [`local/LocalFileContextMenu.tsx`](../../src/renderer/src/components/local/LocalFileContextMenu.tsx) · [`remote/FileContextMenu.tsx`](../../src/renderer/src/components/remote/FileContextMenu.tsx) | **무변경**(E6). 함정 B의 sentinel이 여기 있다                |

---

## 8. 완료 기준

1. Test-220~229가 모두 GREEN (실행 출력으로 확인).
2. **선행 작업의 Test-96~116이 계속 GREEN.** 특히 Test-114(공허하지만 유지)와 자기충돌 sentinel.
3. 각 테스트에 `covers: Test-N` 주석.
4. 뮤테이션 스코어 임계값 이상. 신규 스토어를 `stryker.config.json`에 통째로 추가하고, 수정한 4개 뷰의 라인 범위를 `git diff --unified=0 -- <file> | grep '^@@'`로 **재확인해 갱신**한다.
5. `npm run typecheck` · `npm run lint` 통과.
6. E2E 실측:

| 항목 | 확인 내용                                                                                 |
| ---- | ----------------------------------------------------------------------------------------- |
| (a)  | 로컬 메뉴를 연 채 **원격 파일**을 우클릭 → 로컬 메뉴가 닫히고 원격 메뉴만 남는다          |
| (b)  | 원격 메뉴를 연 채 **로컬 파일**을 우클릭 → 그 반대                                        |
| (c)  | 같은 패널에서 다른 파일을 연속 우클릭 → 메뉴가 닫히지 않고 이동한다                       |
| (d)  | 리스트 뷰·그리드 뷰를 오가며 (a)~(c)를 반복해도 동일하다                                  |
| (e)  | 선행 작업 회귀 없음: 최하단 우클릭 잘림, Esc·바깥 클릭·blur·스크롤 닫기가 그대로 동작한다 |
