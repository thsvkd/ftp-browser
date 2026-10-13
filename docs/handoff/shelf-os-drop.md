# 핸드오프: 선반 OS 드롭 — Finder·탐색기에서 끌어온 파일·폴더를 선반에 담기

운영체제 파일 관리자(Finder, Windows 탐색기)에서 끌어온 파일·폴더를 오른쪽 레일의 **선반**에 놓으면 담기게 한다.
지금은 선반이 OS 드롭을 일부러 거절한다(`dnd.ts:118`, `:123`). 폴더는 펼치지 않고 **폴더 항목 하나**로 담는다.
경로로 파일 정보를 읽는 IPC가 없어 `local:stat`을 새로 만든다.
이 문서가 테스트·구현의 유일한 입력이다. 이 문서에 없는 케이스는 완료 범위 밖이다. 케이스를 추가·병합·재해석하지 말 것.

작업 유형(R0): **기능(작은 렌더러 배선 + 새 IPC 채널 1개)**. 테스트를 먼저 세워 RED를 보고 GREEN으로 만든 뒤, 실제 앱에서 R3 실측(§9)을 한다.

입력 문서:

- R1 결정: `.omc/plans/explorer-v2-decisions.md` §C (사용자와 합의). 이 문서의 O1~O3·O8은 그것을 코드에 대응시킨 것이고, O4~O7·O9는 §C가 정하지 않은 부분을 정한 것이다. 그중 **O6·O9는 사람 확인이 필요한 미결(권장안 적용)**이다(§10 '미결').
- 기준 스펙: `docs/handoff/explorer-shelf.md` — 선반(§2 D29, §3), 놓기 대상(함정 6·7), `local:copyFiles`·충돌 시트(D32). 새 채널을 3곳에 등록하는 규칙은 `CLAUDE.md` 'IPC contract'와 같은 문서의 함정 14에 있고, 허용 목록 테스트 형식은 Test-770이다.
- 같은 시기에 쓰는 다른 스펙과의 관계: `collapsible-sidebars.md`(레일 접힘 — O7. `AppShell.tsx`·`RightRail.tsx`를 고친다. 이 스펙은 두 파일의 소스를 건드리지 않고 `RightRail.test.tsx`에 케이스만 더한다), `multi-connection.md`·`split-view.md`(`sendItems.ts`·`dnd.ts`·`AppShell.tsx`를 크게 고칠 것으로 예상된다 — 이 스펙 작성 시점에 두 문서가 없어 예상일 뿐이다. 충돌 줄이기는 §8). `explorer-menu-and-focus.md`·`file-category-filter.md`와는 소스 파일이 겹치지 않는다.

---

## 1. 바꾸는 것

```
Finder / 탐색기 ──끌어서──▶ 선반 (오른쪽 레일)
                              │ ① 놓기: getPathForFile(File) → 절대 경로 (동기)
                              │ ② window.api.invoke('local:stat', paths)   ← 새 채널
                              │ ③ LocalFileEntry[] → fromLocalEntry → useShelfStore.add (locKey로 중복 제거)
                              ▼
                  선반 항목(side:'local', 폴더도 항목 하나) ── 이후는 기존 흐름 그대로
                  (활성 탭에 내려놓기 → transfer:send 업로드 / local:copyFiles 복사)
```

| 지금                                                                                                                                                                                                                     | 이후                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `useDropTarget`이 `'shelf'` 대상에 OS 파일을 받지 않는다(`dnd.ts:118` `dest !== 'shelf'`, `:123` 조기 반환)                                                                                                              | 선반(빈/채움)과, 정보 탭을 보는 동안의 "선반" 세그먼트가 OS 파일을 받는다                               |
| OS 파일의 이름·종류·크기를 읽는 채널이 없다(`dropOsFiles`는 `File`의 크기 0·형식 없음으로 폴더를 짐작한다)                                                                                                               | `local:stat(paths)` — 경로 배열 → `LocalFileEntry[]`. 폴더인지 정확히 안다                              |
| 대상 없는 곳의 OS 파일 드래그: `main.tsx:9~10`의 document 리스너가 `preventDefault`만 해 **창 이동은 이미 막혀 있다**. 다만 `dropEffect`를 안 정해 대상이 아닌 곳에서도 복사 커서가 뜰 수 있다(R3 (d)가 기준선에서 확인) | 같은 document 리스너가 앱 안 드래그가 없는 `Files` 드래그에 `dropEffect = 'none'`(금지 커서)을 둔다(O6) |

---

## 2. 핵심 결정 (R1)

### 사용자와 합의한 것 (`explorer-v2-decisions.md` §C)

| #   | 결정                                                                                                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O1  | OS에서 끌어온 파일·폴더를 **선반에 추가**한다. `dnd.ts`가 선반에 OS 파일을 명시적으로 거부하던 것을 허용으로 바꾼다                                                                |
| O2  | **폴더는 펼치지 않고 폴더 항목 하나**다(`type: 'directory'`). 하위 파일을 열거하지 않는다. 폴더 크기는 합산하지 않고 "＋ 폴더 내용"으로 보인다(기존 `useShelfStore` 규칙 그대로)   |
| O3  | 새 채널 **`local:stat`**(경로 배열 → `LocalFileEntry[]`). 3곳 등록(`ipcMain.handle` / preload `INVOKE_CHANNELS` / `index.d.ts` `InvokeChannel`) + `src/preload/index.test.ts` 커버 |
| O8  | 경로는 `window.api.getPathForFile`(webUtils)로 얻고, **중복은 기존 `locKey`**(`side\|server\|path`)로 거른다. 별도 중복 규칙을 만들지 않는다                                       |

### 이 스펙이 정한 것 (§C가 정하지 않은 부분)

