# 핸드오프: 라이트박스의 영상 재생 (webm/mp4) — GIF는 회귀 고정

> **포트 출처(Provenance)**: 이 문서는 `feat/feedback-batch` 브랜치(v1.3.0 기반)에서 이미 구현된
> 스펙을 현재 브랜치(v1.4.0+ 기반)로 옮긴 것이다. Phase·범위(P1~P8)는 원안과 **변경 없음**이며,
> 테스트 번호만 원래 `Test-872`~`Test-882`에서 **`Test-1202`~`Test-1212`** (+330)로 재배정했다.
> §1·§7의 코드 라인 포인터는 옛(v1.3.0) 기준이므로 현재 브랜치에서는 위치가 다를 수 있다.

R1에서 인간과 합의한 내용의 고충실도 기록. R2(테스트 코드 작성)·구현의 유일한 입력이다.
이 문서에 없는 케이스는 완료 범위 밖이다. 새 케이스를 추가하거나 기존 케이스를 재해석하지 말 것.

작업 유형(R0): **기능 추가**. RED 테스트를 먼저 세운 뒤 GREEN으로 만든다.

선행 작업: 없음.

---

## 1. 문제 정의

사용자 피드백: _"webm이나 gif의 경우 미리보기/본 컨텐츠 보기에서 재생이 가능하게 기능 추가."_

### 현황 실측 — 두 파일의 상태가 다르다

| 파일     | 라이트박스(본 컨텐츠 보기)                                             | 그리드 타일(미리보기)              |
| -------- | ---------------------------------------------------------------------- | ---------------------------------- |
| **GIF**  | **이미 재생된다.** 원본 바이트를 data URL로 받아 `<img>`로 그리기 때문 | sharp로 뽑은 **첫 장 정지 프레임** |
| **webm** | **아예 미리보기가 없다.** 아이콘 + "미리보기 없음"만 나온다            | 카테고리 글리프(영화 아이콘)만     |

