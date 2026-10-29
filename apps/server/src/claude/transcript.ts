import fs from 'node:fs'
import type { AgentItem, TranscriptTurn } from '@vibemobile/protocol'
import { MAX_PER_MESSAGE, type ImageStore } from '../images/store.js'
import { applyToolResult, mapToolItem, toolResultText } from './mapUtils.js'
import { retryDetails } from './retry.js'

// ------------------------------------------------------ transcript history

/** First backward read; doubles until it holds enough turns. */
const TAIL_WINDOW_START = 512 * 1024

/**
 * How deep the synthetic older-page cursor may point, in turns.
 *
 * Ten times the route's per-request ceiling and far beyond any session this
 * app has seen; it exists to keep a hostile `c:999…` from turning the skip
 * count (and therefore the tail reader's window) into Infinity.
 */
export const MAX_CURSOR_SKIP = 10_000

/** Same shape the SDK uses for session ids. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Whether a stored message starts a turn — the same test `buildTurns` uses.
 *
 * Tool results also arrive as `user` messages, so the discriminator has to be
 * the content block type. A message that fails this still belongs to the turn
 * around it (assistant blocks, tool results) and is kept by the reader.
 */
export function isUserPrompt(message: any): boolean {
  if (message?.type !== 'user') return false
  // Subagent traffic is stored inline in some sessions; `buildTurns` skips it
  // and so must the prompt count, or the window would be cut short.
  if (message.parent_tool_use_id) return false
  const content = message?.message?.content
  if (!Array.isArray(content)) return false
  return content.some((part: any) => part?.type === 'text' || part?.type === 'image')
}

/**
 * Assistant message id — the key the SDK groups fragments of one API response
 * by. A response with parallel tool calls is stored as several assistant
 * entries with the same `message.id`.
 */
function assistantMessageId(message: any): string | undefined {
  if (message?.type !== 'assistant') return undefined
  const id = message?.message?.id
  return typeof id === 'string' ? id : undefined
}

/** A `user` entry carrying tool results rather than a prompt. */
function isToolResult(message: any): boolean {
  if (message?.type !== 'user' || !message?.parentUuid) return false
  const content = message?.message?.content
  if (!Array.isArray(content)) return false
  return content.some((part: any) => part?.type === 'tool_result')
}

/**
 * Rebuild the order `getSessionMessages` returns.
 *
 * File order is not conversation order: the JSONL is append-only, so parallel
 * tool calls are written as they finish and a sibling branch can be
 * interleaved with the branch that actually continues. The SDK walks the
 * parent chain from the newest leaf and then re-inserts fragments that share a
 * `message.id` but are off that chain after the last on-chain assistant of the
 * group (assistants sorted by timestamp, then their tool results sorted by
 * timestamp). Reproducing it matters once a session crosses the 5 MB cutoff:
 * the tail reader must not make parallel tool cards jump around compared with
 * what the same session showed before compaction / before it grew.
 *
 * Mirrors the SDK's `yBe` + `bBe` step, including the compact-boundary splice
 * that reattaches preserved messages to the post-boundary chain.
 */
