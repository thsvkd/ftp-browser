import { useState } from 'react'
import { Plus, RotateCcw, Trash2, X } from 'lucide-react'
import { useT } from '@renderer/i18n'
import { useAllCategories, useCategoryName } from '@renderer/hooks/useFileFilter'
import {
  parseExtensionInput,
  type DefaultCategoryId,
  type ResolvedCategory
} from '@renderer/lib/fileCategories'
import { confirmDialog } from '@renderer/stores/useConfirmStore'
import { useFileCategoryStore } from '@renderer/stores/useFileCategoryStore'

const btn =
  'flex items-center gap-1.5 rounded-md border border-[var(--bd2)] px-2.5 py-1 text-xs text-[var(--tx)] hover:bg-[var(--hv)]'

type Note = { kind: 'exists' | 'invalid' | 'duplicate'; ext?: string; other?: string }

/** 사용자 카테고리 이름: Enter·포커스 이탈로 확정한다. 빈 이름은 이전 이름으로 되돌린다. */
function NameInput({
  id,
  name,
  autoFocus,
  onSettled
}: {
  id: string
  name: string
  autoFocus: boolean
  onSettled: () => void
}): React.JSX.Element {
  const t = useT()
  const [draft, setDraft] = useState(name)
  const commit = (): void => {
    onSettled()
    const next = draft.trim()
    if (next) useFileCategoryStore.getState().renameCustom(id, next)
    setDraft(next || name)
  }
  return (
    <input
      value={draft}
      aria-label={t('settings.categoryName')}
      autoFocus={autoFocus}
      onFocus={(e) => autoFocus && e.currentTarget.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) commit()
      }}
      className="h-7 min-w-0 flex-1 rounded-md border border-[var(--bd)] bg-[var(--bg)] px-2 text-sm text-[var(--tx)] outline-none focus:border-[var(--ac)]"
    />
  )
}

