# 핸드오프: 원격 썸네일 — 뷰포트 기준 요청 교체와 우선순위

진단은 썸네일 담당 에이전트가 코드와 재현 테스트로 했고, §2의 결정은 R1에서 오케스트레이터가 확정했다
(D9는 초안에서 변경, D12·D13은 추가, D14는 구현 중 발견해 추가). 이 문서가 테스트·구현의 유일한 입력이다.
이 문서에 없는 케이스는 완료 범위 밖이다. 케이스를 추가·병합·재해석하지 말 것.

작업 유형(R0): **버그 1건 + 같은 큐의 곁다리 결함 2건(D12·D13)**. 재현하는 RED 테스트(Test-262, Test-274)를 먼저 세운다.

§1의 줄 번호는 변경 전 커밋 `b233f56` 기준이다.

---

## 1. 문제 정의

### 증상

사용자 보고(원문): "썸네일 다운 받을 때 처음 상위 목록의 썸네일을 받는 와중에 사용자가 목록을 맨 밑으로
내리는 등 급격한 목록 뷰 변화가 있는 경우 기존 순차적 다운을 끊고 새로 변경된 뷰에 대해서 적절히 마진을
두어 새롭게 썸네일 출력을 위한 다운 작업을 하도록 하자. 지금은 스크롤을 내리면 영원히 썸네일이 출력이
안된다(0~50 썸네일 다운이 예약되어서 500~600 썸네일은 영원히 안 보여지는 것 같은 느낌을 사용자에게 준다.)"

### 근본 원인 1 — main 큐가 사실상 FIFO이고, 대기 항목을 빼는 길이 디렉터리 이동뿐이다

- 렌더러의 모든 이미지 요청이 같은 우선순위를 보낸다:
  [`ThumbnailImage.tsx:33`](../../src/renderer/src/components/thumbnail/ThumbnailImage.tsx) `priority: 0`.
- [`ThumbnailQueue.ts:86-87`](../../src/main/thumbnail/ThumbnailQueue.ts)은 뒤에 붙이고 안정 정렬한다.
  우선순위가 모두 같으니 도착 순서 그대로다.
- 이미 대기 중인 키를 다시 요청하면 `ThumbnailQueue.ts:65-66`이 그냥 반환한다. 다시 보인 항목을 앞으로 당길 방법이 없다.
- 대기 항목을 지우는 것은 `cancelAll`(`ThumbnailQueue.ts:92-102`)뿐이고, 호출부는 디렉터리 이동 때의
  [`RemoteExplorer.tsx:42-48`](../../src/renderer/src/components/remote/RemoteExplorer.tsx) 하나다.
- 재정렬용 `updatePriorities`(`ThumbnailQueue.ts:104-110`)는 IPC도 호출부도 없다.
  `thumbnail:requestBatch`([`thumbnailHandlers.ts:46-56`](../../src/main/ipc/thumbnailHandlers.ts))는
  등록·허용 목록·타입에 모두 있으나 렌더러 호출부가 없다.

### 근본 원인 2 — 셀이 한 번 보이면 요청하고, 화면을 떠나도 요청을 거두지 않는다

- `ThumbnailImage.tsx:37-53`: 셀마다 `IntersectionObserver`(threshold 0.1)를 달아 처음 보이는 순간 한 번 요청한다.
- 셀이 가상 스크롤 밖으로 나가 언마운트되면 cleanup(`:52`)은 observer만 끊는다. main 큐의 요청은 그대로 남는다.
- 그리드는 `@tanstack/react-virtual`([`FileGridView.tsx:112-117`](../../src/renderer/src/components/remote/FileGridView.tsx), overscan 2행)이고
  셀은 보이는 범위를 모른다. 휠·트랙패드로 내리면 지나가는 행마다 마운트되어 몇 프레임씩 보이므로,
  0번에서 500번까지 내리는 동안 지나간 거의 모든 이미지가 목적지보다 **먼저** 큐에 들어간다.
  스크롤바를 끌어 점프해도 처음 화면의 요청(0~50)이 먼저 처리된다.

### 근본 원인 3 — 마진이 없다

threshold 0.1이라 실제로 화면에 걸친 셀만 요청한다. overscan 행은 마운트되지만 요청하지 않는다.
조금만 스크롤해도 매번 빈 칸부터 보인다.

### 재현 (진단 중 임시 테스트, 삭제함)

