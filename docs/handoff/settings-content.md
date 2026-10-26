# 핸드오프: 설정창 콘텐츠 보강 — 계정/보안 · 정보 섹션 추가 (화면 토글 이식 제외)

R1에서 인간과 합의한 내용의 고충실도 기록. R2(테스트 코드 작성)·구현의 유일한 입력이다.
이 문서에 없는 케이스는 완료 범위 밖이다. 새 케이스를 추가하거나 기존 케이스를 재해석하지 말 것.

**이식 노트(provenance)**: 이 문서는 옛 `v1.3.0` 기반 브랜치 `feat/feedback-batch`의
`docs/handoff/settings-content.md`를 `feat/feedback-v1.5`(**업스트림 `v1.4.0+`**, 이 브랜치의 기존 최대 번호
`Test-1201`)에 이식한 것이다. 이식 범위에서 아래 두 가지가 조정되었다.

1. **S3(화면 토글) 전면 제외 — superseded by upstream `useLayoutStore`**: 업스트림은 이미
   접이식 좌/우 패널을 ships 한다(`src/renderer/src/stores/useLayoutStore.ts`의 `left`/`right`에
   `collapsed`+`width`, persist 포함, `AppShell.test.tsx`가 양쪽 접힘을 이미 단언). 우리 토글을
   추가하면 같은 기능이 중복 구현된다. S3·Test-883·Test-885·Test-887·Test-892·Test-893는
   **이식에서 제외(superseded by upstream `useLayoutStore`)** 로 표기해 히스토리를 남긴다.
   `AppShell.tsx`는 이 포트에서 **변경하지 않는다**.
2. **테스트 번호 재배정**: 원 번호 `Test-883`~`Test-893` → 이 브랜치에서 `Test-1239`~`Test-1244`로
   재배정(§6의 매핑표). 생존 케이스만 번호를 받는다. 이 브랜치의 기존 최대는 `Test-1201`,
   이 포트의 사용 구간은 `Test-1239`~`Test-1244`다.

작업 유형(R0): **기능 추가**. RED 테스트를 먼저 세운 뒤 GREEN으로 만든다.

선행 작업: 없음.
후속 연결: 원본 스펙의 후속 연결(`shelf-floating-remote.md` 6번, `showRail` 언급)은 **이 포트에서는
무관하다** — S3가 제외되어 우리 계약에 화면 토글이 남지 않았다.

---

## 1. 문제 정의

사용자 피드백: _"설정창이 너무 콘텐츠가 부실한데 어떤 것을 넣으면 좋을지 제안해줘."_

R1에서 제목 목록을 논의해 아래 묶음을 확정했다. 지금 설정창에 있는 것은
**언어 · 테마 · 썸네일 크기 · 숨김 파일 · 삭제 확인 · 캐시 정리 · 업데이트 · 에이전트** 여덟 개
뿐이다([`SettingsDialog.tsx`](../../src/renderer/src/components/settings/SettingsDialog.tsx)).
이식 시점에 업스트림이 **파일 카테고리** 섹션을 추가했으므로, 이 포트에서는 그 섹션을 **유지**하고
우리 섹션을 S1 순서에 맞춰 그 앞뒤에 끼운다(§2 S1).

### 넣기로 한 것 / 넣지 않기로 한 것

| 넣는다                                                   | 이유 / 지금 상태                                                                                                                                                                                |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **기본 보기 모드**(그리드/목록)                          | `useSettingsStore.viewMode`·`setViewMode`가 **이미 있는데 설정창에 없다.** 탭을 새로 열 때만 쓰여 지금은 어디서도 고를 수 없다                                                                  |
| **화면: 사이드바 표시 / 오른쪽 레일 표시**               | **이식에서 제외 (superseded by upstream `useLayoutStore`)** — 업스트림이 이미 접이식 좌/우 패널(상태·persist·테스트)을 ships 해 중복이 된다. 원래 이유: 넓은 화면에서 탐색 영역을 늘리려는 수요 |
| **계정 · 보안**: 저장된 서버 수, 저장 비밀번호 보호 수준 | 지금은 보호 수준이 `basic`·`none`일 때 **폼 안에 경고 한 줄**로만 나온다. 얼마나 위험한지 알리는 자리가 필요하다                                                                                |
| **캐시: 상한 표시**                                      | 통계·정리는 있는데 "언제까지 쌓이나"가 안 보인다. `MAX_CACHE_SIZE_BYTES`는 `@shared`에 있어 렌더러가 바로 읽는다                                                                                |
| **정보: 플랫폼 · 버전 · 진단 정보 복사**                 | 문제 제보 때 필요한 조합을 한 번에 복사한다. **새 IPC 없이** 가능하다(아래 S4)                                                                                                                  |
| **설정 초기화**                                          | 구조가 커진 만큼 되돌릴 자리가 필요하다                                                                                                                                                         |

