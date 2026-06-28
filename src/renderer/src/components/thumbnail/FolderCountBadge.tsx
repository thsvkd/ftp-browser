interface FolderCountBadgeProps {
  count: number
}

/**
 * Bottom-right overlay showing how many items a gallery folder contains.
 * Hidden for non-positive counts (e.g. cache rows from before counts existed).
 */
export function FolderCountBadge({ count }: FolderCountBadgeProps): React.JSX.Element | null {
  if (count <= 0) return null
  return (
    <span
      className="absolute bottom-0 right-0 rounded-tl bg-gray-900/70 px-1 text-[10px] leading-tight text-white"
      title={`${count} ${count === 1 ? 'item' : 'items'}`}
    >
      {count}
    </span>
  )
}
