import { useLayoutEffect, useRef, useState } from 'react'
import { resizeColumnWidths } from '../../lib/workbench'

type Axis = 'column' | 'row'

export function columnTracks(widths: number[]): string {
  return widths.map((width) => `minmax(0, ${width}fr)`).join(' var(--workbench-divider-size) ')
}

export default function WorkbenchSplitDivider({
  axis,
  column,
  onSave,
}: {
  axis: Axis | 'auto'
  column?: { index: number; widths: number[] }
  onSave: (ratio: number | null) => void
}) {
  const ref = useRef<HTMLHRElement>(null)
  const drag = useRef<{ pointerId: number; offset: number; ratio: number | null } | null>(null)
  const [orientation, setOrientation] = useState<Axis>(axis === 'auto' ? 'column' : axis)
  const [position, setPosition] = useState(50)
  const variable = column
    ? '--workbench-live-columns'
    : axis === 'auto'
      ? '--workbench-live-ratio'
      : '--workbench-live-' + axis

  function measure() {
    const divider = ref.current
    const parent = divider?.parentElement
    if (!divider || !parent) return null
    const direction =
      axis === 'auto'
        ? getComputedStyle(parent).getPropertyValue('--workbench-split-axis').trim() === 'row'
          ? 'row'
          : 'column'
        : axis
    const bounds = parent.getBoundingClientRect()
    const handle = divider.getBoundingClientRect()
    if (column) {
      const first = parent.querySelector(`[data-slot="${column.index}"]`)?.getBoundingClientRect()
      const second = parent.querySelector(`[data-slot="${column.index + 1}"]`)?.getBoundingClientRect()
      if (!first || !second) return null
      const size = second.right - first.left - handle.width
      return { direction, origin: first.left, handle, size, ratio: size > 0 ? (handle.left - first.left) / size : 0.5 }
    }
    const size = direction === 'column' ? bounds.width - handle.width : bounds.height - handle.height
    const offset = direction === 'column' ? handle.left - bounds.left : handle.top - bounds.top
    return {
      direction,
      origin: direction === 'column' ? bounds.left : bounds.top,
      handle,
      size,
      ratio: size > 0 ? offset / size : 0.5,
    }
  }

  useLayoutEffect(() => {
    const parent = ref.current?.parentElement
    if (!parent) return
    const update = () => {
      const geometry = measure()
      if (geometry) {
        setOrientation(geometry.direction)
        setPosition(Math.round(geometry.ratio * 100))
      }
    }
    const observer = new ResizeObserver(update)
    observer.observe(parent)
    for (const pane of parent.querySelectorAll('[data-slot]')) observer.observe(pane)
    update()
    return () => {
      observer.disconnect()
      parent.style.removeProperty(variable)
    }
  }, [axis, variable, column?.index, column?.widths])

  function clear() {
    drag.current = null
    ref.current?.parentElement?.style.removeProperty(variable)
  }

  return (
    <hr
      ref={ref}
      tabIndex={0}
      data-divider={axis}
      style={column ? { gridColumn: column.index * 2 + 2, gridRow: 1 } : undefined}
      aria-label={
        column
          ? `调整分屏 ${column.index + 1} 与 ${column.index + 2} 宽度`
          : axis === 'auto'
            ? '调整分屏比例'
            : axis === 'column'
              ? '调整左右分屏比例'
              : '调整上下分屏比例'
      }
      aria-orientation={orientation === 'column' ? 'vertical' : 'horizontal'}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={position}
      title="拖动调整分屏比例，双击恢复默认比例"
      className="workbench-divider"
      onPointerDown={(event) => {
        const geometry = measure()
        if (event.button !== 0 || !event.isPrimary || drag.current || !geometry) return
        drag.current = {
          pointerId: event.pointerId,
          offset:
            geometry.direction === 'column'
              ? event.clientX - geometry.handle.left
              : event.clientY - geometry.handle.top,
          ratio: null,
        }
        event.preventDefault()
        event.currentTarget.focus({ preventScroll: true })
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        const current = drag.current
        if (!current || event.pointerId !== current.pointerId) return
        const geometry = measure()
        if (!geometry || geometry.size <= 0) return
        const offset = (geometry.direction === 'column' ? event.clientX : event.clientY) - geometry.origin
        current.ratio = Math.max(0, Math.min(1, (offset - current.offset) / geometry.size))
        event.currentTarget.parentElement?.style.setProperty(
          variable,
          column ? columnTracks(resizeColumnWidths(column.widths, column.index, current.ratio)) : String(current.ratio),
        )
      }}
      onPointerUp={(event) => {
        const current = drag.current
        if (!current || current.pointerId !== event.pointerId) return
        if (current.ratio !== null) onSave(current.ratio)
        clear()
      }}
      onPointerCancel={clear}
      onLostPointerCapture={clear}
      onDoubleClick={() => onSave(null)}
      onKeyDown={(event) => {
        const geometry = measure()
        if (!geometry) return
        const start = geometry.direction === 'column' ? 'ArrowLeft' : 'ArrowUp'
        const end = geometry.direction === 'column' ? 'ArrowRight' : 'ArrowDown'
        let ratio = geometry.ratio
        if (event.key === start) ratio -= 0.05
        else if (event.key === end) ratio += 0.05
        else if (event.key === 'Home') ratio = 0
        else if (event.key === 'End') ratio = 1
        else return
        event.preventDefault()
        onSave(Math.max(0, Math.min(1, ratio)))
      }}
    />
  )
}
