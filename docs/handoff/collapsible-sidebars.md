# 핸드오프: 접이식·리사이즈 사이드바 (왼쪽 Sidebar + 오른쪽 RightRail)

왼쪽 `Sidebar`(폭 220 고정)와 오른쪽 `RightRail`(폭 288 고정)을 **끌어서 폭을 바꾸고, 접고, 다시 펼 수 있게** 한다.
둘은 같은 모듈(디자인 토큰 + 순수 함수 + 훅 + 핸들 컴포넌트)을 쓴다. 방식은 VS Code의 사이드바를 따른다.
결정의 출처는 `.omc/plans/explorer-v2-decisions.md` §D(사용자와 합의)이고, 이 문서는 그것을 구현 가능한 형태로 풀어 쓴 것이다.
이 문서가 테스트·구현의 유일한 입력이다. 이 문서에 없는 케이스는 완료 범위 밖이다. 케이스를 추가·병합·재해석하지 말 것.

작업 유형(R0): **기능(렌더러 UI, 신규 공용 모듈)**. main·IPC·preload 변경 없음(채널 추가 없음).
순수 함수 → 스토어 → 훅·컴포넌트 → 셸 배선 순으로 슬라이스(§9)마다 테스트를 먼저 세워 RED를 보고 GREEN으로 만든다.
끝으로 실제 앱에서 R3 실측(§10)을 한다.

테스트 번호: **Test-890 ~ Test-917**(예약 범위 890~919 중 918·919는 쓰지 않는다).
같은 시기에 쓰는 다른 스펙: `explorer-menu-and-focus.md`(846~869), `shelf-os-drop.md`(870~889), `file-category-filter.md`(920~959),
`multi-connection.md`(960~1039), `split-view.md`(1040~1099). 같은 파일을 만지는 곳은 §9의 표에 모았다.

---

## 1. 바꾸는 것

```
┌ Toolbar: [◧ 좌 토글] ConnectBar · 새로 고침 · [활동] · 설정 · 연결 해제 [우 토글 ◨] ───────────┐  ← 토글은 양 끝, 위치 고정
├ Sidebar ┃ TabStrip ───────────────────────────────────────────────────┃ RightRail ┤
│ 180–360 ┃ PathBar / Explorer                                          ┃ 240–480   │
│ (기본220)┃                                                             ┃ (기본 288)│
└──────────┸─────────────────────────────────────────────────────────────┸───────────┘
   ┃ = ResizeHandle (히트 6px, role="separator"). 접히면 0px, 창 가장자리 6px가 "끌어내기 영역"으로 남는다.
```

- 핸들을 끌면 폭이 바뀐다. min 아래로 `min/2` 이상 더 끌면 **끌고 있는 중에 즉시 접힌다**(0px). 다시 끌어내면 펼쳐진다(히스테리시스).
- 핸들 더블클릭 = 기본 폭으로 리셋(펼침).
- 툴바 양 끝의 토글 버튼, 단축키(왼쪽 ⌘B / 오른쪽 ⌥⌘B, Windows·Linux는 Ctrl+B / Ctrl+Alt+B), 핸들의 Enter로 접고 편다.
  펼칠 때는 **접기 전 폭**으로 돌아간다.
- 폭과 접힘 상태는 저장된다(재시작 뒤에도 유지).

### 이 스펙이 대체하는 `explorer-shelf.md`의 내용

| 위치                  | 지금 내용                                                       | 이 스펙 이후                                                                                                                                                             |
| --------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| §2 노브 표 "사이드바" | `폭 220px. 아이콘만·숨김 모드 없음` (:56)                       | 폭은 **기본값** 220(180–360). 숨김(접힘)이 있다. "아이콘만" 모드는 여전히 없다(접히면 0px)                                                                               |
| §2 H1·§3 도식         | `Sidebar 220`, `RightRail 288` 고정 (:27)                       | 220·288은 **기본 폭**                                                                                                                                                    |
| §2 D25                | 창 최소 폭 1024. 근거에 "좁을 때 레일을 접는 반응형은 새 코드"  | **최소 폭 1024는 그대로**(`src/main/index.ts:49`). "레일 접기"는 사용자가 하는 동작으로 채택한다. 좁은 창에서 **자동으로** 접는 동작은 여전히 없다(대신 D12의 맞춤 규칙) |
| §9 기각한 대안        | "좁은 창에서 레일 접기 — 랩에 없는 새 반응형 코드. 기각" (:400) | 이 스펙이 "수동 접기"를 채택한다. 자동 접기는 기각 유지                                                                                                                  |
| §15 위험              | 최소 창 폭 1024 (:719)                                          | 그대로. 폭 최대값 조합은 D12로 보호한다                                                                                                                                  |

`explorer-shelf.md`의 D24(접근성 표면: 사이드바 `nav`, 레일 `region`+`tablist`)는 그대로다. 접힌 동안만 접근성 트리에서 빠진다(D8).

---

## 2. 핵심 결정 (R1)

출처 열: **사용자** = 결정 파일 §D(합의 완료, 다시 열지 않는다) · **스펙** = 구현 세부로 이 문서가 정함 ·
**미결(권장안 적용)** = 결정 파일이 답하지 않아 권장안으로 정했다(§11 · 보고서 openQuestions).