가짜 FTP 클라이언트로 `ThumbnailQueue`에 지나간 항목 0~499를 `priority: 0`으로 넣고 이어서 목적지 500~529를 넣었다.
동시 3개 슬롯을 하나씩 비우면 **목적지의 첫 다운로드가 시작되기 전에 498건이 끝난다.**
목적지는 "영원히"가 아니라 지나간 항목 전부의 다운로드 시간 뒤에 나온다. WAN에서 수 MB 사진 500장이면 수십 분이다.

### 곁다리 결함 (D12·D13)

- **보조 연결 누수.** 연결 중(`createSecondaryClient` 대기)에 `cancelAll`이 오면, 연결이 끝난 클라이언트가 비워진 풀에
  들어가고(`ThumbnailQueue.ts:124-126`) `processNext`는 `aborted`를 보고 그냥 반환한다(`:175-176`). 아무도 닫지 않는다.
  MCP 미리보기([`mcp/thumbnailPreviews.ts`](../../src/main/mcp/thumbnailPreviews.ts))는 호출마다 `finally`에서 `cancelAll`을 부르므로 실제로 걸린다.
- **취소한 다운로드가 에러를 보고한다.** `aborted`는 큐 전역 플래그인데 다음 항목이 시작하며 `false`로 되돌린다(`:156`).
  디렉터리 이동 직후 새 폴더 요청이 먼저 시작되면, 닫힌 연결 때문에 실패한 이전 폴더 다운로드가 `thumbnail:error`를 보낸다.

---

## 2. 핵심 결정 (R1 확정)

