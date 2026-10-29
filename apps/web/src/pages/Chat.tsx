import { RetryBanner } from '../components/RetryBanner'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { AgentInput, AgentItem, ModelInfo, SessionSummary, TranscriptTurn } from '@vibemobile/protocol'
import { api, ApiError } from '../lib/api'
import { socket } from '../lib/ws'
import { loadTranscript, mergeTurnTimes, prependTranscriptItems, resyncTranscript, useChatStore } from '../lib/store'
import {
  downloadMarkdown,
  markdownFilename,
  sessionMarkdown,
  turnMarkdown,
  type ExportMode,
} from '../lib/exportMarkdown'
import { indexTurns } from '../lib/turnIndex'
import { Button } from '../components/ui/button'
import ChatHeader from '../components/ChatHeader'
import ChatItemList from '../components/ChatItemList'
import ChatLoadError from '../components/ChatLoadError'
import ChatOverlays from '../components/ChatOverlays'
import Composer, { type TurnOptions } from '../components/Composer'
import Sheet from '../components/Sheet'
import ConnectionBanner from '../components/ConnectionBanner'
import { PERMISSIONS, permissionCardFor, permissionCardsFor, type PermissionCard } from '../lib/permission'
import { retryInput } from '../lib/retry'
import { runnerPath } from '../lib/runner'
import type { FileRef } from '../lib/fileLink'

/**
 * How many rendered items a transcript page asks for.
 *
 * Not a turn count: one turn can be a single message or several hundred tool
 * cards, so twenty turns is sometimes one screen and sometimes thousands of
 * items. The server cuts on whole turns, so the page may be larger than this.
 */
const PAGE_ITEMS = 60

/** What the export sheet was opened for; the mode is chosen inside it. */
type ExportChoice = { kind: 'session' } | { kind: 'turn'; items: AgentItem[]; label: string }

/**
 * Every turn in the session, for the Markdown export.
 *
 * Pages are walked newest→oldest (the direction the cursor supports) and
 * concatenated oldest→newest. Items are deduplicated by id because a Claude
 * cursor counts from the newest end and can overlap when a turn starts while
 * the pages are being fetched; a boundary turn that overlaps is folded into
 * the previous one when the ids agree.
 */
async function fetchAllTurns(threadId: string): Promise<TranscriptTurn[]> {
  const pages: TranscriptTurn[][] = []
  let page = await api.session(threadId, { items: PAGE_ITEMS })
  pages.unshift(page.turns)
  let cursor = page.nextCursor ?? null
  let hasMore = page.hasMore === true
  // A provider with a misbehaving cursor must not turn an export into a loop.
  for (let guard = 0; hasMore && cursor && guard < 100; guard++) {
    page = await api.session(threadId, { items: PAGE_ITEMS, cursor })
    pages.unshift(page.turns)
    cursor = page.nextCursor ?? null
    hasMore = page.hasMore === true
  }

  const seen = new Set<string>()
  const turns: TranscriptTurn[] = []
  for (const group of pages) {
    for (const turn of group) {
      const fresh = turn.items.filter((item) => !seen.has(item.id))
      if (fresh.length === 0) continue
      for (const item of fresh) seen.add(item.id)
      const last = turns.at(-1)
      if (last && last.id === turn.id) last.items.push(...fresh)
      else turns.push({ ...turn, items: fresh })
    }
  }
  return turns
}