| #   | 결정                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 근거                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O4  | **`local:stat`의 계약.** 인자: 문자열 배열. 결과: `IpcResult<LocalFileEntry[]>`. 절대 경로만 받는다(`path.isAbsolute`). 각 경로는 `path.resolve`로 정규화한다(끝 구분자 제거). `fs.stat`(심볼릭 링크는 가리키는 대상 기준 — Test-882가 `lstat` 구현을 잡는다)으로 읽고, 입력 **순서를 보존**한다. 판정은 `LocalFileSystem.ts`가 이미 가진 `path` import의 `path.isAbsolute`·`path.resolve`로 한다. 읽을 수 없는 경로(없음·권한·상대 경로·문자열 아님)는 **조용히 결과에서 빠지고** 던지지 않는다. 배열이 아닌 인자는 실패 값. 이름은 `basename`, 루트처럼 비면 경로 전체. `isImage = !폴더 && isImageFile(이름)`                                                                                                                            | 항목별 실패가 한 번의 드롭 전체를 막으면 안 된다. 호출자는 `결과 길이 < 요청 길이`로 빠진 수를 안다. `stat`은 업로드 계획(`folderPlan.ts:205`)의 판정과 같아, 선반에서 "폴더"로 보이면 전송도 폴더로 처리한다 |
| O5  | **`getPathForFile`은 드롭 핸들러에서 동기로** 모두 부른다(기존 `dropOsFiles`와 같다). 빈 문자열(가상 파일: 압축 파일 안, 메일 첨부, 웹 이미지)은 건너뛰고 빠진 수에 센다. 읽은 항목만 `fromLocalEntry`로 바꿔 `useShelfStore.add`에 넘기며, 레일은 `add`가 선반 탭으로 바꾼다                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `DataTransfer`는 이벤트 안에서만 믿을 수 있다. 새 상태·새 스토어 없이 기존 `add`를 쓴다                                                                                                                       |
| O6  | **대상 없는 곳의 금지 커서(미결 → 권장안 적용, 사람 확인 필요).** 현재 `main.tsx:9~10`의 document `dragover`·`drop` 리스너는 모든 드래그를 `preventDefault`만 하므로 **창이 파일로 이동하는 일은 이미 없다**(파일을 놓아도 조용히 무시). 남은 문제는 `dropEffect`를 안 정해 대상이 아닌 곳(정보 본문, 사이드바 빈 곳, 접힌 레일)에서도 복사 커서가 뜰 수 있다는 점이다. 그래서 그 리스너를 `lib/osDropGuard.ts`의 `installDropGuard(document)`로 꺼내(동작 보존 + 추가), 앱 안 드래그(`useDnd.items`)가 없고 `types`에 `Files`가 있는 `dragover`에는 `dropEffect = 'none'`을 더한다. `AppShell.tsx`는 건드리지 않는다. 놓기 대상은 `dragover`에서 `stopPropagation`하므로(함정 6) document까지 오지 않고, 대상 위의 동작은 그대로다         | 기존 리스너를 확장하는 가장 작은 변경이다. 대안 비교는 §5. §C는 앱 전체의 드래그 커서 변경을 요구한 적이 없다 — 사람이 거절하면 S3·Test-880·883·R3 (d)의 커서 확인만 빼면 되고 O1~O5·O7~O9는 영향이 없다      |
| O7  | **정보 탭 중**: "선반" 세그먼트만 대상이다(Test-808의 앱 안 드래그와 같다). 놓으면 `add`가 레일을 선반 탭으로 바꾼다. 전부 이미 있어 0개가 담기면 탭은 그대로이고 "이미 선반에 있습니다" 토스트만 보인다. **레일이 접힌 상태**(`collapsible-sidebars.md`)는 이 스펙이 다루지 않는다: 놓기 대상이 없고 O6 가드(document 리스너)가 금지 커서를 보인다. 가장자리 호버로 펼치기는 하지 않는다                                                                                                                                                                                                                                                                                                                                                   | Test-808과 일관. 접힘의 DOM이 아직 정해지지 않았고, 접힌 레일에 호버로 펼치는 것은 그 스펙의 일이다                                                                                                           |
| O9  | **빠진 항목은 토스트로 알린다(미결 → 권장안 적용, 사람 확인 필요).** 새 키 `toast.shelfDropSkipped`(복수형) — "{{count}} dropped item couldn't be read". 정확한 호출: 부분 실패·경로 없음은 `toast(t('toast.shelfDropSkipped', { count }))`(`toast.error`가 아니다 — 일부는 담겼을 수 있다). `local:stat`이 통째로 실패하면 `toast.error(t('toast.shelfDropSkipped', { count: 파일 수 }), { description })` — `description`은 `success: false`면 `result.error`, `invoke`가 reject하면 `err instanceof Error ? err.message : String(err)`. 읽을 수 없는 항목이 있고 읽은 것이 전부 중복이면 **두 토스트가 순서대로 모두** 뜬다(빠진 수 → "이미 선반에 있습니다": 둘 다 사실이다). 읽은 것 중 일부만 중복이면 새것만 담고 중복 토스트는 없다 | 조용히 빠지면 사용자는 왜 4개 중 3개만 담겼는지 모른다. 새 키는 11개 로캘에 함께 넣는다(CLAUDE.md i18n)                                                                                                       |

### 이 스펙이 건드리지 않는 것

- 탐색기 영역·폴더 타일·탭·사이드바·경로 조각이 OS 파일을 받는 동작(`dropOsFiles`, Test-811·840)은 그대로다. 크기 0·형식 없음으로 폴더를 짐작하는 그 코드를 `local:stat`으로 바꾸는 것은 후속 과제다.
- 선반 항목의 전송(`dropShelf`, `planSend`, 충돌 시트)은 그대로다. OS에서 온 항목도 `side: 'local'` 항목일 뿐이다.
- 레이아웃·키보드: OS 드롭에는 키보드 대응이 없다(마우스 동작). 키보드로 로컬 파일을 선반에 담는 길은 Shift+S(D29)가 이미 있다.

---

## 3. 대상 API (main·IPC·렌더러)

```ts
// src/shared/types/local.ts — 변경 없음. 결과 형태는 기존 LocalFileEntry를 그대로 쓴다.
//   { name, path, type: 'file' | 'directory', size, modifiedAt (ISO), isImage }

// src/main/local/LocalFileSystem.ts (추가)
/** O4: 절대 경로만, resolve, 입력 순서, 읽을 수 없는 것은 뺀다. 던지지 않는다. */
statEntries(paths: unknown[]): Promise<LocalFileEntry[]>   // path.isAbsolute·path.resolve는 이 파일의 기존 `path` import

// src/main/ipc/localFsHandlers.ts (추가) — `local:getPlaces` 옆
// 인자는 신뢰하지 않으므로 unknown으로 받는다(함정 7). statEntries가 던지지 않으므로(O4) try/catch는 두지 않는다.
ipcMain.handle('local:stat', async (_e, paths: unknown): Promise<IpcResult<LocalFileEntry[]>> => {
  if (!Array.isArray(paths)) return { success: false, error: 'paths must be an array' }
  return { success: true, data: await localFs.statEntries(paths) }
})

// src/renderer/src/lib/sendItems.ts (추가) — `dropOsFiles` 옆
/** OS에서 끌어온 파일·폴더를 선반에 담는다. 새로 담은 수를 돌려준다. */
export async function shelveOsFiles(files: readonly File[]): Promise<number>
```