| #   | 결정                                                                                                                                                                                                                                                                                                | 근거                                                                                                                                                                                                                                                               |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | 원격 이미지 썸네일의 **요청 주체를 셀에서 그리드로 옮긴다.** `FileGridView`가 가상 스크롤러의 보이는 행 범위(`virtualizer.range`)가 바뀔 때마다 `thumbnail:requestBatch`를 1건 보낸다. `ThumbnailImage`는 표시와 ↻ 클릭 재시도(`thumbnail:request`, priority 0)만 한다(`IntersectionObserver` 제거) | 무엇이 보이는지는 가상 스크롤러만 안다. 셀 단위 요청으로는 순서와 취소를 한 번에 정할 수 없다                                                                                                                                                                      |
| D2  | 배치 범위 = **보이는 행 ± 마진 행** 안의 이미지 항목. `priority` = 보이는 범위로부터의 **행 거리**(보이는 행 0, 바로 위·아래 행 1, …). 같은 거리면 위 행 먼저, 행 안에서는 왼쪽부터                                                                                                                 | 사용자 요청 "새 뷰에 마진을 두어". 보이는 것 먼저, 그다음 가까운 순                                                                                                                                                                                                |
| D3  | 마진 = **보이는 행 수**(위·아래로 한 화면씩)                                                                                                                                                                                                                                                        | 줌·창 크기에 따라 자동으로 비례한다. 보이는 행이 먼저 처리되므로 마진은 보이는 썸네일을 늦추지 않고 대역폭만 쓴다. 대가: 원본을 통째로 받는 구조라 축소한 갤러리 + 큰 창에서는 한 화면이 100장을 넘을 수 있다                                                      |
| D4  | 배치는 **교체**다. main은 (1) 직전 배치로 들어와 아직 시작하지 않은 항목 중 이번 배치에 없는 것을 큐에서 버리고, (2) 남은 항목은 이번 priority로 재정렬하고(`updatePriorities` 재사용), (3) 새 항목을 priority 오름차순으로 `request()`한다. 입력 순서는 믿지 않는다                                | "기존 순차적 다운을 끊고". `request()`는 빈 슬롯이 있으면 즉시 시작하므로 정렬 없이 넣으면 앞에 온 항목이 슬롯을 먼저 잡는다                                                                                                                                       |
| D5  | "급격한 변화" 임계값을 두지 않는다. 보이는 행 범위가 바뀔 때마다 교체한다. 스크롤 중 디바운스도 하지 않는다                                                                                                                                                                                         | 느린 연속 스크롤에서도 대기열이 쌓이지 않는다. 매직 넘버가 없다. 디바운스하면 천천히 스크롤하는 동안 아무것도 안 뜬다                                                                                                                                              |
| D6  | 진행 중 다운로드(최대 `MAX_CONCURRENT` = 3건)는 **끊지 않는다.** 끝까지 받아 캐시에 넣고 `thumbnail:ready`를 보낸다. 버리는 것은 아직 시작하지 않은 대기 항목뿐이다                                                                                                                                 | 대가: 점프 뒤 첫 썸네일이 슬롯당 최대 다운로드 1건(타임아웃 30초)만큼 늦을 수 있다. 끊는 안은 §5에서 기각                                                                                                                                                          |
| D7  | 채널은 기존 `thumbnail:requestBatch`를 재사용하고 의미를 "뷰포트 배치 교체"로 정한다. 새 채널을 만들지 않는다. 핸들러에 이 의미를 주석으로 남긴다                                                                                                                                                   | main 핸들러·preload 허용 목록·`index.d.ts` 3곳에 이미 있고 렌더러 호출부가 0이라 기존 동작을 깨지 않는다. MCP 미리보기는 IPC를 쓰지 않는다                                                                                                                         |
| D8  | 단건 `thumbnail:request`로 들어온 대기 항목(갤러리 폴더 미리보기의 내부 이미지 priority 1, ↻ 재시도)은 **배치가 버리지 않는다.** 단, 이후 배치에 포함된 키는 그때부터 배치 소유로 취급한다                                                                                                          | 폴더 미리보기 이미지 키는 비동기 LIST 결과라 그리드가 모른다. 버리면 `RemoteFolderPreviewImage`의 `requestedRef` 때문에 다시 요청되지 않아 리마운트 전까지 폴더 아이콘으로 남는다                                                                                  |
| D9  | 렌더러는 `useThumbnailStore`에 썸네일 또는 에러가 있는 항목을 배치에서 뺀다. 에러 항목은 **창(보이는 행 ± 마진) 안에 있는 동안** 재요청하지 않고, **창을 벗어나면 에러를 지운다.** 그래서 다시 창에 들어오면 재요청된다. ↻ 클릭은 즉시 재시도한다                                                   | 썸네일이 있는 항목을 넣으면 main이 디스크 캐시 적중으로 dataURL(항목당 수십 KB)을 범위가 바뀔 때마다 다시 보낸다. 에러 항목을 창 안에서 넣으면 깨진 파일을 스크롤 한 행마다 다시 받는다. 창을 벗어날 때 지우는 것은 지금의 "리마운트 시 자동 재시도"와 같은 효과다 |
| D10 | 범위는 원격 그리드·갤러리의 이미지 썸네일이다. `ThumbnailImage`를 그리는 곳은 `FileGridView` 하나뿐이다(원격 리스트 뷰는 썸네일이 없고 `ImagePreviewModal`은 스토어만 읽는다). 로컬 패널과 원격 폴더 미리보기 큐는 후속 과제다(§6)                                                                  | 보고된 증상은 원격 다운로드다. 두 후속 과제는 같은 교체 패턴을 작게 적용할 수 없다(§6)                                                                                                                                                                             |
| D11 | 배치는 비어 있어도 보낸다                                                                                                                                                                                                                                                                           | 이미지가 없는 구간(폴더·문서 영역)으로 스크롤했을 때 직전 창의 대기 항목을 버리는 신호가 빈 배치다                                                                                                                                                                 |
| D12 | `cancelAll` 뒤에 연결이 끝난 보조 클라이언트는 **즉시 닫고** 풀에서 뺀다                                                                                                                                                                                                                            | 누수 수정. MCP 미리보기는 호출마다 `cancelAll`을 부른다                                                                                                                                                                                                            |
| D13 | 전역 `aborted` 플래그를 **세대 번호**로 바꾼다. `cancelAll`이 세대를 올리고, 작업은 시작할 때 읽은 세대와 다르면 취소된 것으로 보고 결과·에러를 보내지 않는다                                                                                                                                       | 다음 항목이 플래그를 되돌리는 문제를 구조적으로 없앤다. 변경이 큐 안에 갇혀 작다                                                                                                                                                                                   |
| D14 | (구현 중 발견) `RemoteExplorer`의 디렉터리 변경 effect(`thumbnail:cancelAll` 등)를 `useLayoutEffect`로 바꾼다                                                                                                                                                                                       | React는 자식 passive effect를 부모보다 먼저 돌린다. 경로가 바뀐 커밋에서 그리드가 이미 범위를 알면 새 폴더 배치가 먼저 나가고 부모의 `cancelAll`이 그것을 지운다. layout effect는 같은 커밋의 모든 passive effect보다 먼저 돈다. jsdom에서 재현했다(Test-278)      |