| #   | 결정                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 출처                                                                                                                                                                                                                                                                                                                          | 근거                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **라이브러리 없이 자체 모듈.** `react-resizable-panels`는 `package.json`에 없고(`node_modules` 잔재뿐) **추가하지 않는다**. 레이아웃이 `flex` + px 고정 폭이라 훅 하나와 핸들 하나가 더 단순하다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 사용자                                                                                                                                                                                                                                                                                                                        | 의존성을 늘리지 않는다                                                                                                                                                                    |
| D2  | **폭 수치(px)**: 왼쪽 min 180 / 기본 220 / max 360, 오른쪽 min 240 / 기본 288 / max 480. 한 곳(`lib/sidebarLayout.ts`의 `PANE_SPECS`)에 두고, `globals.css` `:root`의 CSS 변수와 **같은 값**임을 계약 테스트가 지킨다(Test-900)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 사용자 + 스펙(동기화)                                                                                                                                                                                                                                                                                                         | CSS 변수만으로는 훅이 숫자를 못 읽는다(jsdom은 `getComputedStyle`로 변수를 풀지 못한다). 상수 하나 + 계약 테스트가 두 벌의 어긋남을 막는다                                                |
| D3  | **디자인 토큰(`globals.css` `:root`)**: `--sidebar-left-min/default/max`, `--sidebar-right-min/default/max`, `--handle-hit: 6px`(히트 영역 = 가장자리 끌기 영역 폭), `--handle-line: 2px`(표시선), `--handle-hover-delay: 300ms`, `--pane-anim: 200ms`. 핸들·전환 CSS는 이 변수만 쓴다(색은 기존 `--ac`·`--bd`). 폭 min/max 변수는 창에서 폭이 넘치지 않게 하는 안전망으로 `.side-pane`의 `max-width`에 쓴다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 사용자(토큰 목록) + 스펙                                                                                                                                                                                                                                                                                                      | 사용자가 정한 토큰 범주(폭 min/default/max, 핸들 두께, 호버 지연, 전환 시간)를 그대로 CSS 변수로 둔다                                                                                     |
| D4  | **스냅 접기.** 끌 때 포인터가 가리키는 폭을 `raw`라 하면, **펼쳐진 상태에서** `raw ≤ min − min/2`(왼쪽 90, 오른쪽 120)이면 접힌다(0px). **접힌 상태에서** `raw ≥ min`(왼쪽 180, 오른쪽 240)이 되면 펼쳐지고 폭은 `clamp(raw)`다. 그 사이(`min/2 < raw < min`)는 **직전 상태를 유지**한다(히스테리시스 구간 = `min/2`). 펼쳐진 동안 `min/2 < raw < min`이면 폭은 min이다. 접힘 판정은 포인터 이동마다, **드래그 중에 즉시** 한다(놓을 때가 아니다)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 사용자(`min/2`) + **미결(권장안 적용)**(펼침 경계)                                                                                                                                                                                                                                                                            | 결정 파일: "접힘 경계 min−min/2, 펼침 경계 동일 거리 반대쪽". 동일 거리(`min/2`)를 접힘 경계 **위쪽**으로 잰 값이 min이라 해석했다. 펼칠 때 폭이 min으로 정확히 시작해 튀지 않는다(§11-1) |
| D5  | **애니메이션.** 드래그 중에는 없다(폭이 포인터를 즉시 따른다). **접힘 상태가 바뀌는 커밋**(토글 버튼·단축키·핸들 Enter/방향키로 펼침·더블클릭 리셋)만 `--pane-anim`(200ms) ease-out 폭 전환. 드래그의 놓기 커밋·방향키 폭 조정·Home/End·창 크기 변화(D12)는 전환 없음. `prefers-reduced-motion: reduce`이면 전환을 끈다. 전환 표시는 DOM `data-animate`로 하고 `transitionend`(폭) 또는 `PANE_ANIM_MS + 50`ms 뒤 지운다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 사용자 + 스펙                                                                                                                                                                                                                                                                                                                 | 창을 줄일 때나 드래그 후 놓을 때 폭이 한 박자 늦게 따라오면 어색하다. 전환 없는 경우에 `data-animate`가 남아 있지 않게 타이머 보험을 둔다                                                 |
| D6  | **핸들.** 히트 영역 6px(`--handle-hit`), 안쪽 경계선(기존 `border-r`/`border-l`) 위에 걸쳐 가운데 정렬. 표시선(2px, `--ac`)은 호버 **300ms 지연 뒤** 강조되고 **드래그 중·키보드 포커스에서는 지연 없이** 강조된다(CSS `transition-delay`만 쓴다. JS 타이머 없음). 커서 `col-resize`. **더블클릭 = 기본 폭 리셋**(접혀 있으면 펼침). 접힌 동안 핸들은 **같은 요소**가 창 가장자리 6px로 자리를 옮겨 "끌어내기 영역"이 된다(요소를 바꿔 끼우면 드래그 도중 접힐 때 포인터 캡처를 잃는다)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 사용자 + 스펙                                                                                                                                                                                                                                                                                                                 | 드래그 중에 핸들이 접힘으로 모양이 바뀌어도 같은 DOM 요소여야 `setPointerCapture`가 이어진다                                                                                              |
| D7  | **접근성.** 핸들은 `role="separator"` `aria-orientation="vertical"` `tabIndex=0`, 이름 `panes.resizeLeft`/`panes.resizeRight`, `aria-valuemin=0` `aria-valuemax=max` `aria-valuenow=현재 폭(접히면 0)` `aria-valuetext`("220 px" / "Collapsed"), `aria-controls`=패널 id. 접힘(0)이 닿을 수 있는 값이라 `valuemin`은 0이다. 접힌 동안에도 핸들은 포커스 가능하다(Enter/→로 다시 펴는 길, WAI-ARIA window splitter 패턴). 키: 키 하나로 늘림 방향 ±16px(Shift는 ±64), Home=min, End=max, Enter=접기/펴기 토글. **방향키로는 접히지 않는다**(접힘 경계가 min 아래 `min/2`이므로 키 조정은 min에서 멈춘다)                                                                                                                                                                                                                                                                                                                                                                        | 사용자(role·방향키) + 스펙                                                                                                                                                                                                                                                                                                    | 늘리는 방향은 핸들이 바깥쪽 끝에 있느냐에 따라 다르다: 왼쪽 핸들은 →가 늘림, 오른쪽 핸들은 ←가 늘림                                                                                       |
| D8  | **접힌 패널은 접근성 트리와 탭 순서에서 빠진다.** 패널 루트에 `inert`와 `aria-hidden`을 둔다(둘 다: 테스트 라이브러리는 `inert`를 보지 못한다). 내용은 **언마운트하지 않는다**(스크롤·상태·선반 항목 유지). 접힐 때 포커스가 패널 안에 있었으면 본문 목록(`[id^="explorer-list-"]`)으로 옮긴다(없으면 그대로). 접힌 패널의 `data-region`은 F6 순환에서 건너뛴다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 스펙                                                                                                                                                                                                                                                                                                                          | `inert`가 없으면 접힌 사이드바의 버튼이 Tab에 걸린다. 크롬은 `inert` 포커스 보정이 비동기라 `useLayoutEffect`에서 먼저 옮긴다                                                             |
| D9  | **토글 버튼 위치 = `Toolbar` 양 끝.** 왼쪽 토글은 툴바의 첫 자식, 오른쪽 토글은 마지막 자식(연결 해제 버튼 뒤). 툴바는 창 전체 폭이라 패널이 접혀도 **자리가 변하지 않는다**(탭줄 끝은 패널 폭에 따라 움직인다). 버튼은 `aria-expanded`·`aria-controls`를 갖고 이름은 고정(`panes.toggleLeft`/`panes.toggleRight`), 툴팁에 단축키를 보인다. 아이콘은 lucide `PanelLeftClose`/`PanelLeftOpen`, `PanelRightClose`/`PanelRightOpen`(펼침 상태 = Close 아이콘)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | **미결(권장안 적용)**                                                                                                                                                                                                                                                                                                         | 결정 파일의 "툴바/탭줄 양 끝에 고정 위치"에서 "고정"을 충족하는 쪽은 툴바뿐이다(§11-2)                                                                                                    |
| D10 | **단축키.** 왼쪽 ⌘B / 오른쪽 ⌥⌘B(macOS), Ctrl+B / Ctrl+Alt+B(Windows·Linux). 키 판별은 `e.code === 'KeyB'`다(`e.key`가 아니다): macOS에서 ⌥B의 `key`는 `∫`이고, 한글 자판에서는 `ㅠ`일 수 있다. 플랫폼 수식키만 맞아야 한다(macOS는 `metaKey`·`!ctrlKey`, 그 밖은 `ctrlKey`·`!metaKey`). Shift가 눌렸거나 `AltGraph`(많은 자판의 AltGr = Ctrl+Alt)이면 가로채지 않는다. **입력 칸에 포커스가 있어도 동작**한다(F6과 같다: `AppShell`의 `typing` 검사 앞). 표시는 `formatPaneShortcut`(macOS `⌘B`/`⌥⌘B`, 그 밖 `Ctrl+B`/`Ctrl+Alt+B`)                                                                                                                                                                                                                                                                                                                                                                                                                                           | 사용자(키 조합) + 스펙(`code`·AltGr 처리)                                                                                                                                                                                                                                                                                     | `TabStrip`의 Ctrl 계열 처리기는 `altKey`가 눌리면 물러나므로 충돌하지 않는다(`TabStrip.tsx:107`). `Ctrl+B`는 현재 어디에도 쓰이지 않는다                                                  |
| D11 | **저장.** 별도 스토어 `useLayoutStore`(persist 키 `ftp-browser-layout`, version 1): `{ left: {width, collapsed}, right: {width, collapsed} }` + 비영속 필드 `priority: PaneSide                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | null`(마지막으로 커밋한 쪽, 기본 null — D12의 맞춤 우선권, `partialize`에서 빠진다). `width`는 **마지막으로 펼쳐져 있던 폭**(접혀 있는 동안에도 유지 → 펼 때 복원). 읽을 때 `sanitizePaneState`가 범위 밖·잘못된 값을 고친다. 드래그 중에는 훅의 지역 상태만 바꾸고 **놓을 때 한 번** 커밋한다(`localStorage` 쓰기 폭주 방지) | 스펙                                                                                                                                                                                      | 결정 파일은 "`useSettingsStore` persist 또는 별도 키"를 열어 뒀다. `useSettingsStore`는 `version: 2` 이전(`:67-71`)에 묶여 있고 다른 스펙(필터 설정 등)이 같이 만진다. 파일을 분리하면 충돌과 버전 올림이 없다 |
| D12 | **창이 좁을 때의 맞춤(표시 전용).** 본문이 `CENTER_MIN = 480`px 아래로 내려가지 않게, 두 패널의 합이 `컨테이너 − 480`을 넘으면 각자 **min 위의 여유분에 비례해** 줄여서 그린다(`fitPaneWidths`). 저장된 값은 건드리지 않는다(창을 키우면 원래 폭으로 돌아온다). 끌 때의 상한도 `컨테이너 − 480 − 반대쪽 화면 폭`이다(`dragMax`, 하한 min; 반대쪽 화면 폭 = **드래그 시작 때** 맞춤이 적용돼 그려진 폭, D16). 맞춤은 **가장 최근에 커밋한 쪽(`priority`)을 우선**한다: 줄여야 하면 반대쪽의 min 위 여유분을 먼저 줄이고, 모자랄 때만 우선 쪽을 줄인다(`priority`가 null이면 위의 비례 분배). 놓은 직후 패널이 튀지 않게 하는 규칙이다. 컨테이너 폭을 모르면(0·null, jsdom) 맞춤을 하지 않는다. 컨테이너는 `AppShell`이 `useElementWidth`(`hooks/useElementWidth.ts:8`)로 재서 두 패널에 넘긴다                                                                                                                                                                                  | **미결(권장안 적용)**                                                                                                                                                                                                                                                                                                         | 최대 폭 360 + 480이면 최소 창(1024)에서 본문이 184px만 남는다. 분할 뷰가 요구하는 폭(패널 2×280)은 이 스펙이 보장하지 않는다(`split-view.md` 몫, §11-3)                                   |
| D13 | **접힌 오른쪽 레일과 선반.** 레일이 접혀 있어도 Shift+S는 선반에 담고 레일을 **자동으로 펼치지 않는다**(사용자가 접은 선택을 존중). 날아가는 효과(`flyTo`)는 접힌 패널의 바깥쪽 가장자리로 간다(`getBoundingClientRect`는 클리핑과 무관). 접힌 레일 위의 놓기 대상은 없다. 툴바 토글 버튼에 선반 개수 배지는 **이번 범위가 아니다**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | **미결(권장안 적용)**                                                                                                                                                                                                                                                                                                         | 결정 파일에 없다. 최소 변경을 택하고 후속 과제로 남긴다(§11-4)                                                                                                                            |
| D14 | **드래그 취소·예외.** 드래그 중 Esc = 시작 상태로 복귀하고 커밋하지 않는다. 주 버튼(`button === 0`)만 드래그를 시작한다. 이동 없이 눌렀다 놓기만 한 것은 **커밋하지 않는다**(맞춤으로 줄어 보이는 폭이 저장값을 덮어쓰지 않게). `pointercancel`·`lostpointercapture`는 놓기와 같다(이미 끝난 드래그에 뒤따라 오는 `lostpointercapture`·`pointerup`은 무시 — 실제 브라우저는 `pointerup` 뒤에도 `lostpointercapture`를 보낸다). `pointermove`의 `buttons`는 보지 않는다(§6). 핸들에서 `pointerdown`은 기본 동작(텍스트 선택·포커스 이동)을 막되 핸들에 직접 `focus()`한다                                                                                                                                                                                                                                                                                                                                                                                                       | 스펙                                                                                                                                                                                                                                                                                                                          | 잘못 시작한 드래그를 되돌릴 길이 있어야 한다                                                                                                                                              |
| D15 | **놓을 때 기억할 폭**(`settleDrag`): 펼쳐진 채 끝나면 마지막 폭, **접힌 채 끝나면 드래그를 시작할 때의 폭**(접힌 상태에서 시작해 접힌 채 끝나면 기억 폭 불변). 접힘을 향해 끌었다 놓은 것은 "작게"가 아니라 "숨김"을 뜻하기 때문이다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | **미결(권장안 적용)**                                                                                                                                                                                                                                                                                                         | 결정 파일은 "펼칠 때 접기 전 폭 복원"만 말한다. "접기 전"을 드래그 시작 폭으로 정의했다(§11-5)                                                                                            |
| D16 | **포인터 처리.** 핸들에 `setPointerCapture`(없는 환경에서는 건너뜀 — jsdom에는 없다)를 걸고 `pointermove`/`pointerup`을 핸들에서 받는다. 이동량은 **델타**로 계산한다: `raw = base ± (x − x0)`(`base` = 시작 시 접혀 있으면 0, 아니면 **그때 화면에 그려진 폭**(맞춤 적용값, 저장값이 아니다) · 왼쪽 +, 오른쪽 −). 요소 좌표(`getBoundingClientRect`)를 쓰지 않는다. **드래그 중 렌더 모델**: 끌고 있는 쪽은 `resolveDrag` 결과(이미 `dragMax`로 제한됨)를 **맞춤을 다시 적용하지 않고 그대로** 그린다. 반대쪽 패널은 저장값만 보므로 드래그 동안 폭이 변하지 않는다(= 시작 때 화면 폭). `dragMax`의 `otherWidth`는 시작 스냅샷(ref)에 담은 그 반대쪽 화면 폭이다. 놓으면 `commit`이 `priority`를 끌었던 쪽으로 바꾼다 → 상한에서 놓으면 두 폭이 그대로, 상한보다 작게 놓으면 반대쪽이 저장 폭 쪽으로 남는 공간만큼 넓어질 수 있다(표시 전용 맞춤의 정상 동작, 전환 없음). `requestAnimationFrame` 합치기는 하지 않는다(그리드는 `ResizeObserver`가 프레임당 한 번으로 합친다) | 스펙                                                                                                                                                                                                                                                                                                                          | 델타 방식은 jsdom에서 그대로 테스트되고, 가장자리 영역에서 시작한 드래그와 핸들에서 시작한 드래그를 같은 식으로 다룬다                                                                    |
| D17 | **접힌 오른쪽 가장자리와 스크롤바.** 접힌 동안 오른쪽 끌기 영역(6px)이 본문 스크롤바 위에 겹친다. 이번 범위는 겹침을 허용하고 R3로 확인한다(§10). 스크롤바가 가려지면 `Explorer` 스크롤러에 `--handle-hit` 만큼 여백을 주는 후속 수정을 한다. 왼쪽은 탭줄·목록 왼쪽 끝이라 겹치는 스크롤바가 없다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | **미결(권장안 적용)**                                                                                                                                                                                                                                                                                                         | 가장자리를 비워 두는 방식은 "0px 접힘"(사용자 결정)을 깬다                                                                                                                                |

