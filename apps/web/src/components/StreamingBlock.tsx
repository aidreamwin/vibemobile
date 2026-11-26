import type { Stream } from '../lib/store'
import Markdown, { type MarkdownProps } from './Markdown'

/** Renders the live delta buffer for an item that is still streaming. */
export default function StreamingBlock({
  stream,
  cwd,
  onOpenFile,
}: {
  stream: Stream
} & Pick<MarkdownProps, 'cwd' | 'onOpenFile'>) {
  // Only agent prose is Markdown. Reasoning is prose too, but it is rendered
  // verbatim today; command output never is — shell output is full of `#`,
  // `*` and `<`, which Markdown would silently reformat or swallow.
  if (stream.channel === 'commandOutput') {
    return (
      <pre className="scroll-x max-h-80 px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre text-foreground/90">
        {stream.text}
      </pre>
    )
  }

  if (stream.channel === 'reasoning') {
    return (
      <div className="text-[13px] text-muted-foreground italic">
        <pre className="scroll-x whitespace-pre-wrap">{stream.text}</pre>
      </div>
    )
  }

  return (
    <div className="caret text-foreground">
      <Markdown text={stream.text} cwd={cwd} onOpenFile={onOpenFile} />
    </div>
  )
}