---

## 3. 대상 API

```ts
// src/renderer/src/lib/thumbnailViewport.ts (신규, 순수 함수)
export interface ThumbnailTarget {
  entry: FtpFileEntry
  priority: number
}

/**
 * 그리드의 보이는 행 범위 ± marginRows 행 안에 있는 이미지 항목을 받을 순서대로 돌려준다.
 * priority는 보이는 범위로부터의 행 거리(보이는 행 0). 같은 거리면 위 행 먼저, 행 안은 왼쪽부터.
 * 'parent'와 이미지가 아닌 항목은 건너뛰고, 행 범위는 [0, 마지막 행]으로 자른다.
 */
export function viewportThumbnailTargets(
  items: ReadonlyArray<FtpFileEntry | 'parent'>,
  columnCount: number,
  visibleRows: { startIndex: number; endIndex: number },
  marginRows: number
): ThumbnailTarget[]
```

```ts
// src/main/thumbnail/ThumbnailQueue.ts (메서드 추가. request·cancelAll·updatePriorities 시그니처 무변경)
/** D4 교체 규칙. 반환값은 입력 순서대로의 cacheKey. */
requestBatch(requests: ThumbnailRequest[]): string[]
```

- `thumbnail:requestBatch` 핸들러는 `requests.map(queue.request)` 대신 `queue.requestBatch(requests)`를 부른다(D7 주석).
- "직전 배치의 키"는 큐가 키 집합 하나로 기억한다. 진행 중 항목은 큐에 없으므로 D6이 자동으로 성립한다.
- `FileGridView`: `virtualizer.getVirtualItems()` 호출을 JSX 밖으로 올리고 그 뒤에 `virtualizer.range`를 읽는다.
  범위·열 수·목록·경로가 바뀔 때 effect에서 `viewportThumbnailTargets` → 스토어 필터·에러 정리(D9) →
  `{ remotePath, fileName, fileSize, modifiedAt, priority }` 배열로 `thumbnail:requestBatch`를 보낸다.
  마진 행 수는 `range.endIndex - range.startIndex + 1`. `range`가 `null`이면 보내지 않는다.

---

## 4. 구현 함정

1. **`virtualizer.range`는 lazy다.** `calculateRange()`가 돌아야 갱신되고, 그것은 `getVirtualItems()` 안에서 돈다.
   JSX 안에서 `getVirtualItems()`를 부르면 그 전에 읽은 `range`는 한 박자 늦은 값이다.
   스크롤 중 리렌더는 virtual-core가 보이는 범위나 `isScrolling`이 바뀔 때만 일으키므로, 범위가 같으면 배치도 나가지 않는다.
2. **main은 배치 순서를 믿지 않는다(D4).** `request()`는 빈 슬롯이 있으면 동기적으로 다운로드를 시작한다.
   정렬 전에 넣으면 앞쪽(위 마진 행) 항목이 슬롯 3개를 잡는다. Test-264가 고정한다.
3. **스토어 필터(D9)를 빼면 낭비가 크다.** 썸네일이 렌더러에 이미 있는 항목도 main 디스크 캐시에 있으므로
   `request()`가 동기로 `thumbnail:ready`를 다시 보낸다. 범위가 한 행 바뀔 때마다 화면 전체의 dataURL이 다시 온다.
4. **jsdom에는 `IntersectionObserver`가 없다.** 변경 전에는 이미지 셀을 그리면 `ReferenceError`가 났다(그래서 기존 그리드 테스트는 `.txt`만 썼다).
   그리드 테스트는 IO를 **스텁하지 않는다.** 스텁하면 셀이 몰래 자기 요청을 계속하는 잔재를 가린다.
5. **jsdom에서 가상 스크롤은 결정적으로 움직인다.** `stubGridLayout()`(1200×800) + 그리드 모드면 열 5개, 행 높이 204px
   (`150 + GALLERY_CELL_PADDING 40 + GRID_GAP 14`), 맨 위에서 보이는 행 0~3이다. 스크롤 컨테이너(`container.firstElementChild`)에
   `scrollTop`을 대입하고 `scroll` 이벤트를 `act` 안에서 디스패치하면 그 위치의 행이 렌더된다.