---

## 3. 화면 구조와 상태

```
AppShell (layout/)
├ Toolbar     [왼쪽 토글] ConnectBar … ActivityPill · 설정 · 연결 해제 [오른쪽 토글]
└ <div ref={rowRef} className="flex min-h-0 flex-1">      ← useElementWidth(rowRef) = containerWidth
    ├ SidePane side="left"  id="sidebar-pane"  containerWidth    (신규, layout/SidePane.tsx)
    │   ├ <div class="side-pane" style={{ width }} data-side data-collapsed data-dragging data-animate inert aria-hidden>
    │   │   └ <div style={{ width: contentWidth }}>  <Sidebar/>  </div>      ← 안쪽 폭 고정: 접히는 동안 내용이 다시 흐르지 않는다
    │   └ <ResizeHandle …/>                                               ← 클리핑되는 div의 바깥(형제)
    ├ <main data-region="content"> TabStrip · Explorer </main>
    └ SidePane side="right" id="rail-pane" containerWidth   <RightRail/>
```

| 신규·변경 파일                              | 내용                                                                                                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/sidebarLayout.ts` (신규, 순수)         | §4의 상수·함수 전부. React·DOM·스토어를 import하지 않는다                                                                                               |
| `stores/useLayoutStore.ts` (신규)           | D11. 액션: `commit(side, patch)`(클램프), `toggle(side)`, `reset(side)` — 셋 다 `priority`를 `side`로 바꾼다                                            |
| `hooks/useResizableSidebar.ts` (신규)       | 스토어 + 지역 드래그 상태 → 렌더 값과 이벤트 핸들러                                                                                                     |
| `components/layout/ResizeHandle.tsx` (신규) | `role="separator"` 한 요소. 훅이 준 값·핸들러를 그린다. 자기 안에 상태·타이머 없음                                                                      |
| `components/layout/SidePane.tsx` (신규)     | 훅 + 핸들 + 클리핑 컨테이너 + 접힘 시 포커스 옮기기(D8). `Sidebar`/`RightRail`은 이것의 `children`                                                      |
| `Sidebar.tsx` · `RightRail.tsx`             | 루트 클래스의 고정 폭 `w-[220px]` · `w-[288px]`를 `w-full`로 바꾼다. **그 밖은 건드리지 않는다**(단독 렌더하는 Test-820·821·808이 그대로 통과해야 한다) |
| `AppShell.tsx` · `Toolbar.tsx`              | 패널 감싸기, 컨테이너 폭 측정, 단축키(D10), F6 순환에서 접힌 지역 건너뛰기, 토글 버튼 두 개                                                             |
| `styles/globals.css`                        | D3의 토큰, `.side-pane`(전환·`max-width`), `.pane-handle`(히트·표시선·호버 지연·`forced-colors`), 동작 줄이기에서 `.side-pane { transition: none }`     |
| `i18n/locales/*.ts` 11개                    | §7                                                                                                                                                      |

`useLayoutStore` 상태:

```ts
interface PaneState {
  width: number
  collapsed: boolean
} // width = 마지막으로 펼쳐져 있던 폭
interface LayoutStore {
  left: PaneState
  right: PaneState
  priority: PaneSide | null // 비영속. commit/toggle/reset이 그 쪽으로 바꾼다 (D12)
  commit
  toggle
  reset
}
// 기본값: left { 220, false }, right { 288, false }, priority null
```

훅이 소유하는 지역 상태: `live: PaneState-like | null`(드래그 중에만), `animate: boolean`, 시작 시점 스냅샷(ref).
**렌더되는 폭**(한 모델, D12·D16):

- **평소**(드래그 중이 아닌 쪽 포함): `fitPaneWidths(containerWidth, left(stored), right(stored), priority)`의 해당 쪽. 접힘이면 0.
- **자기가 드래그 중인 쪽**: `live.width` 그대로(맞춤 없음). `live`는 `dragMax(side, containerWidth, 시작 때 반대쪽 화면 폭)`로 이미 제한돼 있어 합이 `컨테이너 − 480`을 넘지 않는다. 반대쪽 훅은 저장값만 보므로 드래그 동안 폭이 변하지 않는다.
- **놓기**: `commit` → `priority`=끌었던 쪽 → 평소 규칙. 상한에서 놓으면 놓기 전후 폭이 같고(튀지 않음), 더 작게 놓으면 반대쪽만 저장 폭 쪽으로 넓어진다.

---

## 4. 대상 API (순수 모듈 · 스토어 · 훅)

```ts
// src/renderer/src/lib/sidebarLayout.ts — 순수. 모든 수는 px 정수.
export type PaneSide = 'left' | 'right'
export interface PaneSpec {
  readonly min: number
  readonly def: number
  readonly max: number
}
export interface PaneState {
  width: number
  collapsed: boolean
}

export const PANE_SPECS: Record<PaneSide, PaneSpec> // left 180/220/360, right 240/288/480 (D2)
export const SNAP_RATIO = 0.5 // 접힘 거리 = min × 0.5 (D4)
export const CENTER_MIN = 480 // D12
export const KEY_STEP = 16,
  KEY_STEP_LARGE = 64 // D7
export const PANE_ANIM_MS = 200 // --pane-anim 과 같은 값 (D3·D5)

/** 정수로 반올림해 [min, maxWidth ?? max]로 자른다. 유한하지 않으면 기본 폭. maxWidth < min 이면 min. */
export function clampPaneWidth(side: PaneSide, width: number, maxWidth?: number): number
export const collapseAt: (side: PaneSide) => number // min − min×SNAP_RATIO  (90 / 120)
export const expandAt: (side: PaneSide) => number // min                    (180 / 240)

/** 포인터가 가리키는 폭. start = 드래그 시작 때 화면에 그려진 { 폭, 접힘 }(맞춤 적용값). base = start.collapsed ? 0 : start.width; 왼쪽 base + (x−x0), 오른쪽 base − (x−x0). */
export function dragRaw(side: PaneSide, start: PaneState, x0: number, x: number): number
/** D4. 접힘이면 width는 0. 펼침이면 clampPaneWidth(raw, maxWidth). */
export function resolveDrag(
  side: PaneSide,
  raw: number,
  wasCollapsed: boolean,
  maxWidth?: number
): { collapsed: boolean; width: number }
/** D15. 놓을 때 저장할 상태. start = 드래그 시작 때의 **저장된** 상태(렌더 폭이 아니다). */
export function settleDrag(start: PaneState, live: { collapsed: boolean; width: number }): PaneState

export const togglePane: (s: PaneState) => PaneState // collapsed 만 뒤집는다(width 보존)
export const resetPane: (side: PaneSide) => PaneState // { def, collapsed: false }
export type PaneKeyAction =
  | { kind: 'grow' | 'shrink'; step: number }
  | { kind: 'min' | 'max' | 'toggle' }
/** 늘림 방향은 왼쪽 핸들 → / 오른쪽 핸들 ←. Shift면 step=KEY_STEP_LARGE. 그 밖의 키는 null. */
export function paneKeyAction(side: PaneSide, key: string, shift: boolean): PaneKeyAction | null
/** 접히지 않는다(D7). 접힌 상태: grow=기억 폭으로 펼침, min/max=그 폭으로 펼침, shrink=무변화. */
export function applyPaneKey(
  side: PaneSide,
  s: PaneState,
  a: PaneKeyAction,
  maxWidth?: number
): PaneState

/** D12. otherWidth = 반대쪽 화면 폭(드래그 시작 때 값). 컨테이너가 null/0이면 spec.max. 아니면 clamp(컨테이너 − CENTER_MIN − otherWidth, min, spec.max). */
export function dragMax(side: PaneSide, container: number | null, otherWidth: number): number
/** D12. 렌더용 폭(접힘 0). 합 ≤ 컨테이너−CENTER_MIN 이거나 컨테이너 미측정이면 그대로. priority가 있으면 그 반대쪽을 먼저 줄인다. */
export function fitPaneWidths(
  container: number | null,
  left: PaneState,
  right: PaneState,
  priority?: PaneSide | null
): { left: number; right: number }

/** 저장소에서 읽은 값 고치기: 객체가 아니면 기본값, width는 clampPaneWidth, collapsed는 true일 때만 true. */
export function sanitizePaneState(side: PaneSide, raw: unknown): PaneState

export interface PaneShortcutEvent {
  code: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  altGraph: boolean
}
/** D10. 맞으면 'left' | 'right', 아니면 null. */
export function matchPaneShortcut(e: PaneShortcutEvent, platform: string): PaneSide | null
export function formatPaneShortcut(side: PaneSide, platform: string): string
```

`fitPaneWidths` 알고리즘(테스트가 이 숫자를 고정한다): `eff = collapsed ? 0 : width`, `avail = container − CENTER_MIN`.
`eff.left + eff.right ≤ avail`이면 그대로. 아니면 `excess = 합 − avail`, `slack = max(0, eff − min)`(접힘은 0),
`leftCut = min(slackL, round(excess × slackL / (slackL + slackR)))`, `rightCut = min(slackR, excess − leftCut)`,
`leftCut = min(slackL, excess − rightCut)` 한 번 더. 여유(slack)의 합이 `excess`보다 작으면 둘 다 min에서 멈춘다(본문이 480 밑으로 내려가는 것을 허용).
`priority`가 `'left'|'right'`이면 분배가 달라진다: 반대쪽 `otherCut = min(slackOther, excess)`, 우선 쪽 `priorityCut = min(slackPriority, excess − otherCut)`. `priority`가 null/생략이면 위의 비례 분배.

```ts
// stores/useLayoutStore.ts
export const useLayoutStore: UseBoundStore<…>   // persist: name 'ftp-browser-layout', version 1,
                                                // partialize { left, right } (priority 제외),
                                                // merge: { ...current, left/right: sanitizePaneState } — priority는 건드리지 않는다