export function orderTranscript(entries: any[]): any[] {
  const byUuid = new Map<string, any>()
  for (const entry of entries) byUuid.set(entry.uuid, entry)

  for (const entry of [...byUuid.values()]) {
    if (entry.type !== 'system' || entry.subtype !== 'compact_boundary') continue
    const preservedMessages = entry.compactMetadata?.preservedMessages
    const preservedSegment = entry.compactMetadata?.preservedSegment
    if (preservedMessages) {
      const uuids: string[] = preservedMessages.uuids
      if (uuids.length === 0 || uuids.some((uuid) => !byUuid.has(uuid))) continue
      // Chain the preserved entries in their recorded order, anchored on the
      // entry they were cut from.
      let previous = preservedMessages.anchorUuid
      for (const uuid of uuids) {
        byUuid.set(uuid, { ...byUuid.get(uuid), parentUuid: previous })
        previous = uuid
      }
      // Everything that used to hang off the anchor now hangs off the segment
      // tail instead, so walking parents crosses the boundary.
      const head = uuids[0]
      const tail = uuids[uuids.length - 1]
      for (const [uuid, item] of byUuid) {
        if (item.parentUuid === preservedMessages.anchorUuid && uuid !== head) {
          byUuid.set(uuid, { ...item, parentUuid: tail })
        }
      }
    } else if (preservedSegment) {
      const head = byUuid.get(preservedSegment.headUuid)
      // Same completeness rule as the branch above. Reparenting to an anchor
      // or tail that is not in the input does not bridge anything — it leaves
      // the entries hanging off a missing uuid, which makes them roots and
      // lets the newest-leaf walk drop them. Skip the splice instead.
      if (!head || !byUuid.has(preservedSegment.anchorUuid) || !byUuid.has(preservedSegment.tailUuid)) continue
      byUuid.set(preservedSegment.headUuid, { ...head, parentUuid: preservedSegment.anchorUuid })
      for (const [uuid, item] of byUuid) {
        if (item.parentUuid === preservedSegment.anchorUuid && uuid !== preservedSegment.headUuid) {
          byUuid.set(uuid, { ...item, parentUuid: preservedSegment.tailUuid })
        }
      }
    }
  }

  /** Original position, used to pick the newest leaf the way the SDK does. */
  const position = new Map<string, number>()
  for (let i = 0; i < entries.length; i++) position.set(entries[i].uuid, i)

  const hasChild = new Set<string>()
  for (const item of byUuid.values()) if (item.parentUuid) hasChild.add(item.parentUuid)
  const leaves = [...byUuid.values()].filter((item) => !hasChild.has(item.uuid))

  // Nearest user/assistant ancestor of every leaf; only user/assistant entries
  // can be the newest message (later system/attachment entries have none).
  const ends: any[] = []
  for (const leaf of leaves) {
    let item = leaf
    const visited = new Set<string>()
    while (item) {
      if (visited.has(item.uuid)) break
      visited.add(item.uuid)
      if (item.type === 'user' || item.type === 'assistant') {
        ends.push(item)
        break
      }
      item = item.parentUuid ? byUuid.get(item.parentUuid) : undefined
    }
  }
  if (ends.length === 0) return []

  const eligible = ends.filter((item) => !item.isSidechain && !item.teamName && !item.isMeta)
  const newest = (list: any[]) =>
    list.reduce((best, item) => ((position.get(item.uuid) ?? -1) > (position.get(best.uuid) ?? -1) ? item : best))
  const last = newest(eligible.length > 0 ? eligible : ends)

  const chain: any[] = []
  const onChain = new Set<string>()
  let item = byUuid.get(last.uuid)
  while (item) {
    if (onChain.has(item.uuid)) break
    onChain.add(item.uuid)
    chain.push(item)
    item = item.parentUuid ? byUuid.get(item.parentUuid) : undefined
  }
  chain.reverse()

  const assistants = chain.filter((message) => message.type === 'assistant')
  if (assistants.length === 0) return chain

  /** Message id -> the LAST on-chain assistant of that group (the insert anchor). */
  const anchor = new Map<string, any>()
  for (const message of assistants) {
    const id = assistantMessageId(message)
    if (id) anchor.set(id, message)
  }

  const assistantGroups = new Map<string, any[]>()
  /** Assistant uuid -> tool results that answer it. */
  const toolResults = new Map<string, any[]>()
  for (const message of byUuid.values()) {
    const id = assistantMessageId(message)
    if (id) {
      const group = assistantGroups.get(id)
      if (group) group.push(message)
      else assistantGroups.set(id, [message])
    } else if (isToolResult(message)) {
      const group = toolResults.get(message.parentUuid)
      if (group) group.push(message)
      else toolResults.set(message.parentUuid, [message])
    }
  }

  const placed = new Set(onChain)
  const insertAfter = new Map<string, any[]>()
  const handled = new Set<string>()
  for (const message of assistants) {
    const id = assistantMessageId(message)
    if (!id || handled.has(id)) continue
    handled.add(id)

    const group = assistantGroups.get(id) ?? [message]
    const fragments = group.filter((entry) => !placed.has(entry.uuid))
    const results: any[] = []
    for (const entry of group) {
      for (const result of toolResults.get(entry.uuid) ?? []) {
        if (!placed.has(result.uuid)) results.push(result)
      }
    }
    if (fragments.length === 0 && results.length === 0) continue

    const byTimestamp = (a: any, b: any) => (a.timestamp ?? '').localeCompare(b.timestamp ?? '')
    fragments.sort(byTimestamp)
    results.sort(byTimestamp)
    const inserted = [...fragments, ...results]
    for (const entry of inserted) placed.add(entry.uuid)
    insertAfter.set(anchor.get(id)!.uuid, inserted)
  }
  if (insertAfter.size === 0) return chain

  const ordered: any[] = []
  for (const message of chain) {
    ordered.push(message)
    const inserted = insertAfter.get(message.uuid)
    if (inserted) ordered.push(...inserted)
  }
  return ordered
}