6. **MCP 미리보기는 호출마다 자기 `ThumbnailQueue`를 만들고 `request()`·`cancelAll()`만 쓴다**
   ([`mcp/thumbnailPreviews.ts`](../../src/main/mcp/thumbnailPreviews.ts)). 두 메서드의 의미를 바꾸지 않는다.
   [`mcp/mcpTools.test.ts`](../../src/main/mcp/mcpTools.test.ts)가 그대로 GREEN이어야 한다.
7. **부모·자식 effect 순서(D14).** 같은 커밋에서 자식 `FileGridView`의 passive effect(배치)가 부모 `RemoteExplorer`의
   passive effect(`cancelAll`)보다 먼저 돈다. 실제 앱의 `navigateTo`는 `loading`을 거쳐 그리드를 다시 마운트하므로
   첫 렌더에 `range`가 `null`이라 우연히 안전하지만, 그 우연에 기대지 않는다.

---

## 5. 기각한 대안

- **진행 중 다운로드도 창 밖이면 끊기** — 끊으려면 그 보조 FTP 연결을 닫아야 하고 다음 항목은 재접속·재로그인(+TLS)부터 한다.
  빠른 스크롤 중에는 배치마다 진행 중 3건을 끊어 재접속이 폭주하고 서버 접속 수 제한·차단에 걸릴 수 있다.
  메인 클라이언트 폴백 경로(`secondaryFailed`)는 사용자의 탐색과 같은 연결이라 끊을 수 없다. 항목별 abort도 필요하다.
  얻는 것은 점프 뒤 첫 썸네일까지 평균 다운로드 반 건 정도다. 기각(D6).
- **셀 언마운트 시 취소(`thumbnail:cancel` 새 채널) + 기존 IO 유지** — 버리는 경계가 overscan 2행에 묶이고 마진 선행 다운로드가 없다.
  한 커밋 안의 요청 순서가 DOM 순서라 위쪽 overscan 행이 보이는 행보다 먼저 슬롯을 잡는다. 새 채널 3곳 + preload 테스트가 필요하다. 기각.
- **셀마다 거리 priority를 props로 받아 바뀔 때마다 재요청** — 한 행 스크롤마다 마운트된 셀 수만큼 취소·요청 IPC 쌍이 나가고,
  배치가 아니라서 D4의 "정렬 후 시작"을 할 수 없다. 기각.
- **큐를 LIFO로(최신 요청 먼저)** — 지나간 항목이 여전히 언젠가 전부 다운로드된다(대역폭 낭비). 한 커밋 안의 순서가 거꾸로라 아래 마진부터 받는다. 기각.
- **"급격한 변화"일 때만 취소(행 N개 이상 점프)** — 매직 넘버. 느린 연속 스크롤에서는 여전히 쌓인다. 기각(D5).
- **스크롤이 멈출 때만 배치 전송(`isScrolling` 디바운스)** — 지나간 항목이 슬롯을 잡는 일은 없어지지만, 천천히 훑는 동안 아무것도 뜨지 않는다. 기각(D5).
- **범위가 바뀔 때마다 `thumbnail:cancelAll` 후 재요청** — `cancelAll`은 보조 연결 풀을 전부 닫는다. 재접속 폭주에 폴더 미리보기 요청까지 버린다. 기각.
- **IO의 `rootMargin`으로 마진** — 암시적 root(뷰포트)에서는 내부 스크롤 컨테이너에 마진이 적용되지 않아 root를 셀마다 넘겨야 하고, 순서 문제는 그대로다. 기각.
- **에러 항목을 배치에서 영구히 제외(초안 D9)** — 지금의 리마운트 자동 재시도가 사라진다. 일시적 타임아웃도 클릭해야 복구된다. 기각.
- **배치 전송을 마이크로태스크로 미뤄 `cancelAll` 뒤로 보내기(D14 대안)** — React가 passive effect를 한 번에 동기로 돈다는 내부 동작에 기댄다. layout effect 순서는 React가 보장하는 규칙이다. 기각.

---

## 6. 후속 과제 (이번 범위 밖, D10)

