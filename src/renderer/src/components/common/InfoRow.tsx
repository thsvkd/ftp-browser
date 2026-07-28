/**
 * One label/value line in a properties dialog. Renders nothing for an empty
 * value so callers can list every field without guarding each one.
 */
export function InfoRow({
  label,
  value
}: {
  label: string
  value: string | undefined
}): React.JSX.Element | null {
  if (!value) return null
  return (
    <div className="flex items-start py-1.5">
      <span className="w-24 shrink-0 text-gray-500">{label}</span>
      <span className="break-all text-gray-800">{value}</span>
    </div>
  )
}