// hooks/useResizableSidebar.ts
export interface ResizableSidebar {
  width: number            // 렌더 폭 (맞춤 적용, 접힘 0)
  contentWidth: number     // 안쪽 고정 폭 (접혀 있어도 기억 폭, 맞춤 상한만 적용)
  collapsed: boolean; dragging: boolean; animate: boolean
  valueNow: number         // aria-valuenow (접힘 0)
  handleProps: Pick<HTMLAttributes<HTMLDivElement>,
    'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel' | 'onLostPointerCapture' |
    'onKeyDown' | 'onDoubleClick'>
  onTransitionEnd: (e: React.TransitionEvent) => void     // propertyName === 'width' 이면 animate 해제
}
export function useResizableSidebar(side: PaneSide, containerWidth: number | null): ResizableSidebar
```

애니메이션 플래그 규칙(D5): 훅은 저장된 `collapsed`의 이전 값을 ref로 기억하고, **드래그 놓기 커밋이 아닌** 변화에서만 `animate`를 켠다
(놓기 커밋은 `settleDrag` 직전에 ref로 표시). 첫 렌더에서는 켜지 않는다.

---

## 5. 구현 함정

1. **핸들을 클리핑 컨테이너 밖에 둔다.** 패널 본체는 `overflow-hidden`(접히는 동안 내용이 삐져나오지 않게)이지만, 핸들은 경계에 걸쳐 -3px 바깥으로 나가야 한다. 핸들은 바깥 `relative` 래퍼의 형제다. 왼쪽 핸들 `right: calc(var(--handle-hit) / -2)`, 오른쪽 `left: calc(var(--handle-hit) / -2)`. 접히면(`data-collapsed`) 왼쪽은 `left: 0`, 오른쪽은 `right: 0`으로 옮긴다 — **같은 요소**(D6).
2. **드래그 중 접혀도 포인터 캡처가 이어져야 한다.** 요소를 `key`로 바꿔 끼우거나 조건부 렌더로 갈아치우지 말 것. 접힘 전후는 클래스·`data-collapsed`만 바뀐다.
3. **`inert`는 React 19에서 불리언 prop이다**(`@types/react`: `inert?: boolean`). `aria-hidden`도 함께 둔다(D8). `getByRole('navigation')`이 접힌 동안 `null`이어야 한다.
4. **`e.code`로 B를 판별한다**(D10). `e.key`는 macOS ⌥B에서 `∫`다. 한국어 사용자(IME 자판)에서 `key`가 `ㅠ`로 올 수 있다. 기존 `AppShell`의 `key = e.key.toLowerCase()` 패턴을 그대로 쓰면 오른쪽 토글이 macOS에서 안 된다.
5. **F6 순환은 접힌 지역을 건너뛴다.** `AppShell`의 `REGIONS`(`:21-30`)에서 요소를 찾은 뒤 `el.closest('[inert]')`인 것을 거른다. `.focus()`는 `inert` 안에서 조용히 실패해 F6이 멈춘 것처럼 보인다. 이 거르기는 `split-view.md`가 `REGIONS`를 바꿀 때도 **유지해야 한다**.
6. **jsdom 제약.** `setPointerCapture`가 없다(`?.`로 건너뜀, D16). `ResizeObserver`는 no-op이고(`vitest.setup.ts:40`) `clientWidth`가 0이라 `useElementWidth`는 0을 준다 → 컨테이너 폭 0/null은 "맞춤 없음"이어야 한다(D12). 맞춤 동작은 `SidePane`에 `containerWidth`를 **props로** 넘겨 테스트한다(`AppShell`에서 측정해 내려보내는 구조의 이유).
7. **드래그 중에는 스토어에 쓰지 않는다**(D11). `persist`가 변경마다 동기 `localStorage.setItem`을 하므로 이동마다 쓰면 느리다. 놓을 때 한 번 커밋한다.
8. **`flyTo`는 접힌 패널에서도 동작한다**(`lib/flyTo.ts:34`). 대상이 클리핑돼도 `getBoundingClientRect`는 값을 주고, 날아가는 요소는 `position: fixed`라 가장자리 밖으로 사라진다. 코드 변경 없음.
9. **`Explorer`의 가상 그리드는 폭이 바뀌면 열 수를 다시 계산한다.** 드래그가 프레임마다 폭을 바꾸므로 600장 폴더에서 끊기지 않는지 R3로 본다(§10-b). 문제가 보이면 `requestAnimationFrame`으로 합치는 것은 후속 수정이다(D16).
10. **전환 중 내용 흐름.** 안쪽 `div`의 폭을 `contentWidth`로 고정하고 바깥만 줄이면 접히는 200ms 동안 목록이 다시 줄바꿈되지 않는다. 안쪽을 `w-full`로 두면 사이드바 텍스트가 매 프레임 잘렸다 펴진다.
11. **`globals.css`의 `@media (prefers-reduced-motion)`이 이미 모든 전환을 1ms로 만든다**(`:233-`). 그래도 `.side-pane { transition: none }`을 명시한다 — `transitionend`가 오지 않는 환경이 있으므로 D5의 타이머 보험이 필요하다.
12. **저장소 접근은 `try/catch`가 필요 없다**(`persist`가 감싼다). 대신 읽은 값 검증이 필요하다(`sanitizePaneState`): 손으로 고친·옛 버전의 JSON, 모니터가 달라져 범위를 벗어난 값.
13. **i18n 키는 11개 로캘에 한 번에 넣는다**(`satisfies LocaleMessages`가 누락을 타입 오류로 만든다). `{{count}}`는 쓰지 않는다 — 이 스펙의 자리표시자는 `{{shortcut}}`·`{{width}}`뿐이다.
14. **macOS 네이티브 메뉴가 ⌘B를 가로채지 않는다.** 앱 메뉴(`main/menu/appMenu.ts`)는 role만 있고 `accelerator`를 직접 선언하지 않는다. ⌘B·⌥⌘B는 렌더러 keydown까지 온다. R3로 확인한다.

---

## 6. 기각한 대안

- **`react-resizable-panels` 도입** — `package.json`에 없고 레이아웃이 px 고정이라 비율 기반 라이브러리와 맞지 않는다. 의존성 증가. 기각(D1, 사용자).
- **아이콘만 보이는 좁은 모드** — 접힘은 0px로 사라지는 것뿐이다(결정 파일: VS Code 방식). 기각.
- **접힘 경계와 펼침 경계를 같은 값으로** — 히스테리시스가 없어 경계에서 포인터가 한 픽셀 흔들리면 접혔다 펴지는 깜빡임이 생긴다. 기각(D4).
- **놓을 때 접힘 판정** — 사용자 결정이 "드래그 중 즉시". 기각(D4).
- **좁은 창에서 자동으로 접기** — 의도하지 않은 상태 변경이고 저장된 선호와 충돌한다. 대신 표시 전용 맞춤(D12). 기각.
- **`useSettingsStore`에 폭·접힘을 더하기** — 스키마 버전을 올리고 다른 스펙과 같은 파일을 만진다. 분리 스토어로 간다(D11).
- **CSS 변수를 런타임에 읽어 숫자로 쓰기** — jsdom에서 안 풀리고 첫 렌더 전에 값이 없다. 상수 + 계약 테스트(D2).
- **핸들을 접힘/펼침마다 다른 컴포넌트로** — 드래그 도중 접힐 때 포인터 캡처를 잃는다. 기각(D6).
- **접힌 레일에 자동 펼침(Shift+S, 다른 탭에서 항목을 선반으로 보냄)** — 사용자가 접은 선택을 뒤집는다. 기각(D13, 후속 과제).
- **툴바 토글에 선반 개수 배지** — 범위 밖. 후속 과제(D13).
- **키보드 방향키로 접기** — 접힘 경계가 min 아래라 방향키는 min에서 멈춘다. 접기는 Enter·토글 버튼·단축키(D7).
- **드래그 중에도 끌고 있는 쪽을 저장된 반대쪽 폭으로 다시 맞추기** — 상한(`dragMax`)은 반대쪽의 화면 폭 기준인데 렌더만 저장 폭 기준이면 둘이 어긋나, 상한에서 멈춰야 할 폭이 더 줄어 보이고 놓은 직후 두 패널이 튄다. 끌고 있는 쪽은 `live`를 그대로 그린다(D16).
- **`pointermove`의 `buttons === 0`을 놓기로 취급** — jsdom `PointerEvent`의 `buttons` 기본값이 0이라 테스트 레시피의 첫 이동이 드래그를 끝낸다. 포인터 캡처 + `lostpointercapture`·`pointercancel`(D14)로 충분하고, 놓기 이벤트를 영영 못 받는 환경은 R3(a)로 확인해 필요하면 후속으로 올린다.
- **`requestAnimationFrame`으로 포인터 이동 합치기** — `ResizeObserver`가 이미 프레임당 한 번으로 합친다. 필요해지면 후속(D16).

---

## 7. i18n

`en.ts`가 원본이고 나머지 10개 로캘에 번역해 넣는다. 기존 `sidebar.label`(Locations)·`rail.label`(Side panel)은 그대로 두고 아래 8개를 더한다.

| 키                         | 영어                                       | 쓰이는 곳                     |
| -------------------------- | ------------------------------------------ | ----------------------------- |
| `panes.toggleLeft`         | Sidebar                                    | 왼쪽 토글 버튼 `aria-label`   |
| `panes.toggleRight`        | Side panel                                 | 오른쪽 토글 버튼 `aria-label` |
| `panes.toggleLeftTooltip`  | Show or hide the sidebar ({{shortcut}})    | 왼쪽 토글 `title`             |
| `panes.toggleRightTooltip` | Show or hide the side panel ({{shortcut}}) | 오른쪽 토글 `title`           |
| `panes.resizeLeft`         | Resize sidebar                             | 왼쪽 핸들 `aria-label`        |
| `panes.resizeRight`        | Resize side panel                          | 오른쪽 핸들 `aria-label`      |
| `panes.collapsed`          | Collapsed                                  | 핸들 `aria-valuetext`(접힘)   |
| `panes.widthValue`         | {{width}} px                               | 핸들 `aria-valuetext`(펼침)   |

`i18n.test.ts`는 자리표시자가 영어와 같아야 통과한다(`{{shortcut}}`·`{{width}}`는 번역에서도 그대로).

---

## 8. 테스트 케이스 리스트 (확정)

`Test-890`부터 신규(예약 범위 890~919). 각 테스트에 `covers: Test-N` 주석. **1:1 매핑. 케이스 추가·병합·재해석 금지.**
컴포넌트 테스트는 첫 줄에 `/** @vitest-environment jsdom */`, `vi.stubGlobal('api', makeApiMock(...))`(`explorerTestHarness.ts`의 `setupExplorer`가 해 준다).
스토어·`localStorage`는 `afterEach`에서 `useLayoutStore.setState`로 기본값(`priority: null` 포함)을 되돌리고 `localStorage.clear()`.
포인터 이벤트는 `fireEvent.pointerDown/Move/Up(핸들, { clientX, button: 0, pointerId: 1 })`. 구현은 `buttons`를 보지 않으므로(§6) 이동에 `buttons`를 주지 않는다(jsdom `PointerEvent`의 `buttons` 기본값은 0).
`setPointerCapture`는 jsdom에 없다. 필요한 테스트(Test-906)만 `HTMLElement.prototype.setPointerCapture = vi.fn()`을 심고 `afterEach`에서 지운다.

### A. 순수 함수 (`src/renderer/src/lib/sidebarLayout.test.ts`, 신규, node)

| #        | 케이스                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Test-890 | `PANE_SPECS`가 left 180/220/360, right 240/288/480. `clampPaneWidth`: 범위 밖은 min/max로, 실수는 반올림(`199.5`→`200`), `NaN`·`Infinity`·`-Infinity`는 기본 폭, `maxWidth`가 주어지면 그 값이 상한(`maxWidth < min`이면 min). `collapseAt`=90/120, `expandAt`=180/240                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Test-891 | `resolveDrag` **펼친 상태** 접힘 경계: left `raw` 91→`{collapsed:false,width:180}`, 90→`{collapsed:true,width:0}`, 0·음수→접힘, 181→181(min 이상이면 그대로), right `raw` 121→`{false,240}`, 120→`{true,0}`. 펼쳐진 동안 `min/2 < raw < min`이면 폭은 min이다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Test-892 | `resolveDrag` **접힌 상태**(히스테리시스): left `raw` 179→`{collapsed:true,width:0}`, 180→`{false,180}`, 300→`{false,300}`; right 239→접힘 유지, 240→`{false,240}`. **같은 `raw`라도 직전 상태에 따라 결과가 다르다**: `raw=150`은 펼친 상태면 `{false,180}`, 접힌 상태면 `{true,0}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Test-893 | `resolveDrag`의 상한: `raw=999`→max(360/480), `maxWidth=300`이 주어지면 300. `dragMax`(`otherWidth` = 반대쪽 화면 폭): 컨테이너 1024·반대쪽 288일 때 left 상한 `min(360, 1024−480−288)=256`; 컨테이너 null·0이면 `spec.max`; 계산값이 min보다 작으면 min(예: 컨테이너 600·반대쪽 480 → left 180)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Test-894 | `dragRaw`: left는 `x`가 커질수록 늘고 right는 `x`가 커질수록 준다(`x0=700, x=640`일 때 right 288→348). 접힌 시작은 base 0(`left`, `x0=2, x=182` → 180). `settleDrag`: 펼친 채 끝나면 `{width: live.width, collapsed:false}`, 접힌 채 끝나면 **시작 때의 폭**과 `collapsed:true`(예: 시작 `{220,false}`, live `{0,true}` → `{220,true}`), 접힌 상태에서 시작해 접힌 채 끝나면 `{300,true}`→`{300,true}`                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Test-895 | `togglePane`는 `collapsed`만 뒤집고 `width`를 보존한다(접기→펴기 왕복 후 같은 객체 값). `resetPane('left')`=`{220,false}`, `('right')`=`{288,false}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Test-896 | `paneKeyAction`: left에서 `ArrowRight`=grow 16, `ArrowLeft`=shrink 16, Shift면 64; right는 방향이 반대(`ArrowLeft`=grow); `Home`=min, `End`=max, `Enter`=toggle, 그 밖의 키(`a`, `ArrowUp`, `Escape`)는 null. `applyPaneKey`: `{220,false}`+grow 16=236; min(180)에서 shrink는 180 그대로(**접히지 않음**); max에서 grow는 그대로; `maxWidth` 인자가 상한; 접힌 `{300,true}`+grow→`{300,false}`, +shrink→무변화, +min→`{180,false}`, +max→`{360,false}`, +toggle→`{300,false}`                                                                                                                                                                                                                                                                                                                                                                         |
| Test-897 | `fitPaneWidths`: 컨테이너 1024, left `{360,false}`·right `{480,false}` → `{left:233, right:311}`(합 544 = 1024−480). 합이 여유 이내(1200, 220/288)면 그대로 `{220,288}`. 컨테이너 null·0이면 접힘 제외 그대로. 접힌 쪽은 0이고 다른 쪽만 줄인다(left 접힘, right 480, 컨테이너 800 → right 320). 둘 다 min이어도 모자라면 min에서 멈춘다(220/288 입력, 컨테이너 600 → `{180,240}`). **`priority`**: 컨테이너 1024, left `{233,false}`·right `{480,false}`에서 `priority` 생략/null → `{202,342}`(비례), `'left'` → `{233,311}`(오른쪽 여유가 먼저 줄어듦), `'right'` → `{180,364}`(왼쪽 여유 53을 먼저 쓰고 나머지 116을 오른쪽에서 뺌). 우선 쪽이 아닌 쪽의 여유가 `excess`보다 작으면 모자란 만큼 우선 쪽에서 줄인다(left `{300,false}`·`'left'`, right `{260,false}`, 컨테이너 1000 → avail 520, excess 40, 오른쪽 여유 20 → 오른쪽 240, 왼쪽 280). |
| Test-898 | `sanitizePaneState`: `undefined`·`null`·문자열·배열 → 해당 쪽 기본값. `{width:'300'}`(문자열)·`{width:NaN}` → 기본 폭. `{width:9999,collapsed:true}`→`{360,true}`(left). `{width:50}`→180. `collapsed: 'yes'`·`1`→false(정확히 `true`만 true)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Test-899 | `matchPaneShortcut`: **macOS**(`'darwin'`) `{code:'KeyB', metaKey}`→'left'; `{code:'KeyB', metaKey, altKey}`(`key`가 `∫`여도)→'right'; Ctrl+B→null. **win32/linux** `{ctrlKey}`→'left', `{ctrlKey, altKey}`→'right', `{metaKey}`→null. Shift 추가→null, `altGraph:true`→null, `code:'KeyV'`→null, **`code`만 보므로** `key:'ㅠ'`(한글 자판)도 일치. `formatPaneShortcut`: darwin `⌘B`/`⌥⌘B`, 그 밖 `Ctrl+B`/`Ctrl+Alt+B`                                                                                                                                                                                                                                                                                                                                                                                                                               |

### B. 토큰 계약 (`src/renderer/src/lib/sidebarLayout.test.ts`, node)

| #        | 케이스                                                                                                                                                                                                                                                                                                                                                         |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Test-900 | `src/renderer/src/styles/globals.css`를 읽어(`node:fs`) `:root` 블록의 `--sidebar-{left,right}-{min,default,max}`가 `PANE_SPECS`와, `--handle-hit`=`6px`, `--handle-line`=`2px`, `--handle-hover-delay`=`300ms`, `--pane-anim`=`${PANE_ANIM_MS}ms`가 정확히 같음. `@media (prefers-reduced-motion: reduce)` 블록 안에 `.side-pane`의 `transition: none`이 있음 |

### C. 스토어 (`src/renderer/src/stores/useLayoutStore.test.ts`, 신규, **jsdom**)

첫 줄에 `/** @vitest-environment jsdom */`. `persist`는 모듈 평가 때 저장소를 붙잡는데, node 환경에는 `window`가 없어 `vitest.setup.ts`의 메모리 `localStorage`(:18-39, `typeof window !== 'undefined'` 가드)가 설치되지 않는다. 그러면 `localStorage` 읽기·쓰기·`clear()`가 모두 실패한다.

| #        | 케이스                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Test-901 | 기본값은 `left {220,false}`·`right {288,false}`. `commit('left',{width:999})`는 360으로 자른다. `toggle('left')` 두 번이면 폭이 그대로고 `collapsed`가 false→true→false. `toggle('left')`는 `right`를 건드리지 않는다. `reset('right')`는 `{288,false}`. **`priority`**: 기본 null, `commit('left',…)` 뒤 `'left'`, `toggle('right')` 뒤 `'right'`, `reset('left')` 뒤 `'left'`                                                                                                                                 |
| Test-902 | 영속: 상태를 바꾸면 `localStorage['ftp-browser-layout']`의 JSON에 `state.left.width`·`state.right.collapsed`가 들어 있다(`version: 1`). 저장소에 `{state:{left:{width:300,collapsed:true},right:{width:9999,collapsed:'x'}},version:1}`를 넣고 `useLayoutStore.persist.rehydrate()`하면 `left {300,true}`·`right {480,false}`. 깨진 JSON(`'{'`)이면 기본값. `priority`는 저장되지 않는다: 저장된 JSON의 `state`에 `priority` 키가 없고, 저장소에 `state.priority:'left'`를 넣고 rehydrate해도 `priority`는 null |

### D. 패널·핸들 (`src/renderer/src/components/layout/SidePane.test.tsx`, 신규, jsdom)

`<SidePane side id containerWidth={null}><button>content</button></SidePane>` 단독 렌더(필요하면 오른쪽 하나, 왼쪽 하나씩).

| #        | 케이스                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Test-903 | 구조·ARIA: 왼쪽은 `.side-pane`의 `style.width`가 `220px`, 안쪽 `contentWidth` 래퍼가 `220px`. 핸들은 `role="separator"` `aria-orientation="vertical"` `tabIndex=0`, 이름 `Resize sidebar`, `aria-valuemin=0` `aria-valuemax=360` `aria-valuenow=220` `aria-valuetext="220 px"` `aria-controls`=패널 id. 오른쪽은 `288px`·이름 `Resize side panel`·`valuemax=480`. 펼쳐진 패널에는 `inert`·`aria-hidden`이 없다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Test-904 | 드래그 폭 변경: 왼쪽 `pointerDown(clientX=220)`→`pointerMove(300)`이면 `style.width`가 `300px`이고 `data-dragging="true"`, **이 시점에 스토어·`localStorage`는 아직 `220`**. `pointerUp`이면 스토어 `left`=`{300,false}`, `data-dragging`이 사라진다. 오른쪽은 `pointerDown(700)`→`pointerMove(640)`이 `348px`(방향 반대). `ArrowRight` 등 키 이벤트와 무관하게 포인터만으로 된다. `pointerDown`의 `fireEvent` 반환값이 `false`(= `preventDefault` 호출, D14)이고 직후 `document.activeElement`가 핸들이다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Test-905 | 스냅 접힘·히스테리시스(왼쪽): `pointerDown(220)`→`Move(90)`이면 폭 `0px`·`data-collapsed`, `Move(179)`이면 여전히 `0px`, `Move(180)`이면 `180px`로 펼쳐지고 `data-collapsed`가 사라진다. 이어서 `Move(300)`=`300px`. `Move(90)`으로 다시 접은 채 `pointerUp`하면 스토어 `left`=`{220,true}`(**드래그 시작 때의 폭**, D15). 이 사이 `data-animate`가 한 번도 켜지지 않았다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Test-906 | 취소·예외: 드래그 중 `Escape`(window `keydown`)이면 시작 폭(220)으로 복귀하고 `pointerUp`해도 스토어는 `{220,false}`, 이후 `pointerMove`는 무시. `button: 2`(보조 버튼)의 `pointerDown`은 드래그를 시작하지 않는다(`data-dragging` 없음). `pointerCancel`은 `pointerUp`과 같이 커밋한다. `lostPointerCapture`도 `pointerUp`과 같이 커밋하고(`Move(300)` 뒤 → `{300,false}`), 이미 끝난 드래그에 뒤따라 오는 `lostPointerCapture`는 무시한다(`pointerUp` 뒤 스토어를 `{250,false}`로 바꾸고 `lostPointerCapture`를 보내도 250 그대로). `setPointerCapture`가 심어져 있으면 `pointerDown`이 `pointerId` 1로 한 번 호출한다(D16). `buttons`를 주지 않은(=0) `pointerMove`를 두 번 보내도 드래그가 이어지고 `pointerUp`에서만 커밋된다(§6)                                                                                                                                                                                                                                                                                           |
| Test-907 | 더블클릭 리셋: 스토어 `left`=`{300,false}`에서 핸들 `doubleClick`→`{220,false}`. 접힌 상태(`{300,true}`)의 핸들 `doubleClick`→`{220,false}`(펼침). 오른쪽은 `{288,false}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Test-908 | 핸들 키보드(왼쪽): 포커스 뒤 `ArrowRight`→`236`(스토어·`aria-valuenow` 갱신), `Shift+ArrowRight`→+64, `ArrowLeft`→−16, `Home`→180, `End`→360, 180에서 `ArrowLeft`→180(접히지 않음). `Enter`→`collapsed:true`·`aria-valuenow=0`·`aria-valuetext="Collapsed"`, 다시 `Enter`→기억 폭으로 펼침. 오른쪽 핸들은 `ArrowLeft`가 늘림. 처리한 키는 `defaultPrevented`이고 이벤트가 `window`까지 올라가지 않는다(F6 등 전역 처리기 보호)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Test-909 | 접힌 상태 DOM: 스토어 `left`=`{250,true}`로 시작하면 처음 렌더부터 `style.width`=`0px`, 패널 루트에 `inert`와 `aria-hidden="true"`, **자식은 마운트돼 있다**(`getByText('content', {hidden:true})`), 핸들은 `data-collapsed`이고 여전히 `role="separator"`·`tabIndex=0`·`aria-valuenow=0`. 가장자리에서 시작한 드래그: `pointerDown(0)`→`Move(179)`는 접힘 유지→`Move(200)`은 `200px`로 펼침→`pointerUp`이면 스토어 `{200,false}`. 처음 렌더에 `data-animate`가 없다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Test-910 | 애니메이션 플래그: 스토어 `toggle('left')`(접기) 직후 패널에 `data-animate="true"`; `fireEvent.transitionEnd(패널, {propertyName:'width'})`이면 사라진다. `propertyName:'opacity'`이면 남는다. `transitionEnd` 없이 `vi.advanceTimersByTime(250)`이면 사라진다(타이머 보험). 방향키 폭 조정·`Home`/`End`(접힘 변화 없음)·드래그 놓기 커밋은 `data-animate`를 켜지 않는다. **접힘이 바뀌는 핸들 조작은 켠다**(D5; 케이스마다 스토어를 초기화하고 `transitionEnd`로 플래그를 지운 뒤): `{300,true}`에서 핸들 `Enter`, `{300,true}`에서 `ArrowRight`, `{300,true}`에서 `doubleClick` → 각각 `data-animate="true"`. 반면 `{300,false}`에서 `doubleClick`(폭만 220으로 리셋, 접힘 불변)은 켜지 않는다                                                                                                                                                                                                                                                                                                                                 |
| Test-911 | 맞춤(D12)·드래그 중 렌더(D16): 컨테이너 1024, 스토어 left `{360,false}`·right `{480,false}`·`priority` null일 때 왼쪽 `style.width`=`233px`, 오른쪽 `311px`(두 `SidePane`을 함께 렌더). **스토어 값은 그대로**(360/480). `containerWidth`를 1400으로 다시 렌더하면 `360px`/`480px`로 돌아온다. 이어서 1024에서 — **(가) 상한에서 끌기**: 왼쪽 핸들 `pointerDown(233)` 직후 폭이 233/311(튀지 않음). `Move(999)`는 상한 `min(360, 1024−480−311)=233`(311 = 시작 때 오른쪽 화면 폭)에서 멈춰 왼쪽 `233px`, 오른쪽은 드래그 내내 `311px`. `pointerUp` 뒤 스토어 left `{233,false}`·`priority:'left'`·right 480 그대로이고 폭은 **놓기 전후 모두 233/311**. **(나) 더 작게 놓기**: 이어서 `pointerDown(233)`→`Move(193)`이면 왼쪽 193·오른쪽 311(고정), `pointerUp` 뒤 왼쪽 193·오른쪽 **351**(우선권이 왼쪽이라 오른쪽 여유가 먼저 줄고 합이 544가 되도록 넓어짐 — 정상 동작). **(다)** 스토어를 초기값(360/480/null)으로 되돌리고 이동 없이 `pointerDown`→`pointerUp`만 하면 스토어 `left.width`는 360, `priority`는 null 그대로다 |

