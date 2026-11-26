import { memo, useMemo } from 'react'
import type { AgentItem } from '@vibemobile/protocol'
import { Download } from 'lucide-react'
import { useStore } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import type { ChatStore, TurnTime } from '../lib/store'
import { formatClock } from '../lib/format'
import { conversationText } from '../lib/exportMarkdown'
import { isItemHidden, useDisplayPrefs } from '../lib/displayPrefs'
import { collapseUnansweredRetries } from '../lib/retry'
import type { FileRef } from '../lib/fileLink'
import CopyButton from './CopyButton'
import ItemCard from './ItemCard'
import StreamingBlock from './StreamingBlock'

const NO_REPLIES: string[] = []

interface TranscriptAppearance {
  chatStore: ChatStore
  cwd?: string
  desktop?: boolean
  onOpenFile: (ref: FileRef) => void
}

const ChatItemList = memo(function ChatItemList({
  items,
  chatStore,
  turnTimes,
  cwd,
  running,
  desktop = false,
  onOpenFile,
  onDownloadTurn,
}: {
  items: AgentItem[]
  /** When each turn began and ended, keyed by turn id. */
  turnTimes: Record<string, TurnTime>
  /** A turn is still executing; its actions would act on a moving target. */
  running: boolean
  onDownloadTurn: (turnId: string, items: AgentItem[]) => void
} & TranscriptAppearance) {
  const prefs = useDisplayPrefs((state) => state.prefs)
  const canHaveRetries = useMemo(() => items.some((item) => item.kind === 'error'), [items])
  // Grouping only needs to know whether a retry already produced a reply.
  // Once that answer exists, additional tokens affect its row alone.
  const replies = useStore(
    chatStore,
    useShallow((state) =>
      canHaveRetries ? Object.keys(state.streams).filter((id) => state.streams[id].text.trim()) : NO_REPLIES,
    ),
  )

  const visibleGroups = useMemo(() => {
    const groups: { turnId: string; items: AgentItem[] }[] = []
    const hasStreamedReply = new Set(replies)
    const { turnIdOfItem } = chatStore.getState()
    const displayItems = canHaveRetries ? collapseUnansweredRetries(items, (id) => hasStreamedReply.has(id)) : items
    for (const item of displayItems) {
      const last = groups.at(-1)
      const turnId = turnIdOfItem(item.id) ?? last?.turnId ?? ''
      if (last && last.turnId === turnId) last.items.push(item)
      else groups.push({ turnId, items: [item] })
    }

    // Display preferences hide cards but not data: the actions below keep the
    // full turn, so an export or copy is unaffected by what is on screen.
    return groups
      .map((group) => ({ group, visible: group.items.filter((item) => !isItemHidden(item.kind, prefs)) }))
      .filter((entry) => entry.visible.length > 0)
  }, [items, chatStore, canHaveRetries, replies, prefs])

  const rendered = useMemo(() => {
    return visibleGroups.map(({ group, visible }, index) => {
      // The last turn is still being written while `running`: offering export
      // or copy there would capture a partial answer, so the actions appear
      // only once it has finished.
      const inProgress = running && index === visibleGroups.length - 1
      return (
        <div key={group.items[0]?.id ?? group.turnId}>
          <div className={desktop ? 'space-y-2.5' : 'space-y-4'}>
            {visible.map((item) => (
              <TranscriptItem
                key={item.id}
                item={item}
                chatStore={chatStore}
                cwd={cwd}
                onOpenFile={onOpenFile}
                desktop={desktop}
              />
            ))}
          </div>
          {group.turnId && !inProgress && (
            // After the turn's last card, not above it: the export belongs to
            // the answer that just ended, and the top of a turn is where the
            // reading starts.
            <TurnActions
              items={group.items}
              chatStore={chatStore}
              time={turnTimes[group.turnId]?.completedAt ?? null}
              onDownload={() => onDownloadTurn(group.turnId, group.items)}
            />
          )}
        </div>
      )
    })
  }, [visibleGroups, chatStore, turnTimes, cwd, running, onOpenFile, onDownloadTurn, desktop])

  return <div className={desktop ? 'space-y-6 pb-3' : 'space-y-4 pb-4'}>{rendered}</div>
})

export default ChatItemList

const TranscriptItem = memo(function TranscriptItem({
  item,
  chatStore,
  cwd,
  desktop,
  onOpenFile,
}: { item: AgentItem } & TranscriptAppearance) {
  const stream = useStore(chatStore, (state) => state.streams[item.id])
  const reasoningStream = item.kind === 'reasoning' && stream?.channel === 'reasoning'
  const isEmptyMessage = item.kind === 'message' && item.text.length === 0
  const isUser = item.kind === 'message' && item.role === 'user'
  return (
    <div>
      {(!stream || !isEmptyMessage) && (
        <ItemCard
          item={item}
          streamText={reasoningStream ? stream.text : undefined}
          sentAt={isUser ? (item.at ?? null) : null}
          cwd={cwd}
          onOpenFile={onOpenFile}
          desktop={desktop}
        />
      )}
      {stream && !reasoningStream && !isUser && <StreamingBlock stream={stream} cwd={cwd} onOpenFile={onOpenFile} />}
    </div>
  )
})

/**
 * Copy the dialogue of one turn, and export the whole turn.
 *
 * Read the delta buffers at click time so this row stays outside the live stream.
 */
function TurnActions({
  items,
  chatStore,
  time,
  onDownload,
}: {
  items: AgentItem[]
  chatStore: ChatStore
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
        getText={() => conversationText(items, chatStore.getState().streams)}
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
