import type { ViewMode } from '@renderer/stores/useSettingsStore'
import { useT, type MessageKey } from '@renderer/i18n'

interface ViewModeToggleProps {
  mode: ViewMode
  onChange: (mode: ViewMode) => void
}

const MODES: Array<{ value: ViewMode; icon: string; label: MessageKey }> = [
  { value: 'list', icon: '☰', label: 'view.list' },
  { value: 'grid', icon: '☷', label: 'view.grid' },
  { value: 'gallery', icon: '\u{1F5BC}', label: 'view.gallery' }
]

export function ViewModeToggle({ mode, onChange }: ViewModeToggleProps): React.JSX.Element {
  const t = useT()
  return (
    <div className="flex items-center gap-0.5">
      {MODES.map((m) => {
        const active = m.value === mode
        return (
          <button
            key={m.value}
            type="button"
            onClick={() => onChange(m.value)}
            title={t(m.label)}
            aria-label={t(m.label)}
            aria-pressed={active}
            className={`rounded px-1.5 py-0.5 text-xs ${
              active ? 'bg-gray-300 text-gray-800' : 'text-gray-500 hover:bg-gray-200'
            }`}
          >
            {m.icon}
          </button>
        )
      })}
    </div>
  )
}