export default function Chat() {
  const { threadId } = useParams<{ threadId: string }>()
  const navigate = useNavigate()

  const [session, setSession] = useState<SessionSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [showDiff, setShowDiff] = useState(false)
  const [openFile, setOpenFile] = useState<FileRef | null>(null)
  const [turnModel, setTurnModel] = useState('')
  const [turnEffort, setTurnEffort] = useState('')
  const [turnPermission, setTurnPermission] = useState<PermissionCard>('ask')
  const [models, setModels] = useState<ModelInfo[]>([])
  const [sendError, setSendError] = useState<string | null>(null)
  const [loadErrorCode, setLoadErrorCode] = useState<string | null>(null)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [readOnly, setReadOnly] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportChoice, setExportChoice] = useState<ExportChoice | null>(null)
  const [forking, setForking] = useState(false)
  const [forkError, setForkError] = useState<string | null>(null)
  /**
   * Older turns: whether more exist, how to ask for them, and the fetch in
   * flight.
   *
   * Page-local state, not in the store: it describes one fetch, not the
   * conversation, and putting it in the store would leave it set after anything
   * that re-syncs the transcript in place (a reconnect, a live turn) — at which
   * point the notice would be about a fetch nobody just made.
   *
   * `hasOlder` and `olderCursor` are separate because they answer different
   * questions: a provider may know older turns exist without being able to
   * hand out a cursor, and the screen must then say they are unreachable
   * instead of offering a load that cannot work.
   */
  const [hasOlder, setHasOlder] = useState(false)
  const [olderCursor, setOlderCursor] = useState<string | null>(null)
  /**
   * Deliberately NOT the page-level `loading`: that one swaps the whole page
   * for 加载中…, which would clip the scroll container to 0 and throw away the
   * reader's position every time a page arrives.
   */
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [olderError, setOlderError] = useState<string | null>(null)

  const items = useChatStore((s) => s.items)
  const streams = useChatStore((s) => s.streams)
  const status = useChatStore((s) => s.status)
  const turnId = useChatStore((s) => s.turnId)
  const turnStatus = useChatStore((s) => s.turnStatus)
  const retryNotice = useChatStore((s) => s.retryNotice)
  const plan = useChatStore((s) => s.plan)
  const diff = useChatStore((s) => s.diff)
  const approvals = useChatStore((s) => s.approvals)
  const usage = useChatStore((s) => s.usage)
  const commands = useChatStore((s) => s.commands)
  const turnTimes = useChatStore((s) => s.turnTimes)

  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedToBottom = useRef(true)
  const initialScrollPending = useRef(false)
  /** The thread the initial load finished for; the re-sync waits on it. */
  const loadedThread = useRef<string | null>(null)
  /** In-flight guard: state updates are async, so a ref is what stops a double tap. */
  const busy = useRef(false)

  /**
   * Refs alongside the state: `onScroll` is a plain callback and would
   * otherwise keep whatever values its closure was created with, loading the
   * same page again (or loading at all after the history ran out).
   */
  const loadingOlderRef = useRef(false)
  const hasOlderRef = useRef(false)
  const olderCursorRef = useRef<string | null>(null)
  /**
   * A failed page is NOT retried by scrolling.
   *
   * Scroll events fire continuously while a thumb rests near the top, so
   * without this a failing server would be asked again on every frame; the
   * visible retry button is the only way back.
   */
  const olderErrorRef = useRef(false)
  /**
   * Distance from the viewport to the bottom, captured before an older page is
   * prepended.
   *
   * Prepending grows the content ABOVE the reader, so `scrollTop` alone stays
   * put and the screen would jump to the new page's start. Restoring
   * `scrollHeight - top` in `useLayoutEffect` is what keeps the same line under
   * the thumb; doing it in an effect would let one frame of the jumped layout
   * paint first.
   */
  const olderAnchor = useRef<{ height: number; top: number } | null>(null)

  const [isAtBottom, setIsAtBottom] = useState(true)

  const running = !readOnly && (turnStatus === 'inProgress' || status === 'working' || status === 'waitingApproval')
  const [retrying, setRetrying] = useState(false)
  const lastPrompt = [...items].reverse().find((item) => item.kind === 'message' && item.role === 'user')

  // ---------------------------------------------------------------- load

  useEffect(() => {
    if (!threadId) return
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    setLoadErrorCode(null)
    setReadOnly(false)
    setForkError(null)
    // Cleared with the rest of the per-session state: a notice left over from
    // the previous session would claim THIS conversation was cut short, and a
    // cursor from it would ask the new provider for turns that are not its own.
    setHasOlder(false)
    setOlderCursor(null)
    hasOlderRef.current = false
    olderCursorRef.current = null
    olderErrorRef.current = false
    setOlderError(null)
    setLoadingOlder(false)
    loadingOlderRef.current = false
    olderAnchor.current = null
    initialScrollPending.current = true
    pinnedToBottom.current = true
    setIsAtBottom(true)
    useChatStore.getState().reset(threadId)

    // Resume first: the transcript is readable straight from disk, but the
    // backend only forwards live events for threads it has re-attached to.
    let subscribed = false
    let viewingReadOnly = false

    api
      .openSession(threadId)
      // Same budget as scrolling up. The server's turn-count default is much
      // heavier than a phone screen needs, and every turn renders eagerly.
      .then(() => api.session(threadId, { items: PAGE_ITEMS }))
      .catch((err) => {
        if (!(err instanceof ApiError) || err.code !== 'session_in_use') throw err
        // The desktop Codex client owns the writer lock. A transcript GET is
        // still safe, so show the saved conversation without taking over the
        // session or attempting to resume its event stream.
        viewingReadOnly = true
        return api.session(threadId, { items: PAGE_ITEMS })
      })
      .then((transcript) => {
        if (cancelled) return
        setReadOnly(viewingReadOnly)
        hasOlderRef.current = transcript.hasMore === true
        // The cursor is only spendable when it came with `hasMore`; a provider
        // that cannot page answers `hasMore` with no cursor, and the UI says
        // so rather than fetching in circles.
        olderCursorRef.current = transcript.hasMore === true ? (transcript.nextCursor ?? null) : null
        setHasOlder(hasOlderRef.current)
        setOlderCursor(olderCursorRef.current)
        setSession(transcript.session)
        setTurnModel(transcript.session.model ?? '')
        setTurnEffort(transcript.session.reasoningEffort ?? '')
        // Alongside model and effort, and for the same reason: this is what the
        // session is running. A session created with 完全访问 used to open with
        // the picker on 按需确认, and the first message then sent that --
        // downgrading the session the user had just configured and filling the
        // screen with approval sheets.
        //
        // Seeded against the same card list the picker is handed below, not the
        // full one: a card that matches but was never offered renders an empty
        // trigger (see `permissionCardFor`).
        setTurnPermission(
          permissionCardFor(
            transcript.session.sandbox,
            transcript.session.approvalPolicy,
            permissionCardsFor(transcript.session.provider),
          ),
        )
        if (!viewingReadOnly) {
          void api
            .models(transcript.session.provider)
            .then(({ data }) => {
              if (cancelled) return
              setModels(data)
              if (transcript.session.reasoningEffort) return
              const selected = data.find((item) => item.id === transcript.session.model) ?? data[0]
              setTurnEffort(selected?.defaultEffort ?? selected?.efforts?.[0] ?? '')
            })
            .catch(() => undefined)
        }
        const items: AgentItem[] = transcript.turns.flatMap((turn) => turn.items)
        // The transcript's last turn being `inProgress` means a turn is still
        // running on the server. Its id is what the stop button sends, so
        // without it a phone that reloaded mid-turn can watch but not stop.
        const open = [...transcript.turns].reverse().find((turn) => turn.status === 'inProgress')
        indexTurns(threadId, transcript.turns)
        mergeTurnTimes(threadId, transcript.turns)
        loadTranscript(threadId, items, {
          turnId: open?.id ?? null,
          turnStatus: open ? 'inProgress' : (transcript.turns.at(-1)?.status ?? null),
        })
        useChatStore.setState({ status: transcript.session.status })
        if (!viewingReadOnly) {
          socket.subscribe(threadId)
          subscribed = true
        }
      })
      .catch((err) => {
        if (cancelled) return
        setLoadError((err as Error).message)
        setLoadErrorCode(err instanceof ApiError ? (err.code ?? null) : null)
      })
      .finally(() => {
        if (cancelled) return
        // Only now may the reconnect re-sync merge into this transcript; see
        // the effect below for why it has to wait.
        loadedThread.current = threadId
        setLoading(false)
      })

    return () => {
      cancelled = true
      if (loadedThread.current === threadId) loadedThread.current = null
      if (threadId && subscribed) socket.unsubscribe(threadId)
    }
  }, [threadId, loadAttempt])

  // -------------------------------------------------------------- events

  useEffect(() => {
    return socket.onEvent((event) => {
      if (!readOnly) useChatStore.getState().applyEvent(event)
    })
  }, [readOnly])

  // ---------------------------------------------------------- re-sync

  // A phone loses this socket constantly — screen lock, app switch, WiFi
  // handoff — and everything the agent produced while it was down is gone: the
  // delta stream is not replayed, and the replayed `subscribe` only restores
  // live status (the running turn, the pending approval, the stop button). So a
  // phone that locked mid-turn comes back to a transcript frozen at the moment
  // it locked, with the rest of the answer missing and nothing on screen to say
  // so. Re-reading the transcript on reconnect is what closes that gap.
  //
  // `resyncTranscript`, not `loadTranscript`: the merge keeps the in-flight
  // text and avoids the full-screen "加载中…" that a phone would otherwise
  // flash every time its screen turned off and on.
  useEffect(() => {
    if (!threadId || readOnly) return
    let cancelled = false
    let previous = socket.state

    const unsubscribe = socket.onState((state) => {
      const reconnected = state === 'open' && previous === 'closed'
      previous = state
      // Nothing to merge into before the first load has run; that load already
      // fetched the same snapshot, and racing it would only duplicate the GET.
      if (!reconnected || loadedThread.current !== threadId) return

      void api
        .session(threadId)
        .then((transcript) => {
          if (cancelled) return
          const items: AgentItem[] = transcript.turns.flatMap((turn) => turn.items)
          const open = [...transcript.turns].reverse().find((turn) => turn.status === 'inProgress')
          indexTurns(threadId, transcript.turns)
          mergeTurnTimes(threadId, transcript.turns)
          resyncTranscript(threadId, items, {
            turnId: open?.id ?? null,
            turnStatus: open ? 'inProgress' : (transcript.turns.at(-1)?.status ?? null),
          })
          useChatStore.setState({ status: transcript.session.status })
          setSession(transcript.session)

          // A session that was short when it was opened can grow past the
          // page limit while the phone is away, and then older turns become
          // reachable for the first time. Only adopted when there is no cursor
          // yet: replacing a deeper one with the newest page's would re-fetch
          // pages already on screen after every reconnect.
          if (!olderCursorRef.current) {
            hasOlderRef.current = transcript.hasMore === true
            olderCursorRef.current = transcript.hasMore === true ? (transcript.nextCursor ?? null) : null
            setHasOlder(hasOlderRef.current)
            setOlderCursor(olderCursorRef.current)
          }
        })
        .catch(() => {
          // Best effort. The socket is back and live events are flowing again,
          // so a failed catch-up read is not worth an error banner — the next
          // reconnect tries again.
        })
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [threadId, readOnly])

  // -------------------------------------------------------- older history

  const loadOlder = useCallback(async () => {
    const el = scrollRef.current
    const cursor = olderCursorRef.current
    if (!threadId || !el || !cursor || loadingOlderRef.current) return

    loadingOlderRef.current = true
    olderErrorRef.current = false
    setLoadingOlder(true)
    setOlderError(null)

    try {
      const transcript = await api.session(threadId, { items: PAGE_ITEMS, cursor })
      // The response can land after the user opened another conversation;
      // `prependTranscriptItems` also checks, but everything else here would
      // write the old session's cursor into the new one.
      if (useChatStore.getState().threadId !== threadId) return

      // Measured at the last moment before the DOM grows, not when the request
      // was sent: a slow page must not undo the scrolling the reader did while
      // waiting for it.
      const anchor = scrollRef.current
      if (anchor) olderAnchor.current = { height: anchor.scrollHeight, top: anchor.scrollTop }

      const items: AgentItem[] = transcript.turns.flatMap((turn) => turn.items)
      indexTurns(threadId, transcript.turns)
      mergeTurnTimes(threadId, transcript.turns)
      const added = prependTranscriptItems(threadId, items)
      // Nothing added means the page was entirely already on screen (a stale
      // cursor, or a turn that started while paging shifted the window):
      // there is no new content to hold the position for.
      if (added === 0) olderAnchor.current = null

      hasOlderRef.current = transcript.hasMore === true
      const nextCursor = transcript.hasMore === true ? (transcript.nextCursor ?? null) : null
      // A page that added nothing and handed back the same cursor cannot make
      // progress; keeping it would let the auto-fill effect ask again forever.
      // A page of pure duplicates is fine as long as the cursor advanced.
      olderCursorRef.current = added === 0 && nextCursor === cursor ? null : nextCursor
      setHasOlder(hasOlderRef.current)
      setOlderCursor(olderCursorRef.current)
    } catch (err) {
      olderAnchor.current = null
      olderErrorRef.current = true
      // Kept on screen as a retry: auto-scrolling again is not something the
      // user did, so a transient failure must not look like the end of history.
      setOlderError((err as Error).message)
    } finally {
      // If the reader switched conversations mid-request, that load already
      // reset these — and a new page fetch may already be running.
      if (useChatStore.getState().threadId === threadId) {
        loadingOlderRef.current = false
        setLoadingOlder(false)
      }
    }
  }, [threadId])

  // Restore the reading position before the browser paints the taller
  // transcript. `useLayoutEffect`, not `useEffect`: the prepend is a visible
  // jump otherwise.
  useLayoutEffect(() => {
    const el = scrollRef.current
    const anchor = olderAnchor.current
    if (!el || !anchor) return
    olderAnchor.current = null
    el.scrollTop = el.scrollHeight - anchor.height + anchor.top
    // The anchor is distance-to-bottom, so this is "keep the same lines under
    // the thumb" independent of how tall the new page turned out to be.
  }, [items])

  // Paging is normally driven by scrolling up, but a page can be shorter than
  // the viewport on a large display — then the scroller never scrolls, no event
  // fires, and the rest of history is unreachable. Keep asking until the
  // transcript overflows. `loadOlder` refuses a cursor that cannot advance, so
  // this cannot spin.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || loadingOlder || !hasOlder || !olderCursor || olderError) return
    if (el.scrollHeight > el.clientHeight + 1) return
    void loadOlder()
  }, [items, loadingOlder, hasOlder, olderCursor, olderError, loadOlder])

  // ---------------------------------------------------------- auto-scroll

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    // 80px of slack so a near-bottom position still counts as "following".
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    pinnedToBottom.current = nearBottom
    setIsAtBottom(nearBottom)

    // 160px of slack, so the next page starts loading before the reader hits
    // the top and waits for it. `initialScrollPending` keeps the first layout
    // (which briefly sits at the top) from firing a fetch.
    if (
      el.scrollTop < 160 &&
      !initialScrollPending.current &&
      hasOlderRef.current &&
      olderCursorRef.current &&
      !loadingOlderRef.current &&
      !olderErrorRef.current
    ) {
      void loadOlder()
    }
  }, [loadOlder])

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    pinnedToBottom.current = true
    setIsAtBottom(true)
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el || !pinnedToBottom.current) return
    if (!initialScrollPending.current) {
      el.scrollTop = el.scrollHeight
      return
    }

    // Historical items can change the container height after the first paint.
    // Wait two frames so the browser has laid out the full transcript before
    // applying the initial jump.
    let secondFrame = 0
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        if (!scrollRef.current) return
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight
        initialScrollPending.current = false
        pinnedToBottom.current = true
        setIsAtBottom(true)
      })
    })
    return () => {
      window.cancelAnimationFrame(firstFrame)
      if (secondFrame) window.cancelAnimationFrame(secondFrame)
    }
  }, [items, streams, plan, loading])

  // -------------------------------------------------------------- actions

  const send = useCallback(
    async (input: AgentInput[], opts?: TurnOptions) => {
      if (!threadId || readOnly || busy.current) return
      // Held across the round trip, not just the render: two taps land in the
      // same event-loop turn well before React has re-rendered the composer
      // with its box emptied, so the button's own disabled state is too late to
      // stop the second message from starting a second turn.
      busy.current = true
      setSendError(null)
      try {
        if (running && turnId) {
          // Mid-turn input goes through `steer`, not a new turn.
          await socket.steer(threadId, turnId, input)
        } else {
          await socket.startTurn(threadId, input, {
            ...opts,
            model: turnModel || undefined,
            effort: turnEffort || undefined,
          })
        }
      } catch (err) {
        setSendError((err as Error).message)
      } finally {
        busy.current = false
      }
    },
    [threadId, readOnly, running, turnId, turnModel, turnEffort],
  )

  const retryLastPrompt = useCallback(async () => {
    if (!threadId || readOnly || running || busy.current || !lastPrompt) return
    busy.current = true
    setRetrying(true)
    setSendError(null)
    try {
      const input = await retryInput(lastPrompt, async (token) => {
        const response = await fetch(runnerPath(`/api/images/${encodeURIComponent(token)}`), { credentials: 'include' })
        if (!response.ok) throw new Error('无法读取上一条指令的图片，请重新选择图片后发送。')
        const blob = await response.blob()
        return new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result))
          reader.onerror = () => reject(new Error('读取图片失败。'))
          reader.readAsDataURL(blob)
        })
      })
      const permission = PERMISSIONS[turnPermission]
      await socket.startTurn(threadId, input, {
        model: turnModel || undefined,
        effort: turnEffort || undefined,
        sandbox: permission.sandbox,
        approvalPolicy: permission.approvalPolicy,
      })
    } catch (err) {
      setSendError((err as Error).message)
    } finally {
      busy.current = false
      setRetrying(false)
    }
  }, [threadId, readOnly, running, lastPrompt, turnPermission, turnModel, turnEffort])

  const stop = useCallback(async () => {
    if (readOnly || !threadId) return
    if (!turnId) {
      // The button is drawn from `running`, which is true whenever the session
      // reports work — but interrupting needs the turn's id, and there is a
      // window (a reconnect before the re-sync lands) where the server says
      // `working` and we have no id to send. Saying so beats a button that
      // looks live and silently does nothing.
      setSendError('还不知道当前回合的编号，稍等一下再试。')
      return
    }
    if (busy.current) return
    busy.current = true
    try {
      await socket.interrupt(threadId, turnId)
    } catch (err) {
      setSendError((err as Error).message)
    } finally {
      busy.current = false
    }
  }, [readOnly, threadId, turnId])

  const requestSessionExport = useCallback(() => {
    if (!session || exporting) return
    setExportChoice({ kind: 'session' })
  }, [session, exporting])

  const requestTurnExport = useCallback(
    (_turnId: string, turnItems: AgentItem[]) => {
      if (!session || turnItems.length === 0) return
      const firstUser = turnItems.find((item) => item.kind === 'message' && item.role === 'user')
      const label =
        firstUser?.kind === 'message' && firstUser.text.trim()
          ? firstUser.text.trim().split('\n')[0].slice(0, 60)
          : '本轮'
      setExportChoice({ kind: 'turn', items: turnItems, label })
    },
    [session],
  )

  /** Both entry points ask for the mode first; conversation is the default. */
  const runExport = useCallback(
    async (mode: ExportMode) => {
      const choice = exportChoice
      if (!choice || !session) {
        setExportChoice(null)
        return
      }
      setExportChoice(null)
      if (choice.kind === 'turn') {
        downloadMarkdown(
          markdownFilename(session.title, mode === 'conversation' ? 'turn-对话' : 'turn-完整'),
          turnMarkdown(session, choice.items, choice.label, streams, mode),
        )
        return
      }
      if (!threadId || exporting) return
      setExporting(true)
      try {
        const turns = await fetchAllTurns(threadId)
        downloadMarkdown(
          markdownFilename(session.title, mode === 'conversation' ? '对话' : '完整'),
          sessionMarkdown(session, turns, mode),
        )
      } catch (err) {
        window.alert(`导出会话失败：${(err as Error).message}`)
      } finally {
        setExporting(false)
      }
    },
    [exportChoice, session, streams, threadId, exporting],
  )

  const changeModel = useCallback(
    (nextModel: string) => {
      setTurnModel(nextModel)
      const selected = models.find((item) => item.id === nextModel) ?? models[0]
      setTurnEffort(selected?.defaultEffort ?? selected?.efforts?.[0] ?? '')
    },
    [models],
  )

  const forkAndContinue = useCallback(async () => {
    if (!threadId || forking) return
    setForking(true)
    setForkError(null)
    try {
      const forked = await api.forkSession(threadId)
      navigate(`/chat/${forked.id}`, { replace: true })
    } catch (err) {
      setForkError((err as Error).message)
      setForking(false)
    }
  }, [threadId, forking, navigate])

  // --------------------------------------------------------------- render

  // Stable across renders: it is a memo dependency of every message card, and
  // a fresh closure would re-parse the whole transcript on each delta frame.
  const showFile = useCallback((ref: FileRef) => setOpenFile(ref), [])

  if (loading) {
    return <div className="h-full flex items-center justify-center text-muted-foreground">加载中…</div>
  }

  if (loadError) {
    return (
      <ChatLoadError
        loadError={loadError}
        sessionInUse={loadErrorCode === 'session_in_use'}
        forking={forking}
        forkError={forkError}
        onFork={forkAndContinue}
        onRetry={() => setLoadAttempt((attempt) => attempt + 1)}
        onBack={() => navigate('/')}
      />
    )
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <ChatHeader
        session={session}
        readOnly={readOnly}
        status={status}
        turnStatus={turnStatus}
        usage={usage}
        plan={plan}
        hasDiff={Boolean(diff)}
        downloading={exporting}
        onDownload={requestSessionExport}
        onBack={() => navigate('/')}
        onShowDiff={() => setShowDiff(true)}
      />

      {/* Between the header and the transcript, because `BottomNav` — which
          carries this strip on every other screen — is unmounted here. Without
          it a chat that has lost its socket looks exactly like one where the
          agent is simply thinking. */}
      <ConnectionBanner />
      <RetryBanner notice={retryNotice} />

      {/* ---- transcript ---- */}
      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} onScroll={onScroll} className="scroll-y h-full px-3.5 py-4">
          {items.length === 0 && !loading && (
            <div className="mt-16 text-center text-sm text-muted-foreground">
              {readOnly
                ? '还没有可查看的历史消息。'
                : `还没有消息。在下面输入任务，代理会在 ${session?.cwd ?? '工作目录'} 中执行。`}
            </div>
          )}
          {/* Above the transcript, at the very top, because that is where the
              missing turns would have been — a notice at the bottom would read
              as "the conversation ends here", which is the one thing it must
              not say. It cannot be dismissed and there is nothing to tap: a
              provider answered `hasMore` without a cursor, so the turns are
              genuinely unreachable and offering a button would be a lie.
              (The loading and retry pills are OUTSIDE the scroller: they come
              and go while the reader is at the top, and growing the content
              there would move the lines under their thumb.) */}
          {hasOlder && !olderCursor && (
            <div className="mb-3 rounded-lg border border-border bg-secondary/50 px-3 py-2 text-center text-[11px] text-muted-foreground">
              以上还有更早的记录（未加载）
            </div>
          )}
          <ChatItemList
            items={items}
            streams={streams}
            turnTimes={turnTimes}
            cwd={session?.cwd}
            threadId={threadId ?? ''}
            running={
              turnStatus === 'inProgress' ||
              status === 'working' ||
              status === 'waitingApproval' ||
              status === 'waitingInput'
            }
            onOpenFile={showFile}
            onDownloadTurn={requestTurnExport}
          />
        </div>

        {(loadingOlder || olderError) && (
          <div className="pointer-events-none absolute inset-x-0 top-2 z-20 flex justify-center">
            {loadingOlder ? (
              <div className="rounded-full border border-border bg-secondary/95 px-3.5 py-1.5 text-[11px] text-muted-foreground shadow-lg backdrop-blur-md">
                正在加载更早的消息…
              </div>
            ) : (
              <button
                type="button"
                onClick={() => void loadOlder()}
                className="tap pointer-events-auto rounded-full border border-destructive/40 bg-background/95 px-3.5 py-1.5 text-[11px] text-destructive shadow-lg backdrop-blur-md"
              >
                加载更早的消息失败，点击重试
              </button>
            )}
          </div>
        )}

        {!isAtBottom && (
          <button
            type="button"
            onClick={scrollToBottom}
            className="tap absolute bottom-3 right-4 z-20 flex items-center gap-1.5 rounded-full border border-border bg-secondary/90 px-3.5 py-2 text-xs font-medium text-primary shadow-xl backdrop-blur-md transition-all"
          >
            <span>跳转至最新</span>
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="size-4"
            >
              <path d="M19 14l-7 7-7-7M12 21V3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </div>

      {!readOnly && !running && turnStatus === 'failed' && lastPrompt && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-4 py-2">
          <span className="text-xs text-muted-foreground">重新提交上一条指令</span>
          <Button
            variant="outline"
            className="min-h-11 shrink-0"
            disabled={retrying}
            onClick={() => void retryLastPrompt()}
          >
            {retrying ? '正在提交…' : '重试上一条'}
          </Button>
        </div>
      )}
      {sendError && (
        <div className="shrink-0 bg-destructive/15 px-3 py-1.5 text-center text-[11px] text-destructive">
          {sendError}
        </div>
      )}

      <Composer
        onSend={send}
        onStop={stop}
        running={running}
        disabled={readOnly}
        models={models}
        model={turnModel}
        effort={turnEffort}
        onModelChange={changeModel}
        onEffortChange={setTurnEffort}
        permission={turnPermission}
        onPermissionChange={setTurnPermission}
        cards={permissionCardsFor(session?.provider)}
        commands={commands}
        readOnly={
          readOnly
            ? {
                forking,
                error: forkError,
                onRetry: () => setLoadAttempt((attempt) => attempt + 1),
                onFork: forkAndContinue,
              }
            : undefined
        }
      />

      <ChatOverlays
        openFile={openFile}
        onCloseFile={() => setOpenFile(null)}
        onOpenFile={showFile}
        readOnly={readOnly}
        approvals={approvals}
        showDiff={showDiff}
        diff={diff}
        onCloseDiff={() => setShowDiff(false)}
      />

      {exportChoice && (
        <Sheet title="导出 Markdown" onClose={() => setExportChoice(null)}>
          <div className="space-y-2 px-4 pt-2 pb-4">
            <p className="px-0.5 text-[12px] text-muted-foreground">
              {exportChoice.kind === 'session' ? '整个会话' : `本轮：${exportChoice.label}`}
            </p>
            <Button
              type="button"
              variant="secondary"
              onClick={() => void runExport('conversation')}
              className="tap h-auto w-full py-3.5 text-[15px]"
            >
              仅对话内容
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => void runExport('full')}
              className="tap h-auto w-full py-3.5 text-[15px]"
            >
              完整记录（含思考、工具调用等）
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setExportChoice(null)}
              className="tap h-auto w-full py-3.5 text-[15px]"
            >
              取消
            </Button>
          </div>
        </Sheet>
      )}
    </div>
  )
}