### E. 셸 (`components/layout/Toolbar.test.tsx` 신규 · `AppShell.test.tsx` · jsdom)

| #        | 파일                                  | 케이스                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Test-912 | `components/layout/Toolbar.test.tsx`  | 툴바 루트의 **첫 자식**이 이름 `Sidebar`인 토글, **마지막 자식**이 이름 `Side panel`인 토글(연결 상태에서 `연결 해제` 버튼이 나타나도 마지막). `aria-expanded`가 펼침 `true`/접힘 `false`, `aria-controls`=`sidebar-pane`/`rail-pane`, `title`에 단축키(win32 `Ctrl+B`/`Ctrl+Alt+B`, `platform='darwin'`이면 `⌘B`/`⌥⌘B`). 클릭하면 스토어 `collapsed`가 뒤집히고 `aria-expanded`가 따라 바뀐다                                                                 |
| Test-913 | `components/layout/AppShell.test.tsx` | 단축키: win32 `keyDown(body, {key:'b', code:'KeyB', ctrlKey:true})`→왼쪽 접힘(`defaultPrevented`), `{ctrlKey, altKey}`→오른쪽 접힘, 같은 키를 한 번 더 누르면 펼침. `Shift` 추가·`metaKey`만(win32)은 무반응. `platform='darwin'`: `{key:'b', code:'KeyB', metaKey}`→왼쪽, `{key:'∫', code:'KeyB', metaKey, altKey}`→오른쪽, `ctrlKey`만→무반응. **주소 입력 칸(`textbox`)에 포커스가 있어도 동작**한다                                                        |
| Test-914 | `components/layout/AppShell.test.tsx` | 접힘과 포커스: 사이드바 안 버튼(현재 위치)에 포커스를 둔 채 왼쪽을 접으면(`Ctrl+B`) `document.activeElement`가 `listbox`로 옮겨진다. 포커스가 다른 곳에 있었으면 옮기지 않는다. 사이드바를 접은 뒤 `F6` 순환은 **탭→목록→레일→탭**(사이드바 건너뜀)이고 `Shift+F6`은 반대. 레일을 접으면 **사이드바→탭→목록**. 둘 다 접어도 순환이 멈추지 않는다(탭→목록)                                                                                                      |
| Test-915 | `components/layout/AppShell.test.tsx` | 통합: 펼친 상태에서 `navigation`(`Locations`)과 레일 `region`(`Shelf`)이 각각 `#sidebar-pane`·`#rail-pane` 안에 있고 `separator`가 2개. 왼쪽을 접으면 `queryByRole('navigation', {name:'Locations'})`가 `null`(접근성 트리에서 빠짐)이고 `getByRole('navigation', {hidden:true})`로는 있다(언마운트되지 않음). 스토어에 `left.collapsed`가 저장돼 있는 채 처음 렌더하면 애니메이션 없이 접혀 있다. 접은 뒤 펴면 접기 전 폭(예: 300)이 `style.width`로 복원된다 |
| Test-916 | `components/layout/AppShell.test.tsx` | 레일이 접힌 동안 `Shift+S`(선택 항목 → 선반)는 선반에 담고(`useShelfStore.items`가 늘어남) **레일을 펼치지 않는다**(`useLayoutStore.right.collapsed`가 그대로 true, D13)                                                                                                                                                                                                                                                                                       |
| Test-917 | `components/layout/SidePane.test.tsx` | 창 크기 변화: 같은 `SidePane` 쌍을 컨테이너 1400→1024→1400으로 다시 렌더하면 폭이 360/480→233/311→360/480으로 오가고, 이 과정에서 `data-animate`가 켜지지 않으며 스토어의 `width`는 그대로다                                                                                                                                                                                                                                                                   |