- 라이트박스는 `entry.isImage`인 항목만 프리뷰를 요청한다
  ([`Lightbox.tsx:22`](../../src/renderer/src/components/explorer/Lightbox.tsx#L22)). 이미지가 아니면
  `EntryThumb` 글리프와 `t('preview.none')`을 그린다(`Lightbox.tsx:157-166`).
- `isImage`는 `IMAGE_EXTENSIONS`로 정해지는데, 거기에는 gif가 있고 **영상 확장자는 하나도 없다**
  ([`constants.ts:1-10`](../../src/shared/constants.ts#L1-L10)).
- `MIME_MAP`에도 영상 MIME이 없다([`previewHandlers.ts:25-34`](../../src/main/ipc/previewHandlers.ts#L25-L34)).
  `local:preview`는 이미지가 아니면 아예 거부한다
  ([`localFsHandlers.ts:110`](../../src/main/ipc/localFsHandlers.ts#L110)).
- 그리고 **CSP가 영상을 막는다**: `img-src 'self' data:`까지만 허용하고 `media-src`는
  `default-src 'self'`로 떨어져 `data:` 영상 소스가 **조용히 차단**된다
  ([`index.html:6-9`](../../src/renderer/index.html#L6-L9)).

따라서 이번 작업은 "GIF를 어떻게 재생하게 할 것인가"가 아니라, **영상 라이트박스 프리뷰의
빈 구간(webm·mp4)을 만들고, GIF가 그 경로로 들어가도 깨지지 않는지 회귀로 고정하는 것**이다.

### 범위의 확인 (R1에서 인간과 논의)

- **타일의 애니메이션 GIF 재생은 이번 범위 밖이다**(§5 기각). 타일이 재생되려면 sharp 썸네일
  대신 원본 GIF를 받아야 하는데, 그리드는 보이는 칸마다 한 번에 그렇게 할 수 있다.
  라이트박스만으로 "본 컨텐츠 보기에서 재생"이라는 요구는 충족한다.

---

## 2. 핵심 결정 (R1에서 인간이 확정)

| #                                                            | 결정                                                                                                                                  | 근거                                                                                                                                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1                                                           | **`VIDEO_EXTENSIONS`는 Chromium이 실제로 디코딩할 수 있는 확장자만** 넣는다: `.webm .mp4 .mov .m4v`                                   | 카테고리 `video` 목록엔 mkv·avi·wmv·mts·3gp도 있다(`explorerEntry.ts:47`). 그것들을 프리뷰 대상으로 삼으면 **빈 플레이어**가 뜬다. 이미지의 선례         |
| (`IMAGE_EXTENSIONS` 8개 ⊂ 카테고리 image 목록)와 같은 구조다 |
| P2                                                           | 판정은 **렌더러가 확장자로** 한다: `isVideoFile(entry.name)`. `ExplorerEntry`에 필드를 추가하지 않는다                                | `category`·`isImage`처럼 메인에서 주지 않아도 되므로 IPC 계약·`FtpConnectionManager`·`LocalFileSystem`·MCP 하네스를 건드리지 않는다                      |
| P3                                                           | 라이트박스는 영상일 때 **`<video controls autoPlay muted>`**를 그린다. 소스는 기존 프리뷰 핸들러의 data URL을 그대로 쓴다             | 이미지와 같은 경로(`ftp:downloadPreview` · `local:preview`)라 새 채널·새 캐시가 없다. 프리뷰 캐시는 확장자만 추가로 인식하면 된다                        |
| P4                                                           | **CSP에 `media-src 'self' data:`를 추가**한다. `img-src`는 그대로 둔다                                                                | 없으면 `<video>`의 data URL이 조용히 차단된다. `Test-1212`가 계약으로 고정한다                                                                           |
| P5                                                           | 크기 상한은 **종류별로 나눈다**: 이미지는 기존 `MAX_IMAGE_SIZE_BYTES`(50MB), 영상은 새 `MAX_VIDEO_SIZE_BYTES = 100MB`                 | data URL은 파일 전체를 메모리에 올려야 하므로(버퍼 + base64) 이미지 기준을 그대로 쓰면 큰 영상이 창을 죽일 수 있다. 100MB를 넘으면 기존 실패 안내로 간다 |
| P6                                                           | 영상 컨트롤에 **키보드가 가로채지지 않게 한다**: `<video>`나 그 자식에 포커스가 있으면 라이트박스의 Space·Enter·←/→ 핸들러를 건너뛴다 | 지금 Space·Enter는 **닫기**, ←/→는 **넘기기**다(`Lightbox.tsx:101-110`). 컨트롤에서 스페이스를 누르면 영상 대신 라이트박스가 닫힌다                      |
| P7                                                           | 프리뷰 실패·거부는 **기존 안내를 그대로** 쓴다: `t('preview.failed', { reason })` / `t('preview.none')`. 새 오류 문구를 만들지 않는다 | 이미지에서 이미 쓰는 경로이고, i18n 키를 늘리지 않는다                                                                                                   |
| P8                                                           | `PreviewCacheManager.mimeToExt`에 영상 MIME을 추가한다(`video/webm` → `.webm` 등)                                                     | 없으면 `.bin`으로 저장된다. 지금은 MIME을 별도 컬럼에 두어 재생에는 지장이 없지만, 캐시 파일을 직접 여는 2차 작업의 전제가 된다                          |

---

## 3. 구현 함정

### 함정 A — 카테고리 목록과 프리뷰 목록이 갈린다

`entry.category === 'video'`는 mkv·avi·wmv를 포함하고, `isVideoFile`은 P1에 따라 네 개만
참이다. **어느 쪽으로 판정하느냐에 따라 "영상인데 플레이어가 안 뜨는 것"과 "플레이어가 뜨는데
재생이 안 되는 것"이 갈린다.** P2의 `isVideoFile(entry.name)`만 쓰고, 카테고리 목록은 건드리지
말아야 한다(카테고리는 아이콘·필터용으로 이미 제 역할을 한다).

### 함정 B — GIF가 `<video>`로 떨어지면 애니메이션이 죽는다

`isVideoFile('.gif')`이 참이면 GIF가 `<video>`로 그려지고, `<video>`는 GIF를 재생하지 못한다
→ **지금 되던 것까지 깨진다.** P1의 확장자 목록에 gif가 없는지가 `Test-1202`·`Test-1209`의
양쪽 단언이다. 반대로 `isImage`만 보고 `<img>`로 그리는 현 로직은 GIF를 이미 제대로 처리하므로,
**분기 순서는 `isVideoFile → isImage → 글리프`**가 아니라 `isVideoFile`이 참할 때만 `<video>`다.

### 함정 C — 영상 컨트롤과 라이트박스 키보드 충돌 (P6)

`onKeyDown`은 다이얼로그 루트에 걸려 있고 `e.stopPropagation()`을 먼저 한다. `<video controls>`
에 포커스가 있으면 키 이벤트는 컨트롤에서 시작해 루트로 **버블링**해온다 → 스페이스로 재생/정지를
누르는 순간 라이트박스가 닫힌다. `e.target`이 `<video>`(또는 그 내부)인지 보고 그때만
`stopPropagation` + `return`한다. 루트를 통째로 무시하면 ←/→ 페이지 넘김까지 죽으므로
**영상 컨트롤에 있을 때만** 건너뛴다. `Test-1210`이 이를 고정한다.

### 함정 D — data URL의 메모리 (P5)

`ftp:downloadPreview`는 파일 전체를 `Buffer`에 모은 뒤 base64로 만들어 반환한다. 영상은
100MB라도 전송 중 대략 1.3배의 메모리가 더 든다. **상한을 이미지와 공유하면 큰 영상에서
창이 죽을 수 있으므로 P5의 별도 상한이 필수**다. 100MB를 넘으면 에러 문자열이 프리뷰 안내로
그대로 전달된다(`Test-1204`·`Test-1207`).

### 함정 E — `entry.isImage`가 false라 타일·상세 패널이 손대면 안 된다

영상 항목의 `isImage`은 false가 맞다(타일은 글리프를 그려야 한다). 이번 변경에서
`IMAGE_EXTENSIONS`·`isImage`·썸네일 큐를 건드리면 **이미지 썸네일이 통째로 깨진다.**
건드리는 것은 프리뷰 핸들러 게이트·MIME·라이트박스 분기·CSP 네 곳뿐이다.

---

## 4. 대상 API

```ts
// src/shared/constants.ts

/**
 * Chromium이 실제로 재생할 수 있는 영상 확장자(P1). 카테고리 `video` 목록
 * (mkv·avi·wmv·mts·3gp 포함)의 **부분 집합**이다 — IMAGE_EXTENSIONS가 카테고리 image보다
 * 좁은 것과 같은 구조.
 */
export const VIDEO_EXTENSIONS = new Set(['.webm', '.mp4', '.mov', '.m4v'])

export const MAX_VIDEO_SIZE_BYTES = 100 * 1024 * 1024 // 100MB (P5)

export function isVideoFile(filename: string): boolean {
  const ext = filename.substring(filename.lastIndexOf('.')).toLowerCase()
  return VIDEO_EXTENSIONS.has(ext)
}
```

```ts
// src/renderer/index.html (P4)
content =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' data:"
```

```ts
// src/main/ipc/localFsHandlers.ts — 'local:preview' 게이트만 바꾼다 (P5)
if (!isImageFile(filePath) && !isVideoFile(filePath))
  return { success: false, error: 'Not an image file' }
const cap = isVideoFile(filePath) ? MAX_VIDEO_SIZE_BYTES : MAX_IMAGE_SIZE_BYTES
if ((await stat(filePath)).size > cap)
  return { success: false, error: 'File too large for preview' }
```

```ts
// src/main/ipc/previewHandlers.ts — MIME_MAP과 상한만 (P5·P8)
'.webm': 'video/webm', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/mp4'
if (req.fileSize > (isVideoFile(req.remotePath) ? MAX_VIDEO_SIZE_BYTES : MAX_IMAGE_SIZE_BYTES)) ...
```

```tsx
// src/renderer/src/components/explorer/Lightbox.tsx — 분기 하나 추가 (P3·P6·P7)
const video = isVideoFile(entry.name)          // P2: 확장자로 판정
{preview?.url && video ? (
  <video
    key={entry.path}
    src={preview.url}
    controls
    autoPlay
    muted
    // P6: 컨트롤에 포커스가 있으면 라이트박스의 키보드를 건너뛴다 (onKeyDown 분기와 짝)
    className="fade max-h-full max-w-full drop-shadow-2xl"
  />
) : preview?.url ? (
  <img ... />                                   // GIF는 여기로 남는다 (함정 B)
) : (
  ...기존 안내...                                // P7: 문구 변경 없음
)}
```

```ts
// usePreview(Lightbox.tsx:18-50)는 `if (!entry.isImage) return` 조건만 바꾼다
if (!entry.isImage && !isVideoFile(entry.name)) return
```

`PreviewCacheManager.mimeToExt`(P8): `video/webm` → `.webm`, `video/mp4` → `.mp4`,
`video/quicktime` → `.mov`.

---

## 5. 기각한 대안

- **그리드 타일에서 GIF 애니메이션 재생(hover 시 원본 로드)** — 타일마다 원본 GIF를 다운로드해야
  해 그리드 스크롤 시 트래픽·메모리가 폭증한다. sharp 썸네일을 애니메이션으로 바꾸는 것도
  첫 장만 가능하다. **라이트박스(본 컨텐츠 보기)로 요구를 충족시킨다.** 별도 스펙 후보로 남긴다.
- **`.mkv`·`.avi`도 플레이어에 넣기** — Chromium이 디코딩하지 못해 빈 플레이어와 콘솔 에러만
  남는다(P1). 외부 플레이어로 여는 기능은 또 다른 작업이다. 기각.
- **프리뷰 캐시 파일을 커스텀 스킴(`preview://`)으로 서빙** — 스크럽·스트리밍이 가능해지고 메모리
  문제(P5)도 사라지지만, `protocol.handle` 등록·범위 요청·계약 테스트가 새로 필요하다.
  R1에서 **1차는 data URL, 2차로 후보**로 미뤘다. 기각(보류).
- **`ExplorerEntry`에 `isVideo` 필드 추가** — 메인 3곳(`LocalFileSystem`·`FtpConnectionManager`·
  MCP 하네스)과 타입·계약 테스트를 건드린다. 확장자 판정으로 충분하다(P2). 기각.
- **영상 전용 프리뷰 채널(`local:videoPreview`) 신규** — 채널 하나를 세 곳(핸들러·허용목록·
  유니언)에 등록해야 하고, 하는 일은 지금 핸들러와 같다. 기각.
- **`controls` 없이 자동 재생만(짧은 클립 루프)** — 라이트박스는 넘겨 보는 탐색기라 재생 위치를
  잡을 수 있어야 한다. `autoPlay`는 편의용 옵션이므로 유지하되, 컨트롤은 반드시 필요하다. 기각.

---

## 6. 테스트 케이스 리스트 (확정)

`Test-1202`부터 신규. 기존 최대 번호는 `Test-1201`(`origin/main` 기준 —
[`explorer-ux-polish.md`](./explorer-ux-polish.md)의 R3 후속 번호가 현재 브랜치의 상단이다).
각 테스트에 `covers: Test-N` 주석을 단다. **1:1 매핑. 케이스 추가·병합·재해석 금지.**

### A. 공유 상수 (`shared/constants.test.ts`)

| #         | 케이스                                                                                             | 기대                                                  |
| --------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Test-1202 | `isVideoFile` 갈래: webm·mp4·mov·m4v은 참 / gif·jpg·mkv·avi·wmv는 거짓 / 확장자 없음·대소문자 혼합 | P1·함정 B. **gif와 재생 불가 포맷이 반드시 거짓**이다 |

### B. 로컬 프리뷰 (`main/ipc/localFsHandlers.test.ts`)

| #         | 케이스                                                                                                           | 기대                                              |
| --------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Test-1203 | `local:preview`가 webm을 `data:video/webm;base64,`로 돌려준다 (기존에는 'Not an image file')                     | P3의 로컬 경로                                    |
| Test-1204 | 크기 상한이 종류별로 다르다: 영상은 `MAX_VIDEO_SIZE_BYTES`, 이미지는 기존 `MAX_IMAGE_SIZE_BYTES`로 각각 거부된다 | P5·함정 D. 두 상한을 한 변수로 합친 구현을 막는다 |

### C. 원격 프리뷰 (`main/ipc/previewHandlers.test.ts`)

| #         | 케이스                                                                                          | 기대                                                          |
| --------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Test-1205 | `ftp:downloadPreview`가 webm을 `data:video/webm;base64,`로 돌려준다 (보조 클라이언트 경로 포함) | P3의 원격 경로. `MIME_MAP` 확장과 게이트가 함께 성립해야 한다 |
| Test-1206 | gif는 `data:image/gif;base64,`로 그대로다                                                       | 회귀 고정 — GIF가 이번 변경으로 끊기지 않는다                 |
| Test-1207 | `MAX_VIDEO_SIZE_BYTES`를 넘는 원격 영상은 거부하고, 이미지의 50MB 기준은 그대로다               | P5·함정 D                                                     |

> 이 브랜치에서는 `previewHandlers.test.ts`가 이미 존재한다(원안에서는 신규). 따라서 세 케이스는
> **기존 파일에 추가**한다. 현재 핸들러의 인자 순서는 `(event, conn, req)`이므로 테스트도
> `conn`을 첫 인자로 넘겨 호출한다.

### D. 라이트박스 (`components/explorer/Explorer.test.tsx` — `lightbox` describe)

| #         | 케이스                                                                                                        | 기대                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Test-1208 | 영상(webm) 항목을 열면 `<video>`가 그리고 `controls`를 가지며 소스가 프리뷰 data URL이다 — **로컬·원격 양쪽** | P2·P3                                                                      |
| Test-1209 | GIF 항목을 열면 여전히 `<img>`이고 소스는 `image/gif` data URL이다                                            | 함정 B 회귀. `<video>`로 떨어지면 이 테스트가 깨진다                       |
| Test-1210 | `<video>` 컨트롤에 포커스한 채 Space·Enter를 누르면 **라이트박스가 닫히지 않고**, ←/→도 목록을 넘기지 않는다  | P6·함정 C. 영상 밖에서는 기존 닫기·넘김이 그대로여야 한다(함정 C의 반대쪽) |
| Test-1211 | 프리뷰가 거부되면(너무 큰 파일) 기존 `preview.failed` 안내로 떨어진다                                         | P7. 새 오류 문구가 생기지 않았음을 함께 단언한다                           |

### E. 계약 (`src/shared/rendererShell.test.ts` 신규)

| #         | 케이스                                                            | 기대                                                                       |
| --------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Test-1212 | `src/renderer/index.html`의 CSP에 `media-src 'self' data:`가 있다 | P4. 없으면 영상이 조용히 차단된다. `img-src`는 그대로 있음도 함께 단언한다 |

- 기존 `Test-791`~ 등 이미지 프리뷰·썸네일 케이스와 `constants.test.ts`의 `isImageFile` 케이스는
  **그대로 GREEN이어야 한다**(`IMAGE_EXTENSIONS`는 건드리지 않는다 — 함정 E).
- E2E가 전담할 것: 실제로 webm·mp4·gif 파일을 라이트박스에서 열어 보는 것(§8 표).

---

## 7. 관련 코드 포인터

> 라인 번호는 옛(v1.3.0) 기준이다. 현재 브랜치(v1.4.0+)에서는 위치가 움직었을 수 있다.

| 파일                                                                                                    | 역할                                                                                                                             |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| [`shared/constants.ts`](../../src/shared/constants.ts)                                                  | `IMAGE_EXTENSIONS` L1-10(무변경), `MAX_IMAGE_SIZE_BYTES` L18(무변경). 새 `VIDEO_EXTENSIONS`·`MAX_VIDEO_SIZE_BYTES`·`isVideoFile` |
| [`components/explorer/Lightbox.tsx`](../../src/renderer/src/components/explorer/Lightbox.tsx)           | `usePreview` L18-50(게이트), 렌더 분기 L148-166, `onKeyDown` L101-110(함정 C)                                                    |
| [`renderer/index.html`](../../src/renderer/index.html)                                                  | CSP L6-9(P4)                                                                                                                     |
| [`main/ipc/localFsHandlers.ts`](../../src/main/ipc/localFsHandlers.ts)                                  | `local:preview` L108-120(게이트·상한)                                                                                            |
| [`main/ipc/previewHandlers.ts`](../../src/main/ipc/previewHandlers.ts)                                  | `MIME_MAP` L25-34, `ftp:downloadPreview` L48-107(게이트·상한)                                                                    |
| [`main/preview/PreviewCacheManager.ts`](../../src/main/preview/PreviewCacheManager.ts)                  | `mimeToExt` L93-103(P8)                                                                                                          |
| [`lib/explorerEntry.ts`](../../src/renderer/src/lib/explorerEntry.ts)                                   | 카테고리 목록 L47(**무변경**, 함정 A) · `isImage` L40(무변경)                                                                    |
| [`components/thumbnail/EntryThumb.tsx`](../../src/renderer/src/components/thumbnail/EntryThumb.tsx)     | `entry.isImage` 분기 L114(**무변경**, 함정 E)                                                                                    |
| [`components/explorer/Explorer.test.tsx`](../../src/renderer/src/components/explorer/Explorer.test.tsx) | `lightbox` describe L170-, 프리뷰 핸들러 스텁 하네스가 이미 있다                                                                 |
| [`main/ipc/localFsHandlers.test.ts`](../../src/main/ipc/localFsHandlers.test.ts)                        | 로컬 프리뷰 하네스. `previewHandlers.test.ts`는 현재 브랜치에 이미 존재한다(기존 하네스에 케이스만 추가)                         |

---

## 8. 완료 기준

1. `Test-1202`~`Test-1212`가 모두 GREEN (실행 출력으로 확인).
2. **기존 이미지·썸네일·라이트박스 케이스가 계속 GREEN.** 특히 `constants.test.ts`의
   `isImageFile`(8개 확장자)과 Explorer의 기존 라이트박스 케이스.
3. 각 신규 테스트에 `covers: Test-N` 주석.
4. **i18n 키 추가 없음** (P7). `i18n.test.ts`와 typecheck가 GREEN이어야 한다.
5. 뮤테이션: `git diff --unified=0 -- src/shared/constants.ts src/renderer/src/components/explorer/Lightbox.tsx src/main/ipc/localFsHandlers.ts src/main/ipc/previewHandlers.ts src/main/preview/PreviewCacheManager.ts | grep '^@@'`로
   변경 라인을 확인해 `stryker.config.json`의 `mutate`를 갱신하고 `break: 70` 통과.
6. `npm run typecheck` · `npm run lint` · `npx prettier --check <변경 파일>` · `npm test` 통과.
7. E2E 실측 (실기기 R3):

   | 항목 | 확인 내용                                                                                |
   | ---- | ---------------------------------------------------------------------------------------- |
   | (a)  | 로컬 webm을 열면 **재생·정지·스크럽**이 되고 ←/→·Esc는 여전히 라이트박스를 넘기고 닫는다 |
   | (b)  | 원격 webm/mp4를 열면 같은 동작이다 (실행 중 파일을 건드리지 않고 프리뷰 캐시만 쓴다)     |
   | (c)  | GIF를 열면 **애니메이션이 돌고**, Space로 닫히는 동작도 그대로다                         |
   | (d)  | 재생 중 스페이스를 눌러도 라이트박스가 **닫히지 않고** 재생/정지된다                     |
   | (e)  | 큰 파일(영상 100MB 초과)은 기존 "파일이 너무 큽니다" 안내로 떨어지고 앱이 죽지 않는다    |
   | (f)  | 그리드 타일·상세 패널의 이미지 썸네일이 이전과 **완전히 같다** (함정 E 회귀 없음)        |