| 넣지 않는다 (기각)                                      | 이유                                                                                            |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **단축키 치트시트**                                     | 항목 설명마다 11개 로케일 번역이 필요해 이번 스펙의 범위를 넘는다. 별도 스펙 후보               |
| **데이터 폴더 열기**                                    | `shell.openPath`용 신규 채널(핸들러·허용목록·유니언 3곳)이 필요하다                             |
| **전송(동시 연결 수·세그먼트) 설정**                    | 연결 수는 **서버별** 설정으로 이미 `ServerForm`에 있다(`maxTransfers`). 전역으로 뺄 근거가 없다 |
| **미리보기 크기 상한 설정**                             | [`lightbox-video-playback.md`](./lightbox-video-playback.md)의 상한과 한 묶음이라 분리한다      |
| **언어·테마를 섹션 헤더 없는 첫 블록에 두는 구조 변경** | 지금 그대로 쓰고 있다. 형식 변경은 콘텐츠 추가와 무관하다                                       |

---

## 2. 핵심 결정 (R1에서 인간이 확정)

| #   | 결정                                                                                                                                                          | 근거                                                                                                                                                                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S1  | 설정창 섹션 순서: **일반(언어·테마·기본 보기 모드) → 격자 → 탐색 → (파일 카테고리: 업스트림 추가, 유지) → 계정·보안 → 캐시 → 업데이트 → 에이전트 → 정보**     | 원래 순서(언어/테마 → 격자 → 탐색 → 화면 → 계정·보안 → 캐시 → 업데이트 → 에이전트)를 유지하고 앞뒤에만 끼우는 원칙. **화면은 S3 제외로 빠지고**, 업스트림이 탐색과 캐시 사이에 넣은 파일 카테고리 섹션은 그 자리에 두고 계정·보안을 파일 카테고리 다음(캐시 바로 앞)에 둔다. 기존 `Test-204`~`845`·`Test-948`~`950`가 참조하는 순서·구조를 깨지 않는다 |
| S2  | 기본 보기 모드는 `<select>`가 아니라 **격자 크기와 같은 줄의 세그먼트(그리드/목록)**로, 기존 "격자" 섹션이 아니라 "일반"에 둔                                 | 보기 모드는 격자 하나의 속성이 아니라 **새 탭의 기본값**이다(D16). 격자 섹션은 크기 전용으로 남는다                                                                                                                                                                                                                                                    |
| S3  | ~~화면 토글 `showSidebar`·`showRail` 필드와 `AppShell` 조건부 렌더~~                                                                                          | **이식에서 제외 (superseded by upstream `useLayoutStore`)** — 업스트림 `useLayoutStore`(`left`/`right`의 `collapsed`+`width`, persist)가 같은 기능을 이미 구현했고 `AppShell.test.tsx`이 양쪽 접힘을 단언한다. 우리 토글은 중복 구현이므로 필드·Setter·`AppShell` 변경 없음                                                                            |
| S4  | 정보 섹션은 **새 IPC 없이** 만든다: 플랫폼·버전은 `window.electron.process.platform` / `.versions`, 앱 버전은 이미 받아 두는 `update:getState.currentVersion` | `@electron-toolkit/preload`가 `process`(platform·versions)를 노출한다. 채널을 하나도 늘리지 않고 끝난다                                                                                                                                                                                                                                                |
| S5  | 진단 정보 복사는 **클립보드 한 줄**로: `FTP Browser <앱버전> · <os> · electron <v> · node <v> · locale <현재 로케일>`                                         | 제보에 필요한 게 이 조합이다. `navigator.clipboard.writeText`로 끝나며, 실패해도 조용히 토스트로 알린다                                                                                                                                                                                                                                                |
| S6  | 보호 수준 표시는 **경고를 "계정·보안" 섹션으로 옮긴다.** `basic`·`none`일 때만 문구를 보여주는 기존 규칙은 그대로 두고, 섹션 헤더 아래로 옮긴다               | 기존 경고는 언어/테마 섹션 바로 아래에 붙어 있어 무슨 말인지 맥락이 없다. 섹션 안에서는 항상 보인다(보호 수준 표시 + 상태)                                                                                                                                                                                                                             |
| S7  | 설정 초기화는 **`confirmDialog`**(기존 확인 모달)를 거쳐 **모든 설정을 초기값으로** 되돌린다 — 언어·테마 포함 `system`                                        | 절반만 초기화하면 "무엇이 초기화됐는지"가 설명 불가능하다. 확인 모달은 이미 `useConfirmStore`에 있다                                                                                                                                                                                                                                                   |
| S8  | 새 i18n 키는 아래 표의 **15개**(원본 18개에서 `settings.display`·`settings.showSidebar`·`settings.showRail` 제외)만 만들고 **`en.ts` + 10개 로케일**에 넣는다 | 키 누락은 typecheck, 플레이스홀더 불일치는 `i18n.test.ts`에서 걸린다                                                                                                                                                                                                                                                                                   |