- **로컬 패널.** [`galleryHandlers.ts`](../../src/main/ipc/galleryHandlers.ts)의 `localThumbnail:request`는 큐 없이 IPC마다 즉시 `sharp`를 돌린다.
  [`LocalThumbnailImage.tsx`](../../src/renderer/src/components/thumbnail/LocalThumbnailImage.tsx)도 같은 일회성 IO 요청이라 지나간 셀이 모두 처리된다.
  로컬 디코드는 건당 수십 ms라 증상이 훨씬 약하다. 고치려면 main에 새 큐(동시성·교체)가 필요하다.
- **원격 갤러리 폴더 미리보기.** [`RemoteGalleryPreviewQueue.ts`](../../src/main/ftp/RemoteGalleryPreviewQueue.ts)(FIFO, 동시 2)와
  [`RemoteFolderThumbnail.tsx`](../../src/renderer/src/components/thumbnail/RemoteFolderThumbnail.tsx)도 같은 구조다.
  같은 교체 패턴이 작게 맞지 않는다: 요청마다 promise를 돌려주는 API라 버린 항목을 reject해야 하고, 렌더러는 그 결과를
  `useGalleryStore`의 error로 남겨 `previewState`가 생기면 다시 요청하지 않으므로, 창 밖 정리(D9와 같은 것)와 그리드 쪽 배치 계산까지
  필요하다. 폴더는 목록 맨 앞에 정렬되므로 보고된 이미지 증상과는 무관하다.

---

## 7. 테스트 케이스 리스트

`Test-262`부터 신규, 이 스펙의 범위는 `Test-262`~`Test-289`(290~299는 다른 작업이 예약). 기존 최대 번호는 `Test-261`(MCP 스펙).
각 테스트 코드에 `covers: Test-N` 주석을 단다. **1:1 매핑. 케이스 추가·병합·재해석 금지.**

### A. 큐 (`src/main/thumbnail/ThumbnailQueue.test.ts`, 신규, node 환경)

`FtpConnectionManager`·`ThumbnailGenerator`·`CacheManager`는 최소 가짜로 둔다. 가짜 보조 클라이언트의 `downloadTo`는
시작한 경로를 기록하고 테스트가 하나씩 끝낼 때까지 대기하며, `close`는 진행 중 다운로드를 에러로 끝낸다.
`createSecondaryClient`·`close` 호출 수를 센다.

| #        | 케이스                                                                                                                                                                                                    |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Test-262 | **재현(RED).** 배치 A(항목 0~49, priority 0)로 슬롯 3개가 찬 뒤 배치 B(항목 500~529)가 온다. 이후 시작되는 다운로드는 B의 항목뿐이고 순서대로이며, A의 미시작 항목(3~49)은 끝까지 한 건도 시작되지 않는다 |
| Test-263 | 진행 중인 A의 3건은 B가 와도 끊기지 않는다(D6). 세 건 모두 완료되어 `onReady`가 불리고, 보조 연결은 닫히지 않고 B 항목에 재사용된다(`createSecondaryClient` 3회, `close` 0회)                             |
| Test-264 | 한 배치 안에서는 priority 오름차순으로 시작한다. priority를 섞어 보내도(예: 2, 1, 0, 0, 1) priority 0 항목이 먼저다. 같은 priority는 입력 순서다                                                          |
| Test-265 | A에서 대기 중이던 항목이 B에도 있으면 B의 priority로 다시 정렬된다. A에서 priority 3이던 항목이 B에서 0이면, B에서 priority 1로 새로 들어온 항목보다 먼저 시작한다. A에만 있던 대기 항목은 버려진다       |
| Test-266 | 단건 `request()`로 들어온 대기 항목은 그것을 포함하지 않는 배치가 와도 큐에 남아 결국 다운로드된다(D8)                                                                                                    |
| Test-267 | B에서 버려진 항목이 배치 C에 다시 들어오면 다시 큐에 들어가 다운로드된다(스크롤 복귀)                                                                                                                     |
| Test-268 | 빈 배치는 직전 배치의 미시작 항목을 모두 버린다(D11)                                                                                                                                                      |
| Test-269 | `cancelAll`이 연결 중에 오면, 뒤늦게 연결된 보조 클라이언트는 다운로드 없이 즉시 닫힌다(D12). 다음 요청은 그 연결을 재사용하지 않고 새로 연다                                                             |
| Test-270 | 진행 중 다운로드를 `cancelAll`로 끊은 직후 새 요청이 시작돼도, 끊긴 다운로드는 `onError`를 부르지 않는다(D13). 대조군: 취소되지 않은 다운로드의 실패는 `onError`로 보고된다                               |

