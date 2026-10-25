# 핸드오프: 충돌 시트의 전송 작업 토글 — 복사(기본) / 이동

R1에서 인간과 합의한 내용의 고충실도 기록. R2(테스트 코드 작성)·구현의 유일한 입력이다.
이 문서에 없는 케이스는 완료 범위 밖이다. 새 케이스를 추가하거나 기존 케이스를 재해석하지 말 것.

작업 유형(R0): **기능 추가**. RED 테스트를 먼저 세운 뒤 GREEN으로 만든다.

선행 작업: 없음.
경계: **이동 선택지는 충돌 시트가 열릴 때만 존재한다**(R1에서 인간이 확정, §5 참조). 충돌이 없는
전송에는 토글이 없고 항상 복사다.

---

## 1. 문제 정의

사용자 피드백: _"파일 전송 시 '이미 있습니다' 모달에서 옮기기 옵션이 있으면 좋겠다.
기본은 복사인데 이동 옵션도 넣자는 의미."_ → R1에서 **전송 작업 토글(복사/이동)**으로 확정.

### 지금 상태

충돌 시트([`ConflictSheet.tsx`](../../src/renderer/src/components/activity/ConflictSheet.tsx))의
선택지는 결정(`ConflictDecision`)뿐이다 — `둘 다 두기 / 덮어쓰기 / 최신만 / 건너뛰기`
([`transfer.ts:37`](../../src/shared/types/transfer.ts#L37)). **이번 전송 자체를 무엇으로 할지**
(복사인가 이동인가)는 고를 수 없다.

더 중요한 것은 **실행 경로가 이미 네 갈래**라는 점이다. `runParts`가 한 보내기를 쪼갠다:

```ts
// src/renderer/src/lib/sendItems.ts:160-175
if (plan.direction)              parts.push([plan.transfer, transfer(plan.direction, ...)]) // upload/download → transfer:send
if (plan.sameSideVerb === 'move') parts.push([plan.sameSide, moveRemote(...)])              // 원격↔원격 → ftp:rename (이미 이동)
if (plan.sameSideVerb === 'copy') parts.push([plan.sameSide, copyLocal(...)])               // 로컬↔로컬 → local:copyFiles (복사 고정)
```

- **upload/download**(교차): 큐가 파일을 복사만 하고 원본은 그대로다. (`transfer:send` → `TransferQueue`)
- **원격↔원격**: 기본이 *이동*이고, 복사는 `send.invalidRemoteCopy`로 아예 금지돼 있다
  ([`sendPlan.ts:71-72`](../../src/renderer/src/lib/sendPlan.ts#L71-L72)).
- **로컬↔로컬**: 기본이 *복사*이며, 이동 경로는 아직 없다.

즉 "기본은 복사, 옵션으로 이동"이라는 요구는 **교차 전송과 로컬↔로컬에서 새로 만들어야 하고,
원격↔원격은 이미 이동이라 복사 칸만 막으면 된다.**

---

## 2. 핵심 결정 (R1에서 인간이 확정)

| #   | 결정                                                                                                                                                                              | 근거                                                                                                                                                                          |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1  | 시트 위쪽에 **전송 작업 토글(복사 · 이동)**을 둔다. 기본값 **복사**                                                                                                               | 사용자 요구 그대로. 복사는 지금의 동작이라 회귀 없음                                                                                                                          |
| V2  | 단, `direction === 'move'`(원격↔원격)인 시트는 **기본이 이동이고 복사 칸을 비활성**한다(사유는 기존 `send.invalidRemoteCopy`)                                                     | 원격 복사는 애초에 지원하지 않는다. 지원하지 않는 선택지를 주는 건 거짓말                                                                                                     |
| V3  | 토글 값은 **프롬프트(충돌 시트 한 장)가 아니라 한 보내기 전체를 공유하는 `VerbRef`에 쓴다** — `runParts`가 만들어 모든 부분에 전달                                                | 한 보내기에 로컬 항목과 원격 항목이 섞이면 시트가 두 번 열리는데, 두 번 모두 같은 값을 보여주고 같은 결과를 내야 한다. 전역 스토어 필드는 동시에 열린 다른 보내기와 섞인다    |
| V4  | **교차 전송의 원본 삭제는 렌더러가** 한다. `TransferSendRequest`·IPC 계약은 **바꾸지 않는다**                                                                                     | 삭제 조건(전체 완료·건너뜀 없음)을 렌더러가 이미 안다(`TransferSendResult.skipped`). 메인 큐에 `move` 플래그를 넣으면 재시도·취소·재시작까지 큐가 따라가야 해서 범위가 커진다 |
| V5  | 원본 삭제 조건: **그 배치의 작업이 전부 `completed`이고, `skipped`가 비어 있을 때만** `request.sources`를 삭제한다. 하나라도 실패·취소·건너뜀이 있으면 **아무것도 지우지 않는다** | 안전이 우선이다. 건너 hợ파스 된 파일까지 폴더 재귀 삭제하면 **데이터 유실**이다. "전부 성공했을 때만"은 규칙이 하나라 테스트로 정확히 고정된다                                |
| V6  | 같은 쪽(로컬↔로컬) 이동은 **복사 성공한 `ops`의 원본만** 지운다. `skipped`에 해당하는 항목은 애초에 `ops`에 없으므로 안전하다                                                     | 동일한 안전 논리를, 이 경로는 결정 직후 ops를 정확히 알므로 더 세밀하게 적용할 수 있다                                                                                        |
| V7  | 원격↔원격은 verb와 무관하게 `ftp:rename` 경로를 쓴다. 삭제 IPC를 부르지 않는다                                                                                                    | rename 자체가 이동이다. 복사-후-삭제로 바꾸면 두 배의 왕복과 중간 실패 지점이 생긴다                                                                                          |
| V8  | 토글이 바뀌면 **이후 라운드에도 유지**된다. `send()`의 충돌 루프는 다음 라운드에 현재 verb를 넘긴다                                                                               | 여러 충돌을 차례로 묻는 중에 값이 복사로 리셋되면 사용자의 선택이 뒤집힌다                                                                                                    |
| V9  | 삭제는 **작업 id 집합으로 한 번만** 수행한다. `applyUpdate`가 처리한 뒤 등록부를 제거한다                                                                                         | `clearCompleted`가 작업을 없앨 수 있고, 재시도·중복 업데이트 경로에서 **두 번 지우는 것**을 막아야 한다                                                                       |
| V10 | 새 i18n 키 5개(`conflict.verbLabel` · `conflict.verbCopy` · `conflict.verbMove` · `conflict.verbMoveHint` · `toast.moveCleanupFailed`)을 11개 로케일 전부에 넣는다                | `en.ts`가 원본이고, 키 누락은 typecheck에서 걸린다(i18n 규칙)                                                                                                                 |

### 사용자에게 보이는 동작 (V1·V2·V5의 합)

| 전송                | 토글 기본값 | 이동을 고르면                    |
| ------------------- | ----------- | -------------------------------- |
| 업로드(로컬→원격)   | 복사        | 도착이 끝나면 **로컬 원본** 삭제 |
| 다운로드(원격→로컬) | 복사        | 도착이 끝나면 **원격 원본** 삭제 |
| 로컬↔로컬           | 복사        | 복사가 끝나면 **로컬 원본** 삭제 |
| 원격↔원격           | 이동(고정)  | 이미 이동. 복사 칸은 비활성      |

---

## 3. 구현 함정

### 함정 A — 건너흟긴 파일 때문에 폴더 원본이 통째로 사라진다

`resolvePlan`은 `skipped`에 **원본 경로**를 남긴다([`folderPlan.ts:329-333`](../../src/main/transfer/folderPlan.ts#L329-L333)).
사용자가 "건너뛰기"를 골랐어도 배치는 `completed`로 끝난다. 이 상태에서
`request.sources`(폴더 경로 포함)를 재귀 삭제하면 **원본 폴더 안의 안 옮겨진 파일까지 없어진다.**
따라서 V5의 두 조건(전체 완료 **그리고** `skipped` 비어 있음)은 한 조건으로 합칠 수 없다.
`Test-864`가 이 함정을 고정한다.

### 함정 B — 포커스와 포커스 가두기가 토글을 모른다

시트는 `firstButton.current?.focus()`로 매 충돌마다 "둘 다 두기"에 포커스를 주고,
Tab을 버튼·입력칸 사이로 가둔다([`ConflictSheet.tsx:54,116-126`](../../src/renderer/src/components/activity/ConflictSheet.tsx#L116-L126)).
토글을 `<button>`/`<input>`으로 넣으면 (1) Tab 순서에 새로 끼어 기존 순환이 밀리고,
(2) 렌더 순서상 토글이 위에 있으면 `querySelectorAll`의 첫 요소가 바뀌어 **가두기의 출발점이 바뀐다.**
기존 `Test-812`(포커스·가두기)가 계속 GREEN인지로 검증하며, 토글은 포커스를 **요구하지 않는** 요소로 둔다.

### 함정 C — `verbRef`를 복사해 버리면 두 부분이 갈린다

V3의 `VerbRef`는 **참조**여야 한다. `runParts`가 `{ ...verbRef }`처럼 새로 만들어 넘기거나,
`send`가 자기 로컬 복사본만 갱신하면 로컬↔로컬 부분과 교차 부분이 다른 값을 쓴다.
`runParts`에서 **하나를 만들어 그대로 주고**, 읽는 곳도 `verbRef.verb`로 직접 읽어야 한다.

### 함정 D — 충돌이 아예 없으면 토글을 볼 수 없다

교차 전송의 충돌은 메인이 `transfer:send`의 응답으로 돌려주기 전에는 나타나지 않고,
같은 쪽은 대상 폴더를 읽은 뒤에야 안다([`sameSideOps`](../../src/renderer/src/lib/sendItems.ts#L96-L111)).
**충돌이 0개면 시트 자체가 열리지 않는다 → 이동을 고를 방법이 없다.** 이는 R1의 결정(축을 C안
"드롭 직후 선택"이 아니라 A안 "충돌 시트 안 토글"로 고름)에서 받아들인 범위다. §5에 기각 기록으로 남긴다.

### 함정 E — 원본 삭제 뒤 목록이 갱신되지 않는다

`applyUpdate`는 완료된 다운로드의 로컬 폴더만 무효화한다([`useTransferStore.ts:128-144`](../../src/renderer/src/stores/useTransferStore.ts#L128-L144)).
이동으로 **원본이 사라진** 폴더는 아무도 무효화하지 않는다: 업로드면 로컬 원본 폴더,
다운로드면 원격 원본 폴더. 삭제 직후 두 폴더를 각각 `useListingStore.invalidate` 해야
목록에서 원본이 사라진 게 보인다. (`Test-861`·`Test-862`가 함께 단언한다.)

---

## 4. 대상 API

```ts
// src/renderer/src/stores/useTransferStore.ts (신규 타입)

/** 이번 보내기의 작업. 충돌 시트의 토글이 바꾸고, 한 보내기의 모든 부분이 공유한다(V3). */
export type SendVerb = 'copy' | 'move'
export interface VerbRef {
  verb: SendVerb
}
/** 충돌 시트의 답. `decisions`는 그대로, `verb`는 이 보내기 전체에 적용된다(V3·V8). */
export interface ConflictAnswer {
  decisions: Record<string, ConflictDecision>
  verb: SendVerb
}
```

```ts
interface TransferStore {
  askConflicts: (
    direction: ConflictPrompt['direction'],
    conflicts: TransferConflict[],
    verb?: SendVerb // 생략하면 direction이 'move'면 'move', 아니면 'copy'(V1·V2)
  ) => Promise<ConflictAnswer | null>
  resolveConflicts: (id: string, answer: ConflictAnswer | null) => void // ← 계약 변경
  send: (
    request: TransferSendRequest,
    meta: BatchMeta,
    verbRef?: VerbRef
  ) => Promise<TransferSendResult | null>
}
```

`send` 내부 (충돌이 모두 정리된 뒤, enqueue 성공 시):

```ts
const verb = verbRef?.verb ?? 'copy'
if (verb === 'move' && data.ids.length && data.skipped.length === 0) {
  registerMove({
    // V5·V9
    ids: data.ids,
    side: request.direction === 'upload' ? 'local' : 'remote',
    sources: request.sources,
    skipped: data.skipped.map((s) => s.path)
  })
}
```

`applyUpdate` 끝에서 (등록된 move마다):

```ts
const jobs = currentJobsOf(move.ids)                 // id로 찾은 현재 작업
if (jobs.length === 0 || jobs.some((j) => j.status !== 'completed')) return // 아직 성립 안 됨
if (move.skipped.length > 0) { forget(move); return } // 건너|(
const channel = move.side === 'local' ? 'local:deleteBatch' : 'ftp:deleteBatch'
const r = await window.api.invoke<IpcResult<void>>(channel, move.sources)
if (r.success) {
  useListingStore.getState().invalidate(move.side, move.side === 'remote' ? server : undefined, parentDir)
  toast(t('toast.moveCleanupFailed') ...)            // ← 실패일 때(V10)
}
forget(move)                                          // 성공·실패 모두 다시 시도하지 않는다(V9)
```

```ts
// src/renderer/src/lib/sendItems.ts

export async function runParts(plan: SendPlan, dest: Loc): Promise<ExplorerEntry[]> {
  const verbRef: VerbRef = { verb: 'copy' } // 함정 C: 하나를 만들어 그대로 준다
  // 전송 부분:   transfer(plan.direction, paths, dest, verbRef)
  // 같은 쪽 부분: moveRemote(...) / copyLocal(plan.sameSide, dest, verbRef)
}

/** V6: 복사가 끝난 ops의 원본만 지운다. skipped는 ops에 없으므로 안전하다. */
async function copyLocal(items, dest, verbRef): Promise<boolean> {
  const ops = await sameSideOps('copy', items, dest, verbRef)
  // ... 기존 local:copyFiles 성공 뒤:
  if (verbRef.verb === 'move' && ops.length)
    await window.api.invoke(
      'local:deleteBatch',
      ops.map((o) => o.source)
    )
}
```

시트([`ConflictSheet.tsx`](../../src/renderer/src/components/activity/ConflictSheet.tsx)):

```tsx
const [verb, setVerb] = useState<SendVerb>(
  prompt.verb ?? (prompt.direction === 'move' ? 'move' : 'copy')
)
// 토글: 카드 위, 복사 · 이동 세그먼트. direction==='move'이면 복사 칸 disabled
// (title: t('send.invalidRemoteCopy')), 포커스를 요구하지 않는다(함정 B).
// decide(d) → resolve(prompt.id, { decisions: next, verb })   ← 기존 resolve(prompt.id, next)에서 변경
```

새 i18n 키 (`src/renderer/src/i18n/locales/en.ts` 원본 + 10개 로케일):

| 키                        | 영문 원본 예시                                  |
| ------------------------- | ----------------------------------------------- |
| `conflict.verbLabel`      | `Send as`                                       |
| `conflict.verbCopy`       | `Copy`                                          |
| `conflict.verbMove`       | `Move`                                          |
| `conflict.verbMoveHint`   | `Remove the original after everything arrives`  |
| `toast.moveCleanupFailed` | `Moved, but the originals could not be removed` |

---

## 5. 기각한 대안

- **드롭 직후 "복사할까요 이동할까요" 확인(축 C)** — 충돌이 없어도 선택할 수 있고 직관적이지만,
  매 드롭마다 한 번 더 묻는 비용이 크고 R1에서 이쪽을 기각했다(충돌 시트 안 토글을 선택).
- **충돌 항목 개별 "이동해서 덮기"(축 B)** — `overwrite`와 의미가 겹치고, 건별로 다른 작업
  (어떤 건 복사, 어떤 건 이동)이 결과적으로 섞여 나온다. 한 전송의 성격은 한 번 정하는 게
  예측 가능하다. 기각.
- **`TransferSendRequest`에 `verb`를 넣어 메인이 큐에서 삭제** — 큐가 재시도·취소·재시작을
  책임지는 만큼 원본 삭제도 함께 책임질 수 있다(V4의 반대). 그러나 `skipped` 조건·로컬↔로컬
  같은 쪽·`ftp:rename` 경로까지 메인으로 옮기면 범위가 두 배가 되고, 메인 쪽 계약·테스트
  (mock FTP 서버)를 건드린다. 렌더러에서 충분히 안전하게 할 수 있다. 기각(단, 향후 후보).
- **작업 하나가 끝날 때마다 즉시 원본 삭제** — 빠르지만 실패한 파일의 원본까지 남길 수 없는
  구조가 아니라 **성공한 파일만 지우는** 결과가 되어, 사용자는 "부분적으로 이동된" 폴더를
  보게 된다. 그리고 폴더 원본은 결국 남는다. V5의 "배치 단위 한 방"이 규칙이 짧고 안전하다. 기각.
- **`local:copyFiles` 대신 이동 IPC 새로 만들기** — 이미 있는 `local:deleteBatch` 두 번으로
  끝난다. 새 채널은 preload 허용목록·`InvokeChannel` 유니언·계약 테스트를 모두 건드린다. 기각.
- **verb를 전역 스토어 필드(`useTransferStore.verb`)로** — 두 번째 시트가 첫 번째 값을 물려받는
  문제는 해결하지만, **동시에 진행 중인 다른 보내기**의 값과 섞인다. V3의 참조 전달이 범위가
  좁고 명시적이다. 기각.

---

## 6. 테스트 케이스 리스트 (확정)

`Test-857`부터 신규. 기존 최대 번호는 `Test-856`([`server-connect-activation.md`](./server-connect-activation.md)).
각 테스트에 `covers: Test-N` 주석을 단다. **1:1 매핑. 케이스 추가·병합·재해석 금지.**

### A. 충돌 시트 UI (`components/activity/ConflictSheet.test.tsx`)

| #        | 케이스                                                                                                               | 기대                                                                                |
| -------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Test-857 | 시트를 열면 토글이 보이고 기본값은 복사다 (`direction`이 `upload`·`download`·`copy` 세 경우 모두)                    | V1. 세 경우 모두 "복사"가 선택되어 있고 이동은 선택되어 있지 않다                   |
| Test-858 | 이동을 고르고 결정하면 resolve가 `{ decisions, verb: 'move' }`로 돌아간다                                            | `resolveConflicts`의 새 계약. 기존 `Test-812`~`814`·`842`의 decisions 값은 그대로다 |
| Test-859 | 남은 충돌이 여러 장이어도 **첫 장에서 고른 이동이 다음 장에 유지**된다                                               | V8                                                                                  |
| Test-860 | `direction === 'move'`(원격↔원격) 시트는 기본이 이동이고 복사 칸이 비활성이며 `send.invalidRemoteCopy`를 이유로 준다 | V2                                                                                  |
| Test-861 | 토글을 추가한 뒤에도 시트는 열릴 때 "둘 다 두기"에 포커스를 주고 Tab이 버튼들 사이를 돈다                            | 함정 B. 기존 `Test-812`의 포커스·가두기 기대가 계속 성립함을 새 번호로 고정         |

### B. 스토어 (`stores/useTransferStore.test.ts`)

| #        | 케이스                                                                                                                                          | 기대                                                                     |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Test-862 | 업로드 + 이동: 배치가 전부 completed이고 skipped가 없으면 `local:deleteBatch`로 `sources`를 한 번 삭제하고 **로컬 원본 폴더 목록을 무효화**한다 | V4·V5·함정 E                                                             |
| Test-863 | 다운로드 + 이동: `ftp:deleteBatch`로 삭제하고 **원격 원본 폴더 목록을 무효화**한다                                                              | V4·V5·함정 E                                                             |
| Test-864 | 배치에 failed·cancelled가 있거나 **skipped가 하나라도 있으면 삭제 IPC를 부르지 않는다**                                                         | 함정 A. 두 조건은 각각 레드여야 한다(하나만 봐도 통과하는 구현을 막는다) |
| Test-865 | 기본(복사)이면 삭제 IPC가 한 번도 호출되지 않는다                                                                                               | V1. 이동을 고르지 않은 전송의 회귀 없음                                  |
| Test-866 | 처리가 끝난 배치가 `removedIds`로 사라져도, 재시도 업데이트가 와도 **삭제가 중복 호출되지 않는다**                                              | V9                                                                       |
| Test-867 | 원본 삭제 IPC가 실패하면 `toast.moveCleanupFailed`를 띄우고 다시 시도하지 않는다                                                                | V10                                                                      |

### C. 같은 쪽 보내기 (`lib/sendItems.test.ts` 신규)

| #        | 케이스                                                                                           | 기대                          |
| -------- | ------------------------------------------------------------------------------------------------ | ----------------------------- |
| Test-868 | 로컬↔로컬 + 이동: `local:copyFiles` 성공 뒤 **복사한 `ops`의 원본만** `local:deleteBatch`로 삭제 | V6                            |
| Test-869 | 로컬↔로컬 + 복사(기본): 삭제 IPC가 호출되지 않는다                                               | V1·V6                         |
| Test-870 | 로컬↔로컬 + 이동인데 `local:copyFiles`가 실패하면 삭제하지 않는다                                | 복사가 성공해야 원본을 잇는다 |
| Test-871 | 원격↔원격: verb와 무관하게 `ftp:rename`만 부르고 삭제 IPC를 부르지 않는다                        | V7                            |

- 기존 `Test-812`·`813`·`814`·`842`(시트의 카드·결정·포커스·폴더 규칙)와 `Test-789`·`790`
  (배치 메타·다운로드 목록 갱신)은 **그대로 GREEN이어야 한다.**
- `sendItems.test.ts`는 신규 파일이다. 렌더러 테스트 규칙을 따른다
  (`/** @vitest-environment jsdom */` 첫 줄, `vi.stubGlobal('api', makeApiMock(vi.fn()))`).
- E2E가 전담할 것: 토글을 실제로 눌러 전송을 돌리고 원본이 사라지는지(§8 표).

---

## 7. 관련 코드 포인터

| 파일                                                                                                                                                                                                            | 역할                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [`components/activity/ConflictSheet.tsx`](../../src/renderer/src/components/activity/ConflictSheet.tsx)                                                                                                         | 시트 전체. 토글 배치 위치, `decide` L57-66(resolve 계약 변경), 포커스 L54·116-126(함정 B)                |
| [`stores/useTransferStore.ts`](../../src/renderer/src/stores/useTransferStore.ts)                                                                                                                               | `ConflictPrompt` L25-30, `send` L176-202(verbRef·registerMove), `applyUpdate` L109-161(삭제 판정·무효화) |
| [`lib/sendItems.ts`](../../src/renderer/src/lib/sendItems.ts)                                                                                                                                                   | `runParts` L160-175(verbRef 생성처), `transfer` L149-157, `sameSideOps` L96-111, `copyLocal` L126-147    |
| [`lib/sendPlan.ts`](../../src/renderer/src/lib/sendPlan.ts)                                                                                                                                                     | `planSend` — verb는 **입력이 아니다**(계획은 작업을 모른다). `send.invalidRemoteCopy` L71-72             |
| [`lib/sameSidePlan.ts`](../../src/renderer/src/lib/sameSidePlan.ts)                                                                                                                                             | `planSameSide` — skip 결정은 ops에서 빠진다(V6의 안전 근거)                                              |
| [`main/transfer/folderPlan.ts`](../../src/main/transfer/folderPlan.ts)                                                                                                                                          | `resolvePlan` L300-345 — `skipped`에 원본 경로(함정 A 근거)                                              |
| [`shared/types/transfer.ts`](../../src/shared/types/transfer.ts)                                                                                                                                                | `TransferSendRequest` L39-47(**무변경**, V4), `TransferSendResult.skipped` L65                           |
| [`stores/useListingStore.ts`](../../src/renderer/src/stores/useListingStore.ts)                                                                                                                                 | `invalidate`(함정 E)                                                                                     |
| [`components/activity/ConflictSheet.test.tsx`](../../src/renderer/src/components/activity/ConflictSheet.test.tsx) · [`stores/useTransferStore.test.ts`](../../src/renderer/src/stores/useTransferStore.test.ts) | 기존 하네스와 `Test-812`~`814`·`842`·`789`·`790`                                                         |

---

## 8. 완료 기준

1. `Test-857`~`Test-871`이 모두 GREEN (실행 출력으로 확인).
2. **기존 `Test-812`·`813`·`814`·`842`·`789`·`790`이 계속 GREEN.** 특히 시트의 포커스·Tab 가두기와
   다운로드 완료 후 목록 갱신.
3. `resolveConflicts`의 호출처를 전부 찾아 새 계약(`ConflictAnswer | null`)으로 맞춘다
   (`graft callers resolveConflicts --direction in`). 빠뜨린 호출처는 런타임에서만 깨진다.
4. 각 신규 테스트에 `covers: Test-N` 주석.
5. **i18n 키 5개가 `en.ts`와 10개 로케일 전부에 있고**, `i18n.test.ts`(플레이스홀더·plural)와
   typecheck가 GREEN이어야 한다.
6. 뮤테이션: `git diff --unified=0 -- src/renderer/src/components/activity/ConflictSheet.tsx src/renderer/src/stores/useTransferStore.ts src/renderer/src/lib/sendItems.ts | grep '^@@'`로
   변경 라인을 확인해 `stryker.config.json`의 `mutate`를 갱신하고 `break: 70` 통과.
7. `npm run typecheck` · `npm run lint` · `npx prettier --check <변경 파일>` · `npm test` 통과.
8. E2E 실측 (실기기 R3):

   | 항목 | 확인 내용                                                                                                       |
   | ---- | --------------------------------------------------------------------------------------------------------------- |
   | (a)  | 로컬 파일을 다른 로컬 폴더로 보낸 뒤 충돌 시트에서 **이동** 고르고 덮어쓰기 → 전송이 끝나면 **원본이 사라진다** |
   | (b)  | 같은 흐름에서 기본(복사)을 그대로 두면 **원본이 남는다**                                                        |
   | (c)  | 업로드 중 충돌 시트에서 이동을 고르고, 일부 파일을 **건너뛰기** → 전송이 끝나도 **원본 폴더가 남는다**          |
   | (d)  | 다운로드 + 이동 → 완료 후 **원격 쪽 원본이 삭제**되고 양쪽 목록에 반영된다                                      |
   | (e)  | 원격↔원격 보내기에서는 복사 칸이 비활성이고, 이동으로 끝난다(기존 동작 회귀 없음)                               |
   | (f)  | 전송을 취소하면 원본이 그대로 남는다                                                                            |
