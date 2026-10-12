import { useEffect, useRef, useState } from 'react'
import { Copy } from 'lucide-react'
import { useT } from '@renderer/i18n'
import { useEscapeKey } from '@renderer/hooks/useEscapeKey'
import { cn, formatBytes, formatDate } from '@renderer/lib/utils'
import { categoryOf, parentPath, type ExplorerEntry } from '@renderer/lib/explorerEntry'
import { EntryThumb } from '@renderer/components/thumbnail/EntryThumb'
import { isImageFile } from '@shared/constants'
import { useTabsStore } from '@renderer/stores/useTabsStore'
import { useTransferStore, type ConflictPrompt } from '@renderer/stores/useTransferStore'
import { useSettingsStore } from '@renderer/stores/useSettingsStore'
import type { ConflictDecision, TransferConflict } from '@shared/types/transfer'

const BTN =
  'inline-flex h-9 items-center justify-center gap-2 rounded-[10px] px-4 text-[13px] font-semibold transition-colors'

/** 선택지와 그 순서(D1). 기본 선택은 `newer`, 기억한 결정이 있으면 그것이다(D2·D4). */
const CHOICES = [
  { value: 'rename', label: 'conflict.keepBoth' },
  { value: 'overwrite', label: 'conflict.overwrite' },
  { value: 'newer', label: 'conflict.newerOnly', hint: 'conflict.newerOnlyHint' },
  { value: 'skip', label: 'conflict.skip' }
] as const

/** 폴더는 덮어쓰지 않는다(D32): 덮어쓰기·더 최신 것만은 둘 다 두기로 바꿔 보낸다. */
function forConflict(c: TransferConflict, d: ConflictDecision): ConflictDecision {
  return c.folder && (d === 'overwrite' || d === 'newer') ? 'rename' : d
}

/** 엄격히 늦은 쪽. 같거나 어느 쪽이든 시각을 읽을 수 없으면 없다(D10과 같은 기준). */
function newerSide(c: TransferConflict): 'incoming' | 'existing' | null {
  const a = Date.parse(c.incoming.modifiedAt)
  const b = Date.parse(c.existing.modifiedAt)
  if (Number.isNaN(a) || Number.isNaN(b) || a === b) return null
  return a > b ? 'incoming' : 'existing'
}

/** 충돌 시트(D11). `useTransferStore.conflictQueue`의 맨 앞 보내기를 묻는다. */
export function ConflictSheet(): React.JSX.Element | null {
  const prompt = useTransferStore((s) => s.conflictQueue[0])
  return prompt ? <Sheet key={prompt.id} prompt={prompt} /> : null
}

