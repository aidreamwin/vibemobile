import { useEffect, useState } from 'react'

type State = { status: 'loading' } | { status: 'ready'; svg: string } | { status: 'error'; message: string }

/**
 * Mermaid is a parser, a layout engine and a dozen diagram types — several
 * hundred kB that a transcript without a diagram must never download. The
 * import is dynamic and shared by every diagram on the page; `initialize` runs
 * once, on the first one.
 *
 * A failed load is not cached: the next diagram retries instead of leaving a
 * broken page for the rest of the session.
 */
let loader: Promise<typeof import('mermaid')> | null = null

function load() {
  loader ??= import('mermaid')
    .then((mod) => {
      mod.default.initialize({
        startOnLoad: false,
        /* `strict` is mermaid's default, written out because this renders
           agent-authored text: it drops scripts, event handlers and links. */
        securityLevel: 'strict',
        /* Without this a parse error injects an error SVG into the document,
           on top of the message we render ourselves. */
        suppressErrorRendering: true,
        theme: 'dark',
        fontFamily: 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        flowchart: { useMaxWidth: false },
        sequence: { useMaxWidth: false },
        class: { useMaxWidth: false },
        state: { useMaxWidth: false },
        er: { useMaxWidth: false },
        gantt: { useMaxWidth: false },
      })
      return mod
    })
    .catch((err) => {
      loader = null
      throw err
    })
  return loader
}

/** Mermaid writes into a live document, so it can only run in an effect. */
let nextId = 0

export default function Mermaid({ code }: { code: string }) {
  const [state, setState] = useState<State>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    const id = `vm-mermaid-${++nextId}`
    load()
      .then(({ default: mermaid }) => (cancelled ? null : mermaid.render(id, code)))
      .then((result) => {
        if (!cancelled && result) setState({ status: 'ready', svg: result.svg })
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ status: 'error', message: describe(err) })
      })
    return () => {
      cancelled = true
    }
  }, [code])

  if (state.status === 'loading') {
    return <div className="px-3 py-6 text-center text-[12px] text-muted-foreground/70">图表绘制中…</div>
  }

  if (state.status === 'error') {
    return (
      <div className="px-3 py-2.5">
        <div className="text-[12px] text-warning">图表渲染失败</div>
        <div className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground">
          {state.message}
        </div>
      </div>
    )
  }

  return (
    /* Natural width and a scrollbar rather than `max-width: 100%`: mermaid's
       own shrink-to-fit turns a six-node flowchart into unreadable 6px text on
       a phone. */
    <div
      className="scroll-x px-3 py-3 [&_svg]:mx-auto [&_svg]:h-auto"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid sanitizes its own SVG under securityLevel 'strict'
      dangerouslySetInnerHTML={{ __html: state.svg }}
    />
  )
}

function describe(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  // Mermaid prefixes parse errors with a stack and appends the whole diagram;
  // the useful part is the first line ("Parse error on line 2: ...").
  const first = message.split('\n').find((line) => line.trim())
  return (first ?? message).slice(0, 300)
}