/** The SDK's final filter: only conversational entries the UI renders. */
function isTranscriptMessage(message: any): boolean {
  if (message?.type !== 'user' && message?.type !== 'assistant' && !retryDetails(message)) return false
  return !message.isSidechain && !message.isMeta && !message.teamName
}

/**
 * Read the newest `neededPrompts` turns off the end of a JSONL transcript,
 * including everything before earlier context compactions.
 *
 * Works backwards in a window that doubles until it holds enough prompts, so
 * the cost is proportional to the history actually returned, not to the file.
 * The window starts at an arbitrary byte, so when it does not begin at offset
 * 0 its first line is dropped (it is a fragment); that is also why the read is
 * done through a Buffer — a multi-byte character cut at the boundary is in the
 * dropped line, not in the JSON we parse.
 *
 * A `compact_boundary` is NOT a scope here. The SDK treats it that way (its
 * small-file chain walk never reaches the old roots, and its large-file path
 * explicitly returns the buffer after the last one), which is exactly why
 * pre-compaction turns were invisible. Instead, the entries between two
 * boundaries form one segment, each segment is ordered on its own — the parent
 * chain breaks at the boundary, whose `parentUuid` is null — and the segments
 * are concatenated oldest to newest. `orderTranscript` must run once per
 * segment: given all of them at once it walks only the newest leaf and drops
 * every older chain (measured: 55 prompts collapse to 4).
 *
 * The boundary entry is returned as a marker between segments and is never
 * passed to `orderTranscript`, so its preserved-message splice does not run.
 * That is deliberate: preserved uuids live in the PREVIOUS segment and are
 * already shown there; splicing them into this one would show them twice. Do
 * not add them back.
 *
 * `truncated` means content older than the returned messages exists, which is
 * the `Transcript.hasMore` signal. Returns raw JSONL entries in conversation
 * order: user/assistant frames filtered the way the SDK filters (no
 * sidechain/meta/team), plus the boundary markers `buildTurns` turns into
 * compaction items.
 */