function CategoryCard({
  category,
  fresh,
  onSettled,
  all
}: {
  category: ResolvedCategory
  fresh: boolean
  onSettled: () => void
  all: ResolvedCategory[]
}): React.JSX.Element {
  const t = useT()
  const nameOf = useCategoryName()
  const [text, setText] = useState('')
  const [note, setNote] = useState<Note | null>(null)
  const store = useFileCategoryStore.getState
  const name = nameOf(category)
  const isDefault = category.kind === 'default'

  const submit = (): void => {
    const { valid, invalid } = parseExtensionInput(text)
    let next: Note | null = null
    for (const ext of valid) {
      const r = store().addExtension(category.id, ext)
      if (r.result === 'exists') next = { kind: 'exists', ext }
      else if (r.duplicateOf) {
        const other = all.find((c) => c.id === r.duplicateOf)
        next = { kind: 'duplicate', ext, other: other ? nameOf(other) : r.duplicateOf }
      }
    }
    if (invalid.length) next = { kind: 'invalid' }
    setText(invalid.join(' '))
    setNote(next)
  }

  const restore = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: t('settings.categoryRestore'),
      message: name,
      confirmLabel: t('settings.categoryRestore')
    })
    if (ok && isDefault) store().restoreCategory(category.id as DefaultCategoryId)
  }

  const remove = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: t('settings.categoryDeleteTitle', { name }),
      confirmLabel: t('settings.categoryDelete'),
      destructive: true
    })
    if (ok) store().deleteCustom(category.id)
  }

  return (
    <div
      role="group"
      aria-label={name}
      className={`rounded-md border border-[var(--bd)] p-3 ${category.hidden ? 'opacity-60' : ''}`}
    >
      <div className="mb-2 flex items-center gap-2">
        {isDefault ? (
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--tx)]">
            {name}
            {category.hidden && (
              <span className="ml-2 rounded-full bg-[var(--hv)] px-2 py-0.5 text-[11px] font-normal text-[var(--mu)]">
                {t('settings.categoryHidden')}
              </span>
            )}
          </span>
        ) : (
          <NameInput
            id={category.id}
            name={category.name ?? ''}
            autoFocus={fresh}
            onSettled={onSettled}
          />
        )}
        {isDefault ? (
          <>
            <button className={btn} onClick={() => void restore()}>
              <RotateCcw size={12} aria-hidden /> {t('settings.categoryRestore')}
            </button>
            <button
              className={btn}
              onClick={() => store().setHidden(category.id as DefaultCategoryId, !category.hidden)}
            >
              {category.hidden ? t('settings.categoryShow') : t('settings.categoryHide')}
            </button>
          </>
        ) : (
          <button className={btn} onClick={() => void remove()}>
            <Trash2 size={12} aria-hidden /> {t('settings.categoryDelete')}
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {category.extensions.map((ext) => (
          <span
            key={ext}
            className="flex h-6 items-center gap-1 rounded-full bg-[var(--hv)] pl-2 pr-1 text-xs text-[var(--tx)]"
          >
            {ext}
            <button
              aria-label={t('filter.removeExtension', { ext })}
              onClick={() => store().removeExtension(category.id, ext)}
              className="flex h-4 w-4 items-center justify-center rounded-full hover:bg-[var(--bd)]"
            >
              <X size={10} aria-hidden />
            </button>
          </span>
        ))}
        <input
          value={text}
          aria-label={t('settings.categoryExtensionAdd')}
          aria-invalid={note?.kind === 'invalid'}
          placeholder={t('settings.categoryExtensionAdd')}
          spellCheck={false}
          onChange={(e) => {
            setText(e.target.value)
            setNote(null)
          }}
          onKeyDown={(e) => {
            e.stopPropagation()
            // 한글 조합 중에는 확정하지 않는다.
            if (e.nativeEvent.isComposing || e.keyCode === 229) return
            if (e.key === 'Enter' || e.key === ',' || e.key === ';' || e.key === ' ') {
              e.preventDefault()
              submit()
            }
          }}
          className="h-6 w-28 rounded-md border border-[var(--bd)] bg-[var(--bg)] px-2 text-xs text-[var(--tx)] outline-none placeholder:text-[var(--mu)] focus:border-[var(--ac)]"
        />
      </div>
      {note && (
        <p
          role="status"
          className={`mt-1.5 text-xs ${note.kind === 'invalid' ? 'text-[var(--dg)]' : 'text-[var(--mu)]'}`}
        >
          {note.kind === 'exists' && t('settings.categoryExtensionExists', { ext: note.ext ?? '' })}
          {note.kind === 'duplicate' &&
            t('settings.categoryExtensionDuplicate', {
              ext: note.ext ?? '',
              name: note.other ?? ''
            })}
          {note.kind === 'invalid' && t('filter.extensionInvalid')}
        </p>
      )}
    </div>
  )
}

/** 설정 "파일 카테고리": 필터 드롭다운이 쓰는 카테고리별 확장자를 편집한다. 아이콘·썸네일 분류와는 무관하다(E8). */
export function FileCategorySettings(): React.JSX.Element {
  const t = useT()
  const all = useAllCategories()
  const [freshId, setFreshId] = useState<string | null>(null)

  const restoreAll = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: t('settings.categoryRestoreAllTitle'),
      message: t('settings.categoryRestoreAllMessage'),
      confirmLabel: t('settings.categoryRestoreAll')
    })
    if (ok) useFileCategoryStore.getState().restoreAllDefaults()
  }

  return (
    <section>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--mu)]">
        {t('settings.categories')}
      </h3>
      <p className="mb-3 text-xs text-[var(--mu)]">{t('settings.categoriesHint')}</p>
      <div className="flex flex-col gap-2">
        {all.map((c) => (
          <CategoryCard
            key={c.id}
            category={c}
            fresh={c.id === freshId}
            onSettled={() => setFreshId(null)}
            all={all}
          />
        ))}
      </div>
      <div className="mt-3 flex gap-2">
        <button
          className={btn}
          onClick={() =>
            setFreshId(useFileCategoryStore.getState().addCustom(t('settings.categoryNewName')))
          }
        >
          <Plus size={12} aria-hidden /> {t('settings.categoryAdd')}
        </button>
        <button className={btn} onClick={() => void restoreAll()}>
          <RotateCcw size={12} aria-hidden /> {t('settings.categoryRestoreAll')}
        </button>
      </div>
    </section>
  )
}
