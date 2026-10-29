import { create } from 'zustand'
import type {
  AgentEvent,
  AgentItem,
  ApprovalRequest,
  PlanStep,
  SessionStatus,
  TurnStatus,
  Usage,
} from '@vibemobile/protocol'
import { indexItemTurn } from './turnIndex'

export interface Stream {
  text: string
  channel: 'text' | 'reasoning' | 'commandOutput'
}

/**
 * When a turn ended, for the clock beside the download action.
 *
 * Only the end lives here. A user message's time belongs to the message
 * itself (`message.at`), because an interjection or a queued push is sent long
 * after the turn began; nothing may borrow the turn's start. Absent means the
 * screen shows no time rather than a guessed one.
 */
export interface TurnTime {
  completedAt?: number
}

interface ChatState {
  threadId: string | null
  /** Ordered items. Replaced only when membership or content changes. */
  items: AgentItem[]
  /** Live delta buffers keyed by item id. Replaced on each animation frame. */
  streams: Record<string, Stream>
  status: SessionStatus
  turnId: string | null
  turnStatus: TurnStatus | null
  retryNotice: Extract<AgentEvent, { kind: 'error' }> | null
  plan: PlanStep[]
  diff: string
  approvals: ApprovalRequest[]
  /**
   * The newest usage report for this session, or null before one arrives.
   *
   * Latest-only, not accumulated: the providers report different things (see
   * `Usage` in the protocol) and adding them up here would mean inventing a
   * number neither backend stands behind. It is also why `reset` clears it —
   * a session's context figure belongs to that session.
   */
  usage: Usage | null
  /**
   * The backend's slash commands for this session, or empty for a backend that
   * has none (Codex) or a session that has not run its first turn yet (Claude).
   *
   * Empty means "no menu", never "still loading": the composer must not show a
   * spinner or an error for it, only nothing.
   */
  commands: string[]
  /**
   * When each turn ended, keyed by turn id.
   *
   * Its own map rather than a field on the items: the transcript flattens turns
   * away, and the end belongs to the group — the actions row under the turn.
   */
  turnTimes: Record<string, TurnTime>
  /** Bumped when `streams` changed, so effects can react without deep compare. */
  streamVersion: number

  reset: (threadId: string) => void
  applyEvent: (event: AgentEvent) => void
  dismissApproval: (requestId: string) => void
}

// ---------------------------------------------------------------- buffers
//
// Deltas arrive many times per second. Writing each one straight into the
// store would re-render the transcript per token and lock up a phone on long
// output, so they accumulate here and are flushed at most once per frame.

const MAX_STREAM_CHARS = 200_000

/** Mutable working copy — never handed to React directly. */
let workingItems: AgentItem[] = []
let workingStreams = new Map<string, Stream>()
const turnErrorIds = new Map<string, string>()
let dirty = false
let flushHandle: number | null = null

function itemKey(item: AgentItem): string {
  return item.id
}

/** Upsert by id, preserving insertion order. */
function upsertItem(item: AgentItem): void {
  const key = itemKey(item)
  const index = workingItems.findIndex((existing) => itemKey(existing) === key)
  if (index === -1) workingItems.push(item)
  else workingItems[index] = item
}

function appendDelta(itemId: string, channel: Stream['channel'], text: string): void {
  const existing = workingStreams.get(itemId)
  if (!existing) {
    workingStreams.set(itemId, { text, channel })
    return
  }
  if (existing.text.length > MAX_STREAM_CHARS) return
  existing.text += text
}

/**
 * The completed item is authoritative, but it is not always *complete*: codex
 * has been observed completing a command with `exitCode: 0` and an empty
 * `aggregatedOutput` — the output only ever existed as deltas. Discarding the
 * buffer in that case loses the only copy of the text, so fold it in instead.
 * Only consulted when the item itself carries nothing.
 */
function withStreamedFallback(item: AgentItem): AgentItem {
  const buffered = workingStreams.get(item.id)?.text
  if (!buffered) return item
  switch (item.kind) {
    case 'message':
      return item.text ? item : { ...item, text: buffered }
    case 'command':
      return item.output ? item : { ...item, output: buffered }
    case 'reasoning': {
      const hasText = [...item.summary, ...item.content].some((part) => part.trim().length > 0)
      return hasText ? item : { ...item, content: [buffered] }
    }
    default:
      return item
  }
}

