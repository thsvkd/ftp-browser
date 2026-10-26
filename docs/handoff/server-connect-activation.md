# 핸드오프: 서버 활성화 규칙 통일 — 클릭은 선택, 더블클릭/Enter는 연결

> **포팅 출처(provenance)**: 이 문서는 `feat/feedback-batch` 브랜치(v1.3.0 기준)에서 구현을 마친
> 스펙을 v1.4.0+ 업스트림을 추적하는 `feat/feedback-v1.5`에 그대로 옮긴(port) 것이다. 테스트
> 번호만 재배정했다: 원래의 `Test-846`~`Test-856` → **`Test-1213`~`Test-1223`**(순서 동일,
> 오프셋 +367). 결정 D1~D8, 기각한 대안, 함정 A~D는 원본과 동일하다. 기존 번호는 그대로다
> (`Test-821`, `Test-721`~`744`는 이 브랜치에도 같은 번호로 존재한다 — 함정 D 참고). 단, 본문
> §1·§7의 코드 포인터줄 번호는 원본 작성 시점(v1.3.0) 기준이므로 위치는 해당 파일에서 다시 확인한다.

R1에서 인간과 합의한 내용의 고충실도 기록. R2(테스트 코드 작성)·구현의 유일한 입력이다.
이 문서에 없는 케이스는 완료 범위 밖이다. 새 케이스를 추가하거나 기존 케이스를 재해석하지 말 것.

작업 유형(R0): **기능 개선 + 숨은 버그 수정**. RED 테스트를 먼저 세운 뒤 GREEN으로 만든다.

선행 작업: 없음. 다만 다음 스펙과의 경계가 있다.

- [`shelf-floating-remote.md`](./shelf-floating-remote.md) · [`split-server-drop.md`](./split-server-drop.md)는 이 스펙의 D1·D2를 **그대로 재사용**한다(연결 활성화 로직을 다시 만들지 말 것).

---

## 1. 문제 정의

사용자 피드백: _"서버 탭에서 서버를 더블 클릭하면 연결이 작동하게."_

서버 목록은 **네 곳**에 있고, 지금까지 규칙이 서로 다르다.