### B. 창 계산 (`src/renderer/src/lib/thumbnailViewport.test.ts`, 신규, node 환경)

예시 입력: `items[0] = 'parent'`, 1~29는 파일. 7은 디렉터리, 13은 이미지가 아닌 파일, 나머지는 이미지. `columnCount = 3`.

| #        | 케이스                                                                                                                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Test-271 | 범위. 보이는 행 3~4, 마진 2 → 행 1~6(인덱스 3~20)의 이미지만 나온다. 7·13은 없다. 보이는 행 0, 마진 2 → 행 0~2만 나오고 `'parent'`는 없다(음수 행 없음). 보이는 행 9(마지막), 마진 2 → 행 7~9만 나온다 |
| Test-272 | 순서·priority. 보이는 행 3~4, 마진 2 → `[9,10,11,12,14]`가 priority 0, 이어서 `[6,8]`(행 2)·`[15,16,17]`(행 5)가 priority 1, `[3,4,5]`(행 1)·`[18,19,20]`(행 6)이 priority 2, 정확히 이 순서다         |

### C. 그리드 배선 (`src/renderer/src/components/remote/FileGridView.test.tsx`, jsdom)

이미지 600장(`currentPath = '/'`), `stubGridLayout()`. 함정 4·5 참고.

| #        | 케이스                                                                                                                                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Test-273 | 첫 렌더에서 `thumbnail:requestBatch`가 나간다. 0~39번이 순서대로 들어 있고, 보이는 행(0~3)의 20개가 priority 0, 마진 행 4~7이 priority 1~4다. 셀 단위 `thumbnail:request`는 0건이다                                 |
| Test-274 | **재현(RED).** 스크롤 컨테이너를 맨 아래로 옮기고 `scroll`을 디스패치하면 새 `thumbnail:requestBatch`가 나간다. 그 배치의 priority 0 항목은 새로 보이는 580~599번이고, 배치 어디에도 상단 항목(인덱스 < 500)이 없다 |
| Test-275 | `useThumbnailStore`에 썸네일이 있는 항목과 에러가 있는 항목은 배치에서 빠진다(D9)                                                                                                                                   |
| Test-276 | 에러가 있는 항목은 창 안에 있는 동안 에러가 유지되고 배치에서 빠진다. 맨 아래로 스크롤해 창을 벗어나면 에러가 지워지고, 맨 위로 돌아오면 그 항목이 priority 0으로 다시 배치에 들어간다(D9)                          |
| Test-277 | 에러가 있는 셀(↻)을 클릭하면 그 항목의 `thumbnail:request`가 priority 0으로 1건 나가고 에러가 지워진다(재시도 경로 회귀 고정)                                                                                       |
| Test-278 | **재현(RED, D14).** `RemoteExplorer` 안의 그리드에서 로딩 표시 없이 경로가 바뀌면, 마지막 `thumbnail:cancelAll` **뒤에** 새 폴더 항목을 담은 `thumbnail:requestBatch`가 나간다                                      |

---

## 8. 관련 코드 포인터

| 파일                                                                                                                        | 역할                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| [`main/thumbnail/ThumbnailQueue.ts`](../../src/main/thumbnail/ThumbnailQueue.ts)                                            | `request`·`requestBatch`(D4)·`cancelAll`(세대 증가, D13)·`updatePriorities`(D4가 재사용)·`processNext`(세대 확인, 늦은 연결 닫기 D12) |
| [`main/ipc/thumbnailHandlers.ts`](../../src/main/ipc/thumbnailHandlers.ts)                                                  | `thumbnail:requestBatch` → `queue.requestBatch`, 교체 의미 주석(D7)                                                                   |
| [`renderer/.../lib/thumbnailViewport.ts`](../../src/renderer/src/lib/thumbnailViewport.ts)                                  | 창 계산 순수 함수(D2)                                                                                                                 |
| [`renderer/.../remote/FileGridView.tsx`](../../src/renderer/src/components/remote/FileGridView.tsx)                         | 범위 읽기·배치 effect·에러 정리(D1·D3·D9·D11)                                                                                         |
| [`renderer/.../thumbnail/ThumbnailImage.tsx`](../../src/renderer/src/components/thumbnail/ThumbnailImage.tsx)               | 표시와 ↻ 재시도만                                                                                                                     |
| [`renderer/.../remote/RemoteExplorer.tsx`](../../src/renderer/src/components/remote/RemoteExplorer.tsx)                     | 디렉터리 변경 시 `cancelAll`을 `useLayoutEffect`로(D14)                                                                               |
| [`renderer/.../thumbnail/RemoteFolderThumbnail.tsx`](../../src/renderer/src/components/thumbnail/RemoteFolderThumbnail.tsx) | 폴더 미리보기 내부 이미지 단건 요청(priority 1). **무변경**(D8)                                                                       |
| [`main/mcp/thumbnailPreviews.ts`](../../src/main/mcp/thumbnailPreviews.ts)                                                  | 호출마다 별도 큐. `request`·`cancelAll`만 사용(함정 6). **무변경**                                                                    |
| [`renderer/.../test/rendererTestUtils.ts`](../../src/renderer/src/test/rendererTestUtils.ts)                                | `stubGridLayout`, `makeApiMock`, `invokeCalls`                                                                                        |