`shelveOsFiles`의 순서:

1. `files`가 비면 아무것도 하지 않고 0. 아니면 **동기로** `getPathForFile`을 모두 부른다. 빈 문자열은 빠진 수에 센다.
2. 경로가 하나도 없으면 `local:stat`을 부르지 않고 `toast(t('toast.shelfDropSkipped', { count: files.length }))`, 0.
3. `invoke<IpcResult<LocalFileEntry[]>>('local:stat', paths)`. `success: false`면 `toast.error(t('toast.shelfDropSkipped', { count: files.length }), { description: result.error })`, reject면 같은 호출에 `description: err instanceof Error ? err.message : String(err)`. 어느 쪽이든 0을 돌려주고 던지지 않는다.
4. `빠진 수 = files.length − 결과 길이`가 0보다 크면 `toast(t('toast.shelfDropSkipped', { count: 빠진 수 }))`(부분 실패. 이 토스트가 먼저).
5. `useShelfStore.getState().add(결과.map(fromLocalEntry))` → 새로 담은 수. 결과가 있었는데 0이면 `toast(t('toast.alreadyOnShelf'))`(4번과 둘 다 뜰 수 있다 — O9).

`useDropTarget`(`dnd.ts`)의 변경은 두 군데뿐이다:

- `onDragOver`(`:114~119`): `else if (dest !== 'shelf' && hasFiles(e))` → `else if (hasFiles(e))`. 선반도 `enter(e, 'copy')`로 받는다.
- `onDrop`(`:120~134`): 조기 반환 `if (!dragged && (dest === 'shelf' || !hasFiles(e))) return`에서 `dest === 'shelf'` 조건을 뺀다. `!dragged` 가지는 `dest === 'shelf' ? shelveOsFiles(files) : dropOsFiles(files, dest)`.

`valid`·`verb`·`reason`은 바꾸지 않는다(OS 드래그는 내용을 모르고, 선반 대상의 소비자는 `drop.over`만 본다).

O6 가드(신규 `src/renderer/src/lib/osDropGuard.ts`, `main.tsx:9~10`의 두 줄을 대체):

```ts
/** document 레벨 드래그 기본 동작 방지(창이 파일로 이동하지 않게) + 대상 없는 곳의 Files 드래그는 금지 커서. 해제 함수를 돌려준다. */
export function installDropGuard(doc: Document): () => void
// dragover: 항상 preventDefault(기존 동작). useDnd.getState().items === null 이고 types에 'Files'가 있으면 dropEffect = 'none'
// drop: 항상 preventDefault(기존 동작)
```

`main.tsx`는 `installDropGuard(document)` 한 줄이 된다(`:8` 주석은 유지).

---

## 4. 구현 함정