---

## 3. 구현 함정

### 함정 A — ~~`showSidebar: false`가 F6 사이클과 드롭 대상을 깨뜨린다~~

**이식에서 제외 (superseded by upstream `useLayoutStore`)** — S3가 빠지면서 `AppShell`에 조건부
렌더가 없고, F6 순서(`REGIONS`)·드롭 대상이 건드리는 일이 없다. 업스트림의 패널 접힘은 이미
`AppShell.test.tsx`에서 회귀를 커버한다.

### 함정 B — 설정창이 `open`일 때만 데이터를 가져온다

캐시 통계·업데이트·에이전트 상태는 `useEffect(..., [open])`에서 가져온다
([`SettingsDialog.tsx`](../../src/renderer/src/components/settings/SettingsDialog.tsx)의 `open` 효과).
**새로 넣는 정보(플랫폼·버전)·계정(서버 수·보호 수준)도 같은 규칙**을 따라야 한다 — 컴포넌트가
마운트돼 있는 동안에만 읽는다. `window.electron.process`는 매번 읽어도 되지만,
`ftp:getPasswordProtection`는 지금도 `open`일 때만 부른다를 그대로 따른다.

### 함정 C — 저장된 서버 수는 `useServerStore.servers`가 이미 로드돼 있다는 보장이 없다

서버 목록은 `ConnectBar`가 `loadServers(true)`로 부른 뒤에 채워진다. 설정창이 **앱 시작 직후
먼저 열리면 `servers`가 비어** "저장된 서버 0개"로 잘못 보인다. 설정창이 열릴 때
`loadServers()`를 한 번 더 부르고, 로드가 끝나기 전에는 개수를 단정하지 말아야 한다.
`Test-1241`이 로드 전 상태에서의 표시를 함께 단언한다.

### 함정 D — 초기화가 진행 중인 값을 바꾼다

`reset()`이 타일 크기·기본 보기를 초기값으로 되돌리면 **열려 있는 탭들의 보기는 그대로**다
(탭마다 자기 `viewMode`를 가진다 — `useSettingsStore`의 `viewMode` 주석). 이는 의도된 동작이다:
초기화는 **앞으로 열리는 탭**에만 적용된다. 테스트가 열려 있던 탭의 보기까지 초기화를
기대하면 잘못된 기대가 된다. `Test-1244`는 스토어 값만 단언한다.

### 함정 E — `reset()`이 persist를 깨뜨리지 않아야 한다

`persist`의 `migrate`는 저장본에 없는 필드를 기본값으로 채운다. 이번 이식은 필드 추가가 아니라
**`reset()` 추가뿐**이라 `version` 상승 없음. 함정은 `reset()`이 `partialize`·`version` 옵션과
충돌하는 쪽이다: **`reset()`은 `set()`으로 초기값만 넣고,
persist 설정(`name`·`version`·`migrate`)은 건드리지 않는다.**

---

## 4. 대상 API

```ts
// src/renderer/src/stores/useSettingsStore.ts

interface SettingsStore {
  // ...기존(upstream 필드 `conflictChoice` 포함)은 그대로 유지
  /** 모든 설정을 초기값으로(S7): 타일·기본 보기·숨김·삭제 확인·언어·테마. */
  reset: () => void
}
```

`showSidebar`·`showRail`·`setShowSidebar`·`setShowRail`·`AppShell` 조건부 렌더는
**이식에서 제외 (superseded by upstream `useLayoutStore`)** — 원본 API 블록에서 삭제됐다.

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

{/* 화면 (S3) — 이식에서 제외 (superseded by upstream `useLayoutStore`) */}