function materializeStreamedItems(): void {
  workingItems = workingItems.map(withStreamedFallback)
}

function streamsToRecord(): Record<string, Stream> {
  const out: Record<string, Stream> = {}
  for (const [id, stream] of workingStreams) {
    // Copy rather than hand out the working object. `appendDelta` mutates in
    // place, so publishing the same reference would make a selector like
    // `s => s.streams[itemId]` compare equal across flushes and the streaming
    // text would stop updating the moment that component is memoized.
    out[id] = { ...stream }
  }
  return out
}

export const useChatStore = create<ChatState>((set, get) => {
  const flush = () => {
    flushHandle = null
    if (!dirty) return
    dirty = false
    set((state) => ({
      items: [...workingItems],
      streams: streamsToRecord(),
      streamVersion: state.streamVersion + 1,
    }))
  }

  const scheduleFlush = () => {
    dirty = true
    if (flushHandle !== null) return
    if (typeof requestAnimationFrame === 'function' && document.visibilityState === 'visible') {
      flushHandle = requestAnimationFrame(flush)
    } else {
      // Backgrounded tabs throttle rAF to a stop; fall back to a timer so the
      // transcript is up to date the moment the user returns.
      flushHandle = window.setTimeout(flush, 50)
    }
  }

  return {
    threadId: null,
    items: [],
    streams: {},
    status: 'idle',
    turnId: null,
    turnStatus: null,
    retryNotice: null,
    plan: [],
    diff: '',
    approvals: [],
    usage: null,
    commands: [],
    turnTimes: {},
    streamVersion: 0,

    reset(threadId) {
      turnErrorIds.clear()
      workingItems = []
      workingStreams = new Map()
      dirty = false
      if (flushHandle !== null) {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(flushHandle)
        clearTimeout(flushHandle)
        flushHandle = null
      }
      set({
        threadId,
        items: [],
        streams: {},
        status: 'idle',
        turnId: null,
        turnStatus: null,
        retryNotice: null,
        plan: [],
        diff: '',
        approvals: [],
        usage: null,
        commands: [],
        turnTimes: {},
        streamVersion: 0,
      })
    },

    applyEvent(event) {
      if (event.kind === 'approval.requested') {
        const current = get().approvals
        if (!current.some((a) => a.requestId === event.approval.requestId)) {
          set({ approvals: [...current, event.approval] })
        }
        return
      }

      if (event.kind === 'approval.resolved') {
        set({ approvals: get().approvals.filter((a) => a.requestId !== event.requestId) })
        return
      }

      // Ignore events for a thread we are not showing.
      const currentThread = get().threadId
      if (currentThread && 'threadId' in event && event.threadId && event.threadId !== currentThread) {
        return
      }

      switch (event.kind) {
        case 'delta':
          if (get().retryNotice) set({ retryNotice: null })
          appendDelta(event.itemId, event.channel, event.text)
          scheduleFlush()
          return

        case 'item.started':
        case 'item.updated':
        case 'item.completed': {
          indexItemTurn(event.threadId, event.item.id, event.turnId)
          if (event.item.kind === 'error') turnErrorIds.set(event.turnId, event.item.id)
          upsertItem(event.kind === 'item.completed' ? withStreamedFallback(event.item) : event.item)
          if (event.kind === 'item.completed') {
            // The completed item is authoritative — drop any accumulated
            // deltas so we cannot drift from the server's final text. Anything
            // it left empty has already been folded in above.
            workingStreams.delete(event.item.id)
          }
          scheduleFlush()
          return
        }

        case 'turn.started':
          set({ turnId: event.turnId, turnStatus: 'inProgress', retryNotice: null })
          return

        case 'turn.completed': {
          const state = get()
          if (event.status === 'failed' || event.error) {
            const message = event.error?.message || '代理执行失败，未返回具体原因。'
            if (!turnErrorIds.has(event.turnId)) {
              const id = `turn-error:${event.turnId}`
              turnErrorIds.set(event.turnId, id)
              indexItemTurn(event.threadId, id, event.turnId)
              upsertItem({ kind: 'error', id, message })
            }
          }
          set({
            retryNotice: null,
            turnId: event.turnId,
            turnStatus: event.status,
            // A turn that is over cannot still be blocking on a human, so any
            // sheet naming it is stale by definition. This is the second line
            // of defence: the server broadcasts `approval.resolved` when it
            // abandons a request, but that broadcast can be missed by a socket
            // that was down — and a sheet is not dismissable, so leaving one on
            // screen blocks the composer until the user reloads.
            ...(event.status === 'inProgress'
              ? {}
              : {
                  approvals: state.approvals.filter((a) => a.turnId !== event.turnId),
                  // The backend's own end time when it reports one (Codex), the
                  // moment this screen learned the turn was over otherwise. A
                  // later transcript read replaces it with the backend's value
                  // in either case.
                  turnTimes: {
                    ...state.turnTimes,
                    [event.turnId]: { ...state.turnTimes[event.turnId], completedAt: event.at ?? Date.now() },
                  },
                }),
          })
          if (event.status !== 'inProgress') {
            // A few app-server/model combinations finish the turn without a
            // useful item.completed payload. Preserve the last streamed text
            // in the already-started item before clearing its buffer.
            materializeStreamedItems()
            workingStreams.clear()
            scheduleFlush()
          }
          return
        }

        case 'session.status':
          set({ status: event.status })
          return

        case 'plan.updated':
          set({ plan: event.plan })
          return

        case 'diff.updated':
          set({ diff: event.diff })
          return

        // Was falling through to `default` and being dropped, which is why the
        // token counts the providers have been sending all along were invisible.
        case 'usage.updated':
          set({ usage: event.usage })
          return

        case 'commands.updated':
          set({ commands: event.commands })
          return

        case 'error':
          if (event.willRetry) {
            set({ retryNotice: event })
          } else {
            const turnId = event.turnId ?? get().turnId ?? 'session'
            const id = `turn-error:${turnId}`
            turnErrorIds.set(turnId, id)
            upsertItem({ kind: 'error', id, message: event.message })
            set({ status: 'error', retryNotice: null })
            scheduleFlush()
          }
          return

        default:
          return
      }
    },

    dismissApproval(requestId) {
      set({ approvals: get().approvals.filter((a) => a.requestId !== requestId) })
    },
  }
})