테스트 합계: **Test-890 ~ Test-917, 28개.**

기존 테스트 처분: Test-808(`RightRail.test.tsx`)·820·821(`Sidebar.test.tsx`)·834(`AppShell.test.tsx` F6)는 **고치지 않고 그대로 통과**해야 한다
(`Sidebar`/`RightRail`을 단독 렌더하므로 `w-full`만 바뀌고, F6 순서는 둘 다 펼친 상태에서 같다).

---

## 9. 구현 슬라이스

| 슬라이스                | 의존 | 맡는 파일                                                                                                                                          | 맡는 테스트                             | 끝 확인                                                                    |
| ----------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------- |
| **P1 순수·토큰·스토어** | —    | `lib/sidebarLayout.ts`, `stores/useLayoutStore.ts`, `styles/globals.css`(토큰 + `.side-pane`·`.pane-handle` 규칙)                                  | 890~902 (스토어 테스트 901·902는 jsdom) | 앱은 그대로 동작(아직 아무도 쓰지 않음). `typecheck && lint && test` GREEN |
| **P2 훅·핸들·패널**     | P1   | `hooks/useResizableSidebar.ts`, `components/layout/ResizeHandle.tsx`, `components/layout/SidePane.tsx`, `i18n/locales/*.ts` 11개(§7)               | 903~911·917                             | `SidePane` 단독 마운트 테스트 GREEN. `i18n.test.ts` GREEN                  |
| **P3 셸 배선**          | P2   | `components/layout/AppShell.tsx`(패널 감싸기·컨테이너 측정·단축키·F6 거르기), `Toolbar.tsx`(토글 두 개), `Sidebar.tsx`·`RightRail.tsx`(`w-full`만) | 912~916                                 | `npm run dev -- -- --devtools`에서 끌기·접기·단축키가 된다                 |

이 스펙의 P3는 다른 스펙과 **같은 파일**을 만진다. 합칠 순서가 필요하다.

