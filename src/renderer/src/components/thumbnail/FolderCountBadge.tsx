import { useT } from '@renderer/i18n'

interface FolderCountBadgeProps {
  count: number
}

/**
 * Bottom-right overlay showing how many items a gallery folder contains.
 * Hidden for non-positive counts (e.g. cache rows from before counts existed).
 */
export function FolderCountBadge({ count }: FolderCountBadgeProps): React.JSX.Element | null {
  const t = useT()
  if (count <= 0) return null
  return (
    <span
      className="mono absolute bottom-1.5 right-1.5 rounded-full bg-black/55 px-1.5 text-[10px] font-semibold leading-4 text-white"
      title={t('common.itemCount', { count })}
    >
      {count}
    </span>
  )
}
