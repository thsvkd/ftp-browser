/**
 * 컨텍스트 메뉴 좌표 보정.
 *
 * 클릭 좌표를 그대로 쓰면 화면 가장자리에서 메뉴가 잘린다. 메뉴 높이는 상태에
 * 따라(입력창 전환, 다중 선택, Upload/Download 노출 여부) 달라지므로 상수로 풀 수
 * 없고, 렌더 후 실측한 크기를 받아 여기서 보정한다.
 *
 * DOM에 손대지 않는 순수 계산이라 `lib/localPath.ts`·`lib/remoteDrop.ts`와 같은
 * 위치에 두고 로컬·원격 두 메뉴가 공유한다.
 */

/** 메뉴와 뷰포트 가장자리 사이에 남기는 최소 여백(px). */
export const MENU_VIEWPORT_MARGIN = 4

/** 우클릭 지점. 보정 전의 앵커 좌표다. */
export interface MenuAnchor {
  x: number
  y: number
}

/** 실측한 메뉴 크기. */
export interface MenuSize {
  width: number
  height: number
}

/** 보정 기준이 되는 뷰포트 크기. */
export interface ViewportSize {
  width: number
  height: number
}

/** 보정된 최종 좌표. `position: fixed`의 left/top에 그대로 넣는다. */
export interface MenuPlacement {
  left: number
  top: number
}

/**
 * 한 축의 좌표를 뷰포트 안으로 넣는다. 가로·세로가 완전히 같은 규칙을 따른다.
 *
 * 1. 끝을 넘치면 앵커를 기준으로 반대 방향으로 뒤집는다(데스크톱 관례).
 *    밀어넣지 않는 이유는 메뉴가 커서 아래에 깔려 항목이 가려지기 때문이다.
 * 2. 뒤집어도 시작 쪽을 넘치면 여백으로 클램프한다. 메뉴가 뷰포트보다 큰 경우도
 *    이 규칙에 흡수되어 시작 정렬이 된다.
 */
function clampAxis(anchor: number, size: number, viewportExtent: number): number {
  let start = anchor
  // `>=`가 아니라 `>`다. 여백에 딱 맞게 들어가는 메뉴는 뒤집지 않는다.
  if (start + size > viewportExtent - MENU_VIEWPORT_MARGIN) {
    start = anchor - size
  }
  if (start < MENU_VIEWPORT_MARGIN) {
    start = MENU_VIEWPORT_MARGIN
  }
  return start
}

/** 앵커·메뉴 크기·뷰포트 크기로부터 잘리지 않는 메뉴 좌표를 계산한다. */
export function clampMenuPosition(
  anchor: MenuAnchor,
  size: MenuSize,
  viewport: ViewportSize
): MenuPlacement {
  return {
    left: clampAxis(anchor.x, size.width, viewport.width),
    top: clampAxis(anchor.y, size.height, viewport.height)
  }
}
