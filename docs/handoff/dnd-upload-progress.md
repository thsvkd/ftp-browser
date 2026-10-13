# 핸드오프: 끌어 놓기 업로드의 진행이 보이지 않음

R2(테스트 코드 작성)·구현의 유일한 입력이다.
이 문서에 없는 케이스는 완료 범위 밖이다. 새 케이스를 추가하거나 기존 케이스를 재해석하지 말 것.

작업 유형(R0): **버그 1건(UI)**. 전송 자체는 정상이고, 지금 보고 있는 탭에 진행이 보이지 않는 것이 버그다.
main·IPC·preload는 바꾸지 않는다.

> 사용자 피드백: "드래그 드랍으로 파일/폴더를 원격 ftp 서버에 전송 시 진행 바가 보이지 않음. 전송 기능 자체의 버그인지 확인 및 수정 필요."

---

## 1. 근본 원인

- 전송은 된다. Finder 끌어 놓기(`dnd.ts` → `dropOsFiles`)와 로컬 탭에서 끌어 온 항목(`dnd.ts` → `sendItems` → `runParts`)은
  메뉴·선반 보내기와 같은 `useTransferStore.send` → `transfer:send`로 간다. main은 한 배치로 큐에 넣고
  `transfer:updated`로 바이트 진행을 보낸다(묶음과 업로드는 Test-1101이 고정).
- 항목별 진행 표시인 `TransferRing`은 전송의 **출처**만 표시한다(로컬 항목 ↔ 업로드의 `localPath`, 원격 항목 ↔ 다운로드의 `remotePath`).
  끌어 놓기가 끝나면 사람은 **목적지**를 보고 있다. Finder 항목은 앱 안에 출처 타일이 없고, 로컬 탭에서 끌면
  `TabStrip`이 커서 아래 탭으로 바꾸어 출처 타일은 숨은 탭에 있다. 목적지 원격 탭의 폴더 타일은 업로드를 받아도 고리가 없다.
- 남는 것은 툴바 알약의 작은 고리뿐이다. 그런데 main이 업로드를 계획하는 동안(collectFiles + 원격 폴더 LIST, 큰 폴더는 수 초)
  알약은 `jobs`만 읽어 유휴로 보인다(`pendingSends`를 보지 않는다).

## 2. 결정

| #   | 결정                                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | `TransferRing`은 출처 외에 **목적지를 담은 폴더**도 표시한다. 원격 항목은 업로드의 `remotePath`, 로컬 항목은 다운로드의 `localPath`가 그 항목 **아래**(경로 + 구분자로 시작)일 때. 로컬 구분자는 `\`·`/`, 원격은 `/`                             |
| D2  | 목적지 일치는 항목 아래만 본다(같은 경로는 아니다). 덮어쓰이는 파일 타일·다운로드 대상 파일은 지금처럼 고리가 없다(Test-831의 마지막 단언 유지). 출처 일치는 그대로(같은 경로 또는 아래)                                                         |
| D3  | 끝난·취소된 작업은 목적지 쪽에도 고리가 없다(살아 있는 상태 `pending`·`active`·`failed`만, 기존과 같다)                                                                                                                                          |
| D4  | 활동 알약은 `pendingSends`가 있고 실행 중 작업이 없으면 바쁨 스피너(`Loader`, 파일 작업 중과 같은 모양)를 보이고, 접근성 이름·title을 기존 `activity.preparing`(`{{label}}`은 첫 준비 중 보내기)으로 한다. 보이는 글자는 그대로 `activity.title` |
| D5  | 실행 중 작업이 있으면 `pendingSends`가 있어도 퍼센트 고리가 우선한다                                                                                                                                                                             |
| D6  | ~~다른 쪽으로 가는 끌어 놓기가 시작되면 놓은 자리에서 카드 하나가 활동 알약(`[data-activity-target]`)으로 날아간다~~ **대체됨**: `transfer-panel.md`(P5). 오른쪽 아래 전송 패널이 새 보내기마다 열리므로 날리기를 뺐다                           |
| D7  | 알약의 접근성 이름은 보이는 글자로 시작한다(WCAG 2.5.3): 준비 중이면 "Activity, Preparing folder…"                                                                                                                                               |

새 i18n 키는 없다.

### 기각한 대안

| 대안                                                          | 기각 이유                                                                                        |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 끌어 놓으면 활동 팝오버를 자동으로 연다                       | 거슬린다. 메뉴·선반 보내기와 다르게 동작한다                                                     |
| 목적지 일치에 같은 경로도 넣는다(방향과 무관하게 경로만 비교) | Test-831이 "다운로드 대상 로컬 파일에는 고리가 없다"를 고정한다. 기존 테스트를 재해석하지 않는다 |
| main이 업로드 시작 전에 원격 목록에 빈 파일을 미리 알린다     | main·IPC 변경이 필요하고 실패 시 유령 항목이 남는다. UI만으로 고칠 수 있다                       |

### 사람의 확인이 필요한 것