/**
 * Load a transcript snapshot into the store (used when opening a session).
 *
 * `live` carries the turn the transcript ended on when that turn is still
 * `inProgress`. It matters because the snapshot is loaded over HTTP while the
 * events for a running turn arrive over the socket, so the two can be missed:
 * a page reloaded mid-turn would otherwise land with `turnId: null`, and the
 * Composer's stop button returns early on a null turn id — the button renders,
 * looks enabled, and silently does nothing.
 *
 * Deliberately not defaulted to "the last turn": a finished turn's id would
 * make the stop button target work that is already over.
 */
export function loadTranscript(
  threadId: string,
  items: AgentItem[],
  live?: { turnId: string | null; turnStatus: TurnStatus | null },
): void {
  workingItems = [...items]
  workingStreams = new Map()
  useChatStore.setState({
    threadId,
    items: workingItems,
    streams: {},
    plan: [],
    diff: '',
    approvals: [],
    // Cleared, not kept: nothing in a transcript carries usage (Codex's thread
    // record has no token counts and Claude has no thread record at all), so
    // after a reload the chip is empty until the next `usage.updated`. Showing
    // the previous session's numbers until then would be worse than showing
    // none, and `resyncTranscript` deliberately leaves this alone so a socket
    // blip mid-turn does not blank a figure that is still true.
    usage: null,
    retryNotice: null,
    // Cleared too, and it comes back on its own: opening a session replays
    // `commands.updated` from the provider's own record of the CLI's list.
    commands: [],
    turnId: live?.turnId ?? null,
    turnStatus: live?.turnStatus ?? null,
  })
}

/**
 * Adopt the end time a transcript page reports for its turns.
 *
 * Kept separate from `loadTranscript` because paging calls it too: an older
 * page brings turns the store never saw live. A turn the page gives no
 * `completedAt` for is left alone — if nothing ever stamped it, the actions
 * row renders without a clock rather than with a guess.
 */
