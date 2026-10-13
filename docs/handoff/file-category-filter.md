# 핸드오프: 파일 카테고리 필터 — `photosOnly` 토글을 탭별 카테고리·확장자 필터로

탭 경로 막대의 "사진만" 칩(`Tab.photosOnly`)을 **탭별 카테고리 + 확장자 필터**로 바꾼다. 드롭다운에서 카테고리를 여러 개 체크하고(현재 폴더 기준 개수 표시),
"고급…"에서 현재 폴더의 실제 확장자 체크리스트와 직접 입력 태그로 거른다. 어떤 확장자가 어느 카테고리인지는 설정 "파일 카테고리"에서 편집한다.
이 문서가 테스트·구현의 유일한 입력이다. 이 문서에 없는 케이스는 완료 범위 밖이다. 케이스를 추가·병합·재해석하지 말 것.

작업 유형(R0): **기능(렌더러 전용) — 순수 매처 모듈 + 탭 상태 교체 + 새 드롭다운 + 설정 섹션 + i18n**. main·preload·IPC 변경 없음(새 채널 없음).
슬라이스(§13)마다 그 슬라이스의 테스트를 먼저 세워 RED를 보고 GREEN으로 만든다. 끝으로 실제 앱에서 R3 실측(§14)을 한다.

입력 문서:

- R1 결정 원본: `.omc/plans/explorer-v2-decisions.md` §E (사용자와 합의). 이 문서의 E1~E9가 그 요약이고, 거기서 정하지 않은 것은 E10~(대응시키며 정한 것)에 모았다.
  **"미결(권장안 적용)"** 표시는 결정 기록이 정하지 않아 권장안을 적용한 것이다. 사람이 뒤집으면 해당 항목만 바꾼다.
- 기존 스펙: `docs/handoff/explorer-shelf.md`. 이 문서는 그 §2의 "사진만" 칩 결정과 §12 Test-772·798·828의 `photosOnly` 부분만 대체한다(§6).
- 같이 쓰이는 병렬 스펙(이 문서는 아래 파일의 번호·결정을 건드리지 않는다): `explorer-menu-and-focus.md`(Test-846~869), `shelf-os-drop.md`(870~889),
  `collapsible-sidebars.md`(890~919), `multi-connection.md`(960~1039), `split-view.md`(1040~1085, 1127, 1128).

---

## 1. 바꾸는 것

```
PathBar  ‹ › ↑ [경로 …]  ⌕ 찾기  [▼ 필터 2]  정렬  ▦☰  📁+  ⓘ
                             │
                             └─ 팝오버(폭 288)
                                ┌ 모두 보기 ────────────────────┐   ← 활성일 때만 누를 수 있음
                                │ ☑ 이미지 (42)                  │
                                │ ☐ RAW (0)          ← 흐림, 체크는 가능
                                │ ☑ 비디오 (3)   … 보이는 카테고리 전부(기본 7 + 사용자) │
                                │ ─────────────────────────────  │
                                │ 고급…  ▾                       │
                                │   ☐ .jpg (30)  ☐ .png (12)  ☐ (확장자 없음) (4) │
                                │   [ tar.gz × ][ .log × ] [ 입력 ⏎ ]  ← 이 폴더에 없는 확장자 조건은 칩(E30) │
                                └────────────────────────────────┘
설정 ▸ 파일 카테고리: 이미지 [jpg ×][png ×]… [+ 확장자]  [기본값 복원] [숨김]   /  [+ 카테고리 추가]
```

- `Tab.photosOnly: boolean` → `Tab.filter: TabFilter` (§3). 탭마다 따로 가지고, 폴더를 옮겨도 유지된다(찾기 문자열과 달리 `navigate`가 지우지 않는다. 지금 `photosOnly`와 같다).
- 걸러내기는 설정의 카테고리 매핑을 쓴다. **아이콘·정보 패널 분류(`categoryOf`/`EntryCategory`)와 썸네일 대상(`isImage`, `IMAGE_EXTENSIONS`)은 건드리지 않는다** — 설정을 바꿔도 썸네일 생성 여부가 바뀌지 않는다(E8).
- 폴더는 필터와 무관하게 늘 보인다. 개수에도 들지 않는다.

---

## 2. 핵심 결정 (R1)

### 사용자와 합의한 것 (결정 기록 §E — 다시 열지 않는다)

| #   | 결정                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | `Tab.photosOnly`를 카테고리 필터 드롭다운으로 확장한다. 탭별 상태 유지(기존과 동일).                                                                                                                                            |
| E2  | 다중 체크(OR). 현재 폴더 기준 개수 "이미지 (42)", 0개는 흐림(체크는 가능). 맨 위 "모두 보기"(초기화). 버튼은 활성 시 틴트 + **선택 수 배지**.                                                                                   |
| E3  | 맨 아래 구분선 뒤 "고급…": 현재 폴더에 실제 있는 확장자 체크리스트(개수 포함, "(확장자 없음)" 포함) + 목록에 없는 확장자 태그 입력(쉼표/공백/Enter 확정, 선행 `.` 무시). **카테고리와 확장자는 OR.**                            |
| E4  | 폴더는 필터와 무관하게 항상 표시(개수에서 제외). 확장자는 소문자로 정규화, 비교는 **마지막 점** 기준. 사용자가 넣은 복합 접미사(`tar.gz`)는 최장 접미사 매칭.                                                                   |
| E5  | 빈 상태: `이 폴더에 '이미지' 파일이 없습니다 [필터 해제]`.                                                                                                                                                                      |
| E6  | 설정 "파일 카테고리" 섹션: 기본 7개(이미지·RAW·비디오·오디오·문서·압축·코드) 확장자 태그 편집, 카테고리별/전체 기본값 복원, 사용자 카테고리 추가·이름 변경·삭제. **기본 카테고리는 삭제 대신 숨김.** 중복 확장자를 넣으면 경고. |
| E7  | 사용자 편집분은 **기본값과 분리 저장**(기본 목록이 업데이트되면 병합 가능). 기본 이름은 i18n 키, 사용자 카테고리는 자유 문자열.                                                                                                 |
| E8  | 필터 분류는 설정 매핑을 쓴다. 아이콘/썸네일용 기존 분류(`EXT_CATEGORY`, `IMAGE_EXTENSIONS`)는 필터와 분리 유지.                                                                                                                 |
| E9  | 기본 확장자 7묶음은 결정 기록 §E의 목록이 출발점이고, `ts`는 코드에만 둔다. 이미지의 `psd?`는 기존 `EXT_CATEGORY`와 대조해 정한다(→ E11).                                                                                       |

### 대응시키며 정한 것

