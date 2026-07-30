# 핸드오프: 컨텍스트 메뉴 뷰포트 보정 + 닫기 트리거

R1에서 인간과 합의한 내용의 고충실도 기록. R2(테스트 코드 작성)·구현의 유일한 입력이다.
이 문서에 없는 케이스는 완료 범위 밖이다. 새 케이스를 추가하거나 기존 케이스를 재해석하지 말 것.

작업 유형(R0): **버그 1건 + 그에 딸린 기능 보강**. 잘림은 재현하는 RED 회귀 테스트를 먼저 세운다.

---

## 1. 문제 정의

### 증상 — 화면 하단에서 우클릭하면 메뉴 아래쪽이 잘린다

두 메뉴 컴포넌트가 클릭 좌표를 아무 보정 없이 그대로 쓴다.

[`FileContextMenu.tsx:176`](../../src/renderer/src/components/remote/FileContextMenu.tsx#L176),
[`LocalFileContextMenu.tsx:205`](../../src/renderer/src/components/local/LocalFileContextMenu.tsx#L205):

```tsx
<div
  className="fixed z-50 min-w-[160px] ..."
  style={{ left: position.x, top: position.y }}
>
```

호출부 4개는 모두 `{ x: e.clientX, y: e.clientY }`만 넘긴다 —
[`FileListView.tsx:201`](../../src/renderer/src/components/remote/FileListView.tsx#L201),
[`FileGridView.tsx:347`](../../src/renderer/src/components/remote/FileGridView.tsx#L347),
[`LocalFileList.tsx:179`](../../src/renderer/src/components/local/LocalFileList.tsx#L179),
[`LocalFileGridView.tsx:317`](../../src/renderer/src/components/local/LocalFileGridView.tsx#L317).

### 왜 상수 높이로 못 푸는가

메뉴 높이가 상태에 따라 달라진다. `editing`이면 입력창 한 줄로 줄고, `isMulti`면 Rename이 사라지며,
`canUpload`(로컬) / `hasFiles`(원격) 여부로 Upload·Download 항목이 붙었다 떨어진다.
따라서 렌더 후 실측이 필요하다.

### 곁다리 결함 — 닫기 트리거가 좌클릭 하나뿐

[`FileContextMenu.tsx:44-48`](../../src/renderer/src/components/remote/FileContextMenu.tsx#L44-L48) ·
[`LocalFileContextMenu.tsx:51-55`](../../src/renderer/src/components/local/LocalFileContextMenu.tsx#L51-L55)에
`document` click 리스너가 있어 **바깥 좌클릭 닫기는 이미 동작한다**. 다만 전용 회귀 테스트가 없다.

Escape는 `<input>`의 `onKeyDown`에만 있어 **editing 모드에서만** 듣는다.
메뉴를 연 직후(버튼 목록 상태)에는 Esc가 무반응이다. 바깥 우클릭·창 blur·스크롤도 닫지 않는다.

---

## 2. 핵심 결정 (R1에서 인간이 확정)

| #   | 결정 | 근거 |
| --- | --- | --- |
| D1 | 좌표 보정은 **메뉴 컴포넌트 책임**. 호출부 4개는 무변경 | 메뉴 크기를 아는 건 메뉴 자신뿐. 호출부는 앵커만 안다 |
| D2 | 순수 함수 `clampMenuPosition`을 `src/renderer/src/lib/menuPosition.ts`에 두고 두 메뉴가 공유 | `lib/localPath.ts`·`lib/remoteDrop.ts`가 이미 순수 계산을 `lib/`에 두는 패턴 |
| D3 | 하단 초과 → **위로 뒤집기**(`top = y - height`). 우측 초과 → 좌측으로 대칭 뒤집기 | Windows 탐색기·Finder의 데스크톱 표준. 커서가 메뉴를 가리지 않는다 |
| D4 | 뒤집어도 넘치면 **여백으로 클램프** | 메뉴가 뷰포트보다 큰 경우가 이 규칙으로 자동 흡수되어 상단 정렬이 된다(별도 분기 불필요) |
| D5 | 위치는 **메뉴가 열릴 때 한 번만** 계산. 이후 내용이 바뀌어도 유지 | 입력창은 기존 메뉴보다 작아 잘릴 위험이 없다. Rename을 누를 때 메뉴가 튀는 것을 막는다 |
| D6 | 실측·적용은 `useLayoutEffect` + `ref` | 브라우저 페인트 전 동기 실행이라 보정 전 위치가 한 프레임 보이는 깜빡임이 없다 |
| D7 | 여백은 상수 `MENU_VIEWPORT_MARGIN`으로 named export | AGENTS.md 「하드코딩 금지」 |
| D8 | Escape는 `document` keydown 리스너로 **통합**하고 `<input>`의 개별 Escape 분기는 제거 | 두 경로 최종 동작이 모두 `handleClose()`로 같다. 갈라두면 한쪽만 고쳐지는 버그가 난다. keydown은 버블링되어 입력창에서도 document에 도달한다 |
| D9 | 닫기 트리거 5종: 바깥 좌클릭(기존) / 바깥 우클릭 / Escape / 창 blur / 스크롤 | 인간이 R1에서 명시 요청 |

---

## 3. 구현 함정 (반드시 읽을 것)

### 함정 1 — contextmenu 리스너의 자기충돌

`document`에 `contextmenu` 리스너를 달면 **메뉴를 여는 우클릭 자체를 그 리스너가 잡는다**.

```
항목 우클릭
 → React onContextMenu (root container에 위임)  → setContextPos({x, y})
 → 같은 native 이벤트가 document까지 버블링       → handleClose() → onClose() → setContextPos(null)
 = 메뉴가 아예 열리지 않는다
```

기존 `click` 리스너가 이 문제를 겪지 않은 건 우클릭이 `click` 이벤트를 발생시키지 않기 때문일 뿐이다.
메뉴 루트에 `onContextMenu={e => e.stopPropagation()}`을 다는 것만으로는 **못 막는다** —
이벤트 타겟이 메뉴 바깥(파일 행)이라 애초에 메뉴를 통과하지 않는다.

구현 방식은 자유이나, 위 시나리오에서 메뉴가 열린 채 남아야 한다.

> **정정(R3 리뷰 반영).** 당초 이 문서는 "`Test-114`가 이 회귀를 고정한다"고 적었으나 **사실이 아니다.**
> 아래 함정 4 때문에 `Test-114`는 jsdom에서 **가드를 통째로 지워도 GREEN**이다.
> 이 변경에서 가장 위험한 메커니즘(깨지면 양 패널 컨텍스트 메뉴가 아예 열리지 않는 전면 기능 정지)에
> 자동 검증이 없다는 뜻이므로, 보장은 전적으로 8절 E2E 체크리스트 (a)~(d)에 있다.

### 함정 4 — jsdom은 dispatch 중간 커밋을 재현하지 않는다

함정 1이 실제 브라우저에서 성립하는 이유는 HTML 스펙이 **각 리스너 콜백이 반환될 때마다**
마이크로태스크 체크포인트를 돌리기 때문이다. React 19는 discrete 이벤트의 sync-lane 작업을
마이크로태스크로 스케줄하므로, 그 체크포인트에서 메뉴가 **전파 도중에** 커밋된다.

jsdom은 이벤트 dispatch를 JS로 구현해 한 콜 스택 안에서 동기로 끝낸다. 스택이 비지 않으니
전파 도중 마이크로태스크가 배출되지 않고, RTL v16+는 `fireEvent`를 `act()`로 감싸 업데이트를
act 스코프 종료 시점에 몰아 flush한다. 즉 **jsdom에서는 커밋이 항상 이벤트가 끝난 뒤에 일어난다.**

여기서 나오는 두 가지 결론:

1. `Test-114`는 구조적으로 RED가 될 수 없다. 공허하게 통과한다.
2. **이 영역을 단위 테스트로 더 덮으려 하지 말 것.** 특히 "메뉴가 열린 상태에서 같은 패널
   빈 공간 우클릭 → 이동" 케이스를 jsdom 테스트로 만들면, 올바른 구현이 오히려 RED로 나온다
   (jsdom에서는 effect 교체가 dispatch 중간에 일어나지 않아 sentinel이 갱신되지 않는다).
   이 경로의 검증은 E2E로 라우팅한다.

### 함정 2 — scroll은 버블링하지 않는다

내부 스크롤 컨테이너(`LocalFileList`의 `div.flex-1.overflow-auto` 등)에서 발생한 `scroll`은
document로 버블링되지 않는다. **capture 단계로 등록해야** 잡힌다:

```ts
window.addEventListener('scroll', handler, true)
```

`Test-116`이 메뉴 바깥의 스크롤 컨테이너를 스크롤해 이를 검증한다. capture를 빼면 RED가 된다.

### 함정 3 — 메뉴 내부 클릭 방어

메뉴 내부 클릭이 닫지 않는 것은 메뉴 루트의 `onClick={e => e.stopPropagation()}` 덕이다
(React가 native 이벤트에도 stopPropagation을 전파하므로 document 리스너까지 막힌다).
우클릭에도 같은 방어(`onContextMenu` stopPropagation)가 필요하다 — `Test-113`.

---

## 4. 대상 API

```ts
// src/renderer/src/lib/menuPosition.ts
export const MENU_VIEWPORT_MARGIN = 4

export interface MenuAnchor { x: number; y: number }
export interface MenuSize { width: number; height: number }
export interface ViewportSize { width: number; height: number }
export interface MenuPlacement { left: number; top: number }

export function clampMenuPosition(
  anchor: MenuAnchor,
  size: MenuSize,
  viewport: ViewportSize
): MenuPlacement
```

두 축이 완전히 동일한 규칙을 따른다:

```
start = anchor
if (start + size > viewportExtent - MARGIN)  start = anchor - size   // D3 flip
if (start < MARGIN)                          start = MARGIN          // D4 clamp
```

---

## 5. 기각한 대안

- **호출부 4곳에서 각자 보정** — 호출부는 메뉴 높이를 모른다. 상수를 넘기면 D5의 가변 높이 문제에 그대로 걸린다. 기각(D1).
- **하단 초과 시 화면 안으로 밀기(shift)** — 메뉴가 커서 아래에 걸쳐 항목 일부가 커서에 가린다. 데스크톱 관례와도 어긋난다. 기각(D3).
- **내용이 바뀔 때마다 재측정** — 항상 화면 안이지만 Rename을 누를 때 메뉴가 아래로 튄다. 기각(D5).
- **메뉴 자체를 `max-height` + `overflow-y:auto`로** — 뷰포트보다 큰 극단적 경우만을 위해 CSS와 테스트 복잡도를 늘린다. D4의 클램프로 충분. 기각.
- **두 메뉴 컴포넌트를 하나로 일반화** — 477ddd5가 기각한 사안이고 그 사유(스토어·경로 규칙·전송 방향이 모두 다름)는 유효하다. **좌표 계산이라는 순수 로직만 `lib/`로 공유**한다. 그 사유는 순수 함수엔 하나도 해당하지 않는다.
- **`Test-114`를 원격 뷰에서도 검증** — 원격 뷰(`FileListView`/`FileGridView`)에는 컴포넌트 테스트 파일이 없어 스토어 목 인프라를 새로 세워야 한다. 자기충돌은 두 메뉴가 공유하는 리스너 등록 방식에서 나오므로 로컬 두 뷰에서 잡힌다. 원격 패널은 R3 E2E 실측으로 확인한다.

---

## 6. 테스트 케이스 리스트 (확정)

`Test-96`부터 신규. 기존 최대 번호는 `Test-95`.
각 테스트 코드에 `covers: Test-N` 주석을 단다. **1:1 매핑. 케이스 추가·병합·재해석 금지.**

### A. 순수 함수 `clampMenuPosition` (`menuPosition.test.ts`)

`MENU_VIEWPORT_MARGIN = 4` 기준의 구체 수치. 테스트는 상수를 직접 참조하지 말고
아래 기대값을 그대로 단언한다(상수를 함께 바꾸면 통과해버리는 자기참조를 막는다).

| #        | 케이스                        | 입력 `anchor` / `size` / `viewport`      | 기대 `{left, top}` |
| -------- | ----------------------------- | ---------------------------------------- | ------------------ |
| Test-96  | 완전히 들어가면 앵커 그대로   | (10,10) / (160,200) / (1000,800)         | `{10, 10}`         |
| Test-97  | 하단 초과 → 위로 뒤집기       | (10,700) / (160,200) / (1000,800)        | `{10, 500}`        |
| Test-98  | 우측 초과 → 왼쪽으로 뒤집기   | (900,10) / (160,200) / (1000,800)        | `{740, 10}`        |
| Test-99  | 하단·우측 동시 초과 → 양방향  | (900,700) / (160,200) / (1000,800)       | `{740, 500}`       |
| Test-100 | 뒤집어도 상단 초과 → 클램프   | (150,150) / (160,200) / (1000,300)       | `top === 4`        |
| Test-101 | 뒤집어도 좌측 초과 → 클램프   | (100,10) / (160,200) / (200,800)         | `left === 4`       |
| Test-102 | 메뉴가 뷰포트보다 큼 → 상단   | (10,100) / (160,1000) / (1000,800)       | `top === 4`        |
| Test-103 | 경계: 딱 맞으면 뒤집지 **않음** | (10,596) / (160,200) / (1000,800)      | `top === 596`      |

Test-103이 경계 부등호를 `>=`로 잘못 쓴 구현을 잡는다.

### B. 위치 통합 (`LocalFileContextMenu.test.tsx`, `FileContextMenu.test.tsx`)

`getBoundingClientRect`를 목해 메뉴 크기를 (160, 200)으로,
`window.innerWidth/innerHeight`를 (1000, 800)으로 고정한다.
목 패턴은 [`LocalFileGridView.test.tsx:40-80`](../../src/renderer/src/components/local/LocalFileGridView.test.tsx#L40-L80)를 따른다.

| #        | 케이스                                                             | 검증 대상        |
| -------- | ------------------------------------------------------------------ | ---------------- |
| Test-104 | 로컬 메뉴: `position={{x:10,y:700}}` → `style.top === '500px'`      | 로컬             |
| Test-105 | 원격 메뉴: `position={{x:10,y:700}}` → `style.top === '500px'`      | 원격             |
| Test-106 | 여유 충분: `position={{x:10,y:10}}` → `left/top === '10px'`         | **양 패널**      |
| Test-107 | `{x:10,y:700}`으로 연 뒤 Rename 클릭 → 입력창 전환 후에도 `top === '500px'` | **양 패널** |
| Test-108 | `{x:10,y:700}` → `null` → `{x:10,y:10}` 재오픈 → `top === '10px'`   | **양 패널**      |

Test-107·108은 짝이다. 107만 있으면 위치를 영영 갱신하지 않는 구현이 통과한다.

### C. 닫기 트리거 (`LocalFileContextMenu.test.tsx`, `FileContextMenu.test.tsx`)

메뉴 컨테이너는 `screen.getByRole('button', { name: 'New Folder' }).parentElement`로 잡는다
(Fragment는 DOM 노드가 아니므로 이 버튼의 부모가 곧 메뉴 루트 `div`다).

| #        | 케이스                                              | 기대                   | 성격        |
| -------- | --------------------------------------------------- | ---------------------- | ----------- |
| Test-109 | `document.body` 좌클릭                              | `onClose` 호출         | 회귀 고정   |
| Test-110 | 메뉴 컨테이너 좌클릭                                | `onClose` **미호출**   | 대조군      |
| Test-111 | 버튼 목록 상태에서 `keyDown(document, 'Escape')`     | `onClose` 호출         | 신규        |
| Test-112 | `document.body` 우클릭(`contextMenu`)                | `onClose` 호출         | 신규        |
| Test-113 | 메뉴 컨테이너 우클릭                                | `onClose` **미호출**   | 대조군      |
| Test-115 | `fireEvent.blur(window)`                            | `onClose` 호출         | 신규        |
| Test-116 | 메뉴 **바깥**의 스크롤 컨테이너에서 `scroll` 발생   | `onClose` 호출         | 신규(함정 2) |

Test-109~113·115·116은 **양 패널 모두**에서 검증한다.
Test-110·113이 없으면 "무조건 닫기" 구현이 109·112를 통과한다.

### D. 자기충돌 방어 (`LocalFileList.test.tsx`, `LocalFileGridView.test.tsx`)

| #        | 케이스                                                                    |
| -------- | ------------------------------------------------------------------------- |
| Test-114 | 파일 행/셀을 우클릭해 메뉴를 열면, 새 `contextmenu` 리스너에도 불구하고 메뉴가 **열린 채 유지된다** |

리스트 뷰·그리드 뷰 양쪽에서 검증한다. `fireEvent.contextMenu(행)` 후 `queryMenu()`가 non-null이어야 한다
([`rendererTestUtils.ts`](../../src/renderer/src/test/rendererTestUtils.ts)의 `queryMenu`).

### E. 기존 유지

| #       | 케이스                                          | 의미                              |
| ------- | ----------------------------------------------- | --------------------------------- |
| Test-94 | 입력창 상태에서 Escape는 IPC 없이 닫는다        | D8 통합 리팩터링의 회귀 안전망    |

---

## 7. 관련 코드 포인터

| 파일 | 역할 |
| --- | --- |
| [`remote/FileContextMenu.tsx`](../../src/renderer/src/components/remote/FileContextMenu.tsx) | 원격 메뉴. L44-48 닫기 리스너, L176 위치, L190-193 입력창 Escape |
| [`local/LocalFileContextMenu.tsx`](../../src/renderer/src/components/local/LocalFileContextMenu.tsx) | 로컬 메뉴. L51-55 닫기 리스너, L205 위치, L219-222 입력창 Escape |
| [`remote/FileListView.tsx`](../../src/renderer/src/components/remote/FileListView.tsx) · [`remote/FileGridView.tsx`](../../src/renderer/src/components/remote/FileGridView.tsx) | 원격 호출부. **무변경** |
| [`local/LocalFileList.tsx`](../../src/renderer/src/components/local/LocalFileList.tsx) · [`local/LocalFileGridView.tsx`](../../src/renderer/src/components/local/LocalFileGridView.tsx) | 로컬 호출부. **무변경**. L69-77의 `handleContextMenu`가 앵커를 만든다 |
| [`lib/localPath.ts`](../../src/renderer/src/lib/localPath.ts) | 순수 함수를 `lib/`에 두는 기존 패턴 (D2가 따를 대상) |
| [`test/rendererTestUtils.ts`](../../src/renderer/src/test/rendererTestUtils.ts) | `queryMenu`, `makeApiMock`, `invokeCalls` |
| [`local/LocalFileGridView.test.tsx`](../../src/renderer/src/components/local/LocalFileGridView.test.tsx) | `getBoundingClientRect`·`clientHeight` 목 패턴 (B절이 따를 대상) |

---

## 8. 완료 기준

1. Test-96~116 + Test-94가 모두 GREEN (실행 출력으로 확인).
2. 각 테스트에 `covers: Test-N` 주석.
3. 뮤테이션 스코어 임계값 이상.
4. `npm run typecheck` · `npm run lint` 통과.
5. R3 E2E 실측. 아래 항목은 **jsdom에서 검증 불가능**하므로(함정 4) 실제 앱 실행이 유일한 보장이다.

| 항목 | 확인 내용 | 근거 |
| --- | --- | --- |
| 잘림 | 원격·로컬 양쪽에서 화면 **최하단** 우클릭 시 메뉴 전체가 보인다. 우측 끝도 동일 | 본 버그의 원 증상 |
| (a) | 4개 뷰(로컬/원격 × 리스트/그리드)에서 파일 행·셀 우클릭 → 메뉴가 열리고 **즉시 사라지지 않는다** | 함정 1. Test-114가 공허하므로 여기서만 잡힌다 |
| (b) | 패널 **빈 공간** 우클릭 → 메뉴가 열린다 | 함정 1. 빈 공간 핸들러에는 `stopPropagation`이 없어 (a)와 경로가 다르다 |
| (c) | 메뉴가 열린 상태에서 **같은 패널 빈 공간** 우클릭 → 닫히지 않고 **새 위치로 이동**한다 | sentinel의 effect 교체 경로. 여기서 닫히면 함정 1 해결이 불완전한 것 |
| (d) | 메뉴가 열린 상태에서 **패널 밖**(툴바 등) 우클릭 → 닫힌다 | Test-112의 실제 대응물 |
| (e) | 메뉴 열기 → Rename 클릭 → 입력창이 뜬 채 **유지된다**(즉시 닫히지 않음) | `autoFocus`의 scroll-into-view가 capture scroll 리스너를 깨울 수 있다. 닫히면 `ref.focus({ preventScroll: true })`로 교체 |
| (f) | Esc / 바깥 클릭 / 창 포커스 이탈 / 목록 스크롤 각각으로 닫힌다 | D9 5종 트리거의 실환경 확인 |
