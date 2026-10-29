import { memo, useMemo } from 'react'
import type { FileChange } from '@vibemobile/protocol'

interface DiffLine {
  kind: 'add' | 'del' | 'hunk' | 'meta' | 'context'
  text: string
}

/**
 * Line-level classification. We colour by prefix rather than running a real
 * parser — it is what every mobile diff viewer does, and it stays O(n) on a
 * phone.
 */
function classify(line: string): DiffLine['kind'] {
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta'
  if (line.startsWith('diff ') || line.startsWith('index ')) return 'meta'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'context'
}

const lineClass: Record<DiffLine['kind'], string> = {
  add: 'bg-success/15 text-success border-l-2 border-success',
  del: 'bg-destructive/15 text-destructive border-l-2 border-destructive',
  hunk: 'bg-primary/15 text-primary border-l-2 border-primary/60 font-semibold',
  meta: 'text-muted-foreground bg-secondary',
  context: 'text-muted-foreground',
}

function DiffBody({ text }: { text: string }) {
  const lines = useMemo<DiffLine[]>(() => text.split('\n').map((raw) => ({ kind: classify(raw), text: raw })), [text])

  if (!text.trim()) {
    return <div className="px-3 py-2 text-[12px] text-muted-foreground/70">（无差异内容）</div>
  }

  return (
    <pre className="scroll-x max-h-96 font-mono text-[11px] leading-[1.5]">
      {lines.map((line, i) => (
        <div key={i} className={`px-3 whitespace-pre ${lineClass[line.kind]}`}>
          {line.text || ' '}
        </div>
      ))}
    </pre>
  )
}

const changeLabel: Record<FileChange['kind'], string> = {
  add: '新增',
  delete: '删除',
  update: '修改',
}

const DiffView = memo(function DiffView({ changes }: { changes: FileChange[] }) {
  if (!changes.length) {
    return <div className="px-3 py-2 text-[12px] text-muted-foreground/70">（无文件变更）</div>
  }
  return (
    <div className="divide-y divide-border">
      {changes.map((change, i) => (
        <div key={`${change.path}-${i}`}>
          <div className="flex items-center gap-2 bg-secondary px-3 py-1.5">
            <span className="rounded bg-raised px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {changeLabel[change.kind]}
            </span>
            <span className="truncate font-mono text-[11px] text-foreground/90">{change.path}</span>
            {change.movePath && (
              <span className="truncate font-mono text-[11px] text-muted-foreground">→ {change.movePath}</span>
            )}
          </div>
          <DiffBody text={change.diff} />
        </div>
      ))}
    </div>
  )
})

export default DiffView

/** Render a whole unified diff, split into per-file sections. */
export const UnifiedDiff = memo(function UnifiedDiff({ diff }: { diff: string }) {
  const files = useMemo(() => {
    if (!diff.trim()) return []
    const sections: { header: string; body: string }[] = []
    // `diff --git a/x b/x` starts each file section.
    const parts = diff.split(/^(?=diff --git )/m).filter(Boolean)
    for (const part of parts) {
      const newline = part.indexOf('\n')
      sections.push({
        header: newline === -1 ? part : part.slice(0, newline),
        body: newline === -1 ? '' : part.slice(newline + 1),
      })
    }
    return sections
  }, [diff])

  if (!files.length) {
    return <div className="px-3 py-4 text-center text-[12px] text-muted-foreground/70">本次没有文件改动</div>
  }

  return (
    <div className="divide-y divide-border">
      {files.map((file, i) => (
        <div key={i}>
          <div className="truncate bg-secondary px-3 py-1.5 font-mono text-[11px] text-foreground/90">
            {file.header.replace(/^diff --git /, '')}
          </div>
          <DiffBody text={file.body} />
        </div>
      ))}
    </div>
  )
})