| #   | 결정                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| E10 | **저장된 `photosOnly`는 없다(확인함).** 탭은 저장되지 않고(`useTabsStore`에 persist 없음, 탭 복원은 explorer-shelf D23 후속 과제), `ftp-browser-settings`(v2)에도 그 필드가 없다. 그래서 **마이그레이션 코드를 만들지 않는다.** 옛 칩과의 연속성은 "이미지+RAW+비디오 세 카테고리를 체크하면 옛 `photosOnly`와 같은 결과"라는 회귀 테스트로 못 박는다(Test-934). **미결(권장안 적용)** — 리드가 "저장분 마이그레이션"을 따로 원했다면 §15에 적었다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| E11 | **기본 확장자 확정**(아래 표). 결정 기록의 목록에, 기존 `EXT_CATEGORY`에만 있던 확장자를 더한 합집합이다 — 옛 사진만 칩이 걸러내던 RAW 확장자(`crw nrw srf sr2 x3f`)가 새 기본값에서 빠져 회귀하지 않게 하려는 것이다. `psd`는 이미지에 둔다(기존 분류가 이미지). 기본 7개 사이에 겹치는 확장자는 없다(Test-923).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| E12 | **저장 위치**: 새 zustand persist 스토어 `useFileCategoryStore`(키 `ftp-browser-file-categories`, version 1). `useSettingsStore`(`ftp-browser-settings` v2)는 **버전을 올리지 않는다** — 사이드바 폭 등 병렬 스펙이 같은 persist의 version을 올릴 수 있어 마이그레이션이 부딪히지 않게 분리한다. 저장 모양은 기본값의 **차이(delta)**(E13).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| E13 | **저장 모양**: `{ defaults: { [기본 id]?: { added: string[]; removed: string[]; hidden: boolean } }, custom: { id; name; extensions: string[] }[] }`. 유효 확장자 = (앱의 기본 목록 − `removed`) ∪ `added`. 앱이 기본 목록에 확장자를 더하면 사용자가 `removed`에 넣지 않은 한 자동으로 들어온다(E7의 "병합").                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| E14 | **필터 상태**: `TabFilter = { categories: string[]; extensions: string[]; noExtension: boolean }`. `categories`는 카테고리 id(기본 `image`/`raw`/`video`/`audio`/`doc`/`archive`/`code`, 사용자 `custom-…`), `extensions`는 정규화된 확장자(복합 `tar.gz` 포함), `noExtension`은 "(확장자 없음)" 체크. 셋 다 비면 필터 없음. 전체 합집합(OR).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| E15 | **숨김·삭제된 카테고리를 가리키는 id는 무시**한다(탭 상태를 지우지 않는다). 무시한 뒤 남는 조건이 없으면 필터는 꺼진 것(전체 보임)이고 배지에도 세지 않는다. 설정에서 다시 보이게 하면 이전 체크가 되살아난다 — 드문 경우라 받아들인다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| E16 | **확장자 추출 규칙**(`extensionOf`): 이름을 소문자로 한 뒤 마지막 `.` 뒤. 점이 없거나, **유일한 점이 맨 앞**(`.gitignore`)이거나, 점이 맨 끝(`a.`)이면 확장자 없음(`''`). 지금 `getFileExtension`(`utils.ts:31`)은 `.gitignore`를 확장자 `.gitignore`로 보지만 그건 아이콘 분류용이라 그대로 둔다. **미결(권장안 적용)**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| E17 | **복합 접미사**: 필터에 들어간 확장자에 점이 있으면(`tar.gz`) 파일 이름이 `.tar.gz`로 끝나고 그 앞에 한 글자 이상 있을 때 일치한다. 마지막 점 확장자(`gz`)도 따로 일치하므로 `a.tar.gz`는 `gz`·`tar.gz` 둘 다에 걸린다. `tar` 하나로는 `a.tar.gz`가 걸리지 않는다. 고급 체크리스트는 **마지막 점 확장자만** 센다(복합은 직접 입력 전용).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| E18 | **파일 판정**: `type === 'directory'`만 무조건 통과. `file`과 `symbolic-link`는 이름으로 판정한다(옛 사진만 칩은 심볼릭 링크를 늘 숨겼다 — 링크 이름이 `x.jpg`면 이제 이미지로 보인다). 심볼릭 링크는 개수에는 파일로 센다. **미결(권장안 적용)**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| E19 | **개수의 기준 집합**: 현재 폴더 목록에서 _숨김 파일 설정을 반영_(숨김을 안 보이게 했으면 세지 않는다)하되 _찾기 문자열은 반영하지 않는다_. 드롭다운은 "이 폴더에 이런 게 이만큼"을 말하고, 찾기는 따로 좁힌다. 파일이 두 카테고리에 속하면 양쪽에 센다(합이 파일 수보다 클 수 있다). **미결(권장안 적용)**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| E20 | **걸러내는 순서와 빠진 수**: 숨김 → 찾기 → 필터. `FilterResult.photosCount`는 `filterCount`로 이름을 바꾸고 *찾기를 통과했지만 필터로 빠진 수*다(옛 정의 그대로).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| E21 | **빈 상태 우선순위**: `filterCount > 0`이면 필터 메시지(E5), 아니면 `query && queryCount > 0`이면 찾기 메시지, 아니면 빈 폴더. 옛 순서는 찾기가 먼저라 "찾기에 걸린 파일이 필터에 모두 막힌" 경우에 엉뚱하게 찾기 탓을 했다. 필터를 풀면 항목이 나오는 쪽을 먼저 말한다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| E22 | **폴더만 남는 경우**: 파일이 모두 걸러지고 하위 폴더가 있으면 폴더 목록이 그대로 보이고 빈 상태 패널은 뜨지 않는다(`items.length > 0`). 따로 안내 띠를 만들지 않는다 — 버튼의 배지·툴팁(숨긴 수, E26)이 단서다. **미결(권장안 적용)**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| E23 | **드롭다운은 `ItemMenu`를 쓰지 않는다.** 체크박스·입력칸·접이식 구역이 있어 `MenuItem`(버튼 행)으로 표현되지 않는다. 별도 컴포넌트 `FileFilterMenu`(트리거 + `role="dialog"` 팝오버). 위치는 `ItemMenu`처럼 `position: fixed` + `clampMenuPosition`(좁은 분할 패널이나 창 가장자리에서 안 잘리게).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| E24 | **닫기 규칙**: 바깥 `pointerdown`(capture), `Esc`(→ 트리거로 포커스 복귀), 창 `blur`. 트리거를 다시 누르면 닫힌다. **열려는 바로 그 클릭이 자신을 닫으면 안 된다**(`ItemMenu.tsx:251`의 click 리스너가 겪는 자기 충돌 — `explorer-menu-and-focus.md` A1/A2). `click`이 아니라 `pointerdown`으로 바깥을 판정하고 트리거를 안쪽으로 친다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| E25 | **태그 입력**: 쉼표·공백·`;`·Enter로 확정, 붙여넣기도 같은 규칙으로 쪼갠다. **IME 조합 중(`isComposing`)의 Enter·Space는 확정하지 않는다**(한글 조합이 쪼개진다). 잘못된 토큰(빈 값·공백/슬래시 포함·끝 점)은 버리고 입력칸에 남긴 채 `aria-invalid`. 폴더 확장자 목록에 있는 확장자를 입력하면 칩이 아니라 그 행이 체크된다(칩/행은 저장이 아니라 현재 폴더로 갈린다 — E30).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| E26 | **트리거 버튼**: 아이콘 `ListFilter` + 라벨 "필터"(좁은 막대에서는 라벨 숨김, 기존 `compact` 규칙 `PathBar.tsx:283`). 활성이면 틴트(`--acw`/`--ac`) + 선택 수 배지(카테고리 수 + 확장자 수 + `noExtension`). `title`에 활성 내용과 _숨긴 파일 수_("필터: 이미지 · 12개 숨김"). 옛 칩의 `−N` 숫자는 없앤다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| E27 | **설정 편집 동작**(순수 리듀서, 설정 UI는 이를 호출만 한다): 기본 카테고리에서 기본 확장자를 지우면 `removed`에, 지웠던 기본 확장자를 다시 넣으면 `removed`에서 뺀다. 같은 카테고리에 이미 있는 확장자는 무시하고 "이미 있음" 안내. **다른 카테고리에 이미 있으면 넣되 경고**(`{ext}`는 `「이름」`에도 있습니다 — OR 필터라 해롭지 않지만 개수가 겹친다). 사용자 카테고리 이름은 앞뒤 공백을 자르고, 빈 이름은 거부(이전 이름 유지), 이름 중복은 허용. **미결(권장안 적용)**                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| E28 | **복원 범위**: "이 카테고리 기본값 복원"은 그 기본 카테고리의 `added`·`removed`·`hidden`을 지운다(사용자 카테고리에는 없음). "전체 기본값 복원"은 **기본 7개만** 되돌리고 사용자 카테고리는 남긴다. 둘 다 `confirmDialog`로 한 번 묻는다. 사용자 카테고리 삭제도 묻는다. **미결(권장안 적용)**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| E29 | **분할 뷰·다중 연결과의 관계**: 필터는 `Tab`에 있으므로 분할된 두 패널은 각자의 필터를 가진다(`split-view.md`). DOM id는 `filter-menu-${tab.id}`처럼 탭 id를 붙여 중복을 피한다. 연결·`Loc.server`와는 무관하다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| E30 | **폴더에 없는 확장자 조건의 표시. 미결(권장안 적용)** 체크리스트 행은 _현재 폴더의_ 확장자만이다(E3). 그런데 `Tab.filter`는 폴더를 옮겨도 유지되므로(E1) 폴더 A에서 건 `.png`는 폴더 B에 행이 없다. 배지에는 세지고 목록은 거르는데 눈에는 안 보이면 "모두 보기"밖에 끌 길이 없다. 그래서 **칩 = `filter.extensions` − (현재 폴더의 마지막 점 확장자 집합)**을 렌더마다 *파생*한다(저장하지 않는다, `orphanExtensions`, §3). 복합 접미사(`tar.gz`)는 체크리스트에 오르지 않으므로(E17) 늘 칩이다. 폴더를 옮겨 행이 생기면 칩이던 것이 그 행의 체크로 바뀌고 반대도 같다(저장된 `filter`는 그대로). `noExtension`이 켜져 있으면 현재 폴더에 확장자 없는 파일이 없어도 `(확장자 없음) (0)` 행을 흐림(`data-empty`)으로 계속 보이고 체크는 해제할 수 있다. "고급…" 구역은 `extensions`·`noExtension` 조건이 하나라도 있으면 열 때 펼쳐 둔다(접힌 채 숨은 조건이 없게). 칩의 제거 버튼은 `filter.extensions`에서 뺀다. |
| E31 | **"필터 해제" 버튼은 전용 키 `filter.clearType`을 쓴다. 미결(권장안 적용)** `filter.clear`는 이미 찾기 입력의 X 버튼(`PathBar.tsx:415`)과 찾기 분기 빈 상태 버튼(`ExplorerStates.tsx:254`)의 이름이다. E5의 버튼이 같은 키를 쓰면 찾기 `b`+종류 필터(Test-946 (4))에서 이름이 같은 버튼 둘이 서로 다른 일을 해 접근성이 깨지고 `getByRole`이 모호하다. 또 ko `filter.clear`는 `필터 지우기`(`ko.ts:262`)라 E5가 정한 `필터 해제`가 나오지 않는다. 새 키: en `Clear type filter`(`filter.clear`의 `Clear filter`와 구별), ko `필터 해제`. 어느 로케일에서도 `filter.clearType`은 같은 로케일의 `filter.clear`와 문구가 달라야 한다(Test-953). `filter.clear`는 찾기용으로 그대로 둔다.                                                                                                                                                                                                                              |
| E32 | **스토어는 `overrides`만 상태로 갖는다.** 해석된 `categories`는 상태 필드가 아니라 `overrides`에서 *파생*한다. persist가 직렬화하지 않고(`partialize`), 앱 업데이트로 `DEFAULT_CATEGORIES`가 바뀌어도 저장된 옛 목록이 되살아나 E7·E13의 병합을 깨지 않으며, 테스트 초기화(`setState({ overrides })`)가 낡은 목록을 남기지 않는다. 파생 배열은 `overrides` 참조 단위로 메모한다(§3, 함정 11).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

**기본 확장자 확정(E11)** — 소문자, 점 없음, 이 순서로 보여 준다. `+`는 결정 기록에는 없고 기존 `EXT_CATEGORY` 때문에 더한 것.

| id (기본 이름 키)              | 확장자                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `image` (`category.image`)     | jpg jpeg png gif webp bmp tif tiff svg heic heif avif ico psd                                                |
| `raw` (`category.raw`)         | cr2 cr3 nef arw dng orf rw2 raf srw pef **+crw +nrw +srf +sr2 +x3f**                                         |
| `video` (`category.video`)     | mp4 mkv mov avi wmv flv webm m4v mpg mpeg m2ts mts 3gp                                                       |
| `audio` (`category.audio`)     | mp3 flac wav aac m4a ogg opus wma aiff                                                                       |
| `doc` (`category.doc`)         | pdf doc docx xls xlsx ppt pptx odt ods odp txt md rtf csv epub hwp hwpx **+log**                             |
| `archive` (`category.archive`) | zip rar 7z tar gz tgz bz2 xz zst iso **+dmg**                                                                |
| `code` (`category.code`)       | js ts jsx tsx py java c cpp h cs go rs rb php sh ps1 json yaml yml toml xml html css sql **+mjs +cjs +scss** |

보이는 순서는 이미지·RAW·비디오·오디오·문서·압축·코드, 그 뒤에 사용자 카테고리(만든 순서). 기본 이름은 기존 `category.*` 키를 **재사용**한다(새 번역 키 없음).

---

## 3. 화면 구조와 상태

### 타입 (`src/renderer/src/lib/fileCategories.ts`, 신규, 순수)

```ts
export type DefaultCategoryId = 'image' | 'raw' | 'video' | 'audio' | 'doc' | 'archive' | 'code'
export interface TabFilter {
  categories: string[]
  extensions: string[]
  noExtension: boolean
}
export const EMPTY_FILTER: TabFilter // 얼린 상수. 새 탭은 이것을 쓴다
export const EMPTY_OVERRIDES: CategoryOverrides // 얼린 상수. 스토어 초기값이자 테스트 초기화 값
export interface CategoryOverrides {
  defaults: Partial<Record<DefaultCategoryId, DefaultEdit>>
  custom: CustomCategory[]
}
export interface ResolvedCategory {
  id: string
  kind: 'default' | 'custom'
  nameKey?: MessageKey // 기본
  name?: string // 사용자
  extensions: string[] // 유효 목록(기본 − removed ∪ added, 정규화·중복 없음)
  hidden: boolean // 사용자 카테고리는 항상 false
}
export type EntryMatcher = (e: Pick<ExplorerEntry, 'name' | 'type'>) => boolean

export const DEFAULT_CATEGORIES: readonly { id: DefaultCategoryId; extensions: readonly string[] }[]
export function normalizeExtension(raw: string): string | null
export function parseExtensionInput(text: string): { valid: string[]; invalid: string[] }
export function extensionOf(name: string): string // E16
export function resolveCategories(
  o: CategoryOverrides,
  defaults?: typeof DEFAULT_CATEGORIES
): ResolvedCategory[]
export function visibleCategories(all: ResolvedCategory[]): ResolvedCategory[]
export function sanitizeOverrides(raw: unknown): CategoryOverrides
export function createMatcher(f: TabFilter, categories: ResolvedCategory[]): EntryMatcher | null // null = 필터 없음
export function activeCount(f: TabFilter, categories: ResolvedCategory[]): number // E15 반영
export function countByCategory(
  files: readonly ExplorerEntry[],
  categories: ResolvedCategory[]
): Record<string, number>
export function extensionCounts(files: readonly ExplorerEntry[]): {
  exts: { ext: string; count: number }[]
  noExtension: number
}
export function orphanExtensions(
  filterExtensions: readonly string[],
  folderExts: readonly string[]
): string[] // E30: filter − 폴더, 입력 순서 유지
export function filterLabel(
  f: TabFilter,
  categories: ResolvedCategory[],
  nameOf: (c: ResolvedCategory) => string,
  noExtLabel: string,
  max?: number
): string
```

편집 리듀서 (`src/renderer/src/lib/fileCategoryEdit.ts`, 신규, 순수 — 입력을 바꾸지 않고 새 객체를 돌려준다):
`addExtension(o, categories, id, raw) → { overrides, result: 'added' | 'exists' | 'invalid', duplicateOf?: string }`, `removeExtension(o, id, ext)`,
`setHidden(o, id: DefaultCategoryId, hidden)`, `restoreCategory(o, id)`, `restoreAllDefaults(o)`, `addCustom(o, id, name)`, `renameCustom(o, id, name)`, `deleteCustom(o, id)`.