1. **`DataTransfer.files`는 드롭 이벤트 안에서 읽는다.** `Array.from(e.dataTransfer.files)`와 `getPathForFile`을 `await` 앞에서 끝낸다(`dropOsFiles`와 같다). 비동기 뒤에 읽으면 빈 목록이 될 수 있다.
2. **폴더 하나가 항목 하나다.** `local:list`·`local:expandForUpload`를 부르지 않는다. 폴더 안 파일은 전송 때 main의 `planUpload`가 펼친다(`folderPlan.ts:198~`). 폴더와 그 안의 파일을 같이 끌어 와도 `outermost()`가 바깥 것만 남긴다(`folderPlan.ts:204`).
3. **`path`는 `local:list`가 만드는 값과 같은 모양이어야 중복이 걸러진다.** `list`는 `path.join(dirPath, name)`(`LocalFileSystem.ts:17`), `stat`은 `path.resolve(입력)`이다. 둘 다 네이티브 구분자·끝 구분자 없음이다. 끝 구분자(`C:\a\`)를 남기면 같은 폴더가 다른 키가 된다 — Test-870이 잡는다.
4. **대소문자만 다른 경로는 다른 항목이다.** `locKey`는 대소문자를 구별한다(O8). Windows·macOS에서 같은 파일을 다른 대소문자로 두 번 담는 경우는 드물어 받아들인다(미결 — §10 '미결').
5. **`useDnd.over`.** 대상은 `enter()`에서 `over`를 정하고 `onDrop`은 `endDrag()`로 지운다(`dnd.ts:126`). OS 드롭도 같은 경로를 탄다. 따로 정리하지 않는다.
6. **O6 가드의 조건.** `useDnd.getState().items === null`이고 `Array.from(e.dataTransfer.types).includes('Files')`일 때만 `dropEffect = 'none'`이다. 앱 안 드래그의 `dropEffect`를 덮으면 안 된다(대상 밖에서 `none`이 되어 버린다). 놓기 대상은 `enter()`에서 `stopPropagation`하므로 document 리스너는 대상 밖의 이벤트만 본다 — 이 전제가 깨지면(대상이 전파를 멈추지 않으면) 대상 위 커서가 `none`이 된다. 전제는 Test-877이 `installDropGuard`를 켠 채로 지킨다.
7. **`ipcMain.handle`은 인자를 믿지 않는다.** 렌더러가 보낸 배열의 원소는 문자열이 아닐 수 있다(핸들러는 `unknown`으로 받아 `Array.isArray`로 확인하고, `statEntries(paths: unknown[])`가 원소마다 `typeof === 'string'`을 확인한다).
8. **새 채널은 3곳 + 테스트.** `index.d.ts`의 `InvokeChannel` 누락은 `shelveOsFiles`가 `window.api.invoke('local:stat', …)`를 부르는 순간 `npm run typecheck`가 잡는다. `INVOKE_CHANNELS` 누락은 렌더러 테스트가 `window.api`를 목으로 바꾸므로 Test-873과 R3로만 잡힌다.

---

## 5. 기각한 대안

- **폴더를 펼쳐 안의 파일을 모두 담기** — 수천 개 항목이 선반을 덮고, 전송은 어차피 main이 폴더를 재귀로 계획한다. 기각(O2, 사용자 결정).
- **`File.size === 0 && !File.type`으로 폴더를 짐작해 `local:stat` 없이 담기** — `dropOsFiles`의 방식. 크기·수정 시각이 없어 선반 합계·정렬이 틀리고 빈 파일을 폴더로 본다. 기각(O3).
- **`local:list(부모)` 후 이름으로 고르기** — 항목마다 부모 폴더 전체를 읽는다(큰 폴더에서 느리다). 기각.
- **`stat` 실패가 하나라도 있으면 전체 실패** — 4개 중 1개가 읽히지 않는다고 나머지를 버릴 이유가 없다. 기각(O4).
- **O6를 `AppShell` 루트 핸들러에 두기** — 루트 밖 포털(Radix 등 `body`로 나가는 오버레이)은 안 덮고, 곧 `collapsible-sidebars.md`·`split-view.md`가 재구성할 `AppShell.tsx`에 충돌 지점을 더하며, 테스트가 `AppShell` 전체 렌더를 요구한다. document 리스너는 이미 있고 포털까지 덮으며 순수 함수처럼 단독 테스트된다. 기각(O6).
- **O6를 하지 않기(복사 커서를 그대로 둠)** — 가능한 선택이고 가장 작다. 다만 정보 탭 중 레일 대부분이 대상이 아니라 "여기에 놓아도 된다"는 거짓 신호가 남는다. 사람이 정할 일이라 §10 '미결'에 올린다.
- **레일에 마우스를 올리면 정보 본문도 대상으로** — Test-808의 "세그먼트만"을 깨고 정보 패널에 놓기 대상 상태가 생긴다. 금지 커서로 충분하다. 기각(O6·O7).
- **접힌 레일 가장자리에 호버하면 펼치기** — `collapsible-sidebars.md`의 몫이다. 기각(O7).
- **경로 대소문자 접기로 중복 제거** — 플랫폼별 규칙이 `locKey` 밖에 생긴다. O8과 충돌. 기각(후속).

---

## 6. i18n

새 키는 **1개**(복수형). `en.ts`에 넣고 나머지 10개 로캘에 번역해 넣는다. `ru.ts`는 `_few`·`_many`까지. 기존 `i18n.test.ts`가 자리표시자와 복수 범주를 이미 검사하므로 새 테스트는 없다.

| 키                             | 영어                                       |
| ------------------------------ | ------------------------------------------ |
| `toast.shelfDropSkipped_one`   | `{{count}} dropped item couldn't be read`  |
| `toast.shelfDropSkipped_other` | `{{count}} dropped items couldn't be read` |

호출은 `t('toast.shelfDropSkipped', { count })`. 위치는 `en.ts:419`(`toast.alreadyOnShelf`) 근처. 기존 키 `toast.alreadyOnShelf`·`shelf.dropHere`·`send.folderContents`·`menu.shelfEmpty`는 그대로 쓴다.

---

## 7. 테스트 케이스 리스트 (확정)

`Test-870~883`. 각 테스트에 `// covers: Test-N` 주석. **1:1 매핑.** 다음 빈 번호는 884(`Test-870~889`가 이 스펙의 예약 구간이다).
renderer 컴포넌트 테스트는 첫 줄에 `/** @vitest-environment jsdom */`, `vi.stubGlobal('api', makeApiMock(...))`(`rendererTestUtils.ts`). OS 드롭 이벤트는 `fireEvent.drop(el, { dataTransfer: { types: ['Files'], files: [file], dropEffect: '' } })` 형태(Test-811과 같다). main 테스트는 실제 임시 폴더(`fs.mkdtemp`)를 쓴다.

### A. main: `statEntries` · `local:stat` (node)

| #        | 파일                                     | 케이스                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Test-870 | `src/main/local/LocalFileSystem.test.ts` | `statEntries([파일, 끝 구분자를 붙인 폴더 경로, 'p.JPG'])`: **입력 순서대로** `LocalFileEntry`를 돌려준다. `path`는 `path.resolve`된 값(끝 구분자 없음, 폴더 경로가 `path.join(tmp,'sub')`와 같다), `name`은 basename, `type`은 `file`/`directory`, `size`는 `stat.size`, `modifiedAt`은 `stat.mtime.toISOString()`. `p.JPG`는 `isImage: true`, **이름이 `x.jpg`인 폴더는 `isImage: false`**. 폴더의 하위 파일은 결과에 없다. 루트(`path.parse(tmp).root`)는 `name`이 비지 않고 경로 전체다 |
| Test-871 | `src/main/local/LocalFileSystem.test.ts` | 읽을 수 없는 입력은 **던지지 않고 빠진다**: 없는 경로, 상대 경로(`'rel/x.txt'`), 빈 문자열, 문자열이 아닌 값(`42`, `null`)이 섞여 있어도 읽을 수 있는 것만 순서대로 돌려준다. 전부 읽을 수 없으면 `[]`. 빈 배열 입력도 `[]`                                                                                                                                                                                                                                                                 |
| Test-872 | `src/main/ipc/localFsHandlers.test.ts`   | `local:stat` 핸들러가 등록되어 있고 `[파일, 없는 경로]`에 `{ success: true, data: [파일 항목] }`을 돌려준다. 배열이 아닌 인자(`'x'`)는 던지지 않고 정확히 `{ success: false, error: 'paths must be an array' }`                                                                                                                                                                                                                                                                             |
| Test-882 | `src/main/local/LocalFileSystem.test.ts` | 심볼릭 링크는 가리키는 대상으로 판정한다(O4): 임시 폴더 안 `sub`를 가리키는 링크를 `fs.symlink(sub, link, 'junction')`로 만든다(POSIX는 세 번째 인자를 무시하고, Windows는 권한 없이 만들어지는 정션이라 `skip`이 필요 없다). `statEntries([link])`는 `type: 'directory'`이고 `path`는 링크 경로다. `lstat` 구현은 링크를 `file`로 보므로 이 케이스에서 RED가 된다                                                                                                                          |

### B. preload (`src/preload/index.test.ts`)

| #        | 케이스                                                                                                                                                                                                            |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Test-873 | `local:stat`이 허용되어 `ipcRenderer.invoke('local:stat', ['C:\\a'])`로 그대로 간다(Test-770과 별도의 새 `it`; Test-770의 네 채널 목록은 건드리지 않는다). 허용 목록에 없는 채널은 던지는 기존 단언은 그대로 둔다 |

### C. 렌더러 `shelveOsFiles` (`src/renderer/src/lib/sendItems.test.ts`, 신규, jsdom)

`vi.mock('sonner', …)`(`Shelf.test.tsx` 상단과 같다)로 토스트를 가로챈다. 각 테스트 전에 `useShelfStore.setState({ items: [], railTab: 'info' })`.

| #        | 케이스                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Test-874 | 파일 `a.jpg`와 폴더 `docs`를 놓으면: `getPathForFile`이 **`await` 전에 동기로** 파일 수만큼 불리고(반환 프로미스를 기다리기 전에 단언), `local:stat`이 **한 번** `[['C:\\in\\a.jpg','C:\\in\\docs']]`(드롭 순서)로 불린다. 선반 항목은 그 순서의 `fromLocalEntry`이고 `docs`는 `type: 'directory'` **항목 하나**(`local:list`·`local:expandForUpload` 호출 없음). `railTab`은 `'shelf'`가 된다. 반환값은 새로 담은 수 2. 빈 `files`는 `local:stat`을 부르지 않고 0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Test-875 | 중복은 `locKey`로 거른다: 이미 선반에 있는 같은 경로(앞서 Shift+S/앱 안 드래그로 담은 항목과 같은 로컬 경로)는 다시 담지 않고, 같은 드롭 안의 같은 경로 둘도 하나만 담는다. **전부 중복**(읽을 수 없는 항목 없음)이면 `toast('Already on the shelf')` 한 번이고 `railTab`은 바뀌지 않는다. **일부만 중복**이면 새것만 담고 토스트는 없다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Test-876 | 실패 처리 — (a) `getPathForFile`이 빈 문자열인 파일은 건너뛰고 `local:stat` 인자에서 빠진다. 모두 빈 문자열이면 `local:stat`을 **부르지 않고** `toast`(기본 호출, `toast.error` 아님)가 `1 dropped item couldn't be read` 형식(count = 파일 수)으로 **한 번**, 선반 변화 없음. (b) 결과가 요청보다 적으면(예: 3개 요청에 2개) 읽은 2개는 담고 `toast('1 dropped item couldn't be read')` 한 번(`toast.error` 아님). (c) `success: false, error: 'boom'`은 아무것도 담지 않고 `toast.error('N dropped items couldn't be read', { description: 'boom' })`(N = 파일 수, 기본 `toast`는 호출되지 않음). (d) `invoke`가 `new Error('ipc down')`로 reject해도 던지지 않고 `toast.error(…, { description: 'ipc down' })`; `invoke`가 문자열 `'x'`로 reject하면 `description: 'x'`. (e) 3개 중 1개가 읽히지 않고(결과 2개) 읽은 2개가 **모두 이미 선반에 있으면** `toast('1 dropped item couldn't be read')`가 먼저, `toast('Already on the shelf')`가 다음으로 **둘 다** 호출된다(호출 순서 단언) |

### D. 선반·레일·드롭 가드 (jsdom)

| #        | 파일                                                     | 케이스                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Test-877 | `components/shelf/Shelf.test.tsx`                        | **빈 선반과 채운 선반 둘 다** OS 파일(`types: ['Files']`)을 받는다: `dragOver`가 `dropEffect = 'copy'`로 두고 기본 동작을 막으며(`fireEvent` 반환값 false), 빈 선반은 `Drop here` 문구를 보인다. `drop`하면 `getPathForFile` 경로로 `local:stat`이 불리고 선반 이름에 항목이 늘며 `useDnd.over`가 `null`이다. **마지막 단언은 `<AppShell/>`을 렌더하고 테스트 안에서 `installDropGuard(document)`를 켠 채로 한다**(`afterEach`에서 해제): 선반 놓기 영역의 `dragOver` 뒤에도 `dropEffect === 'copy'`다 — 대상이 전파를 멈춰 document 가드가 `none`으로 덮지 않는다(함정 6)                                                                              |
| Test-878 | `components/shelf/Shelf.test.tsx`                        | 선반이 받지 말아야 할 드래그: `Files`가 없고 앱 안 항목(`useDnd.items`)도 없는 드래그(`types: ['text/plain']`)는 `dragOver`를 막지 않고(`fireEvent` 반환값 true, `dropEffect` 그대로) `drop`해도 `local:stat`이 불리지 않고 선반이 그대로다. 앱 안 드래그(`useDnd.items`)는 지금처럼 선반에 항목을 더하고 `local:stat`을 부르지 않는다(회귀)                                                                                                                                                                                                                                                                                                            |
| Test-879 | `components/layout/RightRail.test.tsx`                   | (파일 상단에 `Shelf.test.tsx`와 같은 `vi.mock('sonner', …)`를 더한다.) 정보 탭을 보는 동안: "선반" 세그먼트에 OS 파일을 놓으면 `dropEffect = 'copy'`로 받고, 담긴 뒤 `railTab`이 `'shelf'`가 되고 세그먼트 수가 는다. 전부 중복이면 정보 탭에 머물고 `toast('Already on the shelf')`만 보인다. 정보 본문(`region`)은 대상이 아니다: `fireEvent.dragOver(region, …)`가 `true`를 돌려주고(이 컴포넌트가 기본 동작을 막지 않음) `dropEffect`가 그대로이며, `fireEvent.drop(region, …)`해도 `local:stat`이 불리지 않는다                                                                                                                                    |
| Test-880 | `src/renderer/src/lib/osDropGuard.test.ts` (신규, jsdom) | `installDropGuard(document)`(O6): (a) `useDnd.items`가 null일 때 `types: ['Files']`의 `dragover`는 기본 동작이 막히고(`fireEvent` 반환값 false) `dropEffect === 'none'`. (b) `types: ['text/plain']`(`Files` 없음)이고 앱 안 드래그도 없으면 기본 동작은 막히지만 `dropEffect`는 그대로(기존 `main.tsx:9~10` 동작 보존). (c) `useDnd.items`가 있으면(앱 안 드래그) `types: ['Files']`여도 `dropEffect`를 건드리지 않는다. (d) `drop`은 항상 기본 동작이 막힌다. (e) 전파를 멈추는 요소 안에서 일어난 `dragover`는 가드에 닿지 않아 `dropEffect`가 그대로다(놓기 대상의 모사). (f) 반환된 해제 함수를 부르면 이후 `dragover`는 기본 동작이 막히지 않는다 |
| Test-881 | `components/shelf/Shelf.test.tsx`                        | OS 폴더를 놓아 담은 선반이 보이고 내려놓을 수 있다: 폴더 행의 `aria-label`이 `{이름}, This PC, + folder contents`, 합계 크기는 폴더를 더하지 않는다(파일만). 원격 탭에서 `Upload …` 버튼(또는 Enter)을 누르면 `transfer:send`가 `{ direction: 'upload', sources: [폴더 경로], destDir }`로 나가고 성공하면 선반이 빈다(Test-807과 같은 흐름). 로컬 탭이면 `local:copyFiles`로 간다                                                                                                                                                                                                                                                                      |
| Test-883 | `src/renderer/src/lib/osDropGuard.test.ts`               | `main.tsx`가 가드를 실제로 켠다(계약): 파일을 `node:fs`로 읽어 `installDropGuard(document)`가 정확히 한 번 있고, `addEventListener('dragover'`·`addEventListener('drop'` 직접 호출은 없다. (`main.tsx`는 부트스트랩이라 import하면 앱이 렌더되므로 소스 문자열로만 고정한다. 가드 동작 자체는 Test-880이 본다)                                                                                                                                                                                                                                                                                                                                          |

테스트 번호 합계: Test-870~883(14개). Test-811·840(탐색기·탭·사이드바 등 위치 대상의 OS 드롭)은 **그대로 통과해야 한다.**

---

## 8. 구현 슬라이스

| 슬라이스                            | 의존 | 맡는 파일                                                                                                                                                                                                      | 맡는 테스트  | 끝 확인                                                                                                                        |
| ----------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| **S1 main + 채널 3곳**              | —    | `src/main/local/LocalFileSystem.ts`(`statEntries`), `src/main/ipc/localFsHandlers.ts`(`local:stat`, `LocalFileEntry` 타입 import 추가 — 값 import는 없다), `src/preload/index.ts`·`index.d.ts`·`index.test.ts` | 870~873, 882 | 개발 앱 DevTools(`npm run dev -- -- --devtools`)에서 `await window.api.invoke('local:stat', ['<절대경로>'])`가 항목을 돌려준다 |
| **S2 렌더러 배선 + i18n**           | S1   | `src/renderer/src/lib/sendItems.ts`(`shelveOsFiles`), `src/renderer/src/lib/sendItems.test.ts`(신규), `components/explorer/dnd.ts`(두 곳), `i18n/locales/*.ts` 11개(`toast.shelfDropSkipped`)                  | 874~879, 881 | 개발 앱에서 선반이 OS 파일을 받는다(R3 (c))                                                                                    |
| **S3 드롭 가드 (O6, 사람 확인 뒤)** | —    | `src/renderer/src/lib/osDropGuard.ts`·`osDropGuard.test.ts`(신규), `src/renderer/src/main.tsx`(`:9~10` 두 줄을 `installDropGuard(document)` 한 줄로)                                                           | 880, 883     | 대상 없는 곳에서 금지 커서(R3 (d)). Test-877의 마지막 단언은 S3의 `installDropGuard`를 쓰므로 S3 뒤에 GREEN이 된다             |

`localFsHandlers.ts`에는 `isAbsolute`를 import하지 않는다 — 절대 경로 판정은 `statEntries`가 `LocalFileSystem.ts`의 기존 `path` import로 한다(import가 안 쓰이면 `npm run lint`가 실패한다).

`multi-connection.md`와 `split-view.md`는 `sendItems.ts`·`dnd.ts`·`AppShell.tsx`를 크게 고칠 것으로 예상되고(두 문서는 이 스펙 작성 시점에 없다), `collapsible-sidebars.md`는 `AppShell.tsx`·`RightRail.tsx`를 고친다. 이 스펙의 소스 변경은 **`dnd.ts` 두 곳(합쳐 3줄), `sendItems.ts`에 함수 하나 추가, `main.tsx` 두 줄, 신규 파일**로 한정해 병합 충돌을 줄인다 — O6를 `main.tsx`에 둔 이유 중 하나가 `AppShell.tsx`를 피하는 것이다. 테스트 파일은 `RightRail.test.tsx`(collapsible-sidebars도 만진다)·`Shelf.test.tsx`에 케이스를 더하므로 그 부분만 병합한다. 어느 쪽이 먼저 들어와도 되고, 나중 쪽이 위치를 다시 확인한다.

---

## 9. 완료 기준

1. Test-870~883이 GREEN이고 기존 스위트 전체(특히 Test-770·808·811·840)가 GREEN이다(실행 출력으로 확인).
2. 각 테스트에 `covers: Test-N` 주석. `test.skip`·`.only`·빈 테스트 없음.
3. `npm run typecheck` · `npm run lint` 통과, 바꾼 파일에 `npx prettier --check` 통과. `npm run build:unpack` 후 `npm run smoke:packaged` 통과(CI와 같은 경로).
4. `stryker.config.json`의 `mutate`에 이번 변경분을 **더한다**(다른 스펙이 이미 들어와 있으면 그 항목을 지우지 말고 병합한다 — 형제 스펙이 각자 `mutate`·`_comment_scope`를 새로 쓰면 서로 덮어쓴다). `break: 70` 통과. 바뀐 범위만(`git diff --unified=0 -- <file> | grep '^@@'`):
   `src/main/local/LocalFileSystem.ts`(`statEntries`), `src/main/ipc/localFsHandlers.ts`(`local:stat` 핸들러 — try/catch 없이 `Array.isArray` 가드와 `localFs.statEntries` 호출뿐이고, 가드 문구는 Test-872가 정확한 텍스트로 고정한다), `src/renderer/src/lib/sendItems.ts`(`shelveOsFiles`), `src/renderer/src/lib/osDropGuard.ts`(통째로). 컴포넌트는 넣지 않는다. `_comment_scope`는 기존 문장 뒤에 이 범위를 덧붙인다.
5. 이 문서 끝에 R3 실측 결과 표를 붙인다.
6. `docs/handoff/explorer-shelf.md`는 고치지 않는다(이력 문서). `CLAUDE.md`의 IPC 안내(`IPC_CHANNELS`는 쓰이지 않는 목록)는 그대로다.

### R3 실측 계획

jsdom은 실제 OS 드롭과 금지 커서를 재현하지 못한다. CDP로 합성한 `DragEvent`의 `File`은 실제 경로가 없어 `getPathForFile`이 빈 문자열을 준다. 따라서 **진짜 OS 드롭은 손으로**, 나머지는 CDP로 확인한다(`explorer-shelf.md` §14 R3 계획과 같은 앱 구동 방식: `unset ELECTRON_RUN_AS_NODE` 후 `npm run dev -- -- --devtools` 또는 `npm run build:unpack` + `--remote-debugging-port`).

| 항목                  | 방법   | 확인 내용                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) `local:stat` 실물 | CDP    | `window.api.invoke('local:stat', [...])`에 실제 파일·폴더·끝 구분자 붙인 폴더·없는 경로·상대 경로·**폴더를 가리키는 심볼릭 링크**(Test-882의 실제 앱 확인)를 넣어 모양(순서, `type`, `isImage`, 빠진 항목)을 본다. 패키지 앱에서 허용 목록 누락이 없는지(`IPC channel not allowed` 없음)도 이 한 번으로 확인                                                                                                                                          |
| (b) 경로 없는 파일    | CDP    | `new DataTransfer()`에 `new File(...)`을 넣어 선반에 합성 `drop`을 보내면 "1 dropped item couldn't be read" 토스트, 선반 변화 없음                                                                                                                                                                                                                                                                                                                    |
| (c) 파일·폴더 담기    | **손** | Finder(macOS)/탐색기(Windows)에서 파일 3개 + 폴더 1개를 선택해 빈 선반에 놓기 → 4개가 담기고 폴더는 "+ folder contents" 하나. 같은 것을 다시 놓기 → "Already on the shelf". 새 파일 하나만 섞어 놓기 → 그것만 늘고 토스트 없음                                                                                                                                                                                                                        |
| (d) 정보 탭·금지 커서 | **손** | 레일을 정보 탭으로 두고 "선반" 세그먼트에 놓기 → 선반 탭으로 바뀌며 담김. 정보 본문·사이드바 빈 곳·경로 막대 빈 곳 위로 OS 파일을 끌 때의 **커서 모양**을 본다. **먼저 O6 적용 전 빌드(기준선)에서 복사 커서가 뜨는지 기록**해 이 스펙의 전제(코드로 추정한 것)를 확인하고, S3 적용 뒤에는 금지 커서가 뜨고 놓아도 아무 일도 없음을 확인한다. 창이 파일로 이동하지 않는 것은 `main.tsx:9~10` 덕에 기준선에서도 이미 성립한다(O6가 만든 효과가 아니다) |
| (e) 담은 뒤의 전송    | **손** | 담은 OS 폴더를 원격 탭에 내려놓기 → 하위 폴더까지 업로드(`explorer-shelf.md` R3 (d)와 같은 경로). 로컬 탭에 내려놓기 → 복사(같은 이름이면 충돌 시트)                                                                                                                                                                                                                                                                                                  |
| (f) 썸네일·크기       | **손** | 이미지 파일의 선반 썸네일이 뜬다(`localThumbnail:request`). 크기 합계가 파일만 더한다                                                                                                                                                                                                                                                                                                                                                                 |
| (g) 가상 파일         | **손** | 압축 파일 안의 파일·메일 첨부·웹 브라우저의 이미지를 끌어 놓기 → 경로가 없으면 토스트(어느 환경에서 경로가 없는지 기록)                                                                                                                                                                                                                                                                                                                               |
| (h) 많은 항목         | **손** | 수백 개 파일을 한 번에 놓기 → 선반이 곧 갱신되고 UI가 멈추지 않음                                                                                                                                                                                                                                                                                                                                                                                     |
| (i) 접힌 레일         | **손** | `collapsible-sidebars.md` 구현 뒤에만: 레일을 접은 상태에서 놓기 → 금지 커서(S3 적용 시), 창 이동 없음, 레일이 저절로 펼쳐지지 않음                                                                                                                                                                                                                                                                                                                   |
| (j) 회귀              | **손** | 탐색기 영역·폴더 타일·탭·사이드바 장소에 OS 파일 놓기(업로드·복사)는 그대로 된다. 앱 안 드래그의 선반 담기·탭 스프링도 그대로                                                                                                                                                                                                                                                                                                                         |

