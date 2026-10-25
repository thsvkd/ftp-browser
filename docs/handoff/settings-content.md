# 핸드오프: 설정창 콘텐츠 보강 — 화면 · 계정/보안 · 정보 섹션 추가

R1에서 인간과 합의한 내용의 고충실도 기록. R2(테스트 코드 작성)·구현의 유일한 입력이다.
이 문서에 없는 케이스는 완료 범위 밖이다. 새 케이스를 추가하거나 기존 케이스를 재해석하지 말 것.

작업 유형(R0): **기능 추가**. RED 테스트를 먼저 세운 뒤 GREEN으로 만든다.

선행 작업: 없음.
후속 연결: [`shelf-floating-remote.md`](./shelf-floating-remote.md)(6번)이 `showRail`을 그대로
계속 쓴다 — **레일을 없애는 게 아니라 세그먼트만 바꾸므로 이 스펙의 토글은 유효해야 한다.**

---

## 1. 문제 정의

사용자 피드백: _"설정창이 너무 콘텐츠가 부실한데 어떤 것을 넣으면 좋을지 제안해줘."_

R1에서 제안 목록을 논의해 아래 묶음을 확정했다. 지금 설정창에 있는 것은
**언어 · 테마 · 썸네일 크기 · 숨김 파일 · 삭제 확인 · 캐시 정리 · 업데이트 · 에이전트** 여덟 개
뿐이다([`SettingsDialog.tsx:183-432`](../../src/renderer/src/components/settings/SettingsDialog.tsx#L183-L432)).

### 넣기로 한 것 / 넣지 않기로 한 것

| 넣는다                                                   | 이유 / 지금 상태                                                                                                               |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **기본 보기 모드**(그리드/목록)                          | `useSettingsStore.viewMode`·`setViewMode`가 **이미 있는데 설정창에 없다.** 탭을 새로 열 때만 쓰여 지금은 어디서도 고를 수 없다 |
| **화면: 사이드바 표시 / 오른쪽 레일 표시**               | 넓은 화면에서 탐색 영역을 늘리려는 수요. 저장·지속이 필요하므로 스토어 필드로 만든다                                           |
| **계정 · 보안**: 저장된 서버 수, 저장 비밀번호 보호 수준 | 지금은 보호 수준이 `basic`·`none`일 때 **폼 안에 경고 한 줄**로만 나온다. 얼마나 위험한지 알리는 자리가 필요하다               |
| **캐시: 상한 표시**                                      | 통계·정리는 있는데 "언제까지 쌓이나"가 안 보인다. `MAX_CACHE_SIZE_BYTES`는 `@shared`에 있어 렌더러가 바로 읽는다               |
| **정보: 플랫폼 · 버전 · 진단 정보 복사**                 | 문제 제보 때 필요한 조합을 한 번에 복사한다. **새 IPC 없이** 가능하다(아래 S4)                                                 |
| **설정 초기화**                                          | 구조가 커진 만큼 되돌릴 자리가 필요하다                                                                                        |

| 넣지 않는다 (기각)                                      | 이유                                                                                            |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **단축키 치트시트**                                     | 항목 설명마다 11개 로케일 번역이 필요해 이번 스펙의 범위를 넘는다. 별도 스펙 후보               |
| **데이터 폴더 열기**                                    | `shell.openPath`용 신규 채널(핸들러·허용목록·유니언 3곳)이 필요하다                             |
| **전송(동시 연결 수·세그먼트) 설정**                    | 연결 수는 **서버별** 설정으로 이미 `ServerForm`에 있다(`maxTransfers`). 전역으로 뺄 근거가 없다 |
| **미리보기 크기 상한 설정**                             | [`lightbox-video-playback.md`](./lightbox-video-playback.md)의 상한과 한 묶음이라 분리한다      |
| **언어·테마를 섹션 헤더 없는 첫 블록에 두는 구조 변경** | 지금 그대로 쓰고 있다. 형식 변경은 콘텐츠 추가와 무관하다                                       |

---

## 2. 핵심 결정 (R1에서 인간이 확정)

| #   | 결정                                                                                                                                                          | 근거                                                                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | 설정창 섹션 순서: **일반(언어·테마·기본 보기 모드) → 격자 → 탐색 → 화면 → 계정·보안 → 캐시 → 업데이트 → 에이전트 → 정보**                                     | 지금 순서(언어/테마 → 격자 → 탐색 → 캐시 → 업데이트 → 에이전트)를 유지하고 **앞뒤에만 끼운다.** 기존 `Test-204`~`845`가 참조하는 순서·구조를 깨지 않는다                                                                    |
| S2  | 기본 보기 모드는 `<select>`가 아니라 **격자 크기와 같은 줄의 세그먼트(그리드/목록)**로, 기존 "격자" 섹션이 아니라 "일반"에 둔다                               | 보기 모드는 격자 하나의 속성이 아니라 **새 탭의 기본값**이다(D16). 격자 섹션은 크기 전용으로 남는다                                                                                                                         |
| S3  | 화면 토글은 `useSettingsStore`에 **`showSidebar` · `showRail` 두 필드**(기본 `true`)를 추가하고, `AppShell`이 조건부로 렌더링한다                             | 설정은 persist 대상이어야 재시작 후 유지된다. 렌더러 로컬 state로 두면 창을 닫으면 사라진다                                                                                                                                 |
| S4  | 정보 섹션은 **새 IPC 없이** 만든다: 플랫폼·버전은 `window.electron.process.platform` / `.versions`, 앱 버전은 이미 받아 두는 `update:getState.currentVersion` | `@electron-toolkit/preload`가 `process`(platform·versions)를 노출한다. 채널을 하나도 늘리지 않고 끝난다                                                                                                                     |
| S5  | 진단 정보 복사는 **클립보드 한 줄**로: `FTP Browser <앱버전> · <os> · electron <v> · node <v> · locale <현재 로케일>`                                         | 제보에 필요한 게 이 조합이다. `navigator.clipboard.writeText`로 끝나며, 실패해도 조용히 토스트로 알린다                                                                                                                     |
| S6  | 보호 수준 표시는 **경고를 "계정·보안" 섹션으로 옮긴다.** `basic`·`none`일 때만 문구를 보여주는 기존 규칙은 그대로 두고, 섹션 헤더 아래로 옮긴다               | 기존 경고는 언어/테마 섹션 바로 아래에 붙어 있어 무슨 말인지 맥락이 없다([`SettingsDialog.tsx:~183`](../../src/renderer/src/components/settings/SettingsDialog.tsx#L183)). 섹션 안에서는 항상 보인다(보호 수준 표시 + 상태) |
| S7  | 설정 초기화는 **`confirmDialog`**(기존 확인 모달)를 거쳐 **모든 설정을 초기값으로** 되돌린다 — 언어·테마 포함 `system`                                        | 절반만 초기화하면 "무엇이 초기화됐는지"가 설명 불가능하다. 확인 모달은 이미 `useConfirmStore`에 있다                                                                                                                        |
| S8  | 새 i18n 키는 아래 표만큼만 만들고 **`en.ts` + 10개 로케일**에 넣는다. 절대 개수·문구를 스펙 밖에서 늘리지 않는다                                              | 키 누락은 typecheck, 플레이스홀더 불일치는 `i18n.test.ts`에서 걸린다                                                                                                                                                        |

---

## 3. 구현 함정

### 함정 A — `showSidebar: false`가 F6 사이클과 드롭 대상을 깨뜨린다

`AppShell`의 F6 순서(`REGIONS`, `AppShell.tsx:21-30`)는 CSS 쿼리를 찾아 null을 필터링하므로
사이드바가 사라져도 **자체적으로는 안전**하다. 하지만 대상이 하나도 없을 때
`els[cur].focus()`로 가는 경로를 확인해야 한다. 그리고 **드롭 대상**인 사이드바 장소 행이
사라지면 끌던 파일의 `over` 상태가 남을 수 있다 — AppShell의 루트 `onDragOver`가
`over`를 지우므로 끌기를 계속해도 무방하다(`AppShell.tsx:111-114`).
`Test-892`가 "그려지지 않는다"를, 기존 F6·드롭 케이스가 회귀를 본다.

### 함정 B — 설정창이 `open`일 때만 데이터를 가져온다

캐시 통계·업데이트·에이전트 상태는 `useEffect(..., [open])`에서 가져온다
([`SettingsDialog.tsx:64-73`](../../src/renderer/src/components/settings/SettingsDialog.tsx#L64-L73)).
**새로 넣는 정보(플랫폼·버전)·계정(서버 수·보호 수준)도 같은 규칙**을 따라야 한다 —
컴포넌트가 마운트돼 있는 동안에만 읽는다. `window.electron.process`는 매번 읽어도 되지만,
`ftp:getPasswordProtection`는 지금도 `open`일 때만 부른다(L80-89)를 그대로 따른다.

### 함정 C — 저장된 서버 수는 `useServerStore.servers`가 이미 로드돼 있다는 보장이 없다

서버 목록은 `ConnectBar`가 `loadServers(true)`로 부른 뒤에 채워진다. 설정창이 **앱 시작 직후
먼저 열리면 `servers`가 비어** "저장된 서버 0개"로 잘못 보인다. 설정창이 열릴 때
`loadServers()`를 한 번 더 부르거나, 비어 있을 때 `common.loading`을 써야 한다.
`Test-888`이 로드 전 상태에서의 표시를 함께 단언한다.

### 함정 D — 초기화가 진행 중인 값을 바꾼다

`reset()`이 타일 크기·기본 보기를 초기값으로 되돌리면 **열려 있는 탭들의 보기는 그대로**다
(탭마다 자기 `viewMode`를 가진다 — `useSettingsStore` L10의 주석). 이는 의도된 동작이다:
초기화는 **앞으로 열리는 탭**에만 적용된다. 테스트가 열려 있던 탭의 보기까지 초기화를
기대하면 잘못된 기대가 된다. 스펙의 `Test-891`은 스토어 값만 단언한다.

### 함정 E — `reset()`이 persist를 깨뜨리지 않아야 한다

`persist`의 `migrate`(L39-47)는 저장본에 없는 필드를 기본값으로 채운다. 신규 필드 두 개를
`migrate`에 명시해 넣지는 않아도 되지만, **`version`을 올렸다면** `SettingsV1`과 같은
형태로 처리해야 한다(이번에는 필드 추가뿐이라 버전 상승 없음). 함정은 `reset()`이
`partialize`·`version` 옵션과 충돌하는 쪽이다: **`reset()`은 `set()`으로 초기값만 넣고,
persist 설정(`name`·`version`·`migrate`)은 건드리지 않는다.**

---

## 4. 대상 API

```ts
// src/renderer/src/stores/useSettingsStore.ts

interface SettingsStore {
  // ...기존
  /** 왼쪽 사이드바를 그릴지(S3). 기본 true. */
  showSidebar: boolean
  /** 오른쪽 레일을 그릴지(S3). 기본 true. 선반 이동(6번) 이후에도 이 값은 유효하다. */
  showRail: boolean

  setShowSidebar: (show: boolean) => void
  setShowRail: (show: boolean) => void
  /** 모든 설정을 초기값으로(S7): 타일·기본 보기·숨김·삭제 확인·언어·테마·화면 토글. */
  reset: () => void
}
```

```tsx
// src/renderer/src/components/layout/AppShell.tsx (S3)
const showSidebar = useSettingsStore((s) => s.showSidebar)
const showRail = useSettingsStore((s) => s.showRail)
...
<div className="flex min-h-0 flex-1">
  {showSidebar && <Sidebar />}
  <main data-region="content" ...>...</main>
  {showRail && <RightRail />}
</div>
```

설정창 신규 블록 (기존 `<section>` 형식 그대로):

```tsx
{/* 일반 — 기존 블록에 한 줄 추가 (S2) */}
<label className="mt-3 flex items-center justify-between gap-6">
  <span className="text-sm text-[var(--tx)]">{t('settings.viewMode')}</span>
  <div className="flex w-56 shrink-0 rounded-full bg-[var(--bg)] p-1 text-[12.5px]">
    <button aria-pressed={viewMode === 'grid'}  onClick={() => setViewMode('grid')}>  {t('settings.viewModeGrid')}  </button>
    <button aria-pressed={viewMode === 'list'}  onClick={() => setViewMode('list')}>  {t('settings.viewModeList')}  </button>
  </div>
</label>

{/* 화면 (S3) */}
<section>
  <h3>{t('settings.display')}</h3>
  <label>...{t('settings.showSidebar')} <input type="checkbox" checked={showSidebar} ... /></label>
  <label>...{t('settings.showRail')}   <input type="checkbox" checked={showRail}   ... /></label>
</section>

{/* 계정 · 보안 (S6) */}
<section>
  <h3>{t('settings.account')}</h3>
  <p>{t('settings.savedServersCount', { count: servers.length })}</p>   {/* 복수: _one/_other */}
  <p>{t('settings.passwordProtectionLevel')}: {level === 'strong' ? t('settings.passwordProtectionStrong')
      : level === 'basic' ? t('servers.passwordProtectionBasic')        /* 기존 키 재사용 */
      : t('servers.passwordProtectionNone')}</p>
  {level !== 'strong' && <p className="text-[var(--dg)]">{기존 경고 문구}</p>}
</section>

{/* 캐시 — 통계 줄에 상한만 더한다 (S4와 무관, 상한은 @shared) */}
<p className="text-xs text-[var(--mu)]">{t('settings.cacheLimit', { size: formatBytes(MAX_CACHE_SIZE_BYTES) })}</p>

{/* 정보 (S4·S5) */}
<section>
  <h3>{t('settings.about')}</h3>
  <dl>platform / app / electron / node</dl>
  <button onClick={copyDiagnostics}>{t('settings.copyDiagnostics')}</button>
</section>
```

새 i18n 키 (**이 표에 있는 것만**, `en.ts` 원본 + 10개 로케일):

| 키                                  | 예시 (en)                             |
| ----------------------------------- | ------------------------------------- |
| `settings.viewMode`                 | `Default view for new tabs`           |
| `settings.viewModeGrid`             | `Grid`                                |
| `settings.viewModeList`             | `List`                                |
| `settings.display`                  | `Display`                             |
| `settings.showSidebar`              | `Show the sidebar`                    |
| `settings.showRail`                 | `Show the right panel`                |
| `settings.account`                  | `Account & security`                  |
| `settings.savedServersCount_one`    | `{{count}} saved server`              |
| `settings.savedServersCount_other`  | `{{count}} saved servers`             |
| `settings.passwordProtectionLevel`  | `Saved password protection`           |
| `settings.passwordProtectionStrong` | `Encrypted with the system keychain`  |
| `settings.cacheLimit`               | `Kept up to {{size}}`                 |
| `settings.about`                    | `About`                               |
| `settings.copyDiagnostics`          | `Copy diagnostics`                    |
| `settings.diagnosticsCopied`        | `Diagnostics copied`                  |
| `settings.reset`                    | `Reset all settings`                  |
| `settings.resetConfirm`             | `Reset every setting to its default?` |
| `settings.resetDone`                | `Settings reset`                      |

(`settings.passwordProtectionBasic`·`None`는 기존 `servers.*` 키를 재사용한다 — 새 키를 만들지 않는다.)

---

## 5. 기각한 대안

- **단축키 치트시트** — 내용이 가장 크게 늘지만, 항목 설명 15개 안팎 × 11 로케일의 번역이
  필요하고 실제 단축키 배치(AppShell·TabStrip·목록에 흩어져 있다)를 먼저 정리해야 한다.
  **다음 사이클의 별도 스펙**으로 남긴다.
- **"데이터 폴더 열기" 버튼** — `shell.openPath` 신규 채널 3곳 등록 + 계약 테스트. 지금 정보
  섹션의 목적(제보용 진단 복사)을 이루는 데 필요 없다. 기각.
- **전송 섹션 신설** — 전역으로 뺄 설정이 없다. 동시 연결 수는 서버별 `maxTransfers`로 이미
  `ServerForm`에 있고, 분할 기준·캐시 상한은 상수다(S4의 캐시 상한은 표시만 한다).
  존재하지 않는 설정 카드를 만드는 것보다 비어 있는 편이 낫다. 기각.
- **설정 항목을 좌측 탭(일반/전송/보안/고급)으로 나누기** — 680px 대화상자에서 탭은 현재
  한 화면에 다 보이는 구조를 깬다. 지금처럼 단일 스크롤 + 섹션이 이 앱의 형식이다. 기각.
- **`showSidebar`·`showRail`을 로컬 스토리지가 아닌 스토어에 두지 않기** — persist 대상에서
  빼면 재시작 후 복원되지 않는다. 기각.
- **진단 복사에 로그·DB 스키마 포함** — 개인정보·경로 노출이 생기고 수집처도 마땅치 않다.
  버전 조합만으로 제보의 대다수(환경 문제)를 가른다(S5). 기각.

---

## 6. 테스트 케이스 리스트 (확정)

`Test-883`부터 신규. 기존 최대 번호는 `Test-882`([`lightbox-video-playback.md`](./lightbox-video-playback.md)).
각 테스트에 `covers: Test-N` 주석을 단다. **1:1 매핑. 케이스 추가·병합·재해석 금지.**

### A. 스토어 (`stores/useSettingsStore.test.ts`)

| #        | 케이스                                                                                       | 기대                                     |
| -------- | -------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Test-883 | `showSidebar`·`showRail`은 기본 `true`, setter로 끌 수 있고 persist에 남는다                 | S3                                       |
| Test-884 | `reset()`이 타일·기본 보기·숨김·삭제 확인·언어·테마·화면 토글 **전부**를 초기값으로 되돌린다 | S7. 일부만 초기화하는 구현을 막는다      |
| Test-885 | 신규 필드가 없는 예전 저장본을 불러와도 두 필드는 `true`로 채워진다                          | 함정 E. `migrate`·persist 병합 회귀 방어 |

### B. 설정창 (`components/settings/SettingsDialog.test.tsx`)

| #        | 케이스                                                                                                                       | 기대                                                       |
| -------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Test-886 | "일반"의 기본 보기 모드 세그먼트를 `목록`으로 고르면 `useSettingsStore.viewMode`가 `list`가 된다                             | S2. 지금 스토어에만 있고 노출이 없었다                     |
| Test-887 | "화면" 섹션의 두 토글이 보이고 하나를 끄면 해당 스토어 값이 `false`가 된다                                                   | S3                                                         |
| Test-888 | "계정·보안" 섹션에 저장된 서버 수와 보호 수준이 보인다 — **서버가 아직 로드되기 전이어도 0개로 단정하지 않고 로드를 부른다** | S6·함정 C                                                  |
| Test-889 | "캐시" 섹션이 사용량과 함께 **상한(`MAX_CACHE_SIZE_BYTES` 포맷)**을 보여준다                                                 | S4와 구별: 여기는 캐시 상한                                |
| Test-890 | "정보" 섹션이 플랫폼·앱 버전·electron·node를 보이고, 진단 복사 버튼이 클립보드에 **S5의 한 줄 형식**을 넣는다                | S4·S5. 새 IPC를 쓰지 않았음(채널 호출 0회)도 함께 단언한다 |
| Test-891 | 초기화 버튼 → 확인하면 스토어가 초기값으로, 취소하면 그대로 남는다                                                           | S7·confirmDialog 경유                                      |

### C. 적용 (`components/layout/AppShell.test.tsx`)

| #        | 케이스                                                                                    | 기대                                                               |
| -------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Test-892 | `showSidebar: false`면 AppShell이 사이드바를 그리지 않고 콘텐츠 영역이 그 자리를 차지한다 | S3·함정 A                                                          |
| Test-893 | `showRail: false`면 오른쪽 레일이 그려지지 않는다                                         | S3. 선반 이동(6번) 뒤에도 이 토글이 계속 성립해야 함을 함께 지킨다 |

- 기존 `Test-204`·`205`·`210`·`212`·`218`·`219`·`252`·`253`·`294`·`752`·`845`(업데이트·에이전트·언어·테마)
  은 **그대로 GREEN이어야 한다.** 특히 `Test-845`(언어·테마)는 첫 섹션에 줄이 하나 추가돼도
  깨지지 않아야 한다.
- E2E가 전담할 것: 실제 창에서 토글을 켜고 재시작해 유지되는지(§8 표).

---

## 7. 관련 코드 포인터

| 파일                                                                                                                                                                                                      | 역할                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [`components/settings/SettingsDialog.tsx`](../../src/renderer/src/components/settings/SettingsDialog.tsx)                                                                                                 | 섹션 구조 L182-432, `open` 효과 L64-89(함정 B), `CacheStats` 로컬 타입 L20, `copyCommand` L~110(복사 패턴) |
| [`stores/useSettingsStore.ts`](../../src/renderer/src/stores/useSettingsStore.ts)                                                                                                                         | 필드·setter L8-26, 기본값 L52-57, persist L49-72(함정 E)                                                   |
| [`components/layout/AppShell.tsx`](../../src/renderer/src/components/layout/AppShell.tsx)                                                                                                                 | 레이아웃 L117-124(조건부 렌더), `REGIONS` L21-30(함정 A)                                                   |
| [`components/layout/Sidebar.test.tsx`](../../src/renderer/src/components/layout/Sidebar.test.tsx) · [`components/layout/RightRail.test.tsx`](../../src/renderer/src/components/layout/RightRail.test.tsx) | 컴포넌트 단위 하네스                                                                                       |
| [`stores/useConfirmStore.ts`](../../src/renderer/src/stores/useConfirmStore.ts)                                                                                                                           | `confirmDialog`(S7의 확인 흐름)                                                                            |
| [`main/thumbnail/CacheManager.ts`](../../src/main/thumbnail/CacheManager.ts) · [`shared/constants.ts`](../../src/shared/constants.ts)                                                                     | `getStats`·`MAX_CACHE_SIZE_BYTES`(S4의 상한 출처)                                                          |
| [`shared/types/update.ts`](../../src/shared/types/update.ts)                                                                                                                                              | `UpdateState.currentVersion`(S4의 앱 버전 출처)                                                            |
| `@electron-toolkit/preload` 타입                                                                                                                                                                          | `window.electron.process.platform`·`.versions`(S4 — 새 IPC 없음의 근거)                                    |

---

## 8. 완료 기준

1. `Test-883`~`Test-893`이 모두 GREEN (실행 출력으로 확인).
2. **기존 `Test-204`·`205`·`210`·`212`·`218`·`219`·`252`·`253`·`294`·`752`·`845`가 계속 GREEN.**
3. 각 신규 테스트에 `covers: Test-N` 주석.
4. **새 i18n 키 18개**가 `en.ts`와 10개 로케일 전부에 있고, 복수형은 `_one`/`_other`를 갖는다.
   `i18n.test.ts`와 typecheck가 GREEN이어야 한다.
5. **새 IPC 채널 0개.** `src/preload/index.ts`·`index.d.ts`가 바뀌지 않았는지 확인한다.
6. 뮤테이션: `git diff --unified=0 -- src/renderer/src/components/settings/SettingsDialog.tsx src/renderer/src/stores/useSettingsStore.ts src/renderer/src/components/layout/AppShell.tsx | grep '^@@'`로
   변경 라인을 확인해 `stryker.config.json`의 `mutate`를 갱신하고 `break: 70` 통과.
7. `npm run typecheck` · `npm run lint` · `npx prettier --check <변경 파일>` · `npm test` 통과.
8. E2E 실측 (실기기 R3):

   | 항목 | 확인 내용                                                                                          |
   | ---- | -------------------------------------------------------------------------------------------------- |
   | (a)  | 설정에서 사이드바·레일을 끄고 닫으면 **바로 반영**되고, 앱을 재시작해도 **꺼진 채로 유지**된다     |
   | (b)  | 기본 보기 모드를 `목록`으로 바꾼 뒤 새 탭을 열면 목록이고, 열려 있던 탭의 보기는 그대로다 (함정 D) |
   | (c)  | 계정·보안 섹션이 서버 수와 보호 수준을 보여주고, 보호가 약하면 경고가 섹션 안에 보인다             |
   | (d)  | 진단 복사 후 텍스트 편집기에 붙여넣으면 한 줄로 앱·OS·electron·node·locale이 들어 있다             |
   | (e)  | 설정 초기화 → 확인 → 모든 항목이 기본값(언어·테마 포함 `system`)이다                               |
   | (f)  | 업데이트·에이전트·캐시 정리·언어·테마의 기존 동작에 회귀가 없다                                    |