export async function readTranscriptMessages(
  file: string,
  size: number,
  neededPrompts: number,
): Promise<{ messages: any[]; truncated: boolean }> {
  if (neededPrompts <= 0) return { messages: [], truncated: size > 0 }
  // A caller with no limit asks for the whole transcript. Starting at `size`
  // skips the doubling passes, which would otherwise parse most of the file
  // again on every step to answer the same question.
  let window = neededPrompts === Number.POSITIVE_INFINITY ? size : Math.min(size, TAIL_WINDOW_START)
  const handle = await fs.promises.open(file, 'r')
  try {
    for (;;) {
      const start = size - window
      const buffer = Buffer.allocUnsafe(window)
      let read = 0
      while (read < window) {
        const { bytesRead } = await handle.read(buffer, read, window - read, start + read)
        if (bytesRead === 0) break
        read += bytesRead
      }
      let text = buffer.toString('utf8', 0, read)
      if (start > 0) {
        const newline = text.indexOf('\n')
        if (newline < 0) {
          // A single line longer than the whole window; it cannot contain the
          // prompt boundary we need to count, so widen.
          window = Math.min(size, window * 2)
          continue
        }
        text = text.slice(newline + 1)
      }

      /**
       * Every entry the SDK would parse, in file order.
       *
       * All entry types are kept, not just user/assistant: the parent chain
       * that `orderTranscript` walks runs through attachments and system
       * entries, and a compaction's preserved metadata points at them too.
       */
      const entries: any[] = []
      const lines = text.split('\n')
      for (const line of lines) {
        if (!line) continue
        let message: any
        try {
          message = JSON.parse(line)
        } catch {
          // A truncated or corrupt line is not worth failing the whole
          // transcript over; the next window (if any) only moves backwards.
          continue
        }
        if (
          typeof message?.uuid === 'string' &&
          (message.type === 'user' ||
            message.type === 'assistant' ||
            message.type === 'progress' ||
            message.type === 'system' ||
            message.type === 'attachment')
        ) {
          entries.push(message)
        }
      }

      // One segment per compact boundary: everything before the first
      // boundary, then everything after it up to the next one, and so on. The
      // boundary entry is NOT put in either segment — it is emitted as a
      // marker below. Passing it to `orderTranscript` would re-run its
      // preserved-message splice and show those entries a second time.
      const segments: any[][] = [[]]
      const boundaries: any[] = []
      for (const message of entries) {
        if (message.type === 'system' && message.subtype === 'compact_boundary') {
          boundaries.push(message)
          segments.push([])
        } else {
          segments[segments.length - 1].push(message)
        }
      }

      const messages: any[] = []
      for (let i = 0; i < segments.length; i++) {
        // The boundary happened before everything in this segment, so it is
        // emitted first. An empty segment (two boundaries in a row, or the
        // transcript starting with one) still contributes its marker.
        if (i > 0) messages.push(boundaries[i - 1])
        const segment = segments[i]
        const ordered = orderTranscript(segment)
        // A chain that cannot be reconstructed inside the window must not
        // blank the transcript; fall back to the entries themselves.
        const visible = ordered.length > 0 ? ordered.filter(isTranscriptMessage) : segment.filter(isTranscriptMessage)
        messages.push(...visible)
      }

      let prompts = 0
      for (const message of messages) if (isUserPrompt(message)) prompts++

      // Only "enough prompts" or "the window covers the whole file" ends the
      // read. A boundary no longer does — the history on the other side of it
      // is exactly what this reader exists to return.
      if (prompts >= neededPrompts || start === 0) {
        // Drop whole turns before the requested window so `buildTurns` yields
        // exactly what was asked for. Starting at a prompt (never inside a
        // turn) is what keeps the first returned turn complete.
        let cut = 0
        if (prompts > neededPrompts) {
          let skip = prompts - neededPrompts
          for (let i = 0; i < messages.length; i++) {
            if (!isUserPrompt(messages[i])) continue
            if (skip === 0) {
              cut = i
              break
            }
            skip--
          }
        } else if (start > 0) {
          // The window began inside a turn, leaving its head without a prompt.
          // Advance to the first prompt so `buildTurns` does not invent a
          // promptless turn and shift the cursor's turn count. (When the
          // window covers the file, a leading non-prompt frame is simply how
          // the transcript starts and must be kept.)
          const firstPrompt = messages.findIndex(isUserPrompt)
          if (firstPrompt > 0) cut = firstPrompt
        }
        return {
          messages: messages.slice(cut),
          truncated: prompts > neededPrompts || start > 0,
        }
      }

      window = Math.min(size, window * 2)
    }
  } finally {
    await handle.close()
  }
}

// -------------------------------------------------------- history -> turns

/**
 * Synthesise turns from the SDK's flat message list.
 *
 * A turn begins at each real user prompt. Tool results also arrive as `user`
 * messages, so the discriminator is the content block type, not the role —
 * treating a tool result as a prompt would cut every turn into pieces.
 *
 * `sliceAt` drops everything from that user message onward. It is the uuid we
 * stamped on a push that is still running, and it exists because the CLI
 * appends to the JSONL as it goes: mid-turn, the blocks of the live turn are
 * already on disk and would otherwise be rendered twice, once here and once
 * from the live mapper.
 *
 * Item ids deliberately do NOT reproduce the live mapper's
 * `claude:text:{messageId}:{index}`. They cannot: the replay stores each
 * assistant block as its own message with the block at array position 0, so
 * the live index is unrecoverable. Ids only have to be unique within one
 * render, and the two sources never describe the same block at the same time —
 * that is exactly what `sliceAt` guarantees.
 *
 * Stored `compact_boundary` entries arrive as markers between segments (see
 * `readTranscriptMessages`) and become `compaction` items. Their id is derived
 * from the boundary uuid, unlike every other item here, because both the
 * replay and the live stream can name the same boundary.
 */