{/* 계정 · 보안 (S6) — 파일 카테고리 섹션 다음, 캐시 바로 앞 (S1) */}
<section>
  <h3>{t('settings.account')}</h3>
  <p>{t('settings.savedServersCount', { count: servers.length })}</p>   {/* 복수: _one/_other */}
  <p>{t('settings.passwordProtectionLevel')}: {level === 'keyring' ? t('settings.passwordProtectionStrong')
      : level === 'basic' ? t('servers.passwordProtectionBasic')        /* 기존 키 재사용 */
      : t('servers.passwordProtectionNone')}</p>
  {level !== 'keyring' && <p className="text-[var(--dg)]">{기존 경고 문구}</p>}
</section>

{/* 캐시 — 통계 줄에 상한만 더한다 (상한은 @shared) */}
<p className="text-xs text-[var(--mu)]">{t('settings.cacheLimit', { size: formatBytes(MAX_CACHE_SIZE_BYTES) })}</p>

{/* 정보 (S4·S5) — 마지막 섹션 */}
<section>
  <h3>{t('settings.about')}</h3>
  <dl>platform / app / electron / node</dl>
  <button onClick={copyDiagnostics}>{t('settings.copyDiagnostics')}</button>
  <button onClick={resetAllSettings}>{t('settings.reset')}</button>
