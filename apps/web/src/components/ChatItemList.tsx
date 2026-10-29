import { useMemo } from 'react'
import type { AgentItem } from '@vibemobile/protocol'
import { Download } from 'lucide-react'
import type { Stream, TurnTime } from '../lib/store'
import { formatClock } from '../lib/format'
import { conversationText } from '../lib/exportMarkdown'
import { isItemHidden, useDisplayPrefs } from '../lib/displayPrefs'
import { collapseUnansweredRetries } from '../lib/retry'
import type { FileRef } from '../lib/fileLink'
import { turnIdOfItem } from '../lib/turnIndex'
import CopyButton from './CopyButton'
import ItemCard from './ItemCard'
import StreamingBlock from './StreamingBlock'

/**
 * The rendered transcript.
 *
 * Memoised on the item list and stream buffers: a fresh map on every delta
 * frame would re-parse the whole transcript.
 *
 * Items are grouped back into turns here (the store keeps them flat) so each
 * turn can carry its own tiny export button. The grouping uses the same order
 * the transcript is rendered in; a turn id change is a boundary, and an item
 * whose turn is not known yet stays with the previous group.
 */
export default function ChatItemList({
  items,
  streams,
  turnTimes,
  cwd,
  threadId,
  running,
  onOpenFile,
  onDownloadTurn,
}: {
  items: AgentItem[]
  streams: Record<string, Stream>
  /** When each turn began and ended, keyed by turn id. */
  turnTimes: Record<string, TurnTime>
  cwd?: string
  threadId: string
  /** A turn is still executing; its actions would act on a moving target. */
  running: boolean
  onOpenFile: (ref: FileRef) => void
  onDownloadTurn: (turnId: string, items: AgentItem[]) => void
}) {
  const prefs = useDisplayPrefs((state) => state.prefs)

  const rendered = useMemo(() => {
    const groups: { turnId: string; items: AgentItem[] }[] = []
    for (const item of collapseUnansweredRetries(items, streams)) {
      const turnId = turnIdOfItem(threadId, item.id) ?? groups.at(-1)?.turnId ?? ''
      const last = groups.at(-1)
      if (last && last.turnId === turnId) last.items.push(item)
      else groups.push({ turnId, items: [item] })
    }

    const renderItem = (item: AgentItem) => {
      // While an item streams, its buffer holds the text; the item itself may
      // still be empty. Show both, but never duplicate.
      const stream = streams[item.id]
      const hasStream = Boolean(stream)
      const reasoningStream = item.kind === 'reasoning' && stream?.channel === 'reasoning'
      const isEmptyMessage = item.kind === 'message' && item.text.length === 0
      const isUser = item.kind === 'message' && item.role === 'user'
      // The message's own clock, never the turn's — a steer or a queued push is
      // dated when it was typed. No recorded time means no clock at all:
      // showing the turn's start here would be a wrong answer, not a guess
      // worth making.
      const sentAt = item.kind === 'message' && item.role === 'user' ? (item.at ?? null) : null
      return (
        <div key={item.id}>
          {(!hasStream || !isEmptyMessage) && (
            <ItemCard
              item={item}
              streamText={reasoningStream ? stream.text : undefined}
              sentAt={sentAt}
              cwd={cwd}
              onOpenFile={onOpenFile}
            />
          )}
          {hasStream && !reasoningStream && (
            <StreamingBlock itemId={item.id} isUser={isUser} cwd={cwd} onOpenFile={onOpenFile} />
          )}
        </div>
      )
    }

    // Display preferences hide cards but not data: the actions below keep the
    // full turn, so an export or copy is unaffected by what is on screen.
    const visibleGroups = groups
      .map((group) => ({ group, visible: group.items.filter((item) => !isItemHidden(item.kind, prefs)) }))
      .filter((entry) => entry.visible.length > 0)

    return visibleGroups.map(({ group, visible }, index) => {
      // The last turn is still being written while `running`: offering export
      // or copy there would capture a partial answer, so the actions appear
      // only once it has finished.
      const inProgress = running && index === visibleGroups.length - 1
      return (
        <div key={group.items[0]?.id ?? group.turnId}>
          <div className="space-y-4">{visible.map(renderItem)}</div>
          {group.turnId && !inProgress && (
            // After the turn's last card, not above it: the export belongs to
            // the answer that just ended, and the top of a turn is where the
            // reading starts.
            <TurnActions
              items={group.items}
              streams={streams}
              time={turnTimes[group.turnId]?.completedAt ?? null}
              onDownload={() => onDownloadTurn(group.turnId, group.items)}
            />
          )}
        </div>
      )
    })
  }, [items, streams, turnTimes, cwd, threadId, running, onOpenFile, onDownloadTurn, prefs])

  return <div className="space-y-4 pb-4">{rendered}</div>
}

/**
 * Copy the dialogue of one turn, and export the whole turn.
 *
 * Kept as its own component so the "copied" checkmark has somewhere to live:
 * the item list re-renders on every delta, and local state here survives that.
 */
function TurnActions({
  items,
  streams,
  time,
  onDownload,
}: {
  items: AgentItem[]
  streams: Record<string, Stream>
  /** When this turn ended; null when the backend did not report it. */
  time: number | null
  onDownload: () => void
}) {
  const button =
    'inline-flex size-7 items-center justify-center rounded-md text-muted-foreground/70 active:bg-secondary'
  return (
    <div className="mt-0.5 flex items-center justify-start gap-0.5">
      <CopyButton
        // Only messages: reasoning, commands, tool calls and diffs are
        // deliberately left out of what lands on the clipboard.
        getText={() => conversationText(items, streams)}
        label="复制本轮对话"
        className={button}
      />
      <button
        type="button"
        onClick={onDownload}
        title="下载本轮 Markdown"
        aria-label="下载本轮 Markdown"
        className={button}
      >
        <Download aria-hidden="true" className="size-3.5" strokeWidth={1.7} />
      </button>
      {time !== null && (
        <span className="ml-1 text-[11px] leading-none text-muted-foreground/70">{formatClock(time)}</span>
      )}
    </div>
  )
}
