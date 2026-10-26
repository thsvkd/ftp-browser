import { useT } from '@renderer/i18n'
import { InfoPanel } from '@renderer/components/shelf/InfoPanel'

/**
 * 오른쪽 레일: 이제 정보만 쓴다(6번 스펙 F1). 선반은 하단 도크(`ShelfDock`)로 옮겼고,
 * 레일의 켬/끊음 소스는 `useLayoutStore.right`다(F8, §9-1).
 */
export function RightRail(): React.JSX.Element {
  const t = useT()
  return (
    <aside
      role="region"
      aria-label={t('rail.info')}
      data-region="info"
      className="flex w-full shrink-0 flex-col border-l border-[var(--bd)] bg-[var(--sb)]"
    >
      <div className="slide flex min-h-0 flex-1 flex-col">
        <InfoPanel />
      </div>
    </aside>
  )
}