- (대체됨, `transfer-panel.md` P5) D6(옛 보류안 C)은 사용자 보고("진행 바가 보이지 않음")의 가장 흔한 경우, 곧 열린 폴더 빈 곳·탭 머리·사이드바·경로 막대에
  파일을 놓는 경우를 덮으려고 채택했다. 이 경우 목적지 타일이 화면에 없어 D1의 고리가 붙을 곳이 없다. PR에서 사람이 확인한다.
  거절되면 D6·Test-1100을 빼고, PR 본문에 "열린 폴더에 파일을 놓으면 화면 안 진행 표시는 알약뿐"이라고 적는다.

## 3. 테스트 케이스

| 번호      | 파일                                               | 내용                                                                                                                                                                                                                                                                  |
| --------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Test-1093 | `components/thumbnail/TransferRing.test.tsx`       | 원격 폴더 `/dest/folder`와 `remotePath` `/dest/folder/sub/a.bin`인 활성 업로드(40/100) → 고리 `active`, 이름에 40%                                                                                                                                                    |
| Test-1094 | 같은 파일                                          | 로컬 폴더 `C:\dl`과 `localPath` `C:\dl\x\a.jpg`인 활성 다운로드 → 고리. 형제 경로 `C:\dl2\a.jpg`만 있으면 고리 없음(접두어는 구분자에서 끝나야 한다)                                                                                                                  |
| Test-1095 | 같은 파일                                          | 목적지 쪽이라도 완료·취소된 작업만 있으면 고리 없음. Test-831(출처 고리)은 바꾸지 않고 통과                                                                                                                                                                           |
| Test-1096 | `components/explorer/Explorer.test.tsx`            | 목록에 `folder`가 있는 원격 탭(`/photos`)에 Finder 폴더를 놓으면 `transfer:send`, 이어서 `/photos/folder` 아래 활성 업로드가 오면 `folder` 타일에 `[data-transfer-ring='active']`. 목록에 없던 새 폴더 `fresh`는 mkdir 알림(목록 무효화)으로 타일이 생긴 뒤 같은 고리 |
| Test-1097 | 같은 파일                                          | 로컬 항목을 끌어(`useDnd.items`) 원격 폴더 타일 `sub`에 놓으면 `/photos/sub`로 `transfer:send`, 업데이트 뒤 `sub` 타일에 고리                                                                                                                                         |
| Test-1098 | `components/activity/ActivityPill.test.tsx`        | 작업 없이 `pendingSends=[{id:'send1',label:'folder'}]`면 스피너와 이름 "Activity, Preparing folder…"(title은 "Preparing folder…"), 비면 다시 유휴 "Activity"                                                                                                          |
| Test-1099 | 같은 파일                                          | `pendingSends`와 실행 중 작업이 함께 있으면 퍼센트 고리·이름이 남고 스피너는 없다                                                                                                                                                                                     |
| Test-1100 | ~~`components/explorer/Explorer.test.tsx`~~        | **대체됨**(`transfer-panel.md` P5, Test-1119): 끌어 놓기는 더 이상 카드를 날리지 않는다. 테스트와 `covers:` 태그는 지운다                                                                                                                                             |
| Test-1101 | `src/main/transfer/sendUpload.integration.test.ts` | 모의 FTP 서버에 `transfer:send` 업로드 [폴더, 파일] → 모든 id가 한 `batchId`로 완료되고 `server.stored`에 두 원격 경로가 있다. 중간 진행 단언은 뺐다(24MiB를 느리게 올려야 해 CI의 병렬 테스트를 굶겼다. 진행 갱신은 `TransferQueue.test.ts`가 고정)                  |
| Test-1102 | R3(손으로, 실제 앱)                                | 큰 파일이 든 Finder 폴더를 원격 탭에 끌어 놓는다: 계획 중 알약이 돌고, 이어 퍼센트, 목적지 폴더 타일에 고리, 팝오버 진행 막대가 움직인다. 로컬 탭을 원격 탭 머리에 끌어 반복                                                                                          |

## 4. 코드 포인터

- `src/renderer/src/components/thumbnail/TransferRing.tsx` — `summary`의 일치 규칙(D1~D3).
- `src/renderer/src/components/activity/ActivityPill.tsx` — `pendingSends` 구독, 스피너·이름(D4·D5·D7).
- ~~`src/renderer/src/components/explorer/dnd.ts`(onDrop의 놓은 자리) → `lib/sendItems.ts`(`sendItems`·`dropOsFiles`의 `from`, `flyToActivity`) — D6.~~ `transfer-panel.md` P5에서 지운다.
- 참고만: `stores/useTransferStore.ts`(`send`·`pendingSends`),
  `components/layout/TabStrip.tsx`(끌기 중 탭 전환), `main/ipc/transferHandlers.ts`(`transfer:send`).

## 5. 완료 기준

- Test-1093~1101이 통과(RED를 먼저 봤다). Test-831·815는 그대로 통과.
- `npm run typecheck`, `npm run lint`, `npm test`, 바꾼 파일의 `npx prettier --check`.
- Test-1102를 실제 앱에서 확인(R3).

## R3 결과 (2026-10-13)

전송 자체는 정상이다(Test-1101). 화면 쪽 문제는 `transfer-panel.md`의 오른쪽 아래 전송 패널이 맡고, 그 문서
6절에 실제 앱 확인 결과가 있다. Finder에서 끌어 놓기는 합성 입력으로 재현하지 못해 손 확인이 남았다.