</section>
```

새 i18n 키 (**이 표에 있는 15개만**, `en.ts` 원본 + 10개 로케일):

| 키                                  | 예시 (en)                             |
| ----------------------------------- | ------------------------------------- |
| `settings.viewMode`                 | `Default view for new tabs`           |
| `settings.viewModeGrid`             | `Grid`                                |
| `settings.viewModeList`             | `List`                                |
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

원본의 `settings.display`·`settings.showSidebar`·`settings.showRail` 세 키는
**이식에서 제외 (superseded by upstream `useLayoutStore`)** — 만들지 않는다.

(`settings.passwordProtectionBasic`·`None`는 기존 `servers.*` 키를 재사용한다 — 새 키를 만들지 않는다.
`ru.ts`의 복수형은 `savedServersCount_one/_few/_many/_other` 네 벌을 갖춘다 — `i18n.test.ts`의
복수 카테고리 검사가 요구한다.)

---

## 5. 기각한 대안

- **단축키 치트시트** — 내용이 가장 크게 늘지만, 항목 설명 15개 안팎 × 11 로케일의 번역이
  필요하고 실제 단축키 배치(AppShell·TabStrip·목록에 흩어져 있다)를 먼저 정리해야 한다.
  **다음 사이클의 별도 스펙**으로 남긴다.
- **"데이터 폴더 열기" 버튼** — `shell.openPath` 신규 채널 3곳 등록 + 계약 테스트. 지금 정보
  섹션의 목적(제보용 진단 복사)을 이루는 데 필요 없다. 기각.
- **전송 섹션 신설** — 전역으로 뺄 설정이 없다. 동시 연결 수는 서버별 `maxTransfers`로 이미
  `ServerForm`에 있고, 분할 기준·캐시 상한은 상수다(캐시 상한은 표시만 한다).
  존재하지 않는 설정 카드를 만드는 것보다 비어 있는 편이 낫다. 기각.
- **설정 항목을 좌측 탭(일반/전송/보안/고급)으로 나누기** — 680px 대화상자에서 탭은 현재
  한 화면에 다 보이는 구조를 깬다. 지금처럼 단일 스크롤 + 섹션이 이 앱의 형식이다. 기각.
- **`showSidebar`·`showRail`을 로컬 스토리지가 아닌 스토어에 두지 않기** — **이식에서는 무관
  (S3 제외)**. 업스트림 `useLayoutStore`가 이미 persist를 다룬다. 기록용으로 남긴다.
- **진단 복사에 로그·DB 스키마 포함** — 개인정보·경로 노출이 생기고 수집처도 마땅치 않다.
  버전 조합만으로 제보의 대다수(환경 문제)를 가른다(S5). 기각.

---

## 6. 테스트 케이스 리스트 (확정)

이식 기준 **신규 번호 `Test-1239`부터**. 이 브랜치의 기존 최대 번호는 `Test-1201`
(업스트림 `origin/main` 기준), 이 포트의 사용 구간은 `Test-1239`~`Test-1244`다.
각 테스트에 `covers: Test-N` 주석을 단다. **1:1 매핑. 케이스 추가·병합·재해석 금지.**

원 번호 → 이식 번호 매핑:

| 원 번호  | 이식 번호 | 상태                                                        |
| -------- | --------- | ----------------------------------------------------------- |
| Test-883 | —         | **이식에서 제외 (superseded by upstream `useLayoutStore`)** |
| Test-884 | Test-1239 | 생존                                                        |
| Test-885 | —         | **이식에서 제외 (superseded by upstream `useLayoutStore`)** |
| Test-886 | Test-1240 | 생존                                                        |
| Test-887 | —         | **이식에서 제외 (superseded by upstream `useLayoutStore`)** |
| Test-888 | Test-1241 | 생존                                                        |
| Test-889 | Test-1242 | 생존                                                        |
| Test-890 | Test-1243 | 생존                                                        |
| Test-891 | Test-1244 | 생존                                                        |
| Test-892 | —         | **이식에서 제외 (superseded by upstream `useLayoutStore`)** |
| Test-893 | —         | **이식에서 제외 (superseded by upstream `useLayoutStore`)** |

### A. 스토어 (`stores/useSettingsStore.test.ts`)

| #            | 케이스                                                                             | 기대                                                        |
| ------------ | ---------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Test-1239    | `reset()`이 타일·기본 보기·숨김·삭제 확인·언어·테마 **전부**를 초기값으로 되돌린다 | S7. 일부만 초기화하는 구현을 막는다                         |
| ~~Test-883~~ | ~~`showSidebar`·`showRail` 기본 `true`, setter, persist~~                          | **이식에서 제외 (superseded by upstream `useLayoutStore`)** |
| ~~Test-885~~ | ~~예전 저장본에서 두 필드가 `true`로 채워진다~~                                    | **이식에서 제외 (superseded by upstream `useLayoutStore`)** |

### B. 설정창 (`components/settings/SettingsDialog.test.tsx`)

| #            | 케이스                                                                                                                       | 기대                                                            |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Test-1240    | "일반"의 기본 보기 모드 세그먼트를 `목록`으로 고르면 `useSettingsStore.viewMode`가 `list`가 된다                             | S2. 지금 스토어에만 있고 노출이 없었다                          |
| Test-1241    | "계정·보안" 섹션에 저장된 서버 수와 보호 수준이 보인다 — **서버가 아직 로드되기 전이어도 0개로 단정하지 않고 로드를 부른다** | S6·함정 C                                                       |
| Test-1242    | "캐시" 섹션이 사용량과 함께 **상한(`MAX_CACHE_SIZE_BYTES` 포맷)**을 보여준다                                                 | S4와 구별: 여기는 캐시 상한                                     |
| Test-1243    | "정보" 섹션이 플랫폼·앱 버전·electron·node를 보이고, 진단 복사 버튼이 클립보드에 **S5의 한 줄 형식**을 넣는다                | S4·S5. 새 IPC를 쓰지 않았음(채널 호출 0회 증가)도 함께 단언한다 |
| Test-1244    | 초기화 버튼 → 확인하면 스토어가 초기값으로, 취소하면 그대로 남는다                                                           | S7·confirmDialog 경유                                           |
| ~~Test-887~~ | ~~"화면" 섹션의 두 토글~~                                                                                                    | **이식에서 제외 (superseded by upstream `useLayoutStore`)**     |

### C. 적용 (`components/layout/AppShell.test.tsx`)

| 원 번호      | 케이스                                                        | 기대                                                                                                                                                     |
| ------------ | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~Test-892~~ | ~~`showSidebar: false`면 사이드바 미렌더·콘텐츠가 자리 차지~~ | **이식에서 제외 (superseded by upstream `useLayoutStore`)** — `AppShell.tsx` 변경 없음. 업스트림 `AppShell.test.tsx`의 접힘 단언이 해당 회귀를 이미 본다 |
| ~~Test-893~~ | ~~`showRail: false`면 오른쪽 레일 미렌더~~                    | **이식에서 제외 (superseded by upstream `useLayoutStore`)** — 같은 사유                                                                                  |

- 기존 `Test-204`·`205`·`210`·`212`·`218`·`219`·`252`·`253`·`294`·`752`·`845`(업데이트·에이전트·언어·테마),
  `Test-948`~`950`(파일 카테고리, 업스트림 추가)은 **그대로 GREEN이어야 한다.** 특히 `Test-845`(언어·테마)는
  첫 섹션에 줄이 하나 추가돼도 깨지지 않아야 한다.
- E2E가 전담할 것: 실제 창에서 설정 초기화·기본 보기 모드를 재시작 후 확인(§8 표).

---

## 7. 관련 코드 포인터

| 파일                                                                                                                                                                      | 역할                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| [`components/settings/SettingsDialog.tsx`](../../src/renderer/src/components/settings/SettingsDialog.tsx)                                                                 | 섹션 구조(일반·격자·탐색·파일 카테고리·계정·캐시·업데이트·에이전트·정보), `open` 효과(함정 B), `copyCommand`(복사 패턴)                       |
| [`stores/useSettingsStore.ts`](../../src/renderer/src/stores/useSettingsStore.ts)                                                                                         | 필드·setter, 기본값, persist(함정 E)                                                                                                          |
| [`components/layout/AppShell.tsx`](../../src/renderer/src/components/layout/AppShell.tsx) · [`stores/useLayoutStore.ts`](../../src/renderer/src/stores/useLayoutStore.ts) | **이 포트 변경 없음.** 화면 토글의 대체 구현처(superseded by upstream `useLayoutStore`) — `collapsed`·persist·`AppShell.test.tsx`의 접힘 단언 |
| [`stores/useConfirmStore.ts`](../../src/renderer/src/stores/useConfirmStore.ts)                                                                                           | `confirmDialog`(S7의 확인 흐름)                                                                                                               |
| [`stores/useServerStore.ts`](../../src/renderer/src/stores/useServerStore.ts)                                                                                             | `loadServers`(함정 C의 로드 경로)                                                                                                             |
| [`main/thumbnail/CacheManager.ts`](../../src/main/thumbnail/CacheManager.ts) · [`shared/constants.ts`](../../src/shared/constants.ts)                                     | `getStats`·`MAX_CACHE_SIZE_BYTES`(캐시 상한 출처)                                                                                             |
| [`shared/types/update.ts`](../../src/shared/types/update.ts)                                                                                                              | `UpdateState.currentVersion`(S4의 앱 버전 출처)                                                                                               |
| `@electron-toolkit/preload` 타입                                                                                                                                          | `window.electron.process.platform`·`.versions`(S4 — 새 IPC 없음의 근거)                                                                       |

---

## 8. 완료 기준

1. `Test-1239`~`Test-1244`가 모두 GREEN (실행 출력으로 확인).
2. **기존 `Test-204`·`205`·`210`·`212`·`218`·`219`·`252`·`253`·`294`·`752`·`845`,
   `Test-948`~`950`가 계속 GREEN.**
3. 각 신규 테스트에 `covers: Test-N` 주석.
4. **새 i18n 키 15개**가 `en.ts`와 10개 로케일 전부에 있고, 복수형은 `_one`/`_other`
   (`ru`는 `_few`/`_many` 포함)를 갖춘다. `i18n.test.ts`와 typecheck가 GREEN이어야 한다.
5. **새 IPC 채널 0개.** `src/preload/index.ts`·`index.d.ts`가 바뀌지 않았는지 확인한다.
6. 뮤테이션: **이 포트 범위 밖 (제외)** — 원본 스펙의 `stryker.config.json` re-scope 기준은
   이식 작업에서는 수행하지 않는다(오케스트레이터 결정).
7. `npm run typecheck` · `npm run lint` · `npx prettier --check <변경 파일>` · `npx vitest run` 통과.
8. E2E 실측 (실기기 R3):

   | 항목 | 확인 내용                                                                                                                              |
   | ---- | -------------------------------------------------------------------------------------------------------------------------------------- |
   | (a)  | 기본 보기 모드를 `목록`으로 바꾼 뒤 새 탭을 열면 목록이고, 열려 있던 탭의 보기는 그대로다 (함정 D)                                     |
   | (b)  | 계정·보안 섹션이 서버 수와 보호 수준을 보여주고, 보호가 약하면 경고가 섹션 안에 보인다                                                 |
   | (c)  | 진단 복사 후 텍스트 편집기에 붙여넣으면 한 줄로 앱·OS·electron·node·locale이 들어 있다                                                 |
   | (d)  | 설정 초기화 → 확인 → 모든 항목이 기본값(언어·테마 포함 `system`)이다                                                                   |
   | (e)  | 업데이트·에이전트·캐시 정리·언어·테마·파일 카테고리의 기존 동작에 회귀가 없다                                                          |
   | (f)  | ~~화면 토글 유지~~ — **이식에서 제외 (superseded by upstream `useLayoutStore`)**: 업스트림 좌/우 패널 접힘·재시작 유지가 대신 유효하다 |