---

## 10. 위험과 후속 과제

### 미결 (사람 확인 필요 — 권장안 적용 중)

사람이 승인하기 전까지 아래 셋은 이 스펙이 자체로 정한 것이다. 테스트가 O6·O9를 고정하고 있으므로 바꾸면 해당 테스트를 함께 바꿔야 한다.

| #    | 질문                                                                                                                                           | 권장안(적용됨)                                                                | 거절하면                                                                                                                     |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| O6   | 대상이 아닌 곳을 지나는 OS 파일 드래그에 **금지 커서**를 앱 전역(document 리스너)으로 보일까? §C가 요구한 적 없는 앱 전체 드래그 커서 변경이다 | 보인다. 기존 `main.tsx:9~10` 리스너를 `installDropGuard`로 확장(Test-880·883) | S3·Test-880·883과 R3 (d)의 커서 확인을 뺀다. 나머지 O1~O5·O7~O9는 그대로. Test-877의 마지막 단언은 가드 없이 `'copy'`만 확인 |
| O9   | 읽을 수 없는 드롭 항목을 토스트로 알릴까, 조용히 둘까? 새 로캘 키 1개가 든다                                                                   | 알린다. `toast.shelfDropSkipped`(Test-876)                                    | `shelveOsFiles`의 토스트 호출과 i18n 키·Test-876을 뺀다(빠진 수는 반환값으로만)                                              |
| 접기 | 대소문자만 다른 경로를 같은 항목으로 볼까?                                                                                                     | 보지 않는다(O8의 `locKey` 그대로, 함정 4). 플랫폼별 접기 규칙은 후속 과제     | 대소문자 접기를 `locKey` 밖에 두는 별도 스펙이 필요하다                                                                      |

