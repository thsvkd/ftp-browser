import type { ViewMode } from '@renderer/stores/useSettingsStore'

interface ViewModeToggleProps {
  mode: ViewMode
  onChange: (mode: ViewMode) => void
}

const MODES: Array<{ value: ViewMode; icon: string; label: string }> = [
  { value: 'list', icon: '☰', label: 'List view' },
  { value: 'grid', icon: '☷', label: 'Grid view' },
  { value: 'gallery', icon: '\u{1F5BC}', label: 'Gallery view (images only)' }
]

export function ViewModeToggle({ mode, onChange }: ViewModeToggleProps): React.JSX.Element {
  return (
    <div className="flex items-center gap-0.5">
      {MODES.map((m) => {
        const active = m.value === mode
        return (
          <button
            key={m.value}
            type="button"
            onClick={() => onChange(m.value)}
            title={m.label}
            aria-label={m.label}
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
