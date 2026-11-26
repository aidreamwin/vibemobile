import { useLayoutEffect, useRef, useState } from 'react'

interface SplitDrag {
  pointerId: number
  grabOffset: number
  ratio: number | null
}

function isStacked(container: HTMLElement) {
  return getComputedStyle(container).flexDirection === 'column'
}

export default function WorkbenchSplitDivider({
  mixed,
  ratioPaneFirst,
  ratio,
  onPreview,
  onSave,
}: {
  mixed: boolean
  ratioPaneFirst: boolean
  ratio: number | null
  onPreview: (ratio: number | null) => void
  onSave: (ratio: number | null) => void
}) {
  const ref = useRef<HTMLHRElement>(null)
  const drag = useRef<SplitDrag | null>(null)
  const [stacked, setStacked] = useState(false)
  const paneRatio = ratio ?? (mixed ? (stacked ? 0.43 : 0.32) : 0.5)
  const firstPaneRatio = ratioPaneFirst ? paneRatio : 1 - paneRatio

  function toPaneRatio(firstRatio: number) {
    const bounded = Math.max(0, Math.min(1, firstRatio))
    return ratioPaneFirst ? bounded : 1 - bounded
  }

  useLayoutEffect(() => {
    const container = ref.current?.parentElement
    if (!container) return
    const measure = () => setStacked(isStacked(container))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => {
      observer.disconnect()
      container.style.removeProperty('--workbench-live-ratio')
    }
  }, [])

  function cancelDrag(pointerId: number) {
    if (drag.current?.pointerId !== pointerId) return
    drag.current = null
    onPreview(null)
  }

  return (
    <hr
      ref={ref}
      tabIndex={0}
      aria-label="调整分屏比例"
      aria-orientation={stacked ? 'horizontal' : 'vertical'}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(firstPaneRatio * 100)}
      aria-valuetext={mixed ? `Agent 占 ${Math.round(paneRatio * 100)}%` : undefined}
      className="workbench-divider"
      title="拖动调整分屏比例，双击恢复默认比例"
      onPointerDown={(event) => {
        if (event.button !== 0 || drag.current) return
        const divider = event.currentTarget
        const bounds = divider.getBoundingClientRect()
        const grabOffset = stacked ? event.clientY - bounds.top : event.clientX - bounds.left
        drag.current = { pointerId: event.pointerId, grabOffset, ratio: null }
        event.preventDefault()
        divider.focus({ preventScroll: true })
        divider.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        const current = drag.current
        const divider = event.currentTarget
        const container = divider.parentElement
        if (!current || current.pointerId !== event.pointerId || !container) return
        const bounds = container.getBoundingClientRect()
        const usableSize = stacked ? bounds.height - divider.offsetHeight : bounds.width - divider.offsetWidth
        if (usableSize <= 0) return
        const position = stacked ? event.clientY - bounds.top : event.clientX - bounds.left
        current.ratio = toPaneRatio((position - current.grabOffset) / usableSize)
        onPreview(current.ratio)
      }}
      onPointerUp={(event) => {
        const current = drag.current
        if (current?.pointerId !== event.pointerId) return
        drag.current = null
        if (current.ratio !== null) onSave(current.ratio)
        onPreview(null)
      }}
      onPointerCancel={(event) => cancelDrag(event.pointerId)}
      onLostPointerCapture={(event) => cancelDrag(event.pointerId)}
      onDoubleClick={() => onSave(null)}
      onKeyDown={(event) => {
        const towardStart = stacked ? 'ArrowUp' : 'ArrowLeft'
        const towardEnd = stacked ? 'ArrowDown' : 'ArrowRight'
        let next: number
        if (event.key === towardStart) next = firstPaneRatio - 0.05
        else if (event.key === towardEnd) next = firstPaneRatio + 0.05
        else if (event.key === 'Home') next = 0
        else if (event.key === 'End') next = 1
        else return
        event.preventDefault()
        onSave(toPaneRatio(next))
      }}
    />
  )
}