### 위험

- **대소문자만 다른 경로는 중복으로 안 걸러진다**(함정 4). 사용자가 PathBar에 소문자로 친 경로의 탭에서 담은 항목과 Finder에서 끌어 온 실제 경로가 Windows에서 다를 수 있다. 드물고 무해하다(같은 파일을 두 번 보내면 충돌 시트가 묻는다).
- **O6 가드는 앱 전역 `dragover`의 `dropEffect`를 바꾼다.** 창이 파일로 이동하는 문제는 `main.tsx:9~10`이 이미 막고 있으므로 이 스펙의 위험이 아니다. 위험은 놓기 대상이 `stopPropagation`을 빠뜨리면 그 대상 위 커서가 `none`이 된다는 점이다(함정 6, Test-877이 선반에 대해 고정; 다른 대상은 Test-811·840과 R3 (j)). 또 금지 커서가 실제로 보이는지는 OS 드래그 세션이 정하므로 R3 (d)가 유일한 확인이다.
- **심볼릭 링크는 가리키는 대상으로 판정한다**(`fs.stat`, Test-882). `local:list`는 링크 항목을 `dirent`로 보므로 같은 링크가 탐색기에서는 파일, 선반에서는 폴더로 보일 수 있다. 업로드 계획(`folderPlan.ts:205`)과는 일치한다.
- **가상 파일은 담을 수 없다.** 경로가 없는 드롭은 토스트로만 알린다(O9).