function Sheet({ prompt }: { prompt: ConflictPrompt }): React.JSX.Element {
  const t = useT()
  const { conflicts } = prompt
  const [index, setIndex] = useState(0)
  const [decisions, setDecisions] = useState<Record<string, ConflictDecision>>({})
  const [applyAll, setApplyAll] = useState(true)
  // persist는 저장된 값을 그대로 합친다. 결정이 아닌 값(손으로 고침·나중 버전의 이름)은 기억이 없는 것으로 본다
  const [saved] = useState(() => {
    const value = useSettingsStore.getState().conflictChoice
    return CHOICES.find((c) => c.value === value)?.value ?? null
  })
  const [choice, setChoice] = useState<ConflictDecision>(saved ?? 'newer')
  const [remember, setRemember] = useState(saved !== null)
  const dialog = useRef<HTMLDivElement>(null)
  const conflict = conflicts[index]
  const rest = conflicts.length - index - 1
  const side = prompt.direction === 'download' || prompt.direction === 'copy' ? 'local' : 'remote'
  // 같은 쪽 보내기(원격 이동·로컬 복사, D32)와 서버 간 복사(MC33)는 두 카드가 같은 쪽이다.
  const relay = prompt.direction === 'relay'
  const sameSide = prompt.direction === 'move' || prompt.direction === 'copy' || relay
  const newer = newerSide(conflict)
  // 폴더 충돌에서는 기억한 값이 덮어쓰기·더 최신 것만이어도 둘 다 두기를 미리 고른다(D3).
  const selected = forConflict(conflict, choice)

  // 닫히면 연 곳으로 포커스를 돌려준다. 그곳이 사라졌으면 활성 패널의 목록(split-view §4 14행),
  // 없으면 첫 목록으로.
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null
    return () =>
      (back?.isConnected
        ? back
        : (document.getElementById(`explorer-list-${useTabsStore.getState().activeId}`) ??
          document.querySelector<HTMLElement>('[role="listbox"]'))
      )?.focus()
  }, [])
  useEffect(
    () => dialog.current?.querySelector<HTMLElement>('input[type="radio"]:checked')?.focus(),
    [index]
  )

  const resolve = useTransferStore((s) => s.resolveConflicts)
  const decide = (d: ConflictDecision): void => {
    const chosen = applyAll ? conflicts.slice(index) : [conflict]
    const next = { ...decisions }
    for (const c of chosen) next[c.target] = forConflict(c, d)
    if (index + chosen.length >= conflicts.length) resolve(prompt.id, next)
    else {
      setDecisions(next)
      setIndex(index + chosen.length)
    }
  }
  useEscapeKey(() => decide('skip'))
  const setConflictChoice = useSettingsStore((s) => s.setConflictChoice)
  // 확인 때 기억하기가 켜져 있으면 고른 결정을 기억한다. 꺼져 있으면 전에 기억한 값을 그대로 둔다(D4).
  const confirm = (): void => {
    if (remember) setConflictChoice(choice)
    decide(selected)
  }

  const card = (kind: 'existing' | 'incoming'): React.JSX.Element => {
    const facts = conflict[kind]
    // 있던 것은 받는 쪽, 보내는 것은 보내는 쪽 파일이다. 그리드 밖이라 썸네일을 한 건 요청한다(D30).
    const there = kind === 'existing' || sameSide ? side : side === 'local' ? 'remote' : 'local'
    // 원격 카드는 그 연결의 파일이다(썸네일 키·요청이 entry.server를 쓴다). 서버 간 복사의 보내는 것은 보내는
    // 쪽 연결이다. 로컬 카드에는 두지 않는다
    const server = relay && kind === 'incoming' ? prompt.sourceServer : prompt.server
    const entry: ExplorerEntry = {
      side: there,
      ...(there === 'remote' && server ? { server } : {}),
      path: kind === 'existing' ? conflict.target : conflict.source,
      name: conflict.name,
      type: conflict.folder ? 'directory' : 'file',
      size: facts.size,
      modifiedAt: facts.modifiedAt,
      hidden: false,
      category: categoryOf(conflict.name),
      isImage: isImageFile(conflict.name)
    }
    const title = t(kind === 'existing' ? 'conflict.existing' : 'conflict.incoming')
    return (
      <div
        role="group"
        aria-label={title}
        className="min-w-0 flex-1 rounded-[12px] border border-[var(--bd)] bg-[var(--bg)] p-2.5"
      >
        <div className="mb-2 flex items-center justify-between text-[11.5px] font-bold text-[var(--mu)]">
          {title}
          {newer === kind && (
            <span className="rounded-full bg-[var(--acw)] px-2 py-0.5 text-[10.5px] text-[var(--ac)]">
              {t('conflict.newerBadge')}
            </span>
          )}
        </div>
        <div className="h-[92px] overflow-hidden rounded-[8px] bg-[var(--tile)]">
          <EntryThumb entry={entry} glyph="h-8 w-8" request showSlow={false} ext={false} />
        </div>
        <div className="mono mt-2 text-[11.5px] leading-5">
          {!conflict.folder && <div>{formatBytes(facts.size)}</div>}
          <div className="text-[var(--mu)]">{formatDate(facts.modifiedAt)}</div>
        </div>
      </div>
    )
  }

  return (
    <div className="fade fixed inset-0 z-[68] flex items-start justify-center bg-black/25 pt-24">
      <div
        ref={dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="conflict-sheet-title"
        onKeyDown={(e) => {
          e.stopPropagation()
          // 라디오·체크박스에서 누른 Enter는 고른 결정을 적용한다. 단추는 제 동작을 한다.
          if (
            e.key === 'Enter' &&
            !e.nativeEvent.isComposing &&
            e.target instanceof HTMLInputElement
          ) {
            e.preventDefault()
            confirm()
            return
          }
          // 결정 전에 뒤의 탐색기로 포커스가 빠지지 않게 시트 안에 가둔다.
          if (e.key !== 'Tab') return
          // 라디오 묶음은 Tab으로 고른 것 하나만 지나간다(방향키로 옮긴다).
          const items = [
            ...(dialog.current?.querySelectorAll<HTMLElement>(
              'button, input:not([type="radio"]), input[type="radio"]:checked'
            ) ?? [])
          ]
          const at = items.indexOf(document.activeElement as HTMLElement)
          const next = at === -1 ? 0 : (at + (e.shiftKey ? -1 : 1) + items.length) % items.length
          e.preventDefault()
          items[next]?.focus()
        }}
        className="rise w-[540px] overflow-hidden rounded-2xl border border-[var(--bd)] bg-[var(--sf)] text-[var(--tx)]"
        style={{ boxShadow: 'var(--shadow)' }}
      >
        <div className="flex items-start gap-3 p-5 pb-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--shw)] text-[var(--shx)]">
            <Copy className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="conflict-sheet-title" className="break-words text-[16px] font-bold">
              {t('conflict.title', { name: conflict.name })}
            </h2>
            <p className="mt-0.5 truncate text-[12.5px] text-[var(--mu)]">
              {parentPath(side, conflict.target) ?? conflict.target}
              {conflicts.length > 1 &&
                ` · ${t('conflict.progress', { number: index + 1, total: conflicts.length })}`}
            </p>
          </div>
          <button
            type="button"
            onClick={() => resolve(prompt.id, null)}
            className={cn(
              BTN,
              'h-8 px-3 text-[var(--mu)] hover:bg-[var(--hv)] hover:text-[var(--tx)]'
            )}
          >
            {t('common.cancel')}
          </button>
        </div>
        <div className="flex gap-3 px-5">
          {card('existing')}
          {card('incoming')}
        </div>
        <div
          role="radiogroup"
          aria-label={t('conflict.choiceLabel')}
          className="mx-5 mt-3 grid grid-cols-2 gap-2"
        >
          {/* 폴더는 덮어쓰지 않는다: 둘 다 두기·건너뛰기만(D32) */}
          {CHOICES.filter(
            (c) => !conflict.folder || c.value === 'rename' || c.value === 'skip'
          ).map((c) => (
            <label
              key={c.value}
              title={'hint' in c ? t(c.hint) : undefined}
              className={cn(
                'flex h-9 cursor-pointer items-center gap-2 rounded-[10px] border px-3 text-[13px] font-semibold transition-colors',
                selected === c.value
                  ? 'border-[var(--ac)] bg-[var(--acw)] text-[var(--ac)]'
                  : 'border-[var(--bd)] bg-[var(--sf)] text-[var(--tx)] hover:bg-[var(--hv)]'
              )}
            >
              <input
                type="radio"
                name="conflict-choice"
                value={c.value}
                checked={selected === c.value}
                onChange={() => setChoice(c.value)}
                // 이미 골라진 라디오는 onChange가 오지 않는다. 폴더가 미리 고른 둘 다 두기를 눌러도 사람이 고른 것이다
                onClick={() => setChoice(c.value)}
                className="h-4 w-4 accent-[var(--ac)]"
              />
              {t(c.label)}
            </label>
          ))}
        </div>
        {rest > 0 && (
          <label className="mx-5 mt-3 flex cursor-pointer items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              checked={applyAll}
              onChange={(e) => setApplyAll(e.target.checked)}
              className="h-4 w-4 accent-[var(--ac)]"
            />
            {t('conflict.applyToRest', { count: rest })}
          </label>
        )}
        <div className="mt-4 flex items-center justify-between gap-3 border-t border-[var(--bd)] bg-[var(--bg)] p-4">
          <label className="flex cursor-pointer items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="h-4 w-4 accent-[var(--ac)]"
            />
            {t('conflict.rememberChoice')}
          </label>
          <button
            type="button"
            onClick={confirm}
            className={cn(BTN, 'bg-[var(--ac)] text-[var(--acx)] hover:brightness-110')}
          >
            {t('conflict.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
