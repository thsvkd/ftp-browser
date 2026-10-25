import { useEffect, useRef, useState } from 'react'
import { Copy } from 'lucide-react'
import { useT } from '@renderer/i18n'
import { useEscapeKey } from '@renderer/hooks/useEscapeKey'
import { cn, formatBytes, formatDate } from '@renderer/lib/utils'
import { categoryOf, parentPath, type ExplorerEntry } from '@renderer/lib/explorerEntry'
import { EntryThumb } from '@renderer/components/thumbnail/EntryThumb'
import { isImageFile } from '@shared/constants'
import {
  useTransferStore,
  type ConflictPrompt,
  type SendVerb
} from '@renderer/stores/useTransferStore'
import type { ConflictDecision, TransferConflict } from '@shared/types/transfer'

const BTN =
  'inline-flex h-9 items-center justify-center gap-2 rounded-[10px] px-4 text-[13px] font-semibold transition-colors'
const SECONDARY = cn(
  BTN,
  'border border-[var(--bd)] bg-[var(--sf)] text-[var(--tx)] hover:bg-[var(--hv)]'
)

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
  // 전송 작업 토글(V1). `askConflicts`가 기본값(원격↔원격은 이동, 그 외는 복사)을 정해 넣었다(V2).
  const [verb, setVerb] = useState<SendVerb>(prompt.verb)
  // 원격↔원격: 원본 복사는 지원하지 않으므로 복사 칸을 막는다(V2).
  const verbLocked = prompt.direction === 'move'
  const dialog = useRef<HTMLDivElement>(null)
  const firstButton = useRef<HTMLButtonElement>(null)
  const conflict = conflicts[index]
  const rest = conflicts.length - index - 1
  const side = prompt.direction === 'download' || prompt.direction === 'copy' ? 'local' : 'remote'
  // 같은 쪽 보내기(원격 이동·로컬 복사, D32)는 두 카드가 같은 쪽이다.
  const sameSide = prompt.direction === 'move' || prompt.direction === 'copy'
  const newer = newerSide(conflict)

  // 닫히면 연 곳으로 포커스를 돌려준다. 그곳이 사라졌으면 목록으로.
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null
    return () =>
      (back?.isConnected ? back : document.querySelector<HTMLElement>('[role="listbox"]'))?.focus()
  }, [])
  useEffect(() => firstButton.current?.focus(), [index])

  const resolve = useTransferStore((s) => s.resolveConflicts)
  const decide = (d: ConflictDecision): void => {
    const chosen = applyAll ? conflicts.slice(index) : [conflict]
    const next = { ...decisions }
    for (const c of chosen) next[c.target] = d
    // 토글 값은 시트의 답에 함께 실려 이 보내기 전체에 적용된다(V3·V8).
    if (index + chosen.length >= conflicts.length) resolve(prompt.id, { decisions: next, verb })
    else {
      setDecisions(next)
      setIndex(index + chosen.length)
    }
  }
  useEscapeKey(() => decide('skip'))

  const card = (kind: 'existing' | 'incoming'): React.JSX.Element => {
    const facts = conflict[kind]
    // 있던 것은 받는 쪽, 보내는 것은 보내는 쪽 파일이다. 그리드 밖이라 썸네일을 한 건 요청한다(D30).
    const there = kind === 'existing' || sameSide ? side : side === 'local' ? 'remote' : 'local'
    const entry: ExplorerEntry = {
      side: there,
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
          // 결정 전에 뒤의 탐색기로 포커스가 빠지지 않게 시트 안에 가둔다.
          if (e.key !== 'Tab') return
          const items = [...(dialog.current?.querySelectorAll<HTMLElement>('button, input') ?? [])]
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
        {/* 전송 작업 토글(V1): 카드 위쪽. 포커스를 요구하지 않는 요소라 Tab 가두기가 흔들리지 않는다(함정 B). */}
        <div
          role="radiogroup"
          aria-label={t('conflict.verbLabel')}
          className="mx-5 mt-3 flex w-fit items-center gap-1 rounded-[10px] border border-[var(--bd)] bg-[var(--bg)] p-1"
        >
          {(['copy', 'move'] as const).map((v) => {
            const disabled = v === 'copy' && verbLocked
            return (
              <div
                key={v}
                role="radio"
                aria-checked={verb === v}
                aria-disabled={disabled || undefined}
                title={
                  disabled
                    ? t('send.invalidRemoteCopy')
                    : v === 'move'
                      ? t('conflict.verbMoveHint')
                      : undefined
                }
                onClick={() => !disabled && setVerb(v)}
                className={cn(
                  'cursor-pointer select-none rounded-[8px] px-3 py-1 text-[12.5px] font-semibold transition-colors',
                  verb === v
                    ? 'bg-[var(--ac)] text-[var(--acx)]'
                    : 'text-[var(--mu)] hover:bg-[var(--hv)]',
                  disabled && 'cursor-not-allowed opacity-40'
                )}
              >
                {t(v === 'copy' ? 'conflict.verbCopy' : 'conflict.verbMove')}
              </div>
            )
          })}
        </div>
        <div className="flex gap-3 px-5">
          {card('existing')}
          {card('incoming')}
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
        <div className="mt-4 grid grid-cols-2 gap-2 border-t border-[var(--bd)] bg-[var(--bg)] p-4">
          <button
            ref={firstButton}
            type="button"
            onClick={() => decide('rename')}
            className={cn(BTN, 'bg-[var(--ac)] text-[var(--acx)] hover:brightness-110')}
          >
            {t('conflict.keepBoth')}
          </button>
          {/* 폴더는 덮어쓰지 않는다: 둘 다 두기·건너뛰기만(D32) */}
          {!conflict.folder && (
            <>
              <button type="button" onClick={() => decide('overwrite')} className={SECONDARY}>
                {t('conflict.overwrite')}
              </button>
              <button
                type="button"
                onClick={() => decide('newer')}
                className={SECONDARY}
                title={t('conflict.newerOnlyHint')}
              >
                {t('conflict.newerOnly')}
              </button>
            </>
          )}
          <button type="button" onClick={() => decide('skip')} className={SECONDARY}>
            {t('conflict.skip')}
          </button>
        </div>
      </div>
    </div>
  )
}
