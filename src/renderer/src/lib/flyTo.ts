// "모으기" 동작: 화면의 썸네일이 대상(선반, 활동 알약)으로 날아간다. 동작 줄이기 설정이면 생략한다.

export interface FlySource {
  rect: DOMRect
  src: string | null
}

export const reducedMotion = (): boolean =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * 화면에 있는 경로들의 출발점(타일·행은 `data-path`를 갖는다). 많아야 8개. `root` 안에서 찾는다:
 * 분할 보기에서는 탐색기가 자기 목록을 넘겨 다른 패널의 같은 경로를 집지 않는다(split-view P9).
 */
export function sourcesFor(paths: readonly string[], root: ParentNode = document): FlySource[] {
  const out: FlySource[] = []
  for (const p of paths.slice(0, 8)) {
    const el = root.querySelector(`[data-path="${CSS.escape(p)}"]`)
    if (!el) continue
    const img = el.querySelector('img')
    out.push({ rect: (img ?? el).getBoundingClientRect(), src: img?.getAttribute('src') ?? null })
  }
  return out
}

export function flyTo(
  sources: readonly FlySource[],
  target: Element | null,
  onDone?: () => void
): void {
  if (!target || !sources.length || reducedMotion()) {
    onDone?.()
    return
  }
  const to = target.getBoundingClientRect()
  let left = sources.length
  sources.forEach((s, i) => {
    const d = document.createElement('div')
    const w = Math.min(s.rect.width, 120)
    const h = Math.min(s.rect.height, 90)
    Object.assign(d.style, {
      position: 'fixed',
      left: `${s.rect.left + (s.rect.width - w) / 2}px`,
      top: `${s.rect.top + (s.rect.height - h) / 2}px`,
      width: `${w}px`,
      height: `${h}px`,
      borderRadius: '10px',
      background: s.src ? `center/cover url("${s.src}")` : 'var(--sh)',
      boxShadow: 'var(--shadow)',
      border: '2px solid var(--sf)',
      zIndex: '9999',
      pointerEvents: 'none'
    })
    document.body.appendChild(d)
    const dx = to.left + to.width / 2 - (s.rect.left + s.rect.width / 2)
    const dy = to.top + to.height / 2 - (s.rect.top + s.rect.height / 2)
    const anim = d.animate(
      [
        { transform: 'translate(0,0) scale(1) rotate(0deg)', opacity: 1 },
        {
          transform: `translate(${dx * 0.55}px, ${dy * 0.55 - 40}px) scale(.7) rotate(${i % 2 ? 6 : -6}deg)`,
          opacity: 1,
          offset: 0.55
        },
        { transform: `translate(${dx}px, ${dy}px) scale(.25) rotate(0deg)`, opacity: 0.2 }
      ],
      { duration: 380 + i * 40, easing: 'cubic-bezier(.3,.7,.2,1)', delay: i * 25 }
    )
    anim.onfinish = (): void => {
      d.remove()
      if (--left === 0) onDone?.()
    }
  })
}