---

## 9. 완료 기준

1. Test-262~278이 GREEN이고 기존 스위트 전체(`mcpTools.test.ts` 포함)가 GREEN이다(실행 출력으로 확인).
2. 각 테스트에 `covers: Test-N` 주석.
3. `npm run typecheck` · `npm run lint` 통과(바꾼 파일 기준), 바꾼 파일에 `npx prettier --check` 통과.
4. `stryker.config.json`의 `mutate`를 이번 변경분으로 재설정한다(신규 `thumbnailViewport.ts`는 통째로, `ThumbnailQueue.ts`·`FileGridView.tsx`·`ThumbnailImage.tsx`는
   `git diff --unified=0 -- <file> | grep '^@@'`로 얻은 범위). `break: 70` 통과.
5. R3 실측(테스트 FTP 서버에 JPEG 600장, 그리드 모드). jsdom은 실제 IO 타이밍·네트워크를 재현하지 못한다.

| 항목          | 확인 내용                                                                                                                                          |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) 원 증상   | 맨 위에서 썸네일이 받아지는 중에 휠로 맨 아래까지 내린다. 하단 썸네일이 진행 중 3건이 끝나는 대로 받아지기 시작한다(지나간 항목을 기다리지 않는다) |
| (b) 점프      | 스크롤바를 끌어 중간으로 점프한다. 그 화면의 썸네일이 먼저 채워지고, 이어서 위·아래 마진 행이 채워진다                                             |
| (c) 복귀      | 맨 위로 돌아오면 아직 못 받은 상단 항목을 다시 요청해 표시한다                                                                                     |
| (d) 갤러리    | 갤러리 모드에서 폴더 미리보기 이미지가 여전히 나타난다(D8)                                                                                         |
| (e) 폴더 이동 | 하위 폴더로 들어가면 그 폴더의 썸네일이 채워진다(D14)                                                                                              |

### R3 실측 결과 (구현 후)

pyftpdlib 서버(연결당 40 KB/s로 제한해 120 KB JPEG 한 장이 약 2초), JPEG 600장, 창 1200×800(원격 그리드 2열·약 3행).
변경 전 커밋(`b233f56`)과 변경 후 빌드에 같은 Playwright 스크립트를 돌렸다. 맨 위 썸네일이 받아지는 중에 휠로 맨 아래까지 내린 뒤 잰다.

| 항목                                                    | 변경 전         | 변경 후 |
| ------------------------------------------------------- | --------------- | ------- |
| (a) 맨 아래 보이는 5칸 중 첫 썸네일                     | 90초 안에 0개   | 4.0초   |
| (a) 맨 아래 보이는 5칸 전부                             | 180초 안에 미완 | 8.1초   |
| (a) 맨 아래 도착 후 지나친 파일(인덱스 < 565)의 RETR    | 267건           | 0건     |
| (b)(c) 지나치기만 한 중간(299~304)으로 점프 → 전부 표시 | 13.2초          | 5.6초   |
| (d) 갤러리 폴더 미리보기                                | —               | 표시됨  |
| (e) 하위 폴더 진입 → 썸네일                             | 0.1초           | 0.1초   |
| 실행 전체의 RETR                                        | 309건           | 42건    |

변경 후의 4초는 D6의 대가다: 진행 중이던 3건(각 2초)이 끝난 뒤 보이는 칸을 받기 시작한다.