스토어 `src/renderer/src/stores/useFileCategoryStore.ts`(신규, E32): **상태는 `overrides` 하나뿐**이고 액션은 위 리듀서를 감싼다. 해석된 목록은 상태가 아니라 파생이다 —
`export function selectCategories(s: Pick<FileCategoryState, 'overrides'>): ResolvedCategory[]`가 `WeakMap<CategoryOverrides, ResolvedCategory[]>`로 메모해 같은 `overrides` 참조면 같은 배열을 돌려준다(리듀서는 늘 새 `overrides` 객체를 돌려주므로 편집하면 새 배열).
persist: 키 `ftp-browser-file-categories`, `version: 1`, `partialize: (s) => ({ overrides: s.overrides })`(저장 JSON의 `state`에는 `overrides`만 있다), `merge: (persisted, current) => ({ ...current, overrides: sanitizeOverrides((persisted as { overrides?: unknown } | null)?.overrides) })`
(저장분의 다른 키 — 옛 버전이 남긴 `categories` 등 — 는 무시하고 기본 목록은 지금 코드의 `DEFAULT_CATEGORIES`에서 다시 계산한다).
훅 `src/renderer/src/hooks/useFileFilter.ts`(신규): `useAllCategories()`(설정용, 숨김 포함), `useCategories()`(보이는 카테고리), `useTabMatcher(filter)`(`createMatcher` 메모). `Explorer`와 `useTabEntries`가 같은 걸 쓴다. 구현은 셀렉터로 **참조만**(`useFileCategoryStore((s) => s.overrides)`) 고르고 파생은 `useMemo`로 한다 — 셀렉터 안에서 배열을 만들지 않는다(함정 11).

### 탭 (`useTabsStore.ts`)

`Tab.photosOnly` 삭제, `filter: TabFilter` 추가(`newTab`은 `EMPTY_FILTER` 복사). `openTab`은 필터를 물려받지 않는다(보기만 물려받음, `:148-152`). `navigate`/`goBack`/`goForward`는 `query: ''`만 지우고 필터는 둔다.

### 연결

- `lib/entryList.ts` — `FilterOptions { query; matcher: EntryMatcher | null; showHidden }`, `FilterResult.filterCount`.
- `hooks/useTabEntries.ts` — 상태 표시줄·정보 패널이 탐색기와 같은 걸러내기로 센다(`useTabMatcher(tab.filter)`).
- `components/explorer/Explorer.tsx` — `filterEntries`에 `matcher`, `PathBar`에 `entries`(숨김 파일 설정을 반영한 `base`)·`filterHidden`, `EmptyPanel`에 `filterCount`·`filterText`·`onClearFilter`.
- `components/explorer/PathBar.tsx` — 사진만 칩 자리에 `<FileFilterMenu>`.
- `components/explorer/ExplorerStates.tsx` — `EmptyPanel`의 `photosCount` 분기를 필터 분기로.
- `components/settings/SettingsDialog.tsx` — "탐색"(Browsing) 섹션 다음에 `<FileCategorySettings>` 섹션.

---

## 4. 매칭 규칙 (순수 모듈이 책임지는 것)

1. `normalizeExtension(raw)`: 앞뒤 공백 제거 → 소문자 → **앞쪽 `.`을 모두 제거**. 결과가 비었거나, 공백·`/`·`\`가 들어 있거나, `.`으로 끝나거나, `..`이 들어 있으면 `null`. 안쪽 점은 허용(`tar.gz`).
2. `parseExtensionInput(text)`: `[,;\s]+`로 쪼개 각각 정규화. 유효한 것은 입력 순서대로 중복 없이 `valid`, 정규화에 실패한 토큰(원문)은 `invalid`.
3. `extensionOf(name)`: E16. `IMG.JPG`→`jpg`, `a.tar.gz`→`gz`, `README`→`''`, `.gitignore`→`''`, `.config.json`→`json`, `a.`→`''`.
4. `createMatcher(filter, categories)`: 보이는 카테고리 중 `filter.categories`에 든 것만 쓰고(E15) 그 확장자들과 `filter.extensions`를 한 집합으로 합친다. 집합·`noExtension`이 모두 비면 `null`.
   매처(entry): `directory` → 항상 `true`. 그 밖에는 `ext = extensionOf(name)`일 때 `(noExtension && ext === '') || set.has(ext) || 복합 접미사 일치`.
   복합 접미사 = 집합의 점 포함 항목 `c`에 대해 `lower(name).endsWith('.' + c)`이고 `name.length > c.length + 1`.
5. 개수: `countByCategory(files, categories)`는 파일이 아닌 항목을 호출 쪽이 미리 걸러 넣는다고 가정하지 **않고** `directory`를 스스로 제외한다. 보이는 카테고리 전부의 키를 돌려준다(0 포함).
   `extensionCounts`는 `extensionOf` 기준으로 세고 개수 내림차순 → 확장자 오름차순. `''`은 `noExtension`으로 따로 센다.
6. `filterLabel`: 선택된(해석되는) 카테고리 이름 → `.확장자`들 → "(확장자 없음)" 순으로 `, `로 잇고, `max`(기본 3)개를 넘으면 앞 `max`개 + ` +N`.
7. `orphanExtensions(filterExtensions, folderExts)`: `filterExtensions` 중 `folderExts`(= `extensionCounts(...).exts`의 확장자들)에 없는 것을 입력 순서대로 돌려준다(E30). 복합 접미사는 `folderExts`에 있을 수 없으므로 늘 남는다.

---

## 5. 기존 코드와의 대응

| 지금                                                                                                      | 이후                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Tab.photosOnly` (`useTabsStore.ts:20`, 기본 `:70`)                                                       | `Tab.filter` (E14)                                                                                                                                                               |
| `PHOTO_CATEGORIES`·`photosOnly` 분기 (`entryList.ts:52`, `:67-68`)                                        | `matcher` (§4). 이미지·RAW·비디오 세 카테고리 = 옛 사진만                                                                                                                        |
| `useTabEntries.ts:35-39`                                                                                  | `useTabMatcher(tab.filter)`                                                                                                                                                      |
| `Explorer.tsx:165-167` (`filterEntries(base, { …photosOnly })`)                                           | `matcher` 의존성으로 교체                                                                                                                                                        |
| `PathBar.tsx:433-453` 사진만 칩, `PathBarProps.photosHidden`(`:250`)                                      | `FileFilterMenu`, `filterHidden`, `entries`                                                                                                                                      |
| `ExplorerStates.tsx:259-270` `photosCount` 분기, `EmptyPanel` prop `photosCount`·`onShowAll`              | 필터 분기: 문구 `filter.emptyFor`, 버튼 `filter.clearType`("필터 해제", E31 — 찾기 분기의 `filter.clear`(:254)와 구별)                                                           |
| `Explorer.tsx:810` `onShowAll={() => patch({ photosOnly: false })}`                                       | `onClearFilter={() => patch({ filter: EMPTY_FILTER })}`                                                                                                                          |
| 번역 키 `filter.photosOnly`, `explorer.hiddenByPhotos_*`                                                  | 삭제(11개 로케일 전부) — **F4 커밋에서**, 마지막 사용처(`PathBar.tsx:436-437`, `ExplorerStates.tsx:263`)를 지울 때 함께(§13). `explorer.showAll`은 드롭다운 "모두 보기"로 재사용 |
| `explorerEntry.ts:43-62` `EXT_CATEGORY`·`categoryOf`, `InfoPanel.tsx:37` 분류, `EntryThumb.tsx:76` 아이콘 | **그대로**. 필터와 무관(E8)                                                                                                                                                      |

---

## 6. 기존 테스트 처분

| 테스트                                                                    | 처분                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Test-772 `lib/entryList.test.ts` (찾기·사진만·빠진 수)                    | **수정**: `photosOnly: true` 케이스를 `matcher`(이미지·RAW·비디오 세 카테고리의 `createMatcher`)로 바꾸고 `photosCount`→`filterCount`. 단언 값은 그대로(회귀 방지). 번호 유지.                                                                                                   |
| Test-798 `components/explorer/Explorer.test.tsx` (빈 폴더/찾기/사진 필터) | **수정**: "사진 필터로 N개 숨김 · 모두 보기" 구간을 이미지 카테고리 필터 + `이 폴더에 '이미지' 파일이 없습니다` + `[필터 해제]`로 교체. 번호 유지(상세 단언은 Test-946).                                                                                                         |
| Test-828 `components/explorer/PathBar.test.tsx` (사진만 칩 등)            | **수정**: 사진만 칩 클릭 구간을 필터 버튼으로 교체(찾기 Ctrl+F·정렬·보기 전환 단언은 그대로). 번호 유지(상세 단언은 Test-944).                                                                                                                                                   |
| `explorerTestHarness.ts` `setupExplorer`                                  | `useFileCategoryStore.setState({ overrides: EMPTY_OVERRIDES })`를 다른 스토어 초기화(`:148-162`)와 함께 추가(`categories`는 파생이라 따로 지울 것이 없다, E32). 하네스는 테스트가 아니라 번호 없음. 이 하네스는 `confirmBeforeDelete: false`로 시작한다(`:155`) — Test-954 참고. |
| 나머지 `photosOnly` 참조                                                  | 위 세 파일 밖에는 없다(`grep -rn photosOnly src` 확인). 로케일 11개의 `filter.photosOnly`·`explorer.hiddenByPhotos_*`는 §10에서 삭제.                                                                                                                                            |

---

## 7. 구현 함정

1. **열기 클릭이 자신을 닫는 함정(E24).** `document` `click` 리스너가 팝오버를 연 바로 그 클릭을 받으면 즉시 닫힌다(`ItemMenu.tsx:251`와 같은 계열). 기존 `act()` 안 `fireEvent` 테스트는 리스너가 늦게 붙어 통과해 버린다.
   RED 테스트(Test-938)는 `act()` 밖에서 `dispatchEvent(new MouseEvent('click', …))`로 실제 순서를 재현하고, 리스너는 `pointerdown` capture로 바깥을 판정한다.
2. **`photosCount`→`filterCount` 이름 바꾸기**는 `FilterResult`·`PathBarProps`·`EmptyPanel`·`Explorer.tsx` 네 곳. 타입체크가 잡는다.
3. **매처 메모.** `createMatcher`는 매번 새 함수를 만들므로 `useMemo`로 `filter`·카테고리 참조에 묶어라. 안 그러면 `Explorer`의 `filtered`가 렌더마다 다시 계산돼 가상 목록이 흔들린다. `Tab.filter` 객체는 **통째로 교체**하고 제자리 수정하지 마라.
4. **개수 계산은 팝오버가 열렸을 때만.** `PathBar`는 `entries`를 prop으로 넘기되 `countByCategory`/`extensionCounts`는 팝오버 안에서 `useMemo`로 계산한다(닫혀 있을 때 비용 0). 수만 개 폴더에서도 O(n·카테고리 수).
5. **IME(E25).** 한국어 조합 중 Space/Enter에 `e.nativeEvent.isComposing`이 `true`다. 이때 확정하면 "ㅌ" 같은 조각이 태그가 된다. `keyCode === 229`도 같이 본다. 키 이벤트는 `stopPropagation`해서 목록의 type-ahead(`useTypeAhead`)·Delete 단축키로 새지 않게 한다(`PathInput`의 `e.stopPropagation()`과 같은 이유, `PathBar.tsx:77`).
6. **persist 경로(E32).** `partialize`로 `overrides`만 저장하고, `merge`에서 `sanitizeOverrides`를 거치며 저장분의 다른 키는 버린다(`categories`가 저장돼 있으면 앱 업데이트 뒤 옛 기본 목록이 되살아난다). 손상된 localStorage(`defaults`가 배열, `custom[].extensions`에 숫자 등)가 앱을 죽이지 않아야 한다. `localStorage`가 막힌 환경은 zustand persist가 처리한다(스토어는 기본값으로 동작).
7. **사용자 카테고리 id**는 `custom-<무작위>`. 같은 밀리초에 두 번 만들어도 겹치지 않아야 한다(리듀서는 id를 인자로 받아 결정적, 스토어 액션이 생성 — Test-936).
8. **분할 뷰(`split-view.md`)**: 팝오버는 `useActiveTab`이 아니라 prop `tab`만 읽는다. 패널 최소 폭 280 < 팝오버 288이므로 `clampMenuPosition`이 필수다.
9. **`getFileExtension`을 재사용하지 마라.** 맨 앞 점 이름과 끝 점 이름을 다르게 본다(E16). 아이콘 분류 쪽을 건드리면 E8 위반.
10. **i18n.** `{{count}}`를 쓰면 복수형 키(`_one`/`_other`, ru `_few`/`_many`)가 강제된다(`i18n.test.ts`의 "plural category" 검사). 개수 문구는 `{{n}}`을 쓰거나 JSX에서 `toLocaleString`으로 조립해 복수형을 피한다.
11. **zustand 5 셀렉터는 새 배열·객체를 돌려주면 안 된다.** zustand 5.0.x(`useSyncExternalStore` 기반)에서 스냅샷이 호출마다 다르면 React 19가 "getSnapshot should be cached" 경고와 무한 렌더 루프를 낸다. 전형은 `useFileCategoryStore((s) => visibleCategories(resolveCategories(s.overrides)))`. 셀렉터는 저장된 참조(`s.overrides`)만 고르고 `resolveCategories`·`visibleCategories`·`.filter/.map`은 `useMemo` 또는 `selectCategories`의 WeakMap 메모로 한다. `useShallow`로 덮지 마라 — 원인이 가려진다. Test-936이 `renderHook`으로 고정한다.