**후속 과제(이번 범위 밖)**: `dropOsFiles`의 "크기 0·형식 없음 = 폴더" 짐작을 `local:stat`으로 대체, 경로 대소문자 접기 중복 제거, 레일 접힘 상태에서의 호버 펼치기(`collapsible-sidebars.md`).

---

## 11. 관련 코드 포인터

| 파일                                                                                                                                                 | 역할                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`renderer/.../components/explorer/dnd.ts`](../../src/renderer/src/components/explorer/dnd.ts)                                                       | `useDropTarget`: `hasFiles`(:73), `valid`(:88), `onDragOver`(:114~119, 선반 제외 조건 :118), `onDrop`(:120~134, 조기 반환 :123, OS 가지 :127~128)                             |
| [`renderer/.../lib/sendItems.ts`](../../src/renderer/src/lib/sendItems.ts)                                                                           | `dropShelf`(:200), `dropOsFiles`(:234, 동기 `getPathForFile`, 폴더 짐작 :240). `shelveOsFiles`는 그 옆에 둔다                                                                 |
| [`renderer/.../stores/useShelfStore.ts`](../../src/renderer/src/stores/useShelfStore.ts)                                                             | `add`(:24, `locKey` 중복 제거, 레일을 선반으로)                                                                                                                               |
| [`renderer/.../lib/explorerEntry.ts`](../../src/renderer/src/lib/explorerEntry.ts)                                                                   | `locKey`(:69), `fromLocalEntry`(:111), `toEntry`(:86)                                                                                                                         |
| [`renderer/.../components/layout/RightRail.tsx`](../../src/renderer/src/components/layout/RightRail.tsx)                                             | `ShelfSegment`(:13~40, 정보 탭일 때만 대상 :15)                                                                                                                               |
| [`renderer/.../components/shelf/Shelf.tsx`](../../src/renderer/src/components/shelf/Shelf.tsx)                                                       | `useDropTarget('shelf','shelf')`(:157), `EmptyShelf`(:110), 채운 선반의 놓기 영역(:174~184)                                                                                   |
| [`renderer/.../main.tsx`](../../src/renderer/src/main.tsx)                                                                                           | document `dragover`·`drop` 리스너(:9~10, 주석 :8) — 창 이동은 이미 막혀 있다. O6가 이것을 `installDropGuard`로 바꾼다                                                         |
| [`renderer/.../components/layout/AppShell.tsx`](../../src/renderer/src/components/layout/AppShell.tsx)                                               | 루트 `onDragOver`·`onDragLeave`(:111~114)는 `over`만 지운다. 이 스펙은 소스를 바꾸지 않는다(놓기 대상은 전파를 멈춘다 — 함정 6)                                               |
| [`main/ipc/localFsHandlers.ts`](../../src/main/ipc/localFsHandlers.ts)                                                                               | `local:list`(:72), `local:getPlaces`(:88), `local:preview`(:108). `stat`은 이미 import됨(:2). 타입만 `LocalFileEntry`를 :10 import에 더한다. `isAbsolute`는 import하지 않는다 |
| [`main/local/LocalFileSystem.ts`](../../src/main/local/LocalFileSystem.ts)                                                                           | `list`(:9, `path.join` 경로 :17), `collectFiles`(:54). `statEntries`는 여기에 둔다                                                                                            |
| [`main/transfer/folderPlan.ts`](../../src/main/transfer/folderPlan.ts)                                                                               | `planUpload`(:198~, `outermost` :204, `stat` :205) — 선반의 OS 폴더가 전송 때 펼쳐지는 곳                                                                                     |
| [`preload/index.ts`](../../src/preload/index.ts) · [`index.d.ts`](../../src/preload/index.d.ts) · [`index.test.ts`](../../src/preload/index.test.ts) | `INVOKE_CHANNELS`(:22~32 Local FS 묶음), `InvokeChannel`(:18~28), `getPathForFile`(index.ts:115), Test-770 형식(index.test.ts:138~148)                                        |
| [`renderer/.../components/explorer/Explorer.test.tsx`](../../src/renderer/src/components/explorer/Explorer.test.tsx)                                 | Test-811(:430)·Test-840(:455) — OS 드롭 이벤트 합성 방식(`dt({ types: ['Files'], files })`)과 `getPathForFile` 목                                                             |
| [`renderer/.../components/layout/RightRail.test.tsx`](../../src/renderer/src/components/layout/RightRail.test.tsx)                                   | Test-808(:27~28) — 정보 탭 세그먼트 드롭 테스트(이 스펙의 Test-879가 같은 파일에 더해진다)                                                                                    |
| [`renderer/.../test/rendererTestUtils.ts`](../../src/renderer/src/test/rendererTestUtils.ts)                                                         | `makeApiMock`(`getPathForFile` 목 포함), `invokeCalls`                                                                                                                        |
| [`renderer/.../i18n/locales/en.ts`](../../src/renderer/src/i18n/locales/en.ts)                                                                       | `shelf.*`(:344~351), `toast.alreadyOnShelf`(:419)                                                                                                                             |