export function mergeTurnTimes(threadId: string, turns: { id: string; completedAt?: number | null }[]): void {
  const state = useChatStore.getState()
  // The response can land after the reader opened another conversation; item
  // ids are only unique within a thread, so times must not cross either.
  if (state.threadId !== threadId) return
  const next = { ...state.turnTimes }
  let changed = false
  for (const turn of turns) {
    if (typeof turn.completedAt !== 'number') continue
    next[turn.id] = { ...next[turn.id], completedAt: turn.completedAt }
    changed = true
  }
  if (changed) useChatStore.setState({ turnTimes: next })
}

/**
 * Put an older page at the head of the transcript, after the user scrolled up
 * far enough to ask for it.
 *
 * Deduplicated by id: pages are cut at turn boundaries, but the Claude cursor
 * counts from the newest end, so a turn that starts while the user is paging
 * shifts every later page by one and can overlap. Keeping the copy already on
 * screen is right — it may carry live text a re-read would not have.
 *
 * `threadId` is checked against the open session because the HTTP response can
 * land after the user switched conversations. That check is the whole guard:
 * `workingItems` is module state shared by every session.
 */
export function prependTranscriptItems(threadId: string, items: AgentItem[]): number {
  if (useChatStore.getState().threadId !== threadId) return 0
  const known = new Set(workingItems.map(itemKey))
  const fresh: AgentItem[] = []
  for (const item of items) {
    const key = itemKey(item)
    // Dedupe the incoming page against itself too, not just the transcript:
    // adding each key to `known` as it is accepted makes the invariant local.
    if (known.has(key)) continue
    known.add(key)
    fresh.push(item)
  }
  if (fresh.length === 0) return 0
  workingItems = [...fresh, ...workingItems]
  useChatStore.setState({ items: [...workingItems] })
  return fresh.length
}

/** Whether an item carries anything a reader would see. */
function hasContent(item: AgentItem): boolean {
  switch (item.kind) {
    case 'message':
      return item.text.length > 0
    case 'command':
      return item.output.length > 0 || item.command.length > 0
    case 'reasoning':
      return [...item.summary, ...item.content].some((part) => part.trim().length > 0)
    default:
      return true
  }
}

/**
 * Merge a fresh transcript snapshot into the transcript already on screen,
 * after the socket came back.
 *
 * This is not `loadTranscript` and must not become it. The socket replays
 * subscriptions and the providers replay *live* status, but an item that
 * finished while the phone was away was only ever carried by the delta stream,
 * which is gone — the transcript is the only place it survives. So the snapshot
 * is needed. What it must not do is start over: `loadTranscript` clears the
 * delta buffers and the whole store, which on a reconnect would blank the
 * in-flight turn's text and every approval sheet, and flash the loading screen
 * on a phone that merely locked its screen.
 *
 * The two halves of the merge:
 *
 *  - Items the snapshot does not mention are kept. They came from live events
 *    issued after the snapshot was cut, so dropping them would delete the tail
 *    of the turn.
 *  - A buffer is the only copy of text for an item that is still streaming, so
 *    it survives — except where the snapshot already carries that item's text,
 *    in which case the buffer is a stale prefix of it and would render twice.
 *
 * The merge is positional, not "snapshot first, leftovers after": once older
 * pages have been loaded, most items on screen are not in the snapshot at all
 * — they are older, and appending them would move half the conversation below
 * the newest turn. Items the snapshot knows are replaced in place; only items
 * it alone carries are appended, and those are the new tail.
 */
export function resyncTranscript(
  threadId: string,
  items: AgentItem[],
  live?: { turnId: string | null; turnStatus: TurnStatus | null },
): void {
  const snapshot = new Map(items.map((item) => [itemKey(item), item]))
  const merged = workingItems.map((item) => snapshot.get(itemKey(item)) ?? item)
  const present = new Set(merged.map(itemKey))
  for (const item of items) if (!present.has(itemKey(item))) merged.push(item)
  workingItems = merged

  for (const item of items) {
    if (hasContent(item)) workingStreams.delete(itemKey(item))
  }

  useChatStore.setState((state) => ({
    threadId,
    items: [...workingItems],
    streams: streamsToRecord(),
    streamVersion: state.streamVersion + 1,
    turnId: live?.turnId ?? null,
    turnStatus: live?.turnStatus ?? null,
  }))
}