---

## 8. 기각한 대안

| 대안                                                     | 기각 이유                                                                                                                                                                                                   |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useSettingsStore`에 `fileCategories` 필드 + version 3   | 병렬 스펙(사이드바 폭 persist)과 `migrate` 버전이 부딪힌다. 별도 스토어가 되돌리기도 쉽다(E12).                                                                                                             |
| 설정에 확장자 목록 전체를 저장(사본)                     | 앱이 기본 목록에 확장자를 더해도 사용자에게 전달되지 않는다. delta 저장이면 병합된다(E13).                                                                                                                  |
| `ItemMenu`에 체크 항목·입력칸 지원 추가                  | 메뉴 전체가 `MenuItem[]` 버튼 행이라 입력칸·접이식 구역이 안 맞고, `ItemMenu.test.tsx`·`PathBar.test.tsx` 등 기존 메뉴 테스트에 회귀 위험. 전용 팝오버가 작다(E23).                                         |
| 필터 칩을 카테고리 수만큼 막대에 나열                    | 7+개 칩이 `compact` 막대(<900px)에 안 들어간다. 드롭다운 하나가 분할 패널 280px에서도 산다.                                                                                                                 |
| 기본 카테고리도 삭제 허용                                | 결정 §E-6(숨김만). 삭제하면 "기본값 복원"이 모호해진다.                                                                                                                                                     |
| 필터 분류를 `EntryCategory`(아이콘 분류)에 합치기        | 설정 편집이 썸네일/아이콘을 바꾸게 된다(E8 위반).                                                                                                                                                           |
| 확장자를 대소문자 구분                                   | 카메라·Windows는 `IMG.JPG`가 흔하다(E4).                                                                                                                                                                    |
| 옛 `photosOnly` 마이그레이션 함수                        | 저장된 데이터가 없다(E10). 쓰이지 않는 코드가 된다.                                                                                                                                                         |
| 해석된 `categories`를 스토어 상태 필드로 두고 persist    | 기본 persist가 직렬화해 저장된 옛 목록이 앱 업데이트 뒤에도 남고, `merge`가 `overrides`만 손보면 되살아난다(E7·E13 병합 위반). 테스트 초기화도 낡은 목록을 남긴다. `overrides`만 상태로 두고 파생한다(E32). |
| `filter.clear`를 "필터 해제" 버튼에도 재사용             | 같은 이름의 버튼이 둘(찾기 X, 종류 필터 해제)이 되고 ko 문구가 `필터 지우기`라 E5와 다르다(E31). 전용 키 `filter.clearType`.                                                                                |
| 현재 폴더에 없는 확장자 조건을 행으로 계속 남기기(`(0)`) | 폴더를 옮길 때마다 체크리스트가 지난 폴더의 확장자로 불어난다. 행은 현재 폴더, 나머지는 칩으로 파생(E30).                                                                                                   |
| 확장자를 `.` 포함해 저장                                 | 입력 규칙("선행 `.` 무시")과 비교가 단순해지지 않는다. 점 없는 소문자로 통일(E4).                                                                                                                           |

---

## 9. 접근성·상호작용 요약

- 트리거: `aria-haspopup="dialog"`, `aria-expanded`, `aria-controls="filter-menu-<tab.id>"`. 활성 시 `data-active="true"` + 배지 텍스트(숫자). `aria-pressed`는 쓰지 않는다(토글이 아니라 팝오버 트리거).
- 팝오버: `role="dialog"`, `aria-label`(`filter.menuLabel`). 열리면 첫 컨트롤("모두 보기" 또는 첫 체크박스)로 포커스. `Tab` 순환은 팝오버 안에서 자연스럽게(포커스 트랩은 만들지 않는다 — 바깥 클릭·Esc로 닫는다).
- 카테고리/확장자 행은 네이티브 `<input type="checkbox">` + `<label>`(레이블 텍스트 "이미지 (42)"). 0개 행은 `data-empty="true"` + `opacity` 낮춤. **`disabled`가 아니다**.
- "고급…"은 `aria-expanded` 버튼. 펼치면 같은 팝오버 안에서 아래로 늘어난다(내부 스크롤, 최대 높이 `min(70vh, 480px)`).
- 칩 삭제 버튼 `aria-label` = `filter.removeExtension`. 태그 입력 `aria-label` = `filter.extensionInput`. 칩은 _현재 폴더에 없는_ 확장자 조건이다(E30). 조건이 있으면 "고급…"은 펼친 채 열린다.
- 종류 필터를 비우는 빈 상태 버튼의 이름은 `filter.clearType`이고 찾기 X 버튼(`filter.clear`)과 다르다(E31).
- 설정 섹션: 각 카테고리는 `role="group"` + `aria-label`=이름. 확장자 칩 삭제 버튼과 입력칸에 라벨.

---

## 10. i18n

새 키는 `en.ts`(원본)와 나머지 **10개 로케일**(ko ja zh-CN zh-TW de fr es it pt-BR ru)에 번역해 넣는다(`satisfies LocaleMessages` + `i18n.test.ts`가 누락·자리표시자 불일치를 잡는다). 모든 키는 복수형을 쓰지 않는다(함정 10).

| 키                                    | en                                                                                                  | ko                                                                                |
| ------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `filter.button`                       | `Filter`                                                                                            | `필터`                                                                            |
| `filter.buttonTooltip`                | `Filter by file type`                                                                               | `파일 종류로 거르기`                                                              |
| `filter.activeTooltip`                | `Filter: {{what}} · {{n}} hidden`                                                                   | `필터: {{what}} · {{n}}개 숨김`                                                   |
| `filter.menuLabel`                    | `File type filter`                                                                                  | `파일 종류 필터`                                                                  |
| `filter.advanced`                     | `Advanced…`                                                                                         | `고급…`                                                                           |
| `filter.advancedHeading`              | `Extensions in this folder`                                                                         | `이 폴더의 확장자`                                                                |
| `filter.noExtension`                  | `(no extension)`                                                                                    | `(확장자 없음)`                                                                   |
| `filter.extensionInput`               | `Add extensions (comma or Enter)`                                                                   | `확장자 추가 (쉼표 또는 Enter)`                                                   |
| `filter.extensionInvalid`             | `Not a valid extension`                                                                             | `올바른 확장자가 아닙니다`                                                        |
| `filter.removeExtension`              | `Remove {{ext}}`                                                                                    | `{{ext}} 제거`                                                                    |
| `filter.emptyFor`                     | `No “{{what}}” files in this folder.`                                                               | `이 폴더에 '{{what}}' 파일이 없습니다.`                                           |
| `filter.clearType`                    | `Clear type filter`                                                                                 | `필터 해제`                                                                       |
| `settings.categories`                 | `File categories`                                                                                   | `파일 카테고리`                                                                   |
| `settings.categoriesHint`             | `Choose which extensions each filter category covers.`                                              | `필터 카테고리마다 어떤 확장자를 묶을지 정합니다.`                                |
| `settings.categoryAdd`                | `Add category`                                                                                      | `카테고리 추가`                                                                   |
| `settings.categoryNewName`            | `New category`                                                                                      | `새 카테고리`                                                                     |
| `settings.categoryName`               | `Category name`                                                                                     | `카테고리 이름`                                                                   |
| `settings.categoryDelete`             | `Delete category`                                                                                   | `카테고리 삭제`                                                                   |
| `settings.categoryDeleteTitle`        | `Delete “{{name}}”?`                                                                                | `'{{name}}' 카테고리를 삭제할까요?`                                               |
| `settings.categoryHide`               | `Hide`                                                                                              | `숨김`                                                                            |
| `settings.categoryShow`               | `Show`                                                                                              | `표시`                                                                            |
| `settings.categoryHidden`             | `Hidden`                                                                                            | `숨겨짐`                                                                          |
| `settings.categoryRestore`            | `Restore defaults`                                                                                  | `기본값 복원`                                                                     |
| `settings.categoryRestoreAll`         | `Restore all defaults`                                                                              | `모든 기본값 복원`                                                                |
| `settings.categoryRestoreAllTitle`    | `Restore the default categories?`                                                                   | `기본 카테고리를 복원할까요?`                                                     |
| `settings.categoryRestoreAllMessage`  | `Your edits and hidden state of the default categories are reset. Categories you created are kept.` | `기본 카테고리의 편집과 숨김이 초기화됩니다. 직접 만든 카테고리는 그대로 둡니다.` |
| `settings.categoryExtensionAdd`       | `Add extension`                                                                                     | `확장자 추가`                                                                     |
| `settings.categoryExtensionExists`    | `.{{ext}} is already in this category.`                                                             | `.{{ext}}은(는) 이미 이 카테고리에 있습니다.`                                     |
| `settings.categoryExtensionDuplicate` | `.{{ext}} is also in “{{name}}”.`                                                                   | `.{{ext}}은(는) '{{name}}'에도 있습니다.`                                         |

삭제: `filter.photosOnly`, `explorer.hiddenByPhotos_one`, `explorer.hiddenByPhotos_other`(+ ru `_few`/`_many`)를 11개 로케일에서 모두 — **F3이 아니라 F4 커밋에서**. `MessageId = keyof typeof en`(`i18n/index.ts:32`)이 모든 `t()` 호출을 타입 검사하므로 두 키의 마지막 사용처(`PathBar.tsx:436-437`, `ExplorerStates.tsx:263`)가 남은 채 지우면 typecheck가 깨진다. 그 외 `explorer.showAll`(모두 보기)·`category.*`(카테고리 이름)는 재사용이므로 번역을 바꾸지 않는다. `filter.clear`도 번역을 바꾸지 않고 찾기용으로 남긴다(E31) — 새 문구는 `filter.clearType`이 맡는다. `filter.clearType`의 각 로케일 번역은 같은 로케일의 `filter.clear`와 문구가 달라야 한다.

---

## 11. 기준선·기존 결정과의 관계

- explorer-shelf D의 "사진만 칩"(전용 칩, 이미지 아이콘, `−N`)은 이 문서가 **대체**한다. 나머지 PathBar 결정(찾기 Ctrl+F `id=explorer-filter-<tab.id>`, 정렬 메뉴, 보기 전환, `compact` < 900)은 그대로.
- 필터 단축키는 만들지 않는다(범위 밖). 키보드는 트리거 버튼에 `Tab`으로 닿고 Enter/Space로 연다.
- `explorer-menu-and-focus.md`의 선택=포커스 통합과는 독립이다. 단, 필터로 숨겨진 선택 항목이 삭제·보내기 대상에 들지 않는다는 지금의 성질은 지켜야 한다(Test-954).

---

## 12. 테스트 케이스 리스트 (확정)

`Test-920`~`Test-954` 신규(예약 범위 920~959 안, 955~959는 비워 둠). 각 테스트에 `covers: Test-N` 주석. **1:1 매핑. 케이스 추가·병합·재해석 금지.** 수정 대상 기존 테스트는 번호를 유지한다(§6).
renderer 컴포넌트 테스트는 첫 줄에 `/** @vitest-environment jsdom */`, `vi.stubGlobal('api', makeApiMock(...))`. 컴포넌트 테스트의 폴더 항목은 `ftp(name)`/`ftp(name, { dir: true })`(`explorerTestHarness.ts`)로 만든다.

### A. 순수 매처 (`src/renderer/src/lib/fileCategories.test.ts`, 신규, node)

| #        | 케이스                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Test-920 | `normalizeExtension`: `' .JPG '`→`'jpg'`, `'..png'`→`'png'`, `'Tar.GZ'`→`'tar.gz'`. `null`: `''`, `'.'`, `'a b'`, `'a/b'`, `'a\\b'`, `'tar.'`, `'a..b'`                                                                                                                                                                                                                                                                                             |
| Test-921 | `parseExtensionInput('jpg, .PNG;webp  jpg a/b')` → `valid: ['jpg','png','webp']`(순서 유지·중복 제거), `invalid: ['a/b']`. 빈 문자열·공백만 → 둘 다 `[]`                                                                                                                                                                                                                                                                                            |
| Test-922 | `extensionOf`: `IMG.JPG`→`jpg`, `a.tar.gz`→`gz`, `README`→`''`, `.gitignore`→`''`, `.config.json`→`json`, `a.`→`''`, `한글.JPG`→`jpg`, `a.b.C`→`c`                                                                                                                                                                                                                                                                                                  |
| Test-923 | `DEFAULT_CATEGORIES`: 7개, id 순서 `image raw video audio doc archive code`. 모든 확장자가 `normalizeExtension`을 통과하고 그 값과 같다. 한 카테고리 안 중복 없음, **기본 카테고리 사이 중복 없음**(`ts`는 `code`에만). 기존 `categoryOf('x.<ext>')`가 `other`가 아니면 같은 카테고리 id여야 한다. 옛 분류에만 있던 `crw nrw srf sr2 x3f`(raw)·`log`(doc)·`dmg`(archive)·`mjs cjs scss`(code)가 들어 있다. §2 표와 정확히 일치                      |
| Test-924 | `resolveCategories(빈 overrides)`: 기본 7개를 그 순서로, 모두 `hidden:false`, `nameKey`가 `category.<id>`, 확장자가 기본 목록과 같다. `visibleCategories`는 같은 길이                                                                                                                                                                                                                                                                               |
| Test-925 | `resolveCategories`: `removed`는 기본에서 빠지고 `added`는 뒤에 붙으며(중복 없음) `hidden:true`는 `visibleCategories`에서 빠진다. 사용자 카테고리는 기본 뒤에 만든 순서로 오고 `name`을 갖는다. **병합**: 두 번째 인자로 _더 새로운 기본 목록_(확장자 하나 추가·하나 삭제)을 주면 새 확장자는 들어오되 사용자의 `removed`·`added`는 유지된다                                                                                                        |
| Test-926 | `sanitizeOverrides`: `null`/배열/문자열 → 빈 overrides. 알 수 없는 기본 id·확장자가 문자열이 아닌 항목·정규화 실패 항목·빈 이름 사용자 카테고리·같은 id 중복 사용자 카테고리는 버린다. 정상 값은 보존. 알 수 없는 키(옛 `photosOnly` 등)는 무시되고 던지지 않는다                                                                                                                                                                                   |
| Test-927 | `createMatcher`: 선택이 없으면 `null`. 카테고리만·확장자만·`noExtension`만·셋 혼합이 합집합(OR)으로 일치한다. 숨김/삭제된 카테고리 id만 있으면 `null`(E15), 일부만 알 수 있으면 아는 것만 쓴다. `activeCount`는 해석되는 카테고리 수 + 확장자 수 + `noExtension` 1                                                                                                                                                                                  |
| Test-928 | 매칭 규칙: `IMG.JPG`가 `jpg`에 일치(대소문자 무시). `a.tar.gz`는 `gz`·`tar.gz` 둘 다 일치하고 `tar`은 불일치. `b.gz`는 `tar.gz` 불일치, 이름이 정확히 `tar.gz`(앞이 비었음)는 `tar.gz` 불일치. `README`·`.gitignore`·`a.`는 `noExtension`에만 일치. 폴더는 어떤 매처에도 `true`(이름이 `x.png`/`x`여도). 심볼릭 링크는 이름으로 판정(E18)                                                                                                           |
| Test-929 | `countByCategory`/`extensionCounts`: 폴더는 세지 않는다. 모든 보이는 카테고리 키가 있고 0도 0으로 나온다. 한 확장자가 두 카테고리에 있으면 양쪽에 센다. `extensionCounts`는 개수 내림차순 → 확장자 오름차순, 확장자 없는 파일은 `noExtension`에만 센다, `a.tar.gz`는 `gz`로 센다. `orphanExtensions(["jpg","tar.gz","log"], ["log","txt"])`→`["jpg","tar.gz"]`(입력 순서 유지, 복합 접미사는 늘 남음), 빈 입력→`[]`, 입력 배열을 바꾸지 않는다(E30) |
| Test-930 | `filterLabel`: `{categories:['image'], …}`→`이미지`(주입한 `nameOf`), 카테고리 → `.ext` → 확장자 없음 순서, 4개째부터 `…, …, … +N`. 해석되지 않는 id는 라벨에 넣지 않는다                                                                                                                                                                                                                                                                           |

### B. 편집 리듀서 (`src/renderer/src/lib/fileCategoryEdit.test.ts`, 신규, node)

| #        | 케이스                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Test-931 | `addExtension`/`removeExtension`: 기본 확장자를 지우면 `removed`에 들어가고, 다시 넣으면 `removed`에서 빠진다(`added`에는 안 들어감). 기본에 없는 확장자를 넣으면 `added`, 지우면 `added`에서 빠진다. 같은 카테고리에 이미 있으면 `result:'exists'`(overrides 불변), 정규화 실패는 `'invalid'`. **다른 카테고리에 이미 있으면** `'added'`이면서 `duplicateOf`에 그 카테고리 id. 입력 객체를 바꾸지 않는다 |
| Test-932 | `setHidden`/`restoreCategory`/`restoreAllDefaults`: 기본 카테고리 숨김·해제. `restoreCategory`는 그 기본 카테고리의 `added`·`removed`·`hidden`만 지우고 다른 카테고리·사용자 카테고리는 그대로. `restoreAllDefaults`는 기본 7개 전부 초기화하되 **사용자 카테고리는 남긴다**(E28)                                                                                                                         |
| Test-933 | `addCustom`/`renameCustom`/`deleteCustom`: 이름 앞뒤 공백 제거, 빈 이름 거부(overrides 불변), 이름 중복 허용, 이름 변경 시 id·확장자 유지, 삭제하면 목록에서 사라진다. 사용자 카테고리에도 `addExtension`/`removeExtension`이 동작한다                                                                                                                                                                    |

### C. 걸러내기 (`src/renderer/src/lib/entryList.test.ts`, 기존)

| #        | 케이스                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Test-934 | `filterEntries`에 `matcher`(이미지·RAW·비디오 세 카테고리)를 주면 Test-772의 목록에서 **옛 `photosOnly: true`와 같은 결과**(`visible` 이름 순서, `hiddenCount`, `queryCount`, `filterCount`)가 나온다. `matcher: null`이면 `filterCount: 0`. 찾기와 함께 쓰면 `filterCount`는 찾기를 통과한 것 중 필터로 빠진 수만 센다(E20). 각 항목은 숨김·찾기·필터 중 처음 걸린 한 단계에서만 센다(겹쳐 세지 않는다) |

### D. 스토어 (jsdom 환경 — persist가 `localStorage`를 쓴다)

| #        | 파일                                        | 케이스                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Test-935 | `stores/useFileCategoryStore.test.ts`(신규) | 편집이 `localStorage['ftp-browser-file-categories']`에 저장되고 `ftp-browser-settings`에는 아무 필드도 더해지지 않는다(그 키의 version은 2 그대로). 저장분을 다시 읽으면(`persist.rehydrate`) 같은 overrides. 손상된 저장값(문자열·잘못된 모양)은 기본 상태로 돌아가고 던지지 않는다. **저장 모양(E32)**: 편집 뒤 `JSON.parse(localStorage.getItem(…)).state`의 키는 정확히 `['overrides']`다(`categories` 없음). **앱 업데이트 시뮬레이션**: `{"state":{"overrides":{"defaults":{"image":{"added":[],"removed":["png"],"hidden":false}},"custom":[]},"categories":[{"id":"image","extensions":["zzz"]}]},"version":1}`을 `localStorage`에 쓰고 `persist.rehydrate()` → `selectCategories`의 `image`는 `jpg`를 갖고 `png`·`zzz`는 없다(저장돼 있던 옛 `categories`가 되살아나지 않고, 기본 목록은 현재 `DEFAULT_CATEGORIES`로 다시 계산되며 사용자의 `removed`는 유지) |
| Test-936 | 같은 파일                                   | 액션: `addExtension`이 `result`/`duplicateOf`를 돌려주고 상태를 갱신한다. `addCustom`을 연달아 두 번(같은 밀리초, 이름이 같아도) 부르면 서로 다른 id. `restoreAllDefaults` 후 사용자 카테고리 유지. **메모·셀렉터 안정성(함정 11)**: `selectCategories(state)`는 `overrides`가 안 바뀌면 같은 배열 참조, 편집하면 새 참조. `renderHook(() => useCategories())`(`hooks/useFileFilter`)가 던지거나 무한 렌더 없이 렌더되고 `rerender` 사이에 같은 배열 참조를 돌려주며, 편집(`act`) 뒤에는 새 참조. `renderHook(({ f }) => useTabMatcher(f))`는 같은 `filter`·같은 카테고리면 `rerender` 사이에 같은 함수 참조                                                                                                                                                                                                                                                           |
| Test-937 | `stores/useTabsStore.test.ts`(기존)         | 새 탭은 `filter`가 비어 있고 `photosOnly` 키가 없다. `patchTab`으로 한 탭에 필터를 주면 다른 탭은 그대로, `openTab`은 필터를 물려받지 않는다. `navigate`·`goBack`·`goForward`는 `query`는 지우되 **`filter`는 유지**한다(`Tab.filter` 참조 동일)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

### E. 필터 드롭다운 (`src/renderer/src/components/explorer/FileFilterMenu.test.tsx`, 신규, jsdom)

폴더 `/c`: `a.jpg a.PNG b.cr3 c.mp4 d.txt README .hidden.jpg sub/(폴더)`로 시작. 기본 `showHidden=false`.

| #        | 케이스                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Test-938 | **열기 클릭이 자신을 닫지 않는다**: `act()` 밖에서 트리거에 실제 순서로 `pointerdown`→`mouseup`→`click`을 `dispatchEvent`해도 팝오버(`role=dialog`)가 열려 있다. 트리거를 다시 누르면 닫힌다. 팝오버 *바깥*의 `pointerdown`·`Esc`·창 `blur`로 닫히고, Esc는 포커스를 트리거로 돌려준다. 팝오버 *안*의 `pointerdown`·체크박스 클릭으로는 닫히지 않는다. 닫힌 뒤 리스너가 남지 않는다(언마운트 후 이벤트에도 오류 없음)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Test-939 | 열면 보이는 카테고리가 이미지·RAW·비디오·오디오·문서·압축·코드 순으로 `이름 (개수)`로 나온다: `Images (2)`(숨김 파일 `.hidden.jpg`와 폴더는 제외), `RAW (1)`, `Videos (1)`, `Documents (1)`, 0개인 `Audio (0)`은 `data-empty="true"`이면서 **체크 가능**(disabled 아님). 숨김 파일 설정을 켜면 `Images (3)`. 설정에서 숨긴 카테고리는 없고 사용자 카테고리는 끝에 나온다. 찾기 문자열이 있어도 개수는 그대로(E19). 개수는 로케일 숫자 서식(`1,200`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Test-940 | 체크하면 `tab.filter.categories`가 체크한 순서대로 쌓이고(`['image','video']`) 해제하면 빠진다(OR). "모두 보기"는 필터가 비었을 때 `disabled`, 활성일 때 누르면 `categories`·`extensions`·`noExtension`을 모두 `EMPTY_FILTER`로 되돌리고 체크가 모두 풀린다. 다른 탭의 필터는 그대로                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Test-941 | "고급…"(`aria-expanded`)을 누르면 이 폴더의 확장자 체크리스트가 `.jpg (1)`·`.png (1)`·`.cr3 (1)`·`.mp4 (1)`·`.txt (1)`·`(no extension) (1)`로 개수 내림차순→확장자 순으로 나온다(폴더·숨김 파일 제외). 체크하면 `filter.extensions`(정규화됨)·`filter.noExtension`이 갱신된다. 카테고리와 확장자를 함께 체크하면 둘 다 `filter`에 들어간다(OR은 Test-945에서). 폴더를 옮기면(`entries`를 바꿔 rerender) 목록이 새 폴더 기준으로 다시 계산된다. 접어도 체크는 유지. **폴더를 떠난 조건(E30)**: `.jpg`를 체크한 채 `.jpg`가 없는 폴더(예: `.gif`만 있는 폴더)로 옮기면 체크리스트에 `.jpg` 행은 없고 **칩 `.jpg`**(제거 버튼 `Remove jpg`)가 보이며 `filter.extensions`는 `["jpg"]` 그대로다. 칩 제거 버튼은 `filter.extensions`에서 `jpg`를 뺀다. `.jpg`가 있는 폴더로 돌아오면 칩은 사라지고 `.jpg` 행이 체크돼 있다. `noExtension`만 켠 채 확장자 없는 파일이 없는 폴더로 옮기면 `(no extension) (0)` 행이 `data-empty="true"`로 남고 체크는 해제할 수 있다. 확장자 조건이 있으면 "고급…"은 펼친 채 열린다(없으면 접힘) |
| Test-942 | 태그 입력: `Enter`·`,`·공백으로 확정, `.TAR.GZ`→`tar.gz`로 정규화되어 **칩**(제거 버튼 `Remove tar.gz`)이 되고 `filter.extensions`에 들어간다. 이미 있는 확장자는 중복 안 됨. 폴더 목록에 있는 확장자(`.PNG`)를 입력하면 칩이 아니라 `.png` 행이 체크된다(칩은 현재 폴더에 없는 확장자만, E30). 붙여넣기 `log, md  .TXT`가 셋으로 쪼개진다. 잘못된 토큰(`a/b`)은 입력칸에 남고 `aria-invalid="true"`. **`isComposing`인 Enter/Space는 확정하지 않는다**. 칩 제거 버튼이 `filter.extensions`에서 뺀다. 입력 키 이벤트가 목록 단축키(Delete·type-ahead)로 새지 않는다(`stopPropagation`)                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Test-943 | 키보드·접근성: 트리거는 `aria-haspopup="dialog"`·`aria-expanded`·`aria-controls="filter-menu-<tab.id>"`. Enter로 열면 첫 컨트롤에 포커스. `Tab`으로 체크박스를 지나 Space로 토글된다. 팝오버 `aria-label`=`File type filter`. 체크박스는 레이블 텍스트로 이름이 잡힌다(`getByRole('checkbox', { name: /Images/ })`). `position: fixed`이며 앵커가 우측 끝일 때 `clampMenuPosition`으로 뷰포트 안에 들어온다(`stubMenuViewport`로 크기·뷰포트 고정)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

### F. 경로 막대·탐색기 (기존 파일)

| #        | 파일                                    | 케이스                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Test-944 | `components/explorer/PathBar.test.tsx`  | (Test-828 수정과 짝) 필터 버튼: 비활성이면 `data-active` 없음·배지 없음. 이미지+비디오+확장자 `log` 체크 → `data-active="true"`·배지 `3`·`title`에 활성 내용과 숨긴 수(`Filter: Images, Videos, .log · N hidden`). 해석 안 되는(숨긴) 카테고리 id는 배지에 안 센다. 막대가 좁으면(`compact`) 라벨은 숨고 배지는 남는다. "사진만" 버튼은 더 이상 없다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Test-945 | `components/explorer/Explorer.test.tsx` | 필터 적용: `/c`(위 파일)에서 이미지 체크 → 목록에 `a.jpg a.PNG`와 **폴더 `sub`**만. 이미지+RAW+비디오는 옛 사진만과 같은 항목. 카테고리(이미지)와 확장자(`.txt`)를 함께 → 합집합. 찾기 문자열은 AND(찾기 `a`+이미지→`a.jpg a.PNG`). 필터는 `navigate`로 폴더를 옮겨도 유지되고(찾기는 지워짐), 다른 탭에는 영향 없다. 선택은 보이는 항목만 센다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Test-946 | 같은 파일 (Test-798 수정과 짝)          | 빈 상태 구분: (1) 정말 빈 폴더 → `This folder is empty.`. (2) 찾기만 걸려 일치 없음 → `No items match "zzz"` + 찾기 분기 버튼 `Clear filter`. (3) 필터로 파일이 모두 가려진 폴더(파일 `b.txt`만) + 이미지 필터 → `No “Images” files in this folder.` + **`Clear type filter`** 버튼(E31), 누르면 `tab.filter`가 비고 `b.txt`가 보인다. 두 카테고리면 `Images, Videos` 라벨. (4) 찾기 `b`가 일치하는데 필터가 막은 경우는 **필터 문구**(E21). 이때 막대의 찾기 X 버튼(`Clear filter`)과 패널 버튼(`Clear type filter`)은 **서로 다른 접근 가능한 이름**이어서 `getByRole('button', { name: 'Clear filter' })`가 정확히 하나만 잡히고, 각각 누르면 `tab.query`만 / `tab.filter`만 비워진다. (5) 하위 폴더가 있으면 파일이 모두 가려져도 빈 상태 패널 없이 폴더만 보인다(E22)                                                                                                                                                                                                                                                                                                                                                                                                    |
| Test-947 | `components/layout/StatusBar.test.tsx`  | 상태 표시줄 항목 수·숨긴 수가 탐색기와 같은 매처로 센다: 필터를 걸면 `N items`가 줄고 `N hidden`에 필터로 가려진 수가 더해진다(`useTabEntries`). 설정에서 그 카테고리를 삭제/숨기면(E15) 필터가 꺼진 것으로 보여 항목 수가 원래대로 돌아온다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Test-954 | `components/explorer/Explorer.test.tsx` | 필터가 선택 항목을 가리면 그 항목은 동작 대상이 아니다. **검증 수단은 삭제 IPC 호출이다**: `invokeCalls(h.invoke, 'ftp:deleteBatch')`(로컬 탭이면 `local:deleteBatch`, `askDelete` `Explorer.tsx:331`). `setupExplorer`는 `confirmBeforeDelete: false`로 시작하고(`explorerTestHarness.ts:155`) 그러면 `confirmDelete`가 `useConfirmStore.request`를 쓰지 않고 곧장 `true`를 돌려주므로(`useConfirmStore.ts:30`) `request`만 보는 단언은 삭제가 일어나도 통과한다 — 이 테스트의 주 단언으로 쓰지 않는다. 순서: (1) **양성 대조** — 필터 없이 `b.txt`를 선택하고 Delete → 호출 targets에 `b.txt` 경로가 _있다_(단언이 공회전이 아님을 못 박는다). (2) Delete가 선택을 비우므로 `b.txt`를 다시 선택(`tab.sel`)하고 이미지 필터를 건다 → `useTabEntries.selected`가 비고, Delete를 눌러도 삭제 호출 수가 **늘지 않는다**(어떤 호출의 targets에도 새로 `b.txt`가 없다). (3) 변형: `useSettingsStore.setState({ confirmBeforeDelete: true })`로 켜고 같은 상태에서 Delete → `useConfirmStore.getState().request`가 `null`(숨은 선택 때문에 확인창이 뜨지 않음). (4) 필터를 풀면 선택(`tab.sel`)이 되살아나 `selected`에 `b.txt`가 다시 든다(경로 기준 선택이라 `tab.sel`은 그대로) |

### G. 설정 (`src/renderer/src/components/settings/SettingsDialog.test.tsx`, 기존 + 신규 describe)

설정 창을 열고 "파일 카테고리" 섹션을 찾는다(`role=group`, 이름 = 카테고리 이름).

| #        | 케이스                                                                                                                                                                                                                                                                                                                                                                                  |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Test-948 | 섹션이 기본 7개를 순서대로 보이고 각 확장자가 칩(제거 버튼 포함)이다. 확장자 입력에 `RAF`+Enter → 칩이 늘지 않고 `.raf is already in this category.` 안내(기본 raw에 이미 있음), `heics`+Enter → 칩 추가(스토어 `added`). 칩 제거 → 스토어 `removed`. **다른 카테고리에 있는 확장자**(`png`를 비디오에)를 넣으면 추가되고 경고 `.png is also in “Images”.`가 보인다. 잘못된 입력은 거부 |
| Test-949 | 복원: 카테고리별 "기본값 복원"은 `confirmDialog`를 거쳐(확인 시) 그 카테고리만 되돌린다. 취소하면 그대로. "모든 기본값 복원"은 확인 후 기본 7개의 편집·숨김을 모두 지우되 사용자 카테고리는 남는다. 사용자 카테고리에는 per-카테고리 복원 버튼이 없다                                                                                                                                   |
| Test-950 | 사용자 카테고리: "카테고리 추가" → 새 행이 이름 입력으로 열리고 이름 확정 시 `settings.categoryNewName`이 아닌 입력값으로 저장(공백 제거). 이름 변경, 빈 이름으로 확정하면 이전 이름으로 되돌림. 삭제는 확인 후. 기본 카테고리에는 **삭제 버튼이 없고** `Hide`/`Show` 토글이 있어 숨기면 `Hidden` 표시가 붙는다                                                                         |
| Test-951 | `Explorer.test.tsx`: 설정 편집이 필터에 곧바로 반영된다 — 이미지에서 `png`를 지우면 같은 폴더의 이미지 개수·목록에서 `a.PNG`가 빠지고, 사용자 카테고리 `Docs`에 `txt`를 넣으면 드롭다운에 `Docs (1)`이 생겨 체크 시 `d.txt`가 보인다. 이미지 카테고리를 숨기면 드롭다운에서 사라지고 이미 걸려 있던 이미지 체크는 무시된다(E15)                                                         |
| Test-952 | `lib/explorerEntry.test.ts`(기존): 스토어에서 이미지의 `jpg`를 지우고 숨겨도 `categoryOf('a.jpg')==='image'`, `fromFtpEntry(…'a.jpg').category==='image'`, `isImage` 그대로(E8). `EntryThumb`·정보 패널 분류가 필터 설정에 의존하지 않는다는 회귀 고정                                                                                                                                  |

### H. i18n (`src/renderer/src/i18n/i18n.test.ts`, 기존)

| #        | 케이스                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Test-953 | `it` 두 개(둘 다 `covers: Test-953`). **(a) 추가 — F3에서 GREEN**: §10의 새 키(`filter.clearType` 포함) 전부가 11개 로케일에 비어 있지 않은 문자열로 있다(위 `locale catalogs` 일반 검사와 별개로 키 목록을 명시). `filter.emptyFor`·`filter.activeTooltip`·`settings.categoryDeleteTitle`은 로케일마다 `{{what}}`·`{{n}}`·`{{name}}`을 보존. 모든 로케일에서 `filter.clearType`은 같은 로케일의 `filter.clear`와 문구가 다르다(E31). **(b) 부재 — F4 커밋에서 추가해 GREEN**: `filter.photosOnly`와 `explorer.hiddenByPhotos`(`_one`/`_other`/`_few`/`_many`)는 어느 로케일에도 없다. 이 `it`은 옛 키를 지우는 F4 커밋에서 함께 쓴다 — F3에 먼저 두면 옛 키가 아직 쓰이는 동안 테스트가 RED로 남아 슬라이스 규칙(§13)을 깬다 |

**R3에서만 확인(자동화 불가)**: 실제 마우스 클릭으로 열린 팝오버가 유지됨, 창 가장자리·좁은 분할 패널에서 팝오버 위치, 수천 개 폴더의 열림 지연, 실제 한글 IME 조합, 앱 재시작 뒤 설정 유지, 다크 테마·de/ru 문구 잘림(§14).

---

## 13. 구현 슬라이스

| 슬라이스               | 의존   | 맡는 파일                                                                                                                                                                                                        | 테스트                                         |
| ---------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **F1 순수 모듈**       | —      | `lib/fileCategories.ts`, `lib/fileCategoryEdit.ts`(신규), `lib/entryList.ts`(`matcher`·`filterCount`)                                                                                                            | Test-920~934                                   |
| **F2 스토어·탭**       | F1     | `stores/useFileCategoryStore.ts`(신규), `stores/useTabsStore.ts`(`photosOnly`→`filter`), `hooks/useFileFilter.ts`·`hooks/useTabEntries.ts`, `explorerTestHarness.ts`(스토어 초기화), `lib/explorerEntry.test.ts` | Test-935~937, 952                              |
| **F3 i18n 키 추가**    | —      | `i18n/locales/*.ts` 11개(**새 키 추가만**, `filter.clearType` 포함. 옛 키는 건드리지 않음), `i18n.test.ts`                                                                                                       | Test-953 (a)                                   |
| **F4 드롭다운·탐색기** | F2, F3 | `components/explorer/FileFilterMenu.tsx`(신규), `PathBar.tsx`, `Explorer.tsx`, `ExplorerStates.tsx`, **옛 키 삭제**(11개 로케일의 `filter.photosOnly`·`explorer.hiddenByPhotos_*`), `i18n.test.ts`               | Test-938~947, 953 (b), 954 (+772·798·828 수정) |
| **F5 설정 섹션**       | F2, F3 | `components/settings/FileCategorySettings.tsx`(신규), `SettingsDialog.tsx`                                                                                                                                       | Test-948~951                                   |

병렬 가능: **F1 ∥ F3**, F2는 F1 뒤, **F4 ∥ F5**는 F2·F3 뒤. 각 슬라이스는 커밋 하나 이상이고, 끝에 `npm run typecheck && npm run lint && npm test`가 통과한다. 옛 번역 키는 `MessageId = keyof typeof en`(`i18n/index.ts:32`) 때문에 사용처가 있는 동안 지울 수 없다 — 그래서 **F3은 추가만** 하고, 삭제는 마지막 사용처(`PathBar.tsx:436-437`, `ExplorerStates.tsx:263`)를 지우는 **F4 커밋에서 Test-953 (b)와 함께** 한다(F3이 F4에 의존하지 않는다). F2에서 `photosOnly`를 지우면 F4 전까지 `PathBar`/`Explorer`가 타입 오류이므로, **F2와 F4의 컴파일 가능한 최소 배선(`photosOnly` 참조 제거)을 같은 커밋에 둔다**(앱이 매 커밋 동작). 그 커밋은 칩 UI를 임시로 빼고(F4가 `FileFilterMenu`로 채움), `EmptyPanel`의 옛 분기는 prop 이름만 `filterCount`로 바꿔 옛 키를 그대로 쓰며, Test-798·828의 `photosOnly` 구간은 스토어 직접 설정(`patchTab({ filter })`)과 칩 단언 삭제로 고쳐 GREEN을 유지한다(새 단언은 F4).

---

## 14. 완료 기준

1. Test-920~954와 §6의 수정 테스트(772·798·828)가 GREEN이고 기존 스위트 전체가 GREEN이다(실행 출력으로 확인). `grep -rn "photosOnly\|photosHidden\|photosCount\|hiddenByPhotos\|filter.photosOnly" src`가 비어 있다.
2. 각 테스트에 `covers: Test-N` 주석. `test.skip`·`.only`·빈 테스트 없음. 다음 빈 번호는 `grep -rhoE 'Test-[0-9]+' src script docs | sort -t- -k2 -n | tail -1`로 다시 확인(병렬 스펙이 번호를 먼저 예약한다).
3. `npm run typecheck` · `npm run lint` 통과, 바꾼 파일에 `npx prettier --check`. `npm run build:unpack` 후 `npm run smoke:packaged` 통과.
4. `stryker.config.json`의 `mutate`를 이번 변경분으로 재설정하고 `break: 70` 통과: **신규 순수 파일 통째로** — `src/renderer/src/lib/fileCategories.ts`, `lib/fileCategoryEdit.ts`, `stores/useFileCategoryStore.ts`;
   **바뀐 범위만**(`git diff --unified=0 -- <file> | grep '^@@'`) — `lib/entryList.ts`(`FilterOptions`·`FilterResult`·`filterEntries`), `stores/useTabsStore.ts`(`filter` 필드·`newTab`). 컴포넌트는 넣지 않는다. `_comment_scope`를 이 범위로 고쳐 쓰되,
   **다른 병렬 스펙도 같은 배열을 고치므로** 병합할 때 `mutate`는 *합집합*으로 유지하고 서로의 줄을 덮어쓰지 않는다.
5. R3 실측(아래)을 하고 결과 표를 이 문서 끝에 붙인다.
6. `CLAUDE.md` 소스 지도에 `lib/fileCategories`·`useFileCategoryStore`를 한 줄 더한다.

### R3 실측 계획

jsdom은 실제 클릭 순서·레이아웃·IME·재시작을 재현하지 못한다. 필터는 원격·로컬 양쪽 탭에서 같은 코드라 **로컬 탭만으로 대부분 실측**할 수 있고, 원격은 pyftpdlib(`FTPServer(('127.0.0.1', 2121), …)`, 스크래치 폴더)로 한 번 더 본다.

**준비**: 스크래치에 폴더 `r3-filter/`를 만든다 — `IMG_0001.JPG`…(대문자 확장자 포함 600개 이상, sharp로 생성), `.cr3`·`.mp4`·`.mkv`·`.mp3`·`.pdf`·`.txt`·`.zip`·`.js` 소량, `archive.tar.gz`·`backup.tar`·`data.gz`(복합 접미사), `README`·`Makefile`·`.gitignore`(확장자 없음), 하위 폴더 3개(하나는 비어 있음), 5000개 짜리 폴더 하나(`file_0001.dat`…·`.jpg` 혼합).
**앱 구동**: `unset ELECTRON_RUN_AS_NODE` 뒤 손으로는 `npm run dev -- -- --devtools`. 자동 실측은 `npm run build:unpack` → 패키지 앱을 `--remote-debugging-port=9222`로 띄워 CDP `Runtime.evaluate`·`Input.dispatchMouseEvent`(실제 마우스 순서)·`Page.captureScreenshot`로 한다(이전 R3 방식). `Input.imeSetComposition`/`insertText`로 IME 조합을 흉내 내되 **한글 입력기는 손으로 한 번** 확인한다.

| 항목                   | 확인 내용                                                                                                                                                                                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) 실제 클릭으로 열림 | `Input.dispatchMouseEvent`(mousePressed→mouseReleased)로 "필터"를 누르면 팝오버가 열린 채 유지된다(A1 계열 회귀 없음). 같은 버튼 재클릭·바깥 클릭·Esc로 닫히고 Esc 뒤 포커스가 버튼에 있다                                                                      |
| (b) 개수·필터          | `r3-filter/`에서 이미지 (N)이 실제 폴더의 `.jpg/.jpeg/.png…` 개수와 일치(대문자 `.JPG` 포함, 숨김 파일 제외). 이미지+비디오 체크 → 목록이 그 파일들 + 폴더만. 모두 보기로 복귀. 선택 수 배지·툴팁의 숨긴 수가 맞다                                              |
| (c) 고급·복합          | 고급에 `.gz (2)`·`.tar (1)`·`(확장자 없음) (3)`(`.gitignore` 포함). 태그 `tar.gz` 입력 → `archive.tar.gz`만 걸림(`data.gz`·`backup.tar`은 안 걸림). `gz` 체크 → `archive.tar.gz`·`data.gz`                                                                      |
| (d) 빈 상태            | 이미지가 없는 하위 폴더(파일만 `.txt`)에서 이미지 필터 → `이 폴더에 '이미지' 파일이 없습니다 [필터 해제]`. 하위 폴더가 있는 폴더에서는 폴더만 보이고 패널이 없다                                                                                                |
| (e) 탭별 유지          | 탭 A에 이미지 필터, 탭 B는 전체. 전환·폴더 이동에서 A의 필터가 유지되고 B는 영향 없음. 찾기 문자열은 폴더 이동 시 지워짐                                                                                                                                        |
| (f) 큰 폴더            | 5000개 폴더에서 팝오버 열기·체크가 눈에 띄는 지연 없이(체감 <100ms) 반응하고 가상 목록이 깨지지 않는다                                                                                                                                                          |
| (g) 설정·재시작        | 설정에서 이미지에 `heics` 추가·`png` 제거, 코드 숨김, 사용자 카테고리 "Docs"(`txt`,`md`) 생성 → 앱 종료·재실행 후에도 유지되고 드롭다운에 반영. 그 상태에서 **썸네일은 여전히 `.png`에도 생성**된다(E8). "모든 기본값 복원"으로 기본이 돌아오고 "Docs"는 남는다 |
| (h) 위치·분할          | 창 우측 끝·좁은 창(<900, `compact`)에서 팝오버가 잘리지 않고 라벨은 숨고 배지는 보인다. (분할 뷰가 들어오면 280px 패널에서도)                                                                                                                                   |
| (i) 한글 IME           | 한글 입력기로 "ㅎㅏㄴ" 조합 중 Space/Enter가 태그를 확정하지 않고, 조합 종료 뒤 Enter로 확정된다                                                                                                                                                                |
| (j) 테마·로케일        | 밝은·어두운 테마, ko/de/ru에서 "필터" 버튼·카테고리 행·설정 섹션의 문구가 잘리지 않는다                                                                                                                                                                         |
| (k) 원격               | pyftpdlib 서버의 원격 탭에서도 (b)·(c)가 같게 동작(목록이 `ftp:list`로 왔을 때 대문자 확장자·복합 접미사)                                                                                                                                                       |

---

## 15. 위험과 후속 과제

**위험**

- **저장된 `photosOnly` 마이그레이션은 만들지 않았다(E10).** 탭 상태는 저장되지 않으므로 실제 마이그레이션할 데이터가 없다. 탭 복원(explorer-shelf D23 후속 과제)이 들어오면 그때 `Tab.filter`의 저장·검증을 같이 설계해야 한다.
- **개수 계산이 폴더 크기에 선형.** 팝오버를 열 때만 계산하고 메모하지만, 수십만 개 폴더에서는 열 때 한 박자 걸릴 수 있다. R3 (f)가 5000개로만 본다.
- **확장자가 두 카테고리에 있을 때 개수가 겹친다**(E19, E27). 경고로 알리지만 막지는 않는다.
- **숨긴 카테고리를 다시 보이면 옛 체크가 되살아난다**(E15).
- **현재 폴더에 없는 확장자 조건은 칩으로 파생 표시한다(E30, 미결 권장안).** 폴더를 옮길 때 같은 조건이 행↔칩으로 바뀐다. 저장된 `filter`는 그대로라 혼동은 표시에만 있다.
- **`filter.clearType`의 en 문구 `Clear type filter`는 권장안(E31).** 찾기용 `filter.clear`와 구별되기만 하면 다른 문구로 바꿔도 된다.
- **심볼릭 링크가 이름으로 판정된다**(E18). 옛 동작(링크는 늘 숨김)과 다르다.
- **`.gitignore` 같은 맨 앞 점 파일은 확장자 없음**(E16)이라 "확장자 없음"에 묶이고 `gitignore`로 거를 수 없다.
- **`stryker.config.json`의 `mutate`가 병렬 스펙들과 같은 파일.** 병합 시 합집합 규칙(§14-4)을 안 지키면 서로 덮어쓴다.

**후속 과제(이번 범위 밖)**: 필터 단축키, 폴더만 남았을 때의 안내 띠(E22), 확장자 이름으로 카테고리 자동 추천, 필터 상태를 탭 복원과 함께 저장, 카테고리 가져오기·내보내기, 카테고리 순서 바꾸기, 기본 카테고리 이름 바꾸기.

---

## 16. 관련 코드 포인터

| 파일                                                                                                              | 역할                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`lib/entryList.ts`](../../src/renderer/src/lib/entryList.ts)                                                     | `FilterOptions`(:36-40)·`FilterResult`(:42-50)·`PHOTO_CATEGORIES`(:52)·`filterEntries`(:55-72) — `photosOnly` 분기(:67-68)가 바뀐다                                                                                |
| [`lib/explorerEntry.ts`](../../src/renderer/src/lib/explorerEntry.ts)                                             | `EntryCategory`(:19-27), `EXT_CATEGORY`(:43-57)·`categoryOf`(:60-62) — **건드리지 않는다**(E8). 기본 확장자 대조 기준                                                                                              |
| [`lib/utils.ts`](../../src/renderer/src/lib/utils.ts)                                                             | `getFileExtension`(:31) — 맨 앞 점 이름을 확장자로 본다. 필터는 쓰지 않는다(E16)                                                                                                                                   |
| [`stores/useTabsStore.ts`](../../src/renderer/src/stores/useTabsStore.ts)                                         | `Tab`(:7-21, `photosOnly` :20), `newTab`(:57-72, :70), `navigate`(:95-111)·`goBack`(:113-126)·`goForward`(:128-139)의 `query: ''`, `openTab`(:148-152)                                                             |
| [`stores/useSettingsStore.ts`](../../src/renderer/src/stores/useSettingsStore.ts)                                 | persist 패턴(:49-72, 키 `ftp-browser-settings` v2). 새 스토어가 따라 할 모양이지만 **고치지 않는다**(E12)                                                                                                          |
| [`hooks/useTabEntries.ts`](../../src/renderer/src/hooks/useTabEntries.ts)                                         | `photosOnly`(:35)·`filterEntries`(:38) — 상태 표시줄·정보 패널의 걸러내기                                                                                                                                          |
| [`components/explorer/Explorer.tsx`](../../src/renderer/src/components/explorer/Explorer.tsx)                     | `filterEntries` 호출(:164-168), `PathBar` 배선(`photosHidden` :695), `EmptyPanel` 배선(:803-813, `onShowAll` :810), `askDelete`(:325)·Delete(:584)                                                                 |
| [`components/explorer/PathBar.tsx`](../../src/renderer/src/components/explorer/PathBar.tsx)                       | `PathBarProps`(:245-255), 찾기 X 버튼(`filter.clear` :415), 사진만 칩(:433-453, `filter.photosOnly` :436-437), `compact` 판정(:283, `ResizeObserver`, <900), 정렬 메뉴 `setMenu`(:459)·`ItemMenu` 마운트(:519-526) |
| [`components/explorer/ExplorerStates.tsx`](../../src/renderer/src/components/explorer/ExplorerStates.tsx)         | `EmptyPanel`(:234-292): 찾기 분기(:247, 버튼 `filter.clear` :254)·`photosCount` 분기(:259-270, `hiddenByPhotos` :263)                                                                                              |
| [`components/explorer/ItemMenu.tsx`](../../src/renderer/src/components/explorer/ItemMenu.tsx)                     | 바깥 클릭 닫기 리스너(:233-266, `click` :251) — 자기 충돌 함정의 출처(E24). 위치 보정 `clampMenuPosition`(:187,:202), z-index `z-[60]`                                                                             |
| [`lib/menuPosition.ts`](../../src/renderer/src/lib/menuPosition.ts)                                               | `clampMenuPosition(anchor, size, viewport)` — 팝오버 위치(E23)                                                                                                                                                     |
| [`components/settings/SettingsDialog.tsx`](../../src/renderer/src/components/settings/SettingsDialog.tsx)         | "탐색"(Browsing) 섹션(:245-268)과 "캐시" 섹션(:270~) 사이에 새 섹션. 창 폭 680, `divide-y` 섹션 구조                                                                                                               |
| [`stores/useConfirmStore.ts`](../../src/renderer/src/stores/useConfirmStore.ts)                                   | `confirmDialog({ title, message, confirmLabel, destructive })` — 복원·삭제 확인(E28). `confirmDelete`(:27-30)는 `confirmBeforeDelete`가 꺼져 있으면 `request`를 쓰지 않고 `true` — Test-954                        |
| [`components/layout/StatusBar.tsx`](../../src/renderer/src/components/layout/StatusBar.tsx)                       | `useTabEntries`로 센다(:31, :38)                                                                                                                                                                                   |
| [`components/shelf/InfoPanel.tsx`](../../src/renderer/src/components/shelf/InfoPanel.tsx)                         | `Breakdown`(:32-)이 `entry.category`로 센다 — 필터와 분리 유지                                                                                                                                                     |
| [`components/explorer/explorerTestHarness.ts`](../../src/renderer/src/components/explorer/explorerTestHarness.ts) | `setupExplorer`의 스토어 초기화(:142-162)에 새 스토어 추가. `confirmBeforeDelete: false`(:155)                                                                                                                     |
| [`i18n/locales/en.ts`](../../src/renderer/src/i18n/locales/en.ts)                                                 | `filter.*`(:272-275), `explorer.noMatch/hiddenByPhotos/showAll`(:290-293), `category.*`(:356-363), `settings.browsing`(:189)                                                                                       |
| [`i18n/i18n.test.ts`](../../src/renderer/src/i18n/i18n.test.ts)                                                   | 자리표시자·복수형 검사 — `{{count}}`를 쓰면 복수형 키가 강제됨(함정 10)                                                                                                                                            |
| [`i18n/index.ts`](../../src/renderer/src/i18n/index.ts)                                                           | `MessageId = keyof typeof en`(:32) — 모든 `t()` 키를 타입 검사한다. 옛 키 삭제 시점이 F4인 이유(§13)                                                                                                               |

---

## 17. R3 실측 결과

빌드한 앱(`electron-vite build`, 패키지 아님)을 `--remote-debugging-port`로 띄워 CDP(`Input.dispatchMouseEvent` 실제 마우스 순서, `Input.imeSetComposition`, `Page.captureScreenshot`)로 로컬 탭에서 확인했다. 시스템 언어 ko, 창 1200×768.

| 항목            | 결과                                                                                                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| (a) 실제 클릭   | 통과. 클릭으로 열린 팝오버가 유지, 버튼 재클릭·바깥 클릭·Esc로 닫힘, Esc 뒤 포커스는 버튼.                                                                                                                                     |
| (b) 개수·필터   | 통과. 이미지 (603)(대문자 `.JPG` 600 + png 3), 이미지+비디오 → 항목 610개(= 603+3+폴더 4), 툴팁 `필터: 이미지, 동영상 · 13개 숨김`, 배지 2.                                                                                    |
| (c) 고급·복합   | 통과. `.gz (2)`·`.tar (1)`. `tar.gz` 입력 → 항목 5개(폴더 4 + `archive.tar.gz`), `gz` 체크 추가 → 6개. 확장자 없음은 **(2)**: `.gitignore`는 숨김 파일이라 E19에 따라 세지 않는다(스펙 예시의 (3)은 숨김 파일 표시를 켠 경우). |
| (d) 빈 상태     | 통과. docs(txt만) + 이미지 필터 → `이 폴더에 '이미지' 파일이 없습니다.` + `필터 해제`, 누르면 2개 표시. 하위 폴더만 있는 nested에서는 패널 없이 폴더만.                                                                        |
| (e) 탭별 유지   | 통과. 탭 B는 새 필터 없음으로 시작, 서로 독립, 폴더 이동 뒤에도 각자 유지.                                                                                                                                                     |
| (f) 큰 폴더     | 통과. 5000개 폴더에서 팝오버 열림 지연 측정 불가 수준(<1프레임), 체크 반영 16ms, 개수 `이미지 (1,000)`.                                                                                                                        |
| (g) 설정·재시작 | 통과. `heics` 추가·`png` 제거·코드 숨김·사용자 카테고리 Docs(txt, md) 후 앱을 종료·재실행해도 유지. `png` 썸네일은 편집 뒤에도 그대로 생성(E8). "모든 기본값 복원" 뒤 기본 7개는 돌아오고 Docs는 남음.                         |
| (h) 위치·분할   | 통과. 폭 800(compact)에서 라벨 숨김, 팝오버 288px이 뷰포트 안(l 348–636). 폭 400에서도 안(l 4–292).                                                                                                                            |
| (i) 한글 IME    | CDP 시뮬레이션만 통과: 조합 중(`ㅎㅏㄴ`) Enter가 태그를 만들지 않고 조합 확정(`한`) 뒤 Enter로 `.한` 칩. 실제 한글 입력기는 사람이 확인.                                                                                       |
| (j) 테마·로케일 | 라이트(ko)·다크(de, ru)에서 팝오버(고급 펼침)와 설정 섹션을 캡처해 잘림 없음 확인(ru 스크린샷 육안).                                                                                                                           |
| (k) 원격        | 미실시: 이 환경에 pyftpdlib가 없다. 원격 탭 경로는 jsdom의 원격 탭 테스트(Test-945 등)로만 확인했다.                                                                                                                           |

R3 중 발견해 고친 것: "모두 보기"를 누르면 그 버튼이 비활성이 되어 포커스가 body로 빠졌다 → 첫 체크박스로 옮김(Test-940 단언에 포함).

**검증 범위와 남은 확인(병합 전)**

- 이 작업 트리에서는 `@modelcontextprotocol/*`가 공유 `node_modules`에 없어 `typecheck:node`와 메인 프로세스 테스트 7개가 실패한다(환경 문제, 이번 변경은 메인 프로세스를 건드리지 않는다). 그래서 §14-3의 `npm run typecheck` 전체, `npm run build:unpack`, `npm run smoke:packaged`는 **실행하지 못했다**. 병합 전에 깨끗한 체크아웃에서 `npm ci && npm run typecheck && npm run build:unpack && npm run smoke:packaged`를 돌려 결과를 여기에 적는다.
- R3 (k) 원격 탭과 (i) 실제 한글 입력기는 위 표대로 남아 있다.
- 테스트 편차: Test-935·936은 `it` 하나로 둔다(스펙의 1:1 규칙). Test-953만 `it` 둘이다.
