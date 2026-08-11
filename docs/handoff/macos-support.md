# 핸드오프: macOS(맥북) 지원

R1에서 인간과 합의한 내용의 고충실도 기록. R2(테스트 코드 작성)·구현의 유일한 입력이다.
이 문서에 없는 케이스는 완료 범위 밖이다. 새 케이스를 추가하거나 기존 케이스를 재해석하지 말 것.

작업 유형(R0): **기능(feature)**. R1→R4 전체 워크플로우를 수행한다.

---

## 1. 문제 정의

이 앱은 Windows를 전제로 만들어졌다. macOS에서 실행하면 **앱이 뜨긴 하지만 사실상 조작이 불가능하다.**

### 조사로 확인된 사실 (2026-08-12, Darwin 25.6.0 / arm64 / Node v22.21.1)

먼저, **손댈 필요가 없다고 확인된 것**부터 고정한다. 이 영역을 건드리는 변경은 범위 밖이다.

- `./script/test.sh run` → **26개 파일 353개 테스트 전부 통과**. `_common.sh`의 bash 문법, `setup.sh`의
  배열·`find -newer`·`ls -t` 모두 macOS에서 동작한다. **셸 스크립트는 수정 대상이 아니다.**
- [`localPath.ts`](../../src/renderer/src/lib/localPath.ts)는 이미 `isWindowsPath()`로 분기하며
  Unix 경로를 정상 처리한다. macOS는 Unix 분기를 그대로 탄다. **경로 유틸은 수정 대상이 아니다.**
- [`LocalFileSystem.ts`](../../src/main/local/LocalFileSystem.ts)는 전부 `path`/`fs` 기반이고
  `getHomePath()`는 `app.getPath('home')`이다. **파일 시스템 계층은 수정 대상이 아니다.**
- `build/icon.icns`, `build/entitlements.mac.plist`가 이미 존재하고 `package.json`에 `build:mac`이 있다.

### 실제 갭 4건

#### 갭 A — 애플리케이션 메뉴 제거로 Cmd 단축키가 전멸한다 (치명적)