| 표면                                                                                                                                   | 클릭              | 더블클릭              |
| -------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | --------------------- |
| 사이드바 저장 서버 행 ([`Sidebar.tsx:162-168`](../../src/renderer/src/components/layout/Sidebar.tsx#L162-L168))                        | **곧바로 연결**   | 핸들러 없음(부수효과) |
| 주소창 드롭다운 ([`SavedServersPopover.tsx:100-101`](../../src/renderer/src/components/server/SavedServersPopover.tsx#L100-L101))      | 선택(주소만 채움) | 연결                  |
| 서버 관리 다이얼로그 ([`ServerManagerDialog.tsx:330-334`](../../src/renderer/src/components/server/ServerManagerDialog.tsx#L330-L334)) | 선택              | 연결                  |
| 미연결 원격 패널 칩 ([`NotConnectedPane.tsx:45-46`](../../src/renderer/src/components/server/NotConnectedPane.tsx#L45-L46))            | 선택              | 연결                  |

### 원인 1 — 사이드바만 규칙이 다르다

사이드바 행은 `onClick`이 곧 연결이라 "선택해서 상태를 확인한다"는 동작이 없다. 더블클릭하면
첫 클릭이 연결을 시작하고 상태가 `connecting`이 되는 순간 버튼이 `disabled`라(`Sidebar.tsx:171`)
두 번째 클릭은 무시된다 — 더블클릭이 "연결로 인식"되지 않고, 규칙도 다른 표면과 어긋난다.

### 원인 2 — "연결"이 실제로는 두 가지 다른 동작이다 (이것이 체감된 진짜 원인)

`connectSaved`는 저장 비밀번호가 있을 때만 연결하고, 없으면 비밀번호 칸에 포커스만 준다.

```ts
// src/renderer/src/lib/sendItems.ts:311-316
export function connectSaved(saved: FtpServer): void {
  const store = useServerStore.getState()
  store.select(saved)
  if (saved.hasPassword) void store.connect()
  else focusPassword()
}
```

그런데 **드롭다운·관리창·미연결 패널은 이 가드가 없다.** `toDraft(server)`로 바로 `connect()`를
부르면, 비밀번호가 없어도 `password: 'anonymous@'`로 로그인을 시도한다
([`useServerStore.ts:180-182`](../../src/renderer/src/stores/useServerStore.ts#L180-L182)) →
아이디가 있는 서버면 530 실패로 끝난다. 사용자에게는 "더블클릭했는데 연결이 안 된다"로 보인다.

반대로 **사이드바는 정반대의 구멍**을 가진다. `connectSaved`의 가드는 `hasPassword`만 보는데,
익명 서버(`username === ''`)는 저장 비밀번호가 **없는 게 정상**이다
([`servers.test.ts:357`](../../src/main/db/servers.test.ts#L357): `anon` → `hasPassword: false`).
그래서 사이드바에서 익명 서버를 누르면 `focusPassword()`만 불리는데, 비밀번호 칸은
사용자 이름이 있을 때만 그려진다 → **포커스 대상이 없어 아무 일도 일어나지 않는다.**

> 참고: 익명 로그인에 `'anonymous@'` 비밀번호를 쓰는 것은 `connect`의 정상 경로다
> (`useServerStore.ts:182`). 막아야 할 것은 "익명 연결 시도"가 아니라 "아이디가 있는데
> 비밀번호를 모르는 서버에 몰래 빈 비밀번호로 시도하는 것"이다.

---

## 2. 핵심 결정 (R1에서 인간이 확정)

| #   | 결정                                                                                                                                                                                                                     | 근거                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **즉시 연결 판정을 하나의 순수 함수로 통일**한다: `canConnectSaved(server) = 저장 비밀번호 있음 \|\| 익명 서버`. 네 표면 전부 이 함수를 쓴다                                                                             | 원인 2의 두 구멍(무단 빈 비밀번호 시도 / 익명 서버 무반응)을 한 곳에서 없앤다. 순수 함수라 `serverAddress.test.ts`에서 단위로 고정할 수 있다                            |
| D2  | 즉시 연결할 수 없는 서버 → **주소를 채우고 그 맥락의 비밀번호 칸에 포커스**. 연결 시도는 하지 않는다                                                                                                                     | 사용자 이름이 있으면 칸이 실제로 존재하므로 안내가 성립한다. 새 모달·새 i18n 키가 필요 없다                                                                             |
| D3  | 사이드바 규칙 변경: **클릭 = 선택**(툴바 주소 채움), **더블클릭 = 연결**(D1·D2 적용). **연결된 행은 클릭이 루트 이동**, 더블클릭도 같은 동작(연결 시도 없음)                                                             | 피드백의 요구와 다른 세 표면의 기존 규칙을 정렬한다. 연결된 서버에 "연결"은 무의미하므로 이동과 동일하게 둔다                                                           |
| D4  | 드롭다운·관리창·미연결 패널은 **클릭=선택, 더블클릭=연결 현행 유지**. 이 스펙이 바꾸는 것은 D1·D2 적용뿐                                                                                                                 | 이미 규칙이 맞고, 기존 케이스(`Test-721`~`744`, `servers.hint`)가 이를 고정하고 있다                                                                                    |
| D5  | 코드 위치: `canConnectSaved`는 [`lib/serverAddress.ts`](../../src/renderer/src/lib/serverAddress.ts), 활성화 흐름은 [`lib/sendItems.ts`](../../src/renderer/src/lib/sendItems.ts)의 `connectSaved`를 확장해 네 표면 공유 | `toDraft`·`matchServer`·익명 판정이 이미 모여 있는 곳이다. 새 모듈을 만들면 "이미 있는 곳에 두라"는 레포 규칙을 어긴다                                                  |
| D6  | **익명 판정은 `ConnectBar`의 `hasUser`와 같은 기준**이다: `username.trim() !== '' && !/^anonymous$/i.test(...)` — 즉 `anonymous`라는 아이디로 접속하는 서버도 익명                                                       | [`ConnectBar.tsx:169`](../../src/renderer/src/components/server/ConnectBar.tsx#L169)가 비밀번호 칸을 숨기는 기준이다. 두 판정이 갈리면 그 서버는 "연결 불가"로만 남는다 |
| D7  | 사이드바 **미연결 행의 `title`에 기존 `servers.hint`("Enter or double-click to connect")를 덧붙인다**. 드롭 중에는 지금처럼 드롭 안내가 우선한다                                                                         | 규칙이 바뀌었는데 힌트가 드롭다운에만 있어 발견성이 떨어진다. **새 i18n 키 없이** 기존 키를 재사용한다(`en.ts:75`)                                                      |
| D8  | 사이드바 키보드: **Enter = 연결**(D1·D2). 드롭다운의 `servers.hint`가 이미 "Enter or double-click to connect"를 약속한다                                                                                                 | 더블클릭의 키보드 등가물이 필요하다. 클릭→Enter 순서는 드롭다운과 같은 "선택 후 연결" 흐름이 된다                                                                       |

---

## 3. 구현 함정

### 함정 A — `focusPassword`가 문서 전체의 첫 번째 비밀번호 칸을 잡는다

```ts
document.querySelector<HTMLInputElement>('input[type="password"]')?.focus()
```

(`sendItems.ts:319-323`)

툴바 칸이 항상 DOM 앞에 있으므로, **서버 관리 다이얼로그가 열려 있는 동안** 더블클릭하면
포커스가 다이얼로그 밖(툴바)으로 빠진다. 다이얼로그는 자기 안에 포커스를 가두므로 실질적으로
"무반응"이 된다. `focusPassword(scope?: ParentNode)`로 범위를 받고, 관리창은 자기 컨테이너를
넘겨야 한다. `Test-1222`가 이를 고정한다.

### 함정 B — 익명 판정이 두 군데에서 갈린다

D6의 `anonymous` 아이디 서버는 `hasPassword === false`다. `canConnectSaved`가 `hasPassword`만
보면 그 서버는 사이드바·드롭다운·관리창·패널 **네 곳 모두**에서 "연결 불가"가 되어 D2의
포커스만 남는데, 칸은 `hasUser`가 false라 **아예 그려지지 않는다** → 원인 2가 그대로 재현된다.
반대로 `ConnectBar.hasUser`만 참이고 D1이 `''` 판정만 하면 다른 서버에 빈 비밀번호로 시도한다.
**두 판정은 반드시 같은 식 하나를 써야 한다.**

### 함정 C — 사이드바 행은 `disabled` 상태에 걸린다

연결 시작과 동시에 `status === 'connecting'`이 되어 `Sidebar.tsx:171`의 `disabled`가 걸린다.
더블클릭은 `click → click`이라 두 번째 클릭이 죽는다. D3에서 "더블클릭 = 연결"로 정의했으므로,
**첫 클릭(선택)과 더블클릭의 분기를 명시적으로** (`onDoubleClick`에서 연결) 처리해야 하고,
`connecting` 중의 재진입은 `useServerStore.connect:141` (`if (connecting) return false`)이
막는다는 것을 믿고 행을 `disabled`로 만들지 말아야 한다 — 그래야 선택 상태와 힌트가 살아 있다.
단, **연결 중 다른 서버 더블클릭**은 `connectAttempt`가 앞의 시도를 무효화한다
(`useServerStore.ts:151,161`)는 점을 그대로 활용한다.

### 함정 D — 기존 `Test-821`의 두 `it`이 같은 번호를 쓴다

`Sidebar.test.tsx`의 두 `it`이 둘 다 `covers: Test-821`이다(이 브랜치의 업스트림에서도 그대로다 —
`git grep "covers: Test-" -- src/renderer/src/components/layout/Sidebar.test.tsx`로 확인: 첫째
`it` "shows the connected server with its status and four recent folders", 둘째 `it` "connects a
saved server with a saved password, or selects it and focuses the password field"). D3으로
**둘째 `it`의 기대가 바뀐다**(클릭 → 연결이었다). 규칙대로 케이스를 재해석하지 말고, **둘째 `it`을
`Test-1214`로 옮겨 새 기대를 적고**, `Test-821`은 첫째 `it`(연결된 서버 상태·최근 폴더)만 남긴다.
이전 번호는 비운다.

---

## 4. 대상 API

```ts
// src/renderer/src/lib/serverAddress.ts

/** 아이디가 있는 서버인지. ConnectBar가 비밀번호 칸을 그리는 기준과 반드시 같다(D6). */
export function hasUser(username: string): boolean

/**
 * 저장 서버를 곧바로 연결할 수 있는지(D1).
 * 저장 비밀번호가 있거나, 익명(아이디 없음·`anonymous`) 서버면 true.
 * 아이디만 있고 비밀번호를 모르는 서버는 false → 호출부는 D2(비밀번호 칸 포커스)로 간다.
 */
export function canConnectSaved(server: Pick<FtpServer, 'username' | 'hasPassword'>): boolean
```

```ts
// src/renderer/src/lib/sendItems.ts

/** 포커스할 비밀번호 칸의 범위. 없으면 문서 전체(툴바). 관리창은 자기 컨테이너를 넘긴다(함정 A). */
function focusPassword(scope?: ParentNode): void

/**
 * 서버를 활성화한다. 네 표면의 유일한 진입점(D5).
 * 1) 주소를 채운다 2) D1이면 연결 3) 아니면 해당 맥락의 비밀번호 칸에 포커스(D2)
 */
export function connectSaved(saved: FtpServer, scope?: ParentNode): void
```

네 표면의 호출 형태:

```tsx
// 사이드바 (D3): 클릭=선택, 더블클릭=연결, 연결된 행=루트 이동
<button
  onClick={(e) => {
    if (!root) return selectOnly(row.saved)            // 선택만: useServerStore.select
    if (e.ctrlKey || e.metaKey) openTab(root)
    else navigate(root)
  }}
  onDoubleClick={() => !root && row.saved && connectSaved(row.saved)}
  onKeyDown={(e) => {                                  // D8
    if (e.key !== 'Enter' || root) return
    e.preventDefault()
    row.saved ? connectSaved(row.saved) : connectToServer(row.key)
  }}
  title={drop.over ? ... : rowStatus === 'connected' ? sub : `${sub} · ${t('servers.hint')}`}
/>

// 드롭다운 (D4 현행 + D1·D2)
onClick={() => onPick(s, false)}                       // 선택 — 그대로
onDoubleClick={() => onPick(s, true)}                  // onPick이 connectSaved 경로로 바뀐다

// 관리창 (D4 현행 + D1·D2 + 함정 A)
onDoubleClick={() => {
  select(s)
  if (connecting) return
  connectSaved(s, dialogRef.current)                   // 범위를 자기로 지정
    .then(... )                                        // 연결에 실패하면 다이얼로그를 닫지 않는다
}}

// 미연결 패널 칩 (D4 현행 + D1·D2)
onClick={() => select(s)}
onDoubleClick={() => connectSaved(s)}
```

> `connectSaved`의 반환 계약: **연결을 실제로 시작했는지 여부**를 알 수 있어야 관리창이
> "성공했을 때만 닫는다"를 유지한다(`ServerManagerDialog.tsx:331-334`). 지금은 `void`라
> `.then`이 불가능하므로 `Promise<boolean>`로 바꾼다(D2로 연결을 건너뛴 경우 `false`).

---

## 5. 기각한 대안

- **사이드바의 클릭=연결을 유지하고 더블클릭만 추가** — 표면마다 규칙이 계속 다르고, 실수
  한 번의 클릭에 이미 연결이 걸린다. "더블클릭하면 연결"이라는 요구의 전제(클릭은 선택)가
  깨진다. 기각.
- **비밀번호 미저장 서버는 항상 모달로 입력받기** — 새 모달 + 11개 로케일 키가 필요하고,
  지금도 칸이 화면에 있다. D2의 포커스가 더 싸고 충분하다. 기각. 단, **관리창에서 포커스가
  새는 문제(함정 A)는 별도로 D2·Test-1222로 해결한다.**
- **익명 서버에도 비밀번호를 입력받기** — 익명 로그인에는 비밀번호가 필요 없다. 기각.
- **`connectSaved`를 새 파일(`serverActivation.ts`)로 빼기** — 호출부 4개와 `toDraft`·`hasUser`
  가 이미 `serverAddress.ts`·`sendItems.ts`에 모여 있다. 새 모듈은 위치만 흩은 끝이다. 기각(D5).
- **`connecting` 동안 행을 계속 `disabled`로 두기** — 상태 표시와 힌트가 사라지고, D8의 Enter
  동작도 죽는다. 중복 연결은 스토어가 이미 막는다(함정 C). 기각.

---

## 6. 테스트 케이스 리스트 (확정)

`Test-1213`부터 신규. 이 체크아웃의 업스트림 기준선(upstream `origin/main`)은 `Test-1201`이다.
각 테스트에 `covers: Test-N` 주석을 단다. **1:1 매핑. 케이스 추가·병합·재해석 금지.**

### A. 규칙 헬퍼 (`lib/serverAddress.test.ts`)

| #         | 케이스                                                                                            | 기대                                                                          |
| --------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Test-1213 | `canConnectSaved` 세 갈래: 저장 비밀번호 O / 아이디만 있는 서버 X / 익명(빈 아이디·`anonymous`) O | D1과 D6가 한 함수에 모여 있고, 두 갈래의 실패(무단 시도·무반응)가 모두 막힌다 |

### B. 사이드바 (`layout/Sidebar.test.tsx`)

| #         | 케이스                                                                                                | 기대                                                                                      |
| --------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Test-1214 | **미연결 저장 서버: 클릭은 선택만, 더블클릭은 연결** (기존 `Test-821`의 둘째 `it`을 여기로 이전·개정) | 클릭 → `ftp:connect` 호출 **0회** + 툴바 주소가 그 서버. 더블클릭 → `ftp:connect` **1회** |
| Test-1215 | **익명 서버(빈 아이디) 더블클릭**                                                                     | `ftp:connect` 1회 — 이전에는 무반응이었다(원인 2)                                         |
| Test-1216 | **아이디만 있고 저장 비밀번호 없는 서버 더블클릭**                                                    | `ftp:connect` **0회** + 비밀번호 칸에 포커스 (D2)                                         |
| Test-1217 | **연결된 서버 행의 더블클릭**                                                                         | `ftp:connect` 0회, 활성 탭이 그 서버의 루트로 이동(더블클릭이 추가 동작을 만들지 않는다)  |
| Test-1218 | 미연결 행의 `title` (D7)                                                                              | `host:port`와 `servers.hint`가 함께 보인다. 드롭 중이면 드롭 안내가 우선한다              |

### C. 주소창 드롭다운 · 미연결 패널 (`server/ConnectBar.test.tsx`)

| #         | 케이스                                                         | 기대                                                                                |
| --------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Test-1219 | 드롭다운에서 **아이디만 있는 서버 더블클릭**                   | 주소는 채워지되 `ftp:connect` 0회 + 툴바 비밀번호 칸 포커스 (D1·D2가 처음 적용된다) |
| Test-1220 | 드롭다운에서 **익명 서버 더블클릭**                            | `ftp:connect` 1회                                                                   |
| Test-1221 | 미연결 패널 칩 두 갈래(익명 → 연결 / 아이디만 → 포커스·미연결) | `NotConnectedPane`도 같은 진입점(`connectSaved`)을 쓴다                             |

### D. 서버 관리 다이얼로그 (`server/ServerManagerDialog.test.tsx`)

| #         | 케이스                                                        | 기대                                                                                                |
| --------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Test-1222 | **아이디만 있는 서버 더블클릭** — 다이얼로그가 열려 있는 상태 | `ftp:connect` 0회, 포커스가 **다이얼로그 안의 비밀번호 칸**에 간다 (함정 A)                         |
| Test-1223 | 익명 서버 더블클릭 → 연결 성공                                | `ftp:connect` 1회, **성공했을 때만** 다이얼로그가 닫힌다 (`connectSaved`의 `Promise<boolean>` 계약) |

- `Test-821`은 첫째 `it`(연결된 서버의 상태 점·최근 폴더 4개)만 남긴다(함정 D).
- 기존 `Test-721`~`744`(드롭다운·비밀번호 규칙)와 `servers.hint`는 **그대로 GREEN이어야 한다.**
- E2E가 전담할 것: 네 표면을 실제로 오가며 "클릭=선택, 더블클릭=연결"이 같은 서버에서
  동일하게 느껴지는지(§8 표).

---

## 7. 관련 코드 포인터

| 파일                                                                                                                                                                                                                                                                                                              | 역할                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [`lib/sendItems.ts`](../../src/renderer/src/lib/sendItems.ts)                                                                                                                                                                                                                                                     | `connectSaved` L311-316(확장 대상), `focusPassword` L319-323(함정 A), `connectToServer` L292-308 |
| [`lib/serverAddress.ts`](../../src/renderer/src/lib/serverAddress.ts)                                                                                                                                                                                                                                             | `toDraft` L128-136, `savedPassword` L108. `hasUser`·`canConnectSaved`를 새로 넣는다              |
| [`components/layout/Sidebar.tsx`](../../src/renderer/src/components/layout/Sidebar.tsx)                                                                                                                                                                                                                           | `ServerRow` L142-203(클릭·더블클릭·Enter·title), `Servers` L206-267(`onActivate` L255)           |
| [`components/server/SavedServersPopover.tsx`](../../src/renderer/src/components/server/SavedServersPopover.tsx)                                                                                                                                                                                                   | L100-101 클릭/더블클릭. `onPick`의 연결 경로만 바뀐다                                            |
| [`components/server/ConnectBar.tsx`](../../src/renderer/src/components/server/ConnectBar.tsx)                                                                                                                                                                                                                     | `pick` L~250-270, `hasUser` L169(D6의 기준), `PasswordInput` L229                                |
| [`components/server/ServerManagerDialog.tsx`](../../src/renderer/src/components/server/ServerManagerDialog.tsx)                                                                                                                                                                                                   | L330-334 더블클릭, `dialogRef` L45(함정 A의 범위)                                                |
| [`components/server/NotConnectedPane.tsx`](../../src/renderer/src/components/server/NotConnectedPane.tsx)                                                                                                                                                                                                         | L45-46 칩 클릭/더블클릭                                                                          |
| [`stores/useServerStore.ts`](../../src/renderer/src/stores/useServerStore.ts)                                                                                                                                                                                                                                     | `connect` L140-204(연결 중 재진입·시도 무효화·`'anonymous@'` 경로 L180-182)                      |
| [`components/layout/Sidebar.test.tsx`](../../src/renderer/src/components/layout/Sidebar.test.tsx) · [`server/ConnectBar.test.tsx`](../../src/renderer/src/components/server/ConnectBar.test.tsx) · [`server/ServerManagerDialog.test.tsx`](../../src/renderer/src/components/server/ServerManagerDialog.test.tsx) | 테스트 하네스(`renderToolbar(withPane)`, `place()`, `h.handlers`)가 이미 있다                    |

---

## 8. 완료 기준

1. `Test-1213`~`Test-1223`가 모두 GREEN (실행 출력으로 확인).
2. **기존 `Test-721`·`722`·`724`·`726`·`729`·`744`, `Test-821`(첫째 `it`)이 계속 GREEN.**
3. 각 신규 테스트에 `covers: Test-N` 주석. `Test-1214`로 옮긴 `it`의 태그를 정확히 갱신하고
   `Test-821` 태그가 둘째 `it`에 남지 않았는지 확인한다.
4. 뮤테이션: `git diff --unified=0 -- src/renderer/src/lib/sendItems.ts src/renderer/src/lib/serverAddress.ts src/renderer/src/components/layout/Sidebar.tsx src/renderer/src/components/server/*.tsx | grep '^@@'`로
   변경 라인을 확인해 `stryker.config.json`의 `mutate`를 갱신하고 `break: 70` 통과.
5. `npm run typecheck` · `npm run lint` · `npx prettier --check <변경 파일>` · `npm test` 통과.
6. **i18n 키 추가 없음** (D7은 기존 키 재사용). `i18n.test.ts`가 그대로 GREEN이어야 한다.
7. E2E 실측 (실기기 R3):

   | 항목 | 확인 내용                                                                                             |
   | ---- | ----------------------------------------------------------------------------------------------------- |
   | (a)  | 사이드바에서 저장 서버를 **한 번 클릭** → 연결되지 않고 툴바 주소만 바뀐다                            |
   | (b)  | 같은 행을 **더블클릭** → 연결되어 그 서버의 폴더가 열린다                                             |
   | (c)  | 저장 비밀번호가 없는(아이디 있는) 서버 더블클릭 → **실패 메시지 없이** 툴바 비밀번호 칸에 커서가 간다 |
   | (d)  | 익명 서버(아이디 없음)를 사이드바·드롭다운·미연결 패널 어디서 더블클릭해도 **바로 연결**된다          |
   | (e)  | 서버 관리 다이얼로그를 연 채 (c)를 더블클릭 → 커서가 **다이얼로그 안** 비밀번호 칸으로 간다           |
   | (f)  | 연결된 서버 행을 클릭/더블클릭 → 루트로 이동하며 연결이 새로 걸리지 않는다                            |
   | (g)  | 드롭다운·미연결 패널의 기존 동작(선택→Enter 연결, `servers.hint` 문구)이 그대로다                     |
