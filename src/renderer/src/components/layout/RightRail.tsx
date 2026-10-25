import { useT } from '@renderer/i18n'
import { InfoPanel } from '@renderer/components/shelf/InfoPanel'

/**
 * 오른쪽 레일: 이제 정보만 쓴다(6번 스펙 F1). 선반은 하단 도크(`ShelfDock`)로 옮겼고,
 * 레일 토글 소스는 설정의 `showRail`이다(F8).
 */
export function RightRail(): React.JSX.Element {
  const t = useT()
  return (
    <aside
      role="region"
      aria-label={t('rail.info')}
      data-region="info"
      className="flex w-[288px] shrink-0 flex-col border-l border-[var(--bd)] bg-[var(--sb)]"
    >
      <div className="slide flex min-h-0 flex-1 flex-col">
        <InfoPanel />
      </div>
    </aside>
  )
}
