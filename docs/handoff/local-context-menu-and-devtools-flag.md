# 핸드오프: 로컬 컨텍스트 메뉴 + `--devtools` 플래그 강제

R1에서 인간과 합의한 내용의 고충실도 기록. R2(테스트 코드 작성)·구현의 유일한 입력이다.
이 문서에 없는 케이스는 완료 범위 밖이다. 새 케이스를 추가하거나 기존 케이스를 재해석하지 말 것.

작업 유형(R0): **버그 2건**. 각각 재현하는 RED 회귀 테스트를 먼저 세운 뒤 GREEN으로 만든다.

---

## 1. 문제 정의

### 버그 A — 로컬 파일 섹션에서 우클릭이 먹히지 않는다

로컬 패널의 두 뷰([`LocalFileList.tsx`](../../src/renderer/src/components/local/LocalFileList.tsx),
[`LocalFileGridView.tsx`](../../src/renderer/src/components/local/LocalFileGridView.tsx))에는
`onContextMenu` 핸들러도, 컨텍스트 메뉴 컴포넌트도 **아예 존재하지 않는다**.

여기에 [`main.tsx:14-18`](../../src/renderer/src/main.tsx#L14-L18)의 document 레벨 리스너가
Shift+우클릭이 아닌 모든 우클릭에 `preventDefault()`를 걸어 네이티브 메뉴까지 차단한다.
따라서 로컬 패널 우클릭은 앱 메뉴도 네이티브 메뉴도 뜨지 않는 완전 무반응이 된다.

원격 패널은 같은 자리에 구현이 있다 —
[`FileListView.tsx:78-86`](../../src/renderer/src/components/remote/FileListView.tsx#L78-L86)의
`handleContextMenu`가 [`FileContextMenu.tsx`](../../src/renderer/src/components/remote/FileContextMenu.tsx)를 띄운다.
즉 이 버그는 "로컬 쪽 미구현"이며, 원격 구현이 따라야 할 레퍼런스다.

### 버그 B — `--devtools` 없이도 inspect가 활성화된다

[`debug.ts:16-19`](../../src/shared/debug.ts#L16-L19):

```ts
export function isDebugEnabled(argv: readonly string[], isPackaged: boolean): boolean {
  if (!isPackaged) return true // ← dev 빌드는 플래그와 무관하게 항상 debug on
  return argv.includes(DEVTOOLS_FLAG)
}
```

`./script/run.ps1`을 플래그 없이 실행해도 F12·Ctrl+Shift+C·Shift+우클릭 Inspect가 모두 살아 있다.
이 동작은 [`AGENTS.md:24`](../../AGENTS.md#L24)에 "dev 빌드는 플래그 없이도 항상 활성"으로 문서화되어 있고,
`debug.test.ts`의 `Test-3`이 이를 고정하고 있다. 둘 다 뒤집어야 한다.

---

## 2. 핵심 결정 (R1에서 인간이 확정)

| #   | 결정                                                                                                                                | 근거                                                                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| D1  | 로컬 메뉴는 **원격과 동일 수준**: Upload / Rename / Delete / New Folder / Properties                                                | 두 패널의 조작 대칭성. 축소판은 "우클릭이 먹힌다"는 체감을 주지 못함                                                       |
| D2  | Upload 대상은 **원격 패널의 현재 경로**(`useFtpStore.currentPath`). 별도 원격 폴더 선택 UI 없음. FTP 미연결 시 Upload 항목을 숨긴다 | 원격 Download가 `local:selectSaveDirectory`로 폴더를 고르는 것과 비대칭이지만, 원격 디렉터리 피커가 없어 신규 UI 부담이 큼 |
| D3  | **신규 IPC 2개**: `local:rename`, `local:mkdir` (+ `LocalFileSystem.rename` / `mkdir`)                                              | Rename·New Folder에 필수. 현재 로컬 IPC는 delete/copy만 있음                                                               |
| D4  | `isDebugEnabled(argv, isPackaged)` → **`isDebugEnabled(argv)`** 로 파라미터 제거                                                    | `isPackaged` 분기가 사라지면 인자가 무의미해짐. 호출부는 `main/index.ts` 1곳뿐                                             |
| D5  | 로컬 Properties 필드: Name / Type / Location / Full Path / Size / Modified. **Permissions 제외**                                    | [`LocalFileEntry`](../../src/shared/types/local.ts)에 permissions 필드가 없음                                              |
| D6  | dev 빌드에서 `--devtools` 없으면 **F12·Ctrl+Shift+C·우클릭 Inspect 전부** 비활성                                                    | 패키징 빌드와 dev 빌드의 동작을 완전히 일치시킴                                                                            |
| D7  | 테스트 인프라로 **jsdom + @testing-library/react** 도입, vitest `include`에 `.tsx` 추가                                             | 버그 A의 본질이 컴포넌트 배선 누락이라, 순수 함수 테스트로는 RED 재현이 불가능                                             |

---

## 3. 기각한 대안

- **로컬 메뉴를 Delete만으로 최소 구현** — 변경은 작지만 "우클릭이 먹히지 않는다"는 원 증상을 절반만 해소한다. 기각.
- **기존 IPC만 써서 Rename·New Folder 생략** — main 프로세스를 안 건드리는 대신 원격과의 기능 비대칭이 남는다. 기각.
- **`FileContextMenu`를 원격/로컬 공용 컴포넌트로 일반화** — 두 패널은 스토어(`useFtpStore`/`useLocalFsStore`, `useSelectionStore`/`useLocalSelectionStore`), 경로 규칙(POSIX 고정 vs `joinLocalPath`의 OS 감지), 전송 방향이 모두 다르다. 공용화하면 분기투성이 컴포넌트가 된다. **별도 `LocalFileContextMenu`를 만들되 원격 구현의 시그니처·네이밍을 그대로 따른다.**
- **버그 B에서 우클릭 Inspect만 비활성** — TODO 문구에는 가깝지만 F12가 열리는 상태가 남아 "플래그 없이 개발자 도구가 열린다"는 문제가 지속된다. 기각(D6).
- **순수 로직만 추출해 테스트하고 배선은 수동 검증** — 회귀 방지력이 없다. 기각(D7).

---

## 4. 테스트 케이스 리스트 (확정)

`Test-42`부터 신규. 기존 최대 번호는 `Test-41`.
각 테스트 코드에 `covers: Test-N` 주석을 단다. **1:1 매핑. 케이스 추가·병합·재해석 금지.**

### A. 컨텍스트 메뉴 노출 (RTL)

Test-42·44~48은 **리스트 뷰**에서, Test-43·67~71은 **그리드 뷰**에서 검증한다.
두 뷰는 각자 독립된 배선 코드를 가지므로 같은 시나리오를 양쪽에서 확인한다.

- **Test-42** — 리스트 뷰에서 파일 행을 우클릭하면 컨텍스트 메뉴가 나타난다.
- **Test-43** — 그리드 뷰에서 셀을 우클릭하면 컨텍스트 메뉴가 나타난다.
- **Test-44** — (리스트) 항목이 없는 빈 공간을 우클릭하면 선택 없는 메뉴가 나타난다.
- **Test-45** — (리스트) 선택되지 않은 항목을 우클릭하면 그 항목이 단일 선택으로 전환된다.
- **Test-46** — (리스트) 다중 선택된 항목 중 하나를 우클릭하면 기존 선택이 유지된다.
- **Test-47** — (리스트) 메뉴 바깥을 클릭하면 메뉴가 닫힌다.
- **Test-48** — (리스트) debug 모드에서 Shift+우클릭은 앱 메뉴를 띄우지 않는다(네이티브 메뉴에 양보).
- **Test-67** — (그리드) 항목이 없는 빈 공간을 우클릭하면 선택 없는 메뉴가 나타난다.
- **Test-68** — (그리드) 선택되지 않은 항목을 우클릭하면 그 항목이 단일 선택으로 전환된다.
- **Test-69** — (그리드) 다중 선택된 항목 중 하나를 우클릭하면 기존 선택이 유지된다.
- **Test-70** — (그리드) 메뉴 바깥을 클릭하면 메뉴가 닫힌다.
- **Test-71** — (그리드) debug 모드에서 Shift+우클릭은 앱 메뉴를 띄우지 않는다.

### B. 메뉴 항목 구성

- **Test-49** — 선택이 디렉터리뿐이면 Upload 항목이 없다.
- **Test-50** — 다중 선택이면 Rename 항목이 없다.
- **Test-51** — 다중 선택이면 Delete 라벨에 개수가 표시된다.
- **Test-52** — 선택이 없으면 New Folder만 표시된다.
- **Test-53** — FTP 미연결이면 Upload 항목이 없다.

### C. 메뉴 동작

- **Test-54** — Delete → `local:deleteBatch`가 선택 항목의 경로·디렉터리 여부와 함께 호출된다.
- **Test-55** — `confirmBeforeDelete`가 켜진 상태에서 사용자가 취소하면 `local:deleteBatch`가 호출되지 않는다.
- **Test-56** — Rename 제출 → `local:rename`이 (기존경로, 새경로)로 호출된다.
- **Test-57** — 이름을 바꾸지 않거나 비우면 `local:rename`이 호출되지 않는다.
- **Test-58** — New Folder → **인라인 입력**에 이름을 넣고 제출하면 `local:mkdir`이 현재 경로 하위 경로로 호출된다.
- **Test-59** — Upload → 선택된 **파일마다** 원격 `currentPath` 기준으로 큐잉된다.
- **Test-60** — Properties → 이름·전체경로·크기·수정일이 표시된다.
- **Test-72** — Delete 후 `refresh()`가 호출되고 선택이 정리된다.
- **Test-73** — Rename 제출 후 `refresh()`가 호출된다.
- **Test-74** — New Folder 생성 후 `refresh()`가 호출된다.

Test-72~74는 주의점 7(목록 갱신 누락 회귀 방지)에 대응한다. 세 동작이 각각 독립된
코드 경로라 하나로 묶지 않고 분리했다.

### C-2. Properties 다이얼로그 (뮤테이션 결과로 추가)

Test-60만으로는 `LocalFilePropertiesDialog`의 뮤테이션 스코어가 20%에 그쳤다.
표시 필드만 보고 닫힘 동작과 분기를 전혀 단언하지 않았기 때문이다. 실제로 뮤테이션이
`onClick={(e) => e.stopPropagation()}`을 `() => undefined`로, `entry.type === 'file'`을
`true`로 바꿔도 죽는 테스트가 없었다. 닫히지 않는 다이얼로그는 사용자를 가둔다.

- **Test-75** — Escape 키를 누르면 Properties 다이얼로그가 닫힌다.
- **Test-76** — 오버레이(다이얼로그 바깥)를 클릭하면 닫힌다.
- **Test-77** — 다이얼로그 **내부**를 클릭해도 닫히지 않는다.
- **Test-78** — 타입 라벨이 항목 종류에 따라 달라진다(디렉터리 / 이미지 / 일반 확장자 / 확장자 없음).
- **Test-79** — 디렉터리에는 Size 행이 표시되지 않는다.

### C-3. 적대적 리뷰가 찾아낸 결함의 회귀 테스트

구현 리뷰에서 발견된 결함들이다. 전부 289 GREEN인 채로 통과하던 것들이라,
회귀 테스트 없이 고치면 같은 버그가 조용히 재발한다.

- **Test-80** — (그리드) 메뉴 항목을 마우스로 누를 때 마퀴 선택이 기존 선택을 지우지 않는다.

  메뉴는 `parentRef` div의 DOM 자식이라 `position: fixed`여도 이벤트는 그대로 버블링된다.
  메뉴 루트가 `onClick`만 막고 `onMouseDown`을 막지 않아, 메뉴 버튼을 누르면
  `onMarqueeMouseDown`이 실행되어 선택 전체가 비워졌다. 실측 결과 "Delete (3)"을 눌렀는데
  1건만 삭제되었다. **`contextMenu → mouseDown → click` 순서를 실제로 밟아야** 재현된다.
  `fireEvent.click`만으로는 잡히지 않는다.

- **Test-81** — IPC 호출이 reject해도 선택 정리·목록 갱신·메뉴 닫기가 보장된다.

  `await window.api.invoke(...)`가 reject하면(preload 화이트리스트 거부 등) 핸들러 전체가
  중단되어 `clearSelection()`·`refresh()`·`handleClose()`가 모두 건너뛰어졌다. 사용자는
  토스트도 못 보고 메뉴가 열린 채 멈춘 화면을 본다. `LocalExplorer.tsx`의 Delete 키 경로가
  이미 `try/catch/finally`로 이를 보장하므로, 두 경로가 갈리면 안 된다(주의점 2).

- **Test-82** — Rename에 경로 구분자가 든 이름은 거부되고 `local:rename`이 호출되지 않는다.

  `joinLocalPath`는 단순 문자열 접합이라 `..\other`를 걸러내지 않는다. 그대로 넘기면
  `fs.rename`이 **성공하여 파일이 현재 디렉터리 밖으로 조용히 이동**한다.
  `Target already exists` 가드는 최종 경로만 보므로 이를 막지 못한다.

- **Test-83** — New Folder에 경로 구분자가 든 이름은 거부되고 `local:mkdir`이 호출되지 않는다.

- **Test-84** — (원격) New Folder가 인라인 입력으로 `ftp:mkdir`을 호출한다.

  원격 패널도 같은 `window.prompt` 결함을 갖고 있어 함께 고친다(인간 게이트 승인).

- **Test-85** — Properties가 현재 디렉터리 경로를 Location으로 표시한다.

  D5는 Location을 표시 필드로 명시하지만 Test-60은 이름·전체경로·크기·수정일만 본다.
  뮤테이션에서 `useLocalFsStore((s) => s.currentPath)`를 `() => undefined`로 바꿔도
  아무 테스트가 죽지 않았다 — selector가 깨지면 Location이 조용히 사라진다.

- **Test-86** — `LocalFileSystem.rename`이 다른 디렉터리를 가리키는 `newPath`를 거부한다.

  §6은 이름 검증을 렌더러와 main **양쪽**에 두라고 요구한다. 렌더러 검증만으로는
  IPC를 직접 호출하는 경로에서 뚫리기 때문이다. 그런데 Test-82는
  "`local:rename`이 호출되지 않는다"로 **렌더러 반쪽만** 검증한다.
  즉 우회 경로를 막으려고 만든 방어층 자체가 미검증으로 남았다 — 뮤테이션에서
  가드를 `if (false)`로 지워도 죽는 테스트가 없다. 이 케이스가 그 층을 직접 겨냥한다.

- **Test-92** — `local:rename`·`local:mkdir` IPC 핸들러가 성공 시 `{ success: true }`를,
  실패 시 `ipcError`로 감싼 `{ success: false }`를 반환한다.

  핸들러 레이어(`localFsHandlers.ts`)가 커버리지 0%였다. 술어(Test-88)와
  `LocalFileSystem`(Test-61~65, 86)과 렌더러(Test-82/83/90)는 커버되는데
  그 사이를 잇는 `ipcMain.handle` + `ipcError` 래퍼만 비어 있었다.

- **Test-93** — 인라인 입력에 rename/newFolder 각각의 접근 가능한 라벨이 붙는다.

  스크린리더 사용자에게 노출되는 유일한 설명이다. 라벨이 사라지거나 두 모드가
  같은 문구를 쓰면 아무 테스트도 잡지 못했다.

- **Test-94** — 인라인 입력에서 Escape를 누르면 취소되고 IPC가 호출되지 않는다.

  §6이 "Enter로 제출, Escape로 취소한다"를 계약으로 명시하는데 대응 케이스가 없었다.
  Test-75는 Properties 다이얼로그의 Escape로, 다른 컴포넌트다.

- **Test-95** — (원격) 이름을 바꾸지 않거나 비우면 `ftp:rename`이 호출되지 않는다.

  Test-57의 원격 대응물.

- **Test-88** — 이름 검증 술어가 로컬·원격 각각의 규칙대로 거부/허용한다.

  로컬(`isSafeLocalName`)은 `/`·`\`·`:`·`.`·`..`·공백뿐인 이름을 거부한다.
  원격(`isSafeRemoteName`)은 `/`·`.`·`..`·공백뿐인 이름만 거부하고 `\`와 `:`는 **허용**한다.

  술어를 둘로 나눈 이유: 콜론은 NTFS에서 `foo:bar`가 `foo`의 대체 데이터 스트림을
  만들어 사용자가 만들려던 항목이 목록에 나타나지 않는다. 반면 `\`와 `:`는 POSIX·FTP
  파일명에서 합법이라, 하나의 술어로 묶으면 원격에서 서버가 받아줄 이름을 거부하게 된다.
  양쪽 다 "정상 이름 허용"을 반드시 단언한다 — 없으면 "항상 false" 뮤테이션이 살아남는다.

  이 술어는 이번 변경의 핵심 방어인데 직접 단위 테스트가 없어, 측정 범위를 정직하게
  넓히자 42.11%로 드러났다. Test-82/83은 렌더러를 경유한 간접 검증이라 술어 자체의
  경계 조건(공백만 있는 이름, 정상 이름 허용)을 고정하지 못한다.

- **Test-89** — (원격) Rename 제출 시 `ftp:rename`이 (기존경로, 새경로)로 호출된다.
- **Test-90** — (원격) 경로 구분자가 든 이름은 거부되고 IPC가 호출되지 않는다.
- **Test-91** — (원격) IPC가 `{ success: false }`를 반환하면 에러 토스트로 표면화된다.

  Test-89~91은 원격 패널에서 이번에 바꾼 90줄에 대한 안전망이다. `window.prompt` 제거와
  반환값 검사 추가가 Test-84 하나에만 의존하던 상태를 메운다.

- **Test-87** — IPC가 `{ success: false }`를 반환하면 에러 토스트로 표면화된다.

  실패를 조용히 삼키지 않는다는 것이 `toast.error`를 추가한 이유인데, 그 경로를
  검증하는 케이스가 없어 19개 뮤턴트가 생존했다. Test-81은 invoke가 **reject**하는
  경로만 다루고, `{ success: false }`로 **resolve**하는 정상 실패 경로는 별개다.

### D. main 파일시스템

[`LocalFileSystem.test.ts`](../../src/main/local/LocalFileSystem.test.ts)를 확장한다. 기존 tmpdir 패턴을 따를 것.

- **Test-61** — `rename`이 파일 이름을 바꾼다.
- **Test-62** — `rename`이 디렉터리 이름을 바꾼다.
- **Test-63** — 대상 이름이 이미 존재하면 덮어쓰지 않고 실패한다.
- **Test-64** — `mkdir`이 새 디렉터리를 만든다.
- **Test-65** — 이미 존재하는 이름으로 `mkdir` 시 실패한다.

### E. devtools 플래그

- **Test-3 (기존 케이스 단언 반전)** — dev 빌드 + `--devtools` 없음 → **비활성**.
  기존 `debug.test.ts`의 `should enable debug in dev build without --devtools`가 정반대를 단언하고 있다.
  이것이 버그 B의 RED 회귀 테스트다.
- **Test-66** — dev 빌드 + `--devtools` → 활성.
- **Test-1 / Test-2 / Test-4는 그대로 유지.** 패키징 빌드 동작은 불변이다.

---

## 5. 관련 코드 포인터

### 레퍼런스로 삼을 원격 구현

| 파일                                                                                                     | 역할                                                                                              |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [`remote/FileContextMenu.tsx`](../../src/renderer/src/components/remote/FileContextMenu.tsx)             | 메뉴 UI·동작 전체. `selectedEntries` 병합 규칙, `handleClose`, document click 리스너 패턴         |
| [`remote/FileListView.tsx:78-86`](../../src/renderer/src/components/remote/FileListView.tsx#L78-L86)     | `handleContextMenu` 시그니처. 행에서는 `e.stopPropagation()` 후 호출, 컨테이너에서는 `entry=null` |
| [`remote/FileGridView.tsx:169-174`](../../src/renderer/src/components/remote/FileGridView.tsx#L169-L174) | 그리드 뷰의 동일 배선                                                                             |
| [`remote/FilePropertiesDialog.tsx`](../../src/renderer/src/components/remote/FilePropertiesDialog.tsx)   | Properties 다이얼로그 구조. `InfoRow`, Escape 키 처리, 오버레이 클릭 닫기                         |

### 수정 대상

| 파일                                                                                           | 변경                                           |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| [`local/LocalFileList.tsx`](../../src/renderer/src/components/local/LocalFileList.tsx)         | `onContextMenu` 배선 + 메뉴/다이얼로그 렌더    |
| [`local/LocalFileGridView.tsx`](../../src/renderer/src/components/local/LocalFileGridView.tsx) | 동일                                           |
| `local/LocalFileContextMenu.tsx`                                                               | **신규**                                       |
| `local/LocalFilePropertiesDialog.tsx`                                                          | **신규**                                       |
| [`main/local/LocalFileSystem.ts`](../../src/main/local/LocalFileSystem.ts)                     | `rename` / `mkdir` 추가                        |
| [`main/ipc/localFsHandlers.ts`](../../src/main/ipc/localFsHandlers.ts)                         | `local:rename` / `local:mkdir` 핸들러 추가     |
| [`shared/debug.ts`](../../src/shared/debug.ts)                                                 | `isDebugEnabled` 단순화 (D4)                   |
| [`main/index.ts:61-64`](../../src/main/index.ts#L61-L64)                                       | 호출부 + 로그 문구(`via` 분기 제거)            |
| [`shared/debug.test.ts`](../../src/shared/debug.test.ts)                                       | Test-3 반전, Test-66 추가                      |
| [`AGENTS.md:24`](../../AGENTS.md#L24)                                                          | "dev 빌드는 플래그 없이도 항상 활성" 문구 정정 |
| [`vitest.config.ts`](../../vitest.config.ts)                                                   | `environment: 'jsdom'`, `include`에 `.tsx`     |

### 주의점

1. **경로 조합은 반드시 [`joinLocalPath`](../../src/renderer/src/lib/localPath.ts)를 쓴다.**
   원격은 `currentPath === '/' ? ... : ...`로 POSIX를 직접 조립하지만, 로컬은 Windows(`C:\`)와
   POSIX를 모두 다뤄야 한다. 하드코딩된 `/` 조합 금지.

2. **삭제 확인은 `useSettingsStore.getState().confirmBeforeDelete`를 읽는다.**
   [`LocalExplorer.tsx:73-76`](../../src/renderer/src/components/local/LocalExplorer.tsx#L73-L76)의 Delete 키 처리와
   동일한 규칙이어야 한다. 두 경로가 갈리면 안 된다.

3. **`enqueue` 시그니처**: `enqueue(direction, localPath, remotePath, fileName, totalBytes)`.
   Upload는 `enqueue('upload', entry.path, <원격경로>, entry.name, entry.size)`.

4. **선택 병합 규칙**은 원격 `FileContextMenu.tsx:52-57`을 그대로 따른다 —
   우클릭 항목이 이미 선택에 포함되고 선택이 2개 이상이면 선택 전체가 대상, 아니면 그 항목 하나.

5. **`window.api.debugToolsEnabled`** 를 통해 debug 여부를 읽고
   [`shouldDeferToNativeContextMenu`](../../src/renderer/src/lib/debugTools.ts)로 Shift+우클릭을 판정한다(Test-48).

6. **RTL 테스트에서 `window.api`는 목으로 주입**해야 한다. preload가 없는 환경이다.

   ⚠️ 그 결과 **테스트는 preload 화이트리스트 누락을 잡지 못한다.**
   [`preload/index.ts`](../../src/preload/index.ts)의 `INVOKE_CHANNELS`에 채널을 등록하지 않으면
   `invoke`가 `IPC channel not allowed`로 거부되는데, 목킹된 `window.api`는 이 검사를 거치지 않아
   테스트는 전부 GREEN인 채로 실제 앱에서만 터진다. `local:rename`·`local:mkdir` 등록은
   R3의 E2E 실측 검증에서 확인해야 할 항목이다.

7. 삭제·이름변경·폴더생성 후에는 `useLocalFsStore.refresh()`를 호출하고 선택을 정리한다.
   원격의 `refresh()` + `clearSelection()` 패턴과 동일.

---

## 6. 인터페이스 계약 (테스트 작성자 ↔ 구현자 공통 고정)

테스트 작성자와 구현자가 서로를 보지 못하므로, 양쪽이 의존하는 표면을 여기서 못박는다.
**이 시그니처·문자열은 임의로 바꾸지 않는다.** 바꿔야 한다면 이 문서를 먼저 고친다.

### 신규 컴포넌트

`src/renderer/src/components/local/LocalFileContextMenu.tsx`

```ts
export interface LocalFileContextMenuProps {
  entry: LocalFileEntry | null
  position: { x: number; y: number } | null
  onClose: () => void
  onShowProperties?: (entry: LocalFileEntry) => void
}
export function LocalFileContextMenu(props: LocalFileContextMenuProps): React.JSX.Element | null
```

`position`이 `null`이면 `null`을 반환한다(원격 `FileContextMenu`와 동일 규칙).

`src/renderer/src/components/local/LocalFilePropertiesDialog.tsx`

```ts
export interface LocalFilePropertiesDialogProps {
  entry: LocalFileEntry
  onClose: () => void
}
export function LocalFilePropertiesDialog(props: LocalFilePropertiesDialogProps): React.JSX.Element
```

### 메뉴 항목 라벨 (테스트는 이 문자열로 조회한다)

| 조건                               | 라벨                                            |
| ---------------------------------- | ----------------------------------------------- |
| 단일 선택 + 파일 포함 + FTP 연결됨 | `Upload`                                        |
| 다중 선택 + 파일 포함 + FTP 연결됨 | `Upload (N)` — N은 **파일 개수**(디렉터리 제외) |
| 단일 선택                          | `Rename`                                        |
| 단일 선택                          | `Delete`                                        |
| 다중 선택                          | `Delete (N)` — N은 **선택 항목 총개수**         |
| 항상                               | `New Folder`                                    |
| 단일 선택                          | `Properties`                                    |

원격 `FileContextMenu`의 Download/Delete 라벨 규칙을 그대로 옮긴 것이다.

### 이름 입력 메커니즘 — `window.prompt` 사용 금지

Rename과 New Folder **둘 다 메뉴 안의 인라인 `<input type="text">`** 로 이름을 받는다.
Enter로 제출, Escape로 취소한다. 테스트는 `getByRole('textbox')`로 찾는다.

**`window.prompt`는 쓸 수 없다.** Electron이 렌더러에서 이를 명시적으로 막고 예외를 던진다
([`lib/renderer/window-setup.ts`](https://github.com/electron/electron/blob/main/lib/renderer/window-setup.ts)):

```ts
// But we do not support prompt().
window.prompt = function () {
  throw new Error('prompt() is not supported.')
}
```

초기 구현은 원격 `FileContextMenu`를 따라 `window.prompt`를 썼고, 그 결과 New Folder가
실제 앱에서 전혀 동작하지 않았다. 테스트가 `window.prompt`를 목킹해 전 케이스 GREEN인 채로
통과했다. 원격 구현도 같은 이유로 깨져 있으며 이번에 함께 고친다(Test-84).

### 이름 검증

Rename·New Folder 모두 invoke 이전에 이름을 검증하고, 위반 시 `toast.error`로 표면화한다.
**"거부"는 IPC 미호출 + 표면화 둘 다를 뜻한다** — 조용한 거부는 계약 위반이다.

술어는 파일시스템별로 나뉜다:

|      | 함수               | 거부 대상                         |
| ---- | ------------------ | --------------------------------- |
| 로컬 | `isSafeLocalName`  | 빈 이름, `.`, `..`, `/`, `\`, `:` |
| 원격 | `isSafeRemoteName` | 빈 이름, `.`, `..`, `/`           |

`\`와 `:`가 로컬에만 있는 이유: Windows에서 `\`는 경로 구분자이고, `:`는 NTFS 대체 데이터
스트림을 만든다(`foo:bar`는 `foo`의 스트림이 되어 목록에 나타나지 않는다). 반면 POSIX·FTP
파일명에서는 둘 다 합법이므로, 하나의 술어로 묶으면 원격에서 정당한 이름을 거부하게 된다.

디렉터리 탈출 방어는 렌더러와 `LocalFileSystem` **양쪽**에 둔다(렌더러만 막으면 IPC 직접
호출로 우회된다). 콜론 차단은 렌더러에만 둔다 — main의 가드는 "rename은 move가 아니다"라는
동작 계약을 강제하는 것이고, 콜론은 되돌릴 수 없는 이동을 일으키지 않아 범주가 다르다.

### main 프로세스

```ts
// LocalFileSystem
async rename(oldPath: string, newPath: string): Promise<void>
async mkdir(dirPath: string): Promise<void>
```

IPC 채널과 인자 순서:

- `local:rename` — `(oldPath: string, newPath: string)` → `IpcResult<void>`
- `local:mkdir` — `(dirPath: string)` → `IpcResult<void>`

기존 핸들러처럼 `ipcError(err)`로 실패를 감싼다.

`rename`은 대상이 이미 있으면 **덮어쓰지 않고 실패**해야 한다(Test-63).
`fs.rename`은 플랫폼에 따라 조용히 덮어쓰므로, 존재 검사 후 거부하는 방식이 필요하다.
`mkdir`은 `recursive: true`를 쓰면 이미 존재해도 성공해 버리므로 Test-65가 깨진다.

**실패 메시지를 계약으로 고정한다**: 대상이 이미 존재하면 `Target already exists: <basename>`
메시지를 가진 에러를 던진다.

이유: 단순한 `toThrow()`는 **아무 OS 수준 거부에나 만족한다** — 권한 오류, 잠긴 파일,
대상이 디렉터리인 경우 등. 메시지를 고정해야 거부의 **출처**가 우리가 의도한 가드임이
강제된다.

측정된 사실 (뮤테이션으로 확인): `fs.rename`은 **Windows에서도 조용히 덮어쓴다.**
libuv의 `uv_fs_rename`이 `MOVEFILE_REPLACE_EXISTING`을 넘기기 때문이며, EPERM/EEXIST를
던지지 않는다. 즉 이 가드는 POSIX 전용 방어가 아니라 **모든 플랫폼에서 필수**다.
(이 문서의 이전 판에는 "Windows는 이미 던진다"는 반대 서술이 있었다. 실측으로 반증되었다.)

### shared

```ts
export function isDebugEnabled(argv: readonly string[]): boolean
```

`isPackaged` 파라미터는 제거된다(D4). `debug.test.ts`의 기존 호출부도 함께 고쳐야 한다.

### 테스트 환경

렌더러 컴포넌트 테스트 파일은 반드시 첫 줄에 docblock을 둔다:

```ts
/** @vitest-environment jsdom */
```

`vitest.config.ts`의 기본 environment는 `node`이며, `setupFiles`로 `@testing-library/jest-dom/vitest`가
이미 로드되어 있다. `window.api`는 preload가 없으므로 테스트에서 직접 목으로 주입한다.