/**
 * The image blocks of a stored user prompt, resolved to store tokens.
 *
 * The JSONL keeps them as base64 with the mime beside it — the same shape
 * `toSdkContent` sends, read back:
 *
 *   {"type":"image","source":{"type":"base64","media_type":"image/png","data":"…"}}
 *
 * Rebuilt into a data URL here and handed to the store unchanged. The bytes are
 * never re-encoded: what the agent recorded is what the phone displays.
 */
function imagesFromBlocks(content: any[], store: ImageStore): string[] {
  const tokens: string[] = []
  for (const part of content) {
    if (part?.type !== 'image' || tokens.length >= MAX_PER_MESSAGE) continue
    const source = part.source
    if (source?.type !== 'base64' || typeof source.data !== 'string' || typeof source.media_type !== 'string') {
      continue
    }
    const token = store.put(`data:${source.media_type};base64,${source.data}`)
    if (token) tokens.push(token)
  }
  return tokens
}

/**
 * The compaction divider for a stored boundary.
 *
 * The JSONL writes `compactMetadata` in camelCase; live SDK frames use
 * `compact_metadata` with snake_case. Both vocabularies are accepted so this
 * stays the one shape whichever source produced the entry. Missing fields are
 * omitted rather than defaulted — `postTokens: 0` would read as "everything
 * was dropped", the same reason the live mapper omits it.
 */
function compactionItem(message: any): AgentItem {
  const meta = message?.compactMetadata ?? message?.compact_metadata ?? {}
  const trigger = meta?.trigger === 'manual' || meta?.trigger === 'auto' ? meta.trigger : undefined
  const pre = meta?.preTokens ?? meta?.pre_tokens
  const post = meta?.postTokens ?? meta?.post_tokens
  const item: AgentItem = {
    kind: 'compaction',
    id: `claude:compaction:${message.uuid}`,
    status: 'done',
    ...(trigger ? { trigger } : {}),
    ...(typeof pre === 'number' ? { preTokens: pre } : {}),
    ...(typeof post === 'number' ? { postTokens: post } : {}),
  }
  return item
}

/**
 * The stored frame's wall clock, in milliseconds.
 *
 * The JSONL writes an ISO string (`timestamp`); tolerate a number too, since
 * that is what the live side has. Anything unreadable is null rather than
 * "now": a turn with no timestamp must render without one, not with the time
 * the transcript happened to be read.
 */
function timestampOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || value.length === 0) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