[`main/index.ts:71`](../../src/main/index.ts#L71):

```ts
Menu.setApplicationMenu(null)
```

macOS에서 키보드 단축키는 애플리케이션 메뉴에 바인딩된다. 메뉴를 `null`로 만들면
**Cmd+Q(종료), Cmd+W(창 닫기), Cmd+C/V/X/A(복사·붙여넣기·잘라내기·전체선택), Cmd+Z(실행 취소)가
전부 동작하지 않는다.**

[`ConnectDialog.tsx`](../../src/renderer/src/components/server/ConnectDialog.tsx)의 호스트·비밀번호
입력창에 **붙여넣기를 할 수 없다**는 뜻이고, 앱을 정상 종료할 수단도 없다.
Windows/Linux에서는 메뉴바가 없는 편이 의도된 UI이므로 현행 동작을 유지해야 한다.

#### 갭 B — DevTools 단축키가 Windows 전용이다

[`devtools.ts:56-69`](../../src/main/debug/devtools.ts#L56-L69)의 `matchDebugShortcut`은
`F12`와 `Ctrl+Shift+C`만 인식한다. 맥북 내장 키보드의 F12는 기본이 볼륨 키라 `fn`을 함께 눌러야 하고,
macOS의 관례 조합인 **Cmd+Option+I / Cmd+Option+C**는 아예 매칭되지 않는다.

#### 갭 C — Ctrl+클릭이 우클릭과 선택 토글을 동시에 유발한다

macOS에서 **Ctrl+클릭은 보조 클릭(우클릭)** 이다. 그런데 4개 뷰의 클릭 핸들러가 `e.ctrlKey`를
선택 토글로 해석한다:

- [`LocalFileList.tsx:56`](../../src/renderer/src/components/local/LocalFileList.tsx#L56)
- [`LocalFileGridView.tsx:143`](../../src/renderer/src/components/local/LocalFileGridView.tsx#L143)
- [`FileListView.tsx:64`](../../src/renderer/src/components/remote/FileListView.tsx#L64)
- [`FileGridView.tsx:153`](../../src/renderer/src/components/remote/FileGridView.tsx#L153)

결과: 맥에서 파일을 Ctrl+클릭하면 컨텍스트 메뉴가 뜨면서 **동시에 선택 상태가 뒤집힌다.**
[`useMarqueeSelection.ts:62`](../../src/renderer/src/hooks/useMarqueeSelection.ts#L62)의
`additive = e.ctrlKey || e.metaKey || e.shiftKey`도 같은 문제를 갖는다.

#### 갭 D — 갤러리 줌이 `ctrlKey`만 인식한다

[`LocalFileGridView.tsx:132`](../../src/renderer/src/components/local/LocalFileGridView.tsx#L132),
[`FileGridView.tsx:142`](../../src/renderer/src/components/remote/FileGridView.tsx#L142)의 wheel 핸들러가
`if (!e.ctrlKey) return`이다.

macOS 트랙패드의 핀치 줌은 브라우저가 `ctrlKey: true`인 wheel 이벤트로 전달하므로 **트랙패드는 이미 동작한다.**
동작하지 않는 것은 외장 마우스 사용자가 기대하는 **Cmd+휠**이다.

---

## 2. 핵심 결정 (R1에서 인간이 확정)

| #   | 결정                                                                                                                                                                                             | 근거                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | 범위는 **동작 정합성 + 문서**. electron-builder 패키징(dmg/arch/category) 정비와 실제 dmg 산출 검증은 **이번 범위 밖**                                                                           | 지금 필요한 것은 "이 맥에서 개발·실행이 되는가"이고, 배포는 별건이다                                                                                          |
| D2  | 플랫폼 분기는 **순수 함수에 `platform` 문자열을 인자로 주입**해 판정한다. 함수 내부에서 `process.platform`을 직접 읽지 않는다                                                                    | 테스트에서 플랫폼을 결정론적으로 바꿀 수 있어야 한다. 모듈 전역 상수로 캐시하면 두 플랫폼을 한 스위트에서 검증할 수 없다                                      |
| D3  | 렌더러는 preload가 노출하는 **`window.api.platform`** 으로 플랫폼을 얻는다                                                                                                                       | 기존 `debugToolsEnabled`([preload/index.ts:96](../../src/preload/index.ts#L96))와 **동일한 패턴**. 새 IPC·새 패턴을 만들지 않음                               |
| D4  | macOS 앱 메뉴는 **role 기반**으로 구성한다(직접 accelerator 문자열을 쓰지 않음)                                                                                                                  | `role: 'copy'` 등은 Electron이 OS 표준 단축키·라벨·현지화를 자동 부여한다. 손으로 적으면 어긋난다                                                             |
| D5  | macOS 앱 메뉴에 **`toggleDevTools` role을 넣지 않는다**                                                                                                                                          | 메뉴 항목이 생기면 `--devtools` 플래그 없이도 개발자 도구가 열려 [AGENTS.md](../../AGENTS.md)의 기존 결정이 깨진다                                            |
| D6  | Windows/Linux는 계속 `setApplicationMenu(null)`                                                                                                                                                  | 현행 UI 유지. macOS만 메뉴를 갖는다                                                                                                                           |
| D7  | macOS에서 **Cmd(meta)만 선택 토글**로 인정하고 **Ctrl은 무시**한다                                                                                                                               | Ctrl+클릭은 macOS의 보조 클릭이다. 토글로도 해석하면 메뉴와 선택 변경이 동시에 일어난다(갭 C)                                                                 |
| D8  | macOS DevTools는 **Cmd+Option+I / Cmd+Option+C를 추가**하고 **F12·Ctrl+Shift+C도 계속 인정**한다                                                                                                 | 외장 키보드 사용자를 위해 기존 조합을 남긴다. 추가만 하고 제거하지 않으므로 Windows 경로에 회귀가 없다                                                        |
| D9  | 줌 수정자는 macOS에서 **Ctrl과 Cmd 둘 다** 인정, Windows에서는 **Ctrl만** 인정                                                                                                                   | macOS 트랙패드 핀치가 `ctrlKey`로 오므로 Ctrl을 빼면 핀치 줌이 죽는다. Windows의 meta는 Win 키라 줌 수정자가 아니다                                           |
| D11 | macOS의 Cmd+Option 조합은 **`input.code`(`'KeyI'`/`'KeyC'`)로 매칭**한다. F12·Ctrl+Shift+C는 계속 `input.key` 기준 | macOS에서 **Option은 glyph modifier**라 Cmd가 눌려도 문자 매핑에 남는다(Chromium `DomKeyFromNSEvent`, `kGlyphModifiers = Shift｜CapsLock｜Option`). US 배열에서 Option+I는 dead key(ˆ), Option+C는 `ç`이고, **한글 입력 상태에서는 자모**가 된다. `key`로 매칭하면 레이아웃·IME에 따라 단축키가 죽는다. `code`는 물리 키 위치라 무관하다 |
| D10 | 메뉴 템플릿에 **매크로 role 금지**(`viewMenu`·`editMenu`·`windowMenu`·`appMenu` 등). 각 메뉴를 명시적 `submenu` 배열로 쓰고 개별 항목 role만 사용한다. 최상위 label은 정확히 `'Edit'`·`'Window'` | `{ role: 'viewMenu' }`는 런타임에 **Toggle Developer Tools를 포함해** 전개되므로 D5가 그대로 깨진다. 템플릿에는 `'viewMenu'`만 보여 테스트도 이를 잡지 못한다 |

---

## 3. 기각한 대안

- **`Menu.setApplicationMenu(null)`을 전 플랫폼에서 제거하고 기본 메뉴를 쓴다** — Windows/Linux에 없던
  메뉴바가 생겨 기존 UI가 바뀐다. 요청 범위를 넘는 회귀다. 기각(D6).
- **`globalShortcut`으로 Cmd+C/V를 직접 등록** — 전역 단축키는 앱이 포커스를 잃어도 가로채고,
  텍스트 입력의 표준 편집 동작을 손으로 재구현하게 된다. role 메뉴가 정답이다. 기각(D4).
- **macOS에서 F12·Ctrl+Shift+C를 제거하고 Cmd 조합만 인정** — 외장 키보드를 쓰는 경우를 막고,
  플랫폼별 분기 폭이 커져 회귀 위험만 늘어난다. 기각(D8).
- **macOS에서 줌 수정자를 Cmd 전용으로 변경** — 트랙패드 핀치가 `ctrlKey`로 도착하므로
  맥북 사용자의 주된 줌 수단이 죽는다. 기각(D9).
- **각 컴포넌트에서 `window.api.platform`을 직접 읽어 인라인 분기** — 같은 판정이 6곳에 흩어져
  한 곳만 고치는 사고가 난다. 순수 함수 1개로 모으고 컴포넌트는 그것만 호출한다.
- **`navigator.platform` / `navigator.userAgentData`로 렌더러에서 플랫폼 감지** — 표준에서 폐기 예정이고
  Electron 버전에 따라 값이 흔들린다. preload가 `process.platform`을 넘기는 편이 정확하다. 기각(D3).

---

## 4. 신규/변경 파일

| 파일                                                       | 상태 | 역할                                                                                                           |
| ---------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------- |
| `src/main/menu/appMenu.ts`                                 | 신규 | `buildAppMenuTemplate(platform)`, `applyApplicationMenu(platform)`                                             |
| `src/main/menu/appMenu.test.ts`                            | 신규 | A 그룹                                                                                                         |
| `src/main/debug/devtools.ts`                               | 변경 | `matchDebugShortcut(input, platform)` 로 시그니처 확장                                                         |
| `src/main/debug/devtools.test.ts`                          | 변경 | B 그룹 추가. **기존 케이스는 유지**(호출부에 `'win32'`을 넘겨 그대로 통과)                                     |
| `src/main/index.ts`                                        | 변경 | `Menu.setApplicationMenu(null)` → `applyApplicationMenu(process.platform)`. `registerDevtools`에 platform 전달 |
| `src/renderer/src/lib/platform.ts`                         | 신규 | `isMac` / `currentPlatform` / `isToggleSelectModifier` / `isZoomModifier`                                      |
| `src/renderer/src/lib/platform.test.ts`                    | 신규 | C 그룹                                                                                                         |
| `src/preload/index.ts`                                     | 변경 | `api`에 `platform: process.platform` 추가                                                                      |
| `src/preload/index.d.ts`                                   | 변경 | 타입 추가                                                                                                      |
| `src/renderer/src/test/rendererTestUtils.ts`               | 변경 | `ApiMock`에 `platform` 필드 추가(기본값 `'win32'`)                                                             |
| 뷰 4종 + `useMarqueeSelection.ts`                          | 변경 | 인라인 `e.ctrlKey \|\| e.metaKey` → `isToggleSelectModifier(...)`                                              |
| `src/renderer/src/components/remote/FileListView.test.tsx` | 신규 | D 그룹(원격 리스트). **현재 이 파일은 없다**                                                                   |
| `src/renderer/src/components/remote/FileGridView.test.tsx` | 신규 | D 그룹(원격 그리드). **현재 이 파일은 없다**                                                                   |
| `AGENTS.md`                                                | 변경 | macOS 실행·단축키 절 추가                                                                                      |

`rendererTestUtils.makeApiMock`의 `platform` 기본값을 `'win32'`로 두는 이유: 기존 컴포넌트 테스트
110여 개가 Windows 동작을 전제로 작성돼 있다. 기본값을 바꾸면 이번 범위와 무관한 테스트가 무더기로
깨지고, 그 실패는 회귀가 아니라 목 설정 변경의 부작용이라 신호가 오염된다.

---

## 5. 테스트 케이스 리스트 (확정)

`Test-117`부터 신규. **기존 최대 번호는 `Test-116`.**
각 테스트 코드에 `covers: Test-N` 주석을 단다. **1:1 매핑. 케이스 추가·병합·재해석 금지.**

### A. 애플리케이션 메뉴 — `src/main/menu/appMenu.ts`

- **Test-117** — `buildAppMenuTemplate('win32')`는 `null`을 반환한다.
- **Test-118** — `buildAppMenuTemplate('linux')`는 `null`을 반환한다.
- **Test-119** — `buildAppMenuTemplate('darwin')`의 첫 서브메뉴는 앱 메뉴이며 `quit` role을 포함한다.
- **Test-120** — `'darwin'` 템플릿의 Edit 메뉴가 `cut`·`copy`·`paste`·`selectAll` role을 모두 포함한다.
- **Test-121** — `'darwin'` 템플릿의 Edit 메뉴가 `undo`·`redo` role을 포함한다.
- **Test-122** — `'darwin'` 템플릿에 Window 메뉴가 있고 `minimize`·`close` role을 포함한다.
- **Test-123** — `'darwin'` 템플릿 **어디에도 `toggleDevTools` role이 없고, 매크로 role도 없다**(D5·D10).
  매크로 role(`viewMenu` 등)은 런타임에 Toggle Developer Tools로 전개되므로, `toggleDevTools` 문자열만
  검사하면 이 케이스는 통과하면서 실제 메뉴에는 개발자 도구가 뜬다. **매크로 role의 부재까지 단언해야 한다.**
- **Test-124** — `applyApplicationMenu('darwin')`은 `buildFromTemplate` 결과를 `setApplicationMenu`에 넘긴다.
- **Test-125** — `applyApplicationMenu('win32')`은 `setApplicationMenu(null)`을 호출한다.

### B. DevTools 단축키 — `matchDebugShortcut(input, platform)`

- **Test-126** — darwin + Cmd+Option + `code: 'KeyI'` → `'toggle-devtools'` (D11)
- **Test-127** — darwin + Cmd+Option + `code: 'KeyC'` → `'inspect-element'` (D11)
- **Test-128** — darwin + F12 → `'toggle-devtools'`
- **Test-129** — darwin + Ctrl+Shift+C → `'inspect-element'` (기존 조합 유지, D8)
- **Test-130** — win32 + Cmd+Option+I → `null`
- **Test-131** — win32 + Cmd+Option+C → `null`
- **Test-132** — win32 + F12 → `'toggle-devtools'` (회귀 없음)
- **Test-133** — win32 + Ctrl+Shift+C → `'inspect-element'` (회귀 없음)
- **Test-134** — darwin + Cmd + `code: 'KeyI'`(Option 없음) → `null`
- **Test-135** — darwin + Option + `code: 'KeyI'`(Cmd 없음) → `null`
- **Test-136** — darwin에서 `type: 'keyUp'` 또는 `isAutoRepeat: true`이면 Cmd+Option+`KeyI`도 `null`

F12와 Ctrl+Shift+C는 **계속 `input.key` 기준**이다(D11). 회귀 없음이 D8의 전제다.

### C. 수정자 판정 유틸 — `src/renderer/src/lib/platform.ts`

- **Test-137** — `isToggleSelectModifier({ ctrlKey: true, metaKey: false }, 'darwin')` → `false`
- **Test-138** — `isToggleSelectModifier({ ctrlKey: false, metaKey: true }, 'darwin')` → `true`
- **Test-139** — `isToggleSelectModifier({ ctrlKey: true, metaKey: false }, 'win32')` → `true`
- **Test-140** — `isToggleSelectModifier({ ctrlKey: false, metaKey: true }, 'win32')` → `true`
- **Test-141** — 두 수정자가 모두 `false`면 `'darwin'`·`'win32'` 양쪽에서 `false`
- **Test-142** — `currentPlatform()`은 `window.api.platform` 값을 반환한다.
- **Test-143** — `window.api`가 없으면 `currentPlatform()`은 빈 문자열을 반환한다(= mac 아님으로 폴백).
- **Test-144** — `isZoomModifier({ ctrlKey: true, metaKey: false }, 'darwin')` → `true` (트랙패드 핀치 보존)
- **Test-145** — `isZoomModifier({ ctrlKey: false, metaKey: true }, 'darwin')` → `true` (Cmd+휠)
- **Test-146** — `isZoomModifier({ ctrlKey: false, metaKey: true }, 'win32')` → `false` (Win 키는 줌이 아님)

### D. 뷰 4곳 클릭 통합 (RTL)

각 뷰는 독립된 배선 코드를 갖는다. 같은 시나리오를 네 곳에서 확인한다.

- **Test-147** — (로컬 리스트) darwin에서 Ctrl+클릭하면 선택이 **토글되지 않고** 그 항목만 단일 선택된다.
- **Test-148** — (로컬 리스트) darwin에서 Cmd+클릭하면 선택이 토글된다.
- **Test-149** — (로컬 그리드) darwin에서 Ctrl+클릭 → 단일 선택.
- **Test-150** — (로컬 그리드) darwin에서 Cmd+클릭 → 토글.
- **Test-151** — (원격 리스트) darwin에서 Ctrl+클릭 → 단일 선택.
- **Test-152** — (원격 리스트) darwin에서 Cmd+클릭 → 토글.
- **Test-153** — (원격 그리드) darwin에서 Ctrl+클릭 → 단일 선택.
- **Test-154** — (원격 그리드) darwin에서 Cmd+클릭 → 토글.
- **Test-155** — (로컬 리스트) win32에서 Ctrl+클릭 → 토글 (회귀 없음).

### E. 마퀴 선택 — `useMarqueeSelection`

- **Test-156** — darwin에서 `ctrlKey`를 누른 채 빈 공간을 드래그하면 **additive가 아니다**(기존 선택이 대체된다).
- **Test-157** — darwin에서 `metaKey`를 누른 채 드래그하면 additive다(기존 선택에 더해진다).
- **Test-158** — `shiftKey` 드래그는 `'darwin'`·`'win32'` 양쪽에서 additive다.

### F. preload

- **Test-159** — preload가 노출하는 `api.platform`이 `process.platform`과 같다.

### G. R2 도중 추가 (인간 승인 2026-08-12)

R2에서 테스트를 쓰던 중 5절의 구멍 4건이 드러났다. 인간 게이트를 다시 거쳐 승인받고 추가한다.
**추가 경위와 근거는 8절에 기록한다.**

- **Test-160** — (로컬 그리드) darwin에서 **Cmd+휠**을 굴리면 갤러리 썸네일 크기가 실제로 바뀐다.
- **Test-161** — (원격 그리드) darwin에서 **Cmd+휠**을 굴리면 갤러리 썸네일 크기가 실제로 바뀐다.
- **Test-162** — `isZoomModifier({ ctrlKey: true, metaKey: false }, 'win32')` → `true`
- **Test-163** — `applyApplicationMenu('linux')`는 `setApplicationMenu(null)`을 호출하고
  `buildFromTemplate`를 호출하지 않는다.
- **Test-164** — `window.api`는 존재하지만 `platform` 필드가 없으면 `currentPlatform()`은 빈 문자열을 반환한다.

### H. R3 도중 추가 (인간 승인 2026-08-12) — D11 대응

구현 코드 적대적 리뷰가 H1을 제기해 인간 게이트를 거쳐 `input.code` 전환을 확정했다(D11).
아래 3건이 그 전환을 **실제로** 검증한다. 경위는 8절 정정 5에 기록한다.

- **Test-165** — darwin + Cmd+Option에서 `key`가 레이아웃 때문에 `'ˆ'`(dead key)로 와도
  `code: 'KeyI'`이면 `'toggle-devtools'`
- **Test-166** — darwin + Cmd+Option에서 `key`가 `'ç'`로 와도 `code: 'KeyC'`이면 `'inspect-element'`
- **Test-167** — darwin + Cmd+**Ctrl**+Option + `code: 'KeyI'` → `null`
  (Ctrl+Shift+C 분기가 `!alt && !meta`로 엄격한 것과 대칭을 맞춘다. LOW-2 반영)

Test-165·166이 없으면 `code`로 바꿨는지 `key`로 남았는지 테스트가 구분하지 못한다.
**이 두 케이스가 H1의 실질적 게이트다.**

---

Test-160·161은 **배선 검증**이다. 순수 함수(Test-144~146)가 아니라 뷰가 그 함수를 실제로 호출하는지를 본다.
`wheel` 이벤트는 `{ passive: false }` 네이티브 리스너로 붙으므로
([LocalFileGridView.tsx:136](../../src/renderer/src/components/local/LocalFileGridView.tsx#L136)),
React 합성 이벤트가 아니라 실제 `WheelEvent`를 디스패치해야 한다. 갤러리 모드가 켜져 있어야 리스너가 붙는다.

---

## 6. 자동화 밖 — R3에서 이 맥으로 실측할 항목

테스트 코드가 이미 덮은 동작은 여기서 다시 확인하지 않는다. 아래는 **시스템 통합/실제 환경 의존**이라
자동화가 불가능한 것만 남긴 목록이다.

- **E1** — `./script/run.sh --devtools`로 앱이 기동하고 창이 뜬다.
- **E2** — Cmd+Q로 앱이 종료된다.
- **E3** — ConnectDialog의 입력창에 Cmd+V로 붙여넣기가 된다.
- **E4** — Cmd+Option+I로 DevTools가 열린다.
- **E5** — `./script/run.sh`(플래그 없음)로 실행하면 Cmd+Option+I·F12로 DevTools가 열리지 않는다.
- **E6** — 파일 목록에서 Ctrl+클릭 시 컨텍스트 메뉴만 뜨고 선택 상태가 변하지 않는다.
- **E7** — `sharp`·`better-sqlite3`가 arm64에서 로드되어 썸네일이 실제로 생성된다.

---

## 7. 관련 코드 포인터

- 플랫폼 분기 선례: [`main/index.ts:30`](../../src/main/index.ts#L30) (`process.platform === 'linux'`),
  [`main/index.ts:57`](../../src/main/index.ts#L57) (`'win32'`),
  [`main/index.ts:91`](../../src/main/index.ts#L91) (`!== 'darwin'`)
- preload → 렌더러 값 전달 선례: [`preload/index.ts:96`](../../src/preload/index.ts#L96),
  소비측 [`LocalFileGridView.tsx:157`](../../src/renderer/src/components/local/LocalFileGridView.tsx#L157)
- 순수 함수 + 얇은 배선 선례: [`lib/debugTools.ts`](../../src/renderer/src/lib/debugTools.ts)
  (`shouldDeferToNativeContextMenu(event, debugEnabled)`)
- electron 모듈 목 선례: [`devtools.test.ts:4-11`](../../src/main/debug/devtools.test.ts#L4-L11)
- 렌더러 테스트 목 헬퍼: [`rendererTestUtils.ts:24`](../../src/renderer/src/test/rendererTestUtils.ts#L24)
- 컴포넌트 테스트 작성 선례: [`LocalFileList.test.tsx`](../../src/renderer/src/components/local/LocalFileList.test.tsx)
  (원격 뷰 테스트를 새로 만들 때의 레퍼런스)

---

## 8. 정정 기록 (R2 중)

### 정정 1 — 5절 C 그룹 각주는 거짓이었다 (삭제함)

원래 이렇게 적혀 있었다:

> `isZoomModifier({ ctrlKey: true }, 'win32')`은 별도 케이스로 세지 않는다 —
> Windows의 Ctrl+휠 줌은 기존 그리드 테스트가 이미 덮고 있다.

**사실이 아니다.** 코드베이스 전체 테스트에 `wheel` 케이스가 하나도 없다
(`grep -rln wheel src/ --include="*.test.ts*"` → 신규 `platform.test.ts` 외 0건).
R1에서 확인하지 않고 단정한 서술이다. 각주를 삭제하고 해당 케이스를 **Test-162**로 되살렸다.

### 정정 2 — 갭 D는 배선이 검증되지 않는 구조였다

Test-144~146은 `isZoomModifier`라는 **순수 함수만** 검증한다. 뷰가 그 함수를 실제로 호출하는지는
어느 케이스도 보지 않았고, 6절 E 실측 목록에도 줌 항목이 없었다.

이 상태에서는 구현자가 `isZoomModifier`를 만들어 놓고
[`LocalFileGridView.tsx:132`](../../src/renderer/src/components/local/LocalFileGridView.tsx#L132)와
[`FileGridView.tsx:142`](../../src/renderer/src/components/remote/FileGridView.tsx#L142)의
`if (!e.ctrlKey) return`을 그대로 둬도 **43개 테스트가 전부 GREEN**이 된다.
즉 갭 D를 고치지 않아도 완료로 보이는 구멍이다. **Test-160·161**로 막았다.

### 정정 3 — linux 적용 경로와 preload 부분 부재 케이스

Test-117·118은 템플릿만, Test-124·125는 darwin/win32만 검증해 `applyApplicationMenu('linux')`
경로가 비어 있었다(**Test-163**). `currentPlatform()`도 `window.api` 자체가 없는 경우(Test-143)만
규정하고 `platform` 필드만 없는 경우가 비어 있었다(**Test-164**).

### 정정 4 — 매크로 role이 D5를 우회한다 (D10 신설)

적대적 리뷰가 잡아낸 결함이다. Test-123은 템플릿에 **문자열로 적힌** role만 검사하는데,
Electron 매크로 role `{ role: 'viewMenu' }`는 `buildFromTemplate` 시점에
Reload / Force Reload / **Toggle Developer Tools** / Reset Zoom으로 전개된다.

따라서 View 메뉴를 매크로로 넣으면 **Test-123은 GREEN인데 실제 메뉴바에 Toggle Developer Tools가 뜬다.**
`--devtools` 플래그 게이트가 조용히 깨지는, D5가 막으려던 바로 그 상황이다.

**D10**으로 매크로 role을 금지하고, Test-123의 단언을 매크로 role 부재까지 확장한다.
이는 케이스 추가가 아니라 기존 케이스가 원래 검증했어야 할 것의 복원이다.

부수 효과로, 리뷰가 MEDIUM으로 제기한 "구현자가 `{ role: 'editMenu' }`를 쓰면 Test-120~122가
구현 버그처럼 보이는 RED를 낸다"는 모호함도 함께 해소된다 — 이제 스펙이 명시적 submenu를 요구한다.

### 정정 5 — `input.key`로는 macOS Cmd+Option 조합을 잡을 수 없다 (D11 신설)

구현 코드 적대적 리뷰의 H1이다. 정정 4(매크로 role)와 **같은 계층의 위험** — 테스트는 전부 GREEN인데
실기에서 동작하지 않는다.

macOS에서 Option은 glyph modifier다. Chromium `keyboard_code_conversion_mac.mm`의 `DomKeyFromNSEvent`:

> Step 4. if the key event has any modifier keys **other than glyph modifier keys**, then set key to
> the key string that would have been generated with all modifier keys removed **except for glyph
> modifier keys**. (`kGlyphModifiers = Shift | CapsLock | Option`)

Cmd는 glyph가 아니라 제거되지만 **Option은 남는다.** US 배열에서 Option+I는 dead key(ˆ), Option+C는 `ç`,
**한글 입력 상태에서는 자모**가 온다. 따라서 `input.key === 'i'` 매칭은 레이아웃·IME에 따라 실패한다.

Test-126·127이 `key: 'i'`를 직접 주입했기 때문에 401개 GREEN이 이 실패를 완전히 가리고 있었다.
`webContents.sendInputEvent`는 AppKit 레이아웃 변환을 우회하므로 자동화로는 재현조차 되지 않는다.

**D11**로 Cmd+Option 조합만 `input.code` 기준으로 바꾸고, **Test-165·166**으로 전환을 검증한다.
F12·Ctrl+Shift+C는 `key` 기준을 유지한다 — Windows 경로 회귀 없음이 D8의 전제이고,
그 조합들은 glyph modifier의 영향을 받지 않는다.

### 미해결 — 뮤테이션 범위 (R2 6단계 진입 전 처리 필요)

[`stryker.config.json`](../../stryker.config.json)의 `mutate` 목록에 **이번 변경분이 하나도 없다.**
`appMenu.ts`·`platform.ts`(신규), `devtools.ts`, `useMarqueeSelection.ts`,
`remote/FileListView.tsx`, `remote/FileGridView.tsx`, `preload/index.ts` 전부 빠져 있다.

이 상태로 `npm run test:mutation`을 돌리면 **직전 변경분의 점수**가 나오고 이번 48개의 단언 강도는
측정되지 않는다. 신규 파일은 통째로, 기존 파일은 **구현이 끝난 뒤** `git diff --unified=0`로
라인 범위를 확정해 추가한다(같은 파일의 `_comment_maintenance`가 경고하는 대로, 하드코딩된 라인 범위는
구현이 파일을 건드리는 순간 조용히 어긋난다).

### 범위에 영향 없는 것으로 확인된 사항

`script/*.sh` 5개 파일이 변경된 것으로 보이지만 **내용 변경은 0줄이고 파일 모드만 `100644` → `100755`**다.
Windows에서 만들어진 저장소라 실행 비트가 없었고, macOS에서 `./script/run.sh`로 기동하려면 필요하다.
되돌리지 않고 그대로 커밋 대상에 포함한다.
