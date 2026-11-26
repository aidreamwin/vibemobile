import { useState } from 'react'
import { FileImage, LoaderCircle } from 'lucide-react'
import { runnerPath } from '../lib/runner'

/** Native image decoding, without reading raster files into JavaScript. */
export default function ImageFilePreview({
  path,
  svgText,
  refresh = false,
  desktop = false,
}: {
  path: string
  svgText?: string
  refresh?: boolean
  desktop?: boolean
}) {
  const [revision, setRevision] = useState(() => (refresh ? Date.now() : 0))
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null)
  const [failed, setFailed] = useState(false)
  const [actualSize, setActualSize] = useState(false)
  const query = new URLSearchParams({ path })
  if (revision) query.set('v', String(revision))
  // SVG stays an image context even when the source contains scripts or links.
  const src =
    svgText === undefined
      ? runnerPath(`/api/files/image?${query}`)
      : `data:image/svg+xml,${encodeURIComponent(svgText)}`

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden" aria-label="图片预览">
      <div className="relative min-h-0 flex-1 overflow-auto overscroll-contain">
        {failed ? (
          <div className="grid h-full place-content-center justify-items-center gap-3 px-4 text-center text-sm text-muted-foreground">
            <FileImage aria-hidden="true" className="size-9 opacity-50" strokeWidth={1.4} />
            <p role="alert">图片加载失败</p>
            <button
              type="button"
              onClick={() => {
                setFailed(false)
                setDimensions(null)
                setRevision(Date.now())
              }}
              className="rounded-lg border border-border px-4 py-2 text-sm text-foreground hover:bg-secondary"
            >
              重试
            </button>
          </div>
        ) : (
          <div
            className={
              actualSize
                ? 'grid min-h-full min-w-full w-max place-items-center p-4'
                : 'flex h-full items-center justify-center p-4'
            }
          >
            {!dimensions && (
              <div role="status" className="absolute inset-0 grid place-content-center text-sm text-muted-foreground">
                <span className="flex items-center gap-2">
                  <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
                  正在加载图片…
                </span>
              </div>
            )}
            <img
              key={revision}
              src={src}
              alt={path.split(/[\\/]/).at(-1) || '图片'}
              decoding="async"
              draggable={false}
              onLoad={(event) =>
                setDimensions({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })
              }
              onError={() => setFailed(true)}
              className={`${actualSize ? 'max-w-none' : 'max-h-full max-w-full object-contain'} ${dimensions ? '' : 'absolute opacity-0'} rounded-sm bg-[conic-gradient(var(--secondary)_25%,var(--card)_0_50%,var(--secondary)_0_75%,var(--card)_0)] bg-[length:16px_16px]`}
            />
          </div>
        )}
      </div>
      {dimensions && !failed && (
        <footer
          className={`flex shrink-0 items-center justify-between gap-2 border-t border-border bg-card/60 px-3 text-xs text-muted-foreground ${desktop ? 'min-h-8' : 'min-h-12'}`}
        >
          <span className="tabular-nums">
            {dimensions.width} × {dimensions.height}
          </span>
          <fieldset className="flex shrink-0 items-center rounded-lg bg-secondary p-0.5">
            <legend className="sr-only">图片缩放</legend>
            {([false, true] as const).map((mode) => (
              <button
                key={String(mode)}
                type="button"
                aria-pressed={actualSize === mode}
                onClick={() => setActualSize(mode)}
                className={`${desktop ? 'h-6' : 'h-9'} rounded-md px-2.5 text-xs hover:text-foreground aria-pressed:bg-raised aria-pressed:text-foreground`}
              >
                {mode ? '实际大小' : '适应窗口'}
              </button>
            ))}
          </fieldset>
        </footer>
      )}
    </section>
  )
}