| 파일                            | 함께 만지는 스펙                                                                                                              | 조율                                                                                                                                               |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AppShell.tsx`                  | `explorer-menu-and-focus.md`(단축키·포커스), `split-view.md`(⌘\\, F6 `REGIONS` 갱신, `<main>` 안 구조), `multi-connection.md` | 이 스펙의 P3를 **먼저** 넣는다(바깥 `flex` 행을 세 칸으로 정리하는 구조 변경). `REGIONS` 거르기(`closest('[inert]')`, 함정 5)는 뒤 스펙이 유지한다 |
| `Toolbar.tsx`                   | `multi-connection.md`(연결 UI)                                                                                                | 이 스펙은 **첫·마지막 자식 두 개**만 더한다. 연결 쪽이 가운데를 바꿔도 양 끝 위치(D9)는 유지                                                       |
| `Sidebar.tsx` · `RightRail.tsx` | `multi-connection.md`(서버 절), `shelf-os-drop.md`(선반 놓기), `file-category-filter.md`(없음)                                | 이 스펙은 루트 폭 클래스 한 줄만 바꾼다                                                                                                            |
| `globals.css`                   | `explorer-menu-and-focus.md`(`--selin`·`ring-focus` 정리)                                                                     | 이 스펙은 `:root`에 토큰 줄과 새 클래스 블록을 **추가만** 한다                                                                                     |
| `i18n/locales/*.ts`             | 전부                                                                                                                          | 키는 `panes.*` 접두어라 충돌하지 않는다. 같은 줄 근처 병합 충돌만 풀면 된다                                                                        |

`shelf-os-drop.md`: 레일이 접혀 있으면 OS 파일을 선반에 끌어 놓을 대상이 보이지 않는다. 그 스펙은 이를 전제로 해야 하며(접힌 레일로의 드롭은 지원하지 않음, D13) 이 스펙은 펼침 동작을 더하지 않는다.
`split-view.md`: 분할 뷰의 패널 최소 폭(280×2 + 구분선)은 D12의 `CENTER_MIN = 480`으로 보장되지 않는다. 분할 중에 모자라면 그 스펙이 처리한다(권장: 분할 진입 시 본문이 모자라면 사용자 사이드바를 접지 않고 분할을 막는다).

---

## 10. 완료 기준

1. Test-890~917과 기존 스위트 전체가 GREEN(실행 출력으로 확인). Test-808·820·821·834는 수정 없이 GREEN.
2. 각 테스트에 `covers: Test-N` 주석. `test.skip`·`.only`·빈 테스트 없음.
3. `npm run typecheck` · `npm run lint` 통과, 바꾼 파일에 `npx prettier --check` 통과. `npm run build:unpack` 후 `npm run smoke:packaged` 통과.
4. `stryker.config.json`의 `mutate`를 이번 변경분으로 재설정하고 `break: 70` 통과:
   신규 파일 통째로 — `src/renderer/src/lib/sidebarLayout.ts`, `src/renderer/src/stores/useLayoutStore.ts`, `src/renderer/src/hooks/useResizableSidebar.ts`.
   훅의 줄은 Test-904~911이 닫는다(포인터 흐름·`preventDefault`·포커스·`setPointerCapture`·`lostpointercapture`·키·더블클릭·`data-animate`). 컴포넌트(`SidePane`·`ResizeHandle`·`Toolbar`·`AppShell`)는 넣지 않는다(기존 규칙). `_comment_scope`를 이 범위로 고쳐 쓴다. 다른 스펙의 `mutate` 항목은 합칠 때 함께 남긴다.
5. R3 실측(아래)을 하고 결과 표를 이 문서 끝에 붙인다.
6. `CLAUDE.md`: 새 디렉터리가 없어 소스 지도 변경 없음. 단 "Gotchas"에 `단축키는 e.code로 판별(⌥B = ∫)` 한 줄은 두지 않는다 — 이 문서(함정 4)에 둔다.

### R3 실측 계획

jsdom은 실제 포인터 캡처·레이아웃·CSS 전환·`prefers-reduced-motion`·`inert` 포커스 보정·macOS 키 입력을 재현하지 못한다.
**앱 구동**: `unset ELECTRON_RUN_AS_NODE`(Claude Code 셸에서 필수, memory) 뒤 `npm run dev -- -- --devtools`(손) 또는
`npm run build:unpack` → 실행 파일을 `--remote-debugging-port=9222`로 띄워 CDP로 구동한다.
**CDP 입력은 실제 포인터 이벤트를 만든다**: `Input.dispatchMouseEvent`(`mousePressed`/`mouseMoved`/`mouseReleased`)로 핸들 끌기와 가장자리 끌기를 자동화하고,
`Input.dispatchKeyEvent`(`code`·`modifiers` 지정)로 단축키를 보낸다. `Emulation.setEmulatedMedia`로 `prefers-reduced-motion`·`forced-colors`·`prefers-color-scheme`을 바꾼다.
Windows 항목은 memory의 Windows 검증 호스트(`ssh thsvkd-win`) 규칙(PowerShell EncodedCommand, 비침습, 휴대용 Node 24)을 따른다. 이 PC(macOS)에서는 macOS 항목을 직접 한다.

| 항목                  | 확인 내용                                                                                                                                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) 끌기·커서         | 두 핸들을 끌어 폭이 포인터를 프레임 단위로 따른다. 핸들 위에서 커서 `col-resize`(손으로 본다. CDP 스크린샷에는 커서가 안 찍힌다). 창 밖·탐색기 위로 포인터가 나가도 드래그가 이어지고 놓으면 끝난다                   |
| (b) 큰 폴더에서 끌기  | 600장 폴더(`explorer-shelf.md` R3 서버·픽스처)에서 오른쪽 레일을 끌 때 그리드가 끊기지 않는다(주관 + `Performance` 프레임 확인). 끊기면 D16의 `requestAnimationFrame` 합치기를 후속으로 올린다                        |
| (c) 스냅·히스테리시스 | 왼쪽: 220에서 90 아래로 끌면 접히고(그 순간 0px), 179까지 되돌려도 접힌 채, 180에서 펼쳐진다. 오른쪽도 120/240. 접은 채 놓고 재시작해도 접혀 있고, 펼치면 **끌기 시작 때의 폭**(D15)                                  |
| (d) 더블클릭          | 어떤 폭이든 핸들 더블클릭으로 220/288 펼침. 접힌 가장자리 더블클릭도 펼침                                                                                                                                             |
| (e) 호버 지연         | 핸들에 올리면 300ms 뒤 표시선(2px `--ac`)이 나타나고, 끌기·키보드 포커스에서는 즉시. `getComputedStyle`로 `transition-delay` 확인                                                                                     |
| (f) 전환 200ms        | 버튼·단축키로 접고 펼 때 200ms 폭 전환(스크린샷 연속 촬영으로 중간 폭 확인), 드래그·방향키는 전환 없음. `setEmulatedMedia`로 `prefers-reduced-motion: reduce`이면 전환 없이 즉시                                      |
| (g) 단축키 — macOS    | **실제 키 입력**으로 ⌘B(왼쪽), ⌥⌘B(오른쪽). ⌥⌘B에서 `e.key`가 `∫`로 오는 것을 `Input.dispatchKeyEvent`/DevTools에서 확인하고 `e.code`가 `KeyB`임을 본다. 한글 입력기 상태에서도 동작                                  |
| (h) 단축키 — Windows  | Ctrl+B, Ctrl+Alt+B. 한국어 자판·한글 모드에서도. 독일어 같은 AltGr 자판이 없으니 AltGr 거르기(`getModifierState('AltGraph')`)는 단위 테스트(Test-899)로만 보증한다                                                    |
| (i) 포커스            | 사이드바 항목에 포커스를 두고 접으면 포커스가 목록으로 가고 Tab이 접힌 사이드바로 들어가지 않는다. F6 순환이 접힌 지역을 건너뛴다(`inert`의 실제 크롬 동작)                                                           |
| (j) 접힌 가장자리     | 접힌 왼쪽/오른쪽에서 창 가장자리 6px를 끌어 펼친다. **접힌 오른쪽 가장자리가 본문 스크롤바를 가려 스크롤바 드래그가 안 되는지**(D17) 확인하고, 가려지면 `Explorer` 스크롤러 여백 수정을 한다(이 스펙 안에서 처리한다) |
| (k) 최소 창           | 창을 1024로 줄이고 두 패널을 최대(360/480)로 둔다 → 본문이 480 아래로 가지 않고(맞춤 렌더 233/311), 창을 키우면 원래 폭으로 돌아온다. 끌 때 상한에서 멈춘다                                                           |
| (l) 영속              | 폭·접힘을 바꾸고 앱을 끈 뒤 다시 켜면 그대로. `localStorage['ftp-browser-layout']`을 손으로 망가뜨린 뒤 켜면 기본값으로 뜬다                                                                                          |
| (m) 테마·고대비       | 밝게·어둡게에서 핸들 표시선과 경계가 보인다. `forced-colors: active`에서 핸들이 `CanvasText`/`Highlight`로 보인다                                                                                                     |
| (n) 접근성            | 핸들에 Tab → 포커스 링, ←/→ 폭 변경, Enter 접기. 스크린 리더 이름(`Resize sidebar`)과 값(`220 px`/`Collapsed`). 접힌 사이드바가 접근성 트리에서 빠진다                                                                |
| (o) 선반·날기         | 레일을 접은 채 Shift+S → 선반에 담기고(레일 개수는 안 보임) 날아가는 효과가 오른쪽 가장자리로 간다. 펴면 항목이 있다                                                                                                  |

---

## 11. 미결(권장안 적용)과 위험

**미결 — 결정 파일이 답하지 않아 권장안으로 정했다. 사람이 뒤집으면 해당 D와 테스트 숫자만 바뀐다.**

1. **히스테리시스 펼침 경계(D4).** "펼침 경계 동일 거리 반대쪽"의 해석. 권장안: 접힘 경계 = `min/2`(왼쪽 90), 펼침 경계 = `min`(왼쪽 180) — 구간 폭이 접힘 거리와 같은 `min/2`. 대안: 접힘 경계 위쪽으로 `min/2`를 더 가서(`min×1.5` = 270) 펼치는 해석은 끌어내는 동안 270px이 비어 보이다 갑자기 튀어나온다.
2. **토글 버튼 위치(D9).** 툴바 양 끝(창 전체 폭, 자리 불변) vs 탭줄 양 끝(왼쪽 끝이 사이드바 폭에 따라 움직임). 권장안: 툴바.
3. **좁은 창 맞춤과 `CENTER_MIN`(D12).** `CENTER_MIN = 480`, 비례 축소, 표시 전용. 분할 뷰의 2×280 보장은 `split-view.md`로 넘긴다. 맞춤 우선권(`priority`, 마지막으로 만진 쪽 우선)은 놓은 직후 패널이 튀는 것을 막으려고 스펙이 더한 규칙이다 — 뒤집으면 D12·D16·Test-897·901·911만 바뀐다.
4. **접힌 레일에서의 선반 피드백(D13).** 자동 펼침·배지 없음. 권장안은 최소 변경이며, 접힌 채 담긴 항목이 안 보이는 것은 후속 과제.
5. **접힌 채 놓았을 때 기억 폭(D15).** 드래그 시작 때의 폭. 대안: 접히기 직전에 보이던 폭(220→300→접힘이면 300).
6. **접힌 오른쪽 끌기 영역과 스크롤바 겹침(D17).** 겹침을 허용하고 R3(j)로 확인. 수정 CSS(`main[data-region='content']:has(+ div > #rail-pane[...])`)는 main·감싸는 div·`#rail-pane` 형제 구조에 기대고 탭줄도 6px 줄어든다. `split-view.md`가 이 구조를 바꾸면 이 선택자가 계속 맞는지 확인한다(또는 `AppShell`이 다는 데이터 속성으로 바꾼다).

**위험**

- **`AppShell.tsx` 합류 충돌.** 네 스펙이 같은 파일을 고친다(§9 표). P3는 구조 변경이라 먼저 병합하고 나머지가 그 위에 쌓인다.
- **단축키 충돌 가능성.** `Ctrl+B`/`Ctrl+Alt+B`는 지금 비어 있지만 `explorer-menu-and-focus.md`가 키를 더하면 겹칠 수 있다 — 합칠 때 `grep -rn "KeyB\|'b'" src/renderer`로 본다.
- **Windows의 Ctrl+Alt = AltGr.** AltGr 자판(독일어 등)에서 Ctrl+Alt+B가 문자 입력일 수 있어 `AltGraph`를 거른다(D10). 이 자판에서는 오른쪽 토글 단축키가 안 되고 툴바 버튼만 된다.
- **포인터 캡처 유실.** 창 밖에서 놓거나 OS가 캡처를 빼앗으면 `lostpointercapture`가 온다. 놓기와 같이 처리한다(D14, Test-906). 놓기 이벤트를 영영 못 받는 환경이 있으면 `data-dragging`이 남을 수 있는데, `buttons === 0` 휴리스틱은 쓰지 않는다(§6; 테스트 레시피와 충돌). R3(a)에서 창 밖 놓기를 확인하고, 재현되면 후속으로 올린다.
- **저장된 폭이 다른 모니터에서 크다.** 맞춤(D12)이 표시를 보호하고 저장값은 두므로 창을 키우면 돌아온다.

**후속 과제(이번 범위 밖)**: 접힌 레일의 선반 개수 배지·자동 펼침 옵션, 창 크기 구간별 자동 접기 옵션, `requestAnimationFrame` 합치기, 패널 폭 프리셋 메뉴, 분할 뷰와 사이드바 폭의 연동.

---

## 12. 관련 코드 포인터

| 파일                                                                                                                                       | 역할                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`layout/AppShell.tsx`](../../src/renderer/src/components/layout/AppShell.tsx)                                                             | `REGIONS`(:21-30), 전역 keydown(:59-104; F6 :80, `typing` 반환 :81), 바깥 `flex` 행(:117-124) — 패널 감싸기·단축키 자리                                |
| [`layout/Sidebar.tsx`](../../src/renderer/src/components/layout/Sidebar.tsx)                                                               | `<nav data-region="sidebar">`와 고정 폭 `w-[220px]`(:284-288)                                                                                          |
| [`layout/RightRail.tsx`](../../src/renderer/src/components/layout/RightRail.tsx)                                                           | `<aside data-region="shelf">`와 고정 폭 `w-[288px]`(:49-54), `data-shelf-target`(:22)                                                                  |
| [`layout/Toolbar.tsx`](../../src/renderer/src/components/layout/Toolbar.tsx)                                                               | 루트(:24), 왼쪽 그룹(:25-36), 활동 알약(:38), 설정(:40-47), 연결 해제(:49-62) — 토글 두 개가 들어갈 양 끝                                              |
| [`layout/TabStrip.tsx`](../../src/renderer/src/components/layout/TabStrip.tsx)                                                             | Ctrl 계열 처리기가 `altKey`면 물러남(:107)                                                                                                             |
| [`styles/globals.css`](../../src/renderer/src/styles/globals.css)                                                                          | `:root` 토큰(:11-), 다크(:40), `prefers-reduced-motion`(:233), `forced-colors`(:254), `.slide`/`.pop` 등 기존 애니메이션 클래스                        |
| [`hooks/useElementWidth.ts`](../../src/renderer/src/hooks/useElementWidth.ts)                                                              | 컨테이너 폭 측정(:8). jsdom에서는 0                                                                                                                    |
| [`lib/platform.ts`](../../src/renderer/src/lib/platform.ts)                                                                                | `isMac`(:18), `currentPlatform`(:23). 단축키 판별의 플랫폼 인자                                                                                        |
| [`stores/useSettingsStore.ts`](../../src/renderer/src/stores/useSettingsStore.ts)                                                          | persist 선례(:67-71, `version: 2`) — 이 스펙은 건드리지 않는다(D11)                                                                                    |
| [`hooks/useThemeSource.ts`](../../src/renderer/src/hooks/useThemeSource.ts)                                                                | 설정 값 구독 훅의 모양(훅 한 개로 상태→효과) 선례                                                                                                      |
| [`lib/flyTo.ts`](../../src/renderer/src/lib/flyTo.ts) · [`explorer/Explorer.tsx`](../../src/renderer/src/components/explorer/Explorer.tsx) | `flyTo`(:34), `shelve`의 대상 조회(`Explorer.tsx:320`) — 접힌 레일에서도 그대로 동작(함정 8)                                                           |
| [`main/index.ts`](../../src/main/index.ts)                                                                                                 | `minWidth: 1024`(:49) — 바꾸지 않는다                                                                                                                  |
| [`vitest.setup.ts`](../../vitest.setup.ts)                                                                                                 | `ResizeObserver` no-op(:40-47), 메모리 `localStorage`(:18-39, `window`가 있는 jsdom 한정 — node 환경 스토어 테스트는 저장소가 없다) — 테스트 환경 가정 |
| [`explorer/explorerTestHarness.ts`](../../src/renderer/src/components/explorer/explorerTestHarness.ts)                                     | `setupExplorer`(:82), `h.api.platform`을 바꿔 macOS 분기 시험                                                                                          |
| [`layout/AppShell.test.tsx`](../../src/renderer/src/components/layout/AppShell.test.tsx)                                                   | 기존 Test-834(F6 순환, :83-)를 깨지 않는다. 새 셸 테스트가 같은 `describe` 패턴을 따른다                                                               |

---

## 13. R3 실측 결과

빌드한 앱(`electron-vite build`)을 macOS(arm64)에서 `--remote-debugging-port`로 띄우고 CDP(`Input.dispatchMouseEvent`·`Input.dispatchKeyEvent`·`Emulation.setEmulatedMedia`)로 구동했다.
이 작업 환경의 `node_modules`에 `@modelcontextprotocol/*`이 없어 메인 프로세스가 그대로는 뜨지 않았다. `out/main/node_modules` 아래에 빈 스텁(저장소 밖·`out/`은 무시 대상)을 두고 시험했다. Agent access는 꺼져 있어 이 시험과 무관하다.

| 항목                  | 결과   | 내용                                                                                                                                                                                                                                                                                                                                                   |
| --------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| (a) 끌기·커서         | 통과   | 왼쪽 220→300 끌기에서 폭이 포인터를 따르고 끌기 중 `localStorage`는 그대로, 놓으면 한 번 저장. 핸들 `cursor: col-resize`. 창 밖에서 놓는 경우와 실제 커서 모양은 사람이 확인(manualForHuman)                                                                                                                                                           |
| (b) 큰 폴더에서 끌기  | 통과   | 600개 로컬 폴더(탐색기 가상 그리드)에서 오른쪽 레일을 왕복 끌기: 프레임 간격 중앙값 8.3ms · p95 9.1ms · 최대 16.8ms(120Hz 화면). `requestAnimationFrame` 합치기는 필요 없다                                                                                                                                                                            |
| (c) 스냅·히스테리시스 | 통과   | 왼쪽: 90에서 접힘(0px), 91~179 구간은 접힌 채 유지, 180에서 펼침. 오른쪽: 120에서 접힘, 239까지 유지, 240에서 펼침. 접은 채 놓으면 `{300, collapsed:true}`로 시작 때 폭이 남음(D15)                                                                                                                                                                    |
| (d) 더블클릭          | 통과   | 어떤 폭이든 220으로 리셋. 접힌 가장자리에서 시작한 끌기로 펼침도 확인                                                                                                                                                                                                                                                                                  |
| (e) 호버 지연         | 통과   | 호버 직후 `transition-delay: 0.3s`·불투명도 0, 200ms 뒤에도 0, 650ms 뒤 1. 포커스(키보드)·끌기 중에는 `transition-delay: 0s`                                                                                                                                                                                                                           |
| (f) 전환 200ms        | 통과   | 버튼 접기·펼치기는 약 25프레임에 걸쳐 중간 폭이 나오고 방향키·끌기는 한 번에 바뀜. `prefers-reduced-motion: reduce`이면 중간 폭 없이 즉시                                                                                                                                                                                                              |
| (g) 단축키 — macOS    | 통과   | `Input.dispatchKeyEvent`로 ⌘B(왼쪽), ⌥⌘B(오른쪽)이 동작. `key`를 `∫`·`ㅠ`로 보내도 `code: KeyB`로 동작. 실제 키보드의 OS 메뉴 가로채기는 사람이 확인(앱 메뉴에는 B 액셀러레이터가 없음)                                                                                                                                                                |
| (h) 단축키 — Windows  | 미실시 | Windows 검증 호스트를 쓰지 않았다(manualForHuman)                                                                                                                                                                                                                                                                                                      |
| (i) 포커스            | 통과   | 사이드바 버튼에 포커스를 두고 ⌘B → `explorer-list-*`로 이동. Tab 12번에 접힌 사이드바 안으로 들어가지 않음. 레일을 펼친 채 사이드바를 접으면 F6 순환이 `shelf → tabs → content → shelf`                                                                                                                                                                |
| (j) 접힌 가장자리     | 수정   | 접힌 오른쪽 가장자리의 끌기 영역이 본문 스크롤러 오른쪽 끝에 겹쳐 `elementFromPoint`가 핸들을 가리켰다(D17). 접힌 동안만 `main[data-region='content']`에 `padding-right: var(--handle-hit)`을 주는 CSS를 더해 겹침을 없앴다(`globals.css`, `:has()`). 이 macOS는 오버레이 스크롤바(폭 0)라 스크롤바 드래그 자체는 사람이 확인(Windows 클래식 스크롤바) |
| (k) 최소 창           | 통과   | 뷰포트 1024에서 저장값 360/480 → 그려진 폭 233/311, 본문 480. 끌 때 상한(233)에서 멈춤. 1500으로 키우면 건드리지 않은 쪽은 저장 폭(480)으로 돌아옴                                                                                                                                                                                                     |
| (l) 영속              | 통과   | 앱을 껐다 켜도 `{300, 접힘}`/`{400}` 그대로(애니메이션 없이 첫 프레임부터 접힘). 깨진 JSON이면 220/288, 범위 밖·문자열 값은 보정                                                                                                                                                                                                                       |
| (m) 테마·고대비       | 일부   | 밝게·어둡게에서 사이드바 배경·경계 색이 바뀌고 `--ac`도 따라 바뀜. `forced-colors: active`에서 표시선 배경이 `Highlight`로 바뀌는 것(`#fff` 계산값)까지 확인, 화면에 보이는지는 사람이 확인                                                                                                                                                            |
| (n) 접근성            | 일부   | 핸들에 Tab → `aria-label`(현지화된 이름) 확인, 방향키·Enter는 단위·CDP로 확인. 스크린 리더 낭독은 사람이 확인. 접힌 사이드바는 `inert`                                                                                                                                                                                                                 |
| (o) 선반·날기         | 통과   | 레일을 접은 채 항목 선택 후 Shift+S: 날아가는 요소 1개 생성, 레일은 접힌 채, 펼치니 선반에 1개                                                                                                                                                                                                                                                         |