export function buildTurns(
  messages: any[],
  opts: { sliceAt?: string | null; images?: ImageStore } = {},
): TranscriptTurn[] {
  const turns: TranscriptTurn[] = []
  let current: TranscriptTurn | null = null
  /** toolUseId -> index into the current turn's items. */
  let pending = new Map<string, number>()
  /** Dividers that arrived before any turn was open. */
  let pendingCompaction: AgentItem[] = []

  const startTurn = (at: number | null = null): TranscriptTurn => {
    const turn: TranscriptTurn = {
      id: `claude:turn:${turns.length}`,
      status: 'completed',
      items: [],
      ...(at !== null ? { startedAt: at, completedAt: at } : {}),
    }
    turns.push(turn)
    pending = new Map()
    if (pendingCompaction.length > 0) {
      turn.items.push(...pendingCompaction)
      pendingCompaction = []
    }
    return turn
  }

  for (const message of messages) {
    if (opts.sliceAt && message?.uuid === opts.sliceAt) break
    const at = timestampOf(message?.timestamp)

    // Subagent traffic is stored on the main thread but belongs to a nested
    // transcript we do not render; showing it inline would interleave its tool
    // calls with ours under the wrong turn.
    if (message?.parent_tool_use_id) continue

    // A stored compaction boundary. It carries no message content, so it never
    // starts a turn — it belongs to whichever turn is open, matching the live
    // mapper, which files it against the running turn. Before the first prompt
    // it waits for that turn instead of being invented into one of its own.
    if (message?.type === 'system' && message?.subtype === 'compact_boundary') {
      // The id is the boundary's uuid, so a boundary seen both in the replay
      // and on the live stream is deduplicated by the client.
      if (typeof message.uuid === 'string') {
        const item = compactionItem(message)
        if (current) current.items.push(item)
        else pendingCompaction.push(item)
      }
      if (current && at !== null) current.completedAt = at
      continue
    }

    const retry = retryDetails(message)
    if (retry) {
      if (!current) current = startTurn(at)
      else if (at !== null) current.completedAt = at
      const previous = current.items.find((item) => item.kind === 'retry')
      if (previous?.kind === 'retry') previous.attempts.push(retry)
      else current.items.push({ kind: 'retry', id: `claude:retry:${message.uuid ?? current.id}`, attempts: [retry] })
      continue
    }
    const content = message?.message?.content
    // A compact summary arrives as a bare string. Nothing to render, but it
    // must not reset the turn either.
    if (!Array.isArray(content)) continue

    // Text OR image. An image-only message is a real prompt — the composer
    // allows sending a screenshot with no caption — and requiring a text block
    // made those start no turn at all: no bubble, and the image block dropped
    // into whatever turn happened to be open. A tool result is a `user`
    // message too and carries neither, so this still excludes them.
    const isPrompt = message.type === 'user' && content.some((c: any) => c.type === 'text' || c.type === 'image')
    if (isPrompt) {
      current = startTurn(at)
      const text = content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n')
      const images = opts.images ? imagesFromBlocks(content, opts.images) : []
      current.items.push({
        kind: 'message',
        id: `claude:user:${message.uuid}`,
        role: 'user',
        text,
        ...(images.length ? { images } : {}),
        // Each prompt keeps its own time, not just the turn's: after a reload
        // every prompt starts a turn of its own here, and a steered message
        // must still read as the moment it was typed.
        ...(at !== null ? { at } : {}),
      })
      continue
    }

    if (!current) current = startTurn(at)
    // Every frame that reaches here is something this turn did, so its
    // timestamp is the end of the turn's activity so far. The next prompt
    // starts a new turn and never retroactively stretches this one.
    if (at !== null) current.completedAt = at
    if (message.type === 'assistant' && (message.isApiErrorMessage || message.error)) {
      current.status = 'failed'
      current.items.push({
        kind: 'error',
        id: `claude:error:${message.uuid ?? message.message?.id ?? current.id}`,
        message:
          content
            .filter((p: any) => p?.type === 'text')
            .map((p: any) => p.text)
            .join('\n') || 'API request failed',
      })
      continue
    }

    for (const part of content) {
      // `message.uuid` identifies the frame, and each frame holds exactly one
      // block, so it is unique per card — unlike a position that is always 0.
      const id = String(message.uuid)

      if (part?.type === 'text' && message.type === 'assistant') {
        if (!part.text) continue
        current.items.push({ kind: 'message', id: `claude:text:${id}`, role: 'assistant', text: part.text })
        continue
      }

      if (part?.type === 'thinking' && message.type === 'assistant') {
        // Often stored with empty text and only its signature — on those the
        // words exist in the live deltas and nowhere else, so omit the card
        // rather than showing a permanently empty "思考过程". Some sessions do
        // keep the text, and those render normally.
        if (!part.thinking) continue
        current.items.push({
          kind: 'reasoning',
          id: `claude:reasoning:${id}`,
          summary: [],
          content: [part.thinking],
        })
        continue
      }

      if (part?.type === 'tool_use' && message.type === 'assistant') {
        pending.set(part.id, current.items.length)
        current.items.push(
          mapToolItem({
            toolUseId: part.id,
            name: String(part.name ?? ''),
            input: part.input,
            status: 'running',
          }),
        )
        continue
      }

      if (part?.type === 'tool_result') {
        const at = pending.get(part.tool_use_id)
        if (at === undefined) continue
        pending.delete(part.tool_use_id)
        current.items[at] = applyToolResult(
          current.items[at],
          // Replay keeps no structured results — measured: the stored message
          // has no `tool_use_result` field at all, so this is always undefined
          // and `applyToolResult` falls back to the diff built from the input.
          message.tool_use_result,
          toolResultText(part.content),
          Boolean(part.is_error),
        )
      }
    }
  }

  return turns
}
