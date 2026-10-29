import { useEffect, useRef, useState } from 'react'
import {
  ArrowUp,
  Eye,
  GitFork,
  Image as ImageIcon,
  Mic,
  Plus,
  RefreshCw,
  Shield,
  ShieldAlert,
  Square,
  TriangleAlert,
} from 'lucide-react'
import type { AgentInput, ApprovalPolicy, ModelInfo, SandboxMode } from '@vibemobile/protocol'
import { Button } from './ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { MAX_IMAGES, prepareImage, type PreparedImage } from '../lib/image'
import { PERMISSIONS, type PermissionCard } from '../lib/permission'
import { speechSupported, startDictation, type Dictation } from '../lib/speech'

export interface TurnOptions {
  approvalPolicy?: ApprovalPolicy
  sandbox?: SandboxMode
  effort?: string
}

interface Props {
  onSend: (input: AgentInput[], opts?: TurnOptions) => void
  onStop: () => void
  running: boolean
  disabled?: boolean
  models: ModelInfo[]
  model: string
  effort: string
  onModelChange: (model: string) => void
  onEffortChange: (effort: string) => void
  /**
   * Owned by the page, not by this component. It is not a per-render UI
   * preference: it is the session's current permission level, which the page
   * seeds from what the provider says the session is running and keeps for as
   * long as the session is open. Held here, leaving the chat and coming back
   * silently reset it to the safe card — and the next message then ran
   * guarded for a user who had just chosen 完全访问.
   */
  permission: PermissionCard
  onPermissionChange: (permission: PermissionCard) => void
  /**
   * The cards this session's provider can actually be driven with, from
   * `permissionCardsFor()`. Passed in rather than computed here for the same
   * reason `models` is: the composer stays provider-blind, the page supplies the
   * provider-specific data. 自动判断 is Claude-only, so a Codex session must not
   * be offered it — and the seed value must come from the same list, or the
   * trigger renders empty.
   */
  cards: PermissionCard[]
  /**
   * The backend's slash commands for this session, from `commands.updated`.
   *
   * Empty is the normal state for two different reasons — Codex has no such
   * concept, and a Claude session has not published its list until its first
   * turn has started — and both mean the same thing to the user: there is no
   * menu. Nothing here should render a spinner or an error for an empty list.
   */
  commands: string[]
  readOnly?: {
    forking: boolean
    error: string | null
    onRetry: () => void
    onFork: () => void
  }
}

const EFFORT_LABELS: Record<string, string> = {
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最大',
  ultra: '超高',
}

/* Radix rejects <SelectItem value="">, so "no explicit choice" needs a real
 * string. Both are translated back to '' at the boundary -- Chat treats '' as
 * "let the server decide" and passes `model: turnModel || undefined`. */
const MODEL_DEFAULT = '__default__'
const EFFORT_AUTO = '__auto__'

/* The trigger sits inside the composer box, which already carries the only
 * border, so every borderless trigger below undoes the base styling by hand.
 * The `dark:` overrides are spelled out because tailwind-merge does NOT merge
 * across variant modifiers: the base's `dark:bg-input/30` survives a plain
 * `bg-transparent` and would paint a grey pill on a phone in dark mode.
 * `[&>svg]:hidden` drops the chevron SelectTrigger always renders -- the model
 * chip draws one shared arrow for both of its selects.
 *
 * 44px, not the base 36px: this is the app's touch-target floor, and the row
 * these sit in is already 44px tall because of the two `.tap` buttons flanking
 * them -- so the height costs no layout, it only stops the triggers from being
 * the one thing in the row you can miss.
 *
 * The height MUST be written as `data-[size=default]:h-11`. SelectTrigger takes
 * it from a data-variant selector, which outranks a plain `h-11` -- and
 * tailwind-merge will not cancel across variant modifiers anyway. Measured:
 * with a bare `h-11` these render 36px. */
const BARE_TRIGGER =
  'h-11 gap-0 rounded-lg border-0 bg-transparent text-[13px] font-medium shadow-none focus-visible:ring-0 data-[size=default]:h-11 dark:bg-transparent dark:hover:bg-transparent [&>svg]:hidden'

export default function Composer({
  onSend,
  onStop,
  running,
  disabled,
  models,
  model,
  effort,
  onModelChange,
  onEffortChange,
  permission,
  onPermissionChange,
  cards,
  commands,
  readOnly,
}: Props) {
  const [text, setText] = useState('')
  const [images, setImages] = useState<PreparedImage[]>([])
  const [imageError, setImageError] = useState<string | null>(null)
  const [dropping, setDropping] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [dictating, setDictating] = useState(false)
  const [speechError, setSpeechError] = useState<string | null>(null)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [slashIndex, setSlashIndex] = useState(0)

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const dictationRef = useRef<Dictation | null>(null)
  const dictationBaseRef = useRef('')
  /** The highlighted row, so the list can be scrolled to follow the arrows. */
  const activeSlashRef = useRef<HTMLButtonElement>(null)

  const selectedModel = models.find((item) => item.id === model) ?? models[0]
  const effortOptions = selectedModel?.efforts ?? []
  const canSend = !disabled && (text.trim().length > 0 || images.length > 0)

  // The command menu is derived from the text, not held as its own open flag:
  // there is exactly one state where it belongs on screen — a single token that
  // starts with a slash — and deriving it means no code path can leave it open
  // over a message that is no longer a command. A space closes it (the command
  // is named, arguments follow), and so does deleting the slash.
  const slashQuery = /^\/[^\s]*$/.test(text) ? text.slice(1) : null
  const slashMatches =
    slashQuery === null || disabled ? [] : commands.filter((command) => command.startsWith(slashQuery))
  const slashOpen = slashMatches.length > 0

  // One button, two jobs. While a turn runs the primary action is "stop", but
  // only until there is something to say: as soon as the box has text the same
  // button steers the running turn instead (which is what send() does mid-turn).
  // Two side-by-side buttons -- a red stop next to a send -- made the row read
  // as two equally likely actions when one of them is almost always the answer.
  const showStop = running && !canSend

  // Two levels warn, each for its own reason, and they do not share a glyph.
  // 完全访问 removes the sandbox; 自动判断 removes the approval loop and puts
  // nothing on screen in its place (measured: the SDK's `canUseTool` is never
  // called under it). Drawn like the quiet default it would make "the agent
  // stopped asking" invisible, which is the one thing this picker exists to
  // show.
  const permissionWarns = permission === 'unattended' || permission === 'auto'
  const permissionGlyph =
    permission === 'unattended' ? (
      <TriangleAlert className="size-4 text-warning" />
    ) : permission === 'auto' ? (
      <ShieldAlert className="size-4 text-warning" />
    ) : (
      <Shield className="size-4 text-muted-foreground" />
    )

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`
  }, [text])

  useEffect(() => () => dictationRef.current?.stop(), [])

  // Back to the top whenever the filter changes: keeping the old index would
  // highlight an unrelated command after the first keystroke.
  useEffect(() => setSlashIndex(0), [slashQuery])
  useEffect(() => {
    activeSlashRef.current?.scrollIntoView({ block: 'nearest' })
  }, [slashIndex])

  /**
   * Put a command in the box — it is not sent.
   *
   * Tapping a row used to be tempting to wire straight to `send()`, and that
   * would be wrong twice: the CLI's commands take arguments (`/model opus`),
   * and a mis-tap would fire an action with no way to think about it. The text
   * goes in with a trailing space and the user presses send, exactly as if they
   * had typed it — which is also what makes this work at all, since the CLI
   * expands commands from ordinary prompt text (measured: `probe-slash.ts`).
   */
  function insertCommand(name: string) {
    setText(`/${name} `)
    textareaRef.current?.focus()
  }

  function send() {
    if (!canSend) return
    const input: AgentInput[] = images.map(({ dataUrl }) => ({ type: 'image' as const, url: dataUrl }))
    if (text.trim()) input.push({ type: 'text', text: text.trim() })

    const selectedPermission = PERMISSIONS[permission]
    onSend(input, {
      approvalPolicy: selectedPermission.approvalPolicy,
      sandbox: selectedPermission.sandbox,
      effort: effort || undefined,
    })
    setText('')
    setImages([])
    setToolsOpen(false)
    stopDictation()
  }

  /**
   * Prepare and attach pictures, from the picker, a paste, or a drop.
   *
   * One at a time on purpose: `prepareImage` decodes a full-size photo and
   * re-encodes it on a canvas, and a phone asked to do eight of those at once
   * stalls the whole page — including the thumbnails the user is watching for.
   *
   * The cap is applied here rather than on the server alone so the user learns
   * about the ninth picture while the caption is still being typed. The
   * overflow is *reported*, never silent: a message quietly sent with fewer
   * pictures than the user attached is the one outcome worse than an error.
   */
  async function addImages(files: Iterable<File>): Promise<void> {
    const incoming = [...files].filter((file) => file.type.startsWith('image/'))
    if (incoming.length === 0) return
    setPreparing(true)
    setImageError(null)
    // Counted locally rather than re-read from state: the loop awaits, and the
    // array this handler closed over is not the one that will be current by the
    // second picture.
    const room = Math.max(0, MAX_IMAGES - images.length)
    const accepted = incoming.slice(0, room)
    let failure: string | null = null
    try {
      for (const file of accepted) {
        try {
          const ready = await prepareImage(file)
          setImages((current) => [...current, ready])
        } catch (err) {
          failure = (err as Error).message
        }
      }
      // Set last, so it is the message the user is left with: "that picture was
      // unreadable" is less important than "eight is the limit" when both are
      // true, because only the second one is about the message they are writing.
      if (accepted.length < incoming.length) failure = `最多只能发 ${MAX_IMAGES} 张图片`
      setImageError(failure)
      setToolsOpen(false)
    } finally {
      setPreparing(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  function toggleDictation() {
    if (dictating) {
      stopDictation()
      return
    }
    setSpeechError(null)
    setToolsOpen(false)
    dictationBaseRef.current = text ? `${text.trimEnd()} ` : ''
    setDictating(true)
    dictationRef.current = startDictation(
      (transcript, isFinal) => {
        setText(dictationBaseRef.current + transcript)
        if (isFinal) dictationBaseRef.current += transcript
      },
      (message) => {
        setSpeechError(message)
        setDictating(false)
        dictationRef.current = null
      },
    )
  }

  function stopDictation() {
    dictationRef.current?.stop()
    dictationRef.current = null
    setDictating(false)
  }

  if (readOnly) {
    return (
      <div className="safe-bottom shrink-0 px-3 pt-1">
        <div className="rounded-2xl border border-border bg-card p-1.5">
          <div className="min-h-[38px] px-2 py-1.5 text-[16px] leading-relaxed text-muted-foreground">
            会话正在电脑端使用，当前仅可查看
          </div>
          {readOnly.error && <div className="px-2 pb-1 text-[11px] text-destructive">{readOnly.error}</div>}
          <div className="flex items-center gap-1">
            <span className="tap -ml-1.5 rounded-full text-warning" aria-hidden="true">
              <Eye className="size-5" />
            </span>
            <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">只读查看</span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={readOnly.onRetry}
              disabled={readOnly.forking}
              className="tap shrink-0 rounded-full text-muted-foreground"
              aria-label="重新尝试打开会话"
              title="重试接管"
            >
              <RefreshCw className="size-4.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={readOnly.onFork}
              disabled={readOnly.forking}
              className="tap shrink-0 rounded-full text-muted-foreground"
              aria-label="创建会话副本"
              title="创建副本继续"
            >
              <GitFork className="size-4.5" />
            </Button>
          </div>
        </div>
      </div>
    )
  }

  // One rounded box holds the whole composer: the input on top, one row of
  // controls underneath. The controls are deliberately borderless -- as three
  // bordered <select> boxes in a row above the input they read as a form, and
  // the two rows pushed the transcript up by another 40px. Only the box itself
  // is drawn; everything inside is text on the surface, like the reference.
  return (
    <div className="safe-bottom shrink-0 px-3 pt-1">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop target; keyboard users attach files through the picker */}
      {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: drag-and-drop target; keyboard users attach files through the picker */}
      <div
        className={`rounded-2xl border bg-card p-1.5 ${dropping ? 'border-primary border-dashed' : 'border-border'}`}
        // Both handlers are needed: `dragover` is what marks this element as a
        // drop target, and without it the browser refuses the drop outright —
        // `onDrop` alone never fires. Desktop-only in practice, which is
        // exactly why it is worth having: dragging a screenshot in is the one
        // way to attach a picture that does not go through the phone's picker.
        onDragOver={(event) => {
          event.preventDefault()
          setDropping(true)
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(event) => {
          setDropping(false)
          const files = [...(event.dataTransfer?.files ?? [])]
          if (files.length === 0) return
          event.preventDefault()
          void addImages(files)
        }}
      >
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(event) => void addImages(event.target.files ?? [])}
        />

        {images.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 px-1.5 pt-1">
            {images.map((image, index) => (
              <div key={`${image.dataUrl.slice(-24)}-${index}`} className="relative">
                <img
                  src={image.dataUrl}
                  alt={`待发送图片 ${index + 1}`}
                  className="h-12 w-12 rounded-lg border border-border object-cover"
                />
                {/* size="icon-xs" is size-6 -- deliberately not `.tap`, since a
                    44px hit area centred on this corner would swallow a third of
                    the 48px thumbnail it sits on. */}
                <Button
                  type="button"
                  variant="secondary"
                  size="icon-xs"
                  onClick={() => setImages((current) => current.filter((_, i) => i !== index))}
                  className="absolute -right-1.5 -top-1.5 rounded-full shadow-md"
                  aria-label={`移除第 ${index + 1} 张图片`}
                >
                  ×
                </Button>
              </div>
            ))}
            <span className="text-[11px] text-muted-foreground">
              {images.length} 张 · {Math.round(images.reduce((sum, i) => sum + i.bytes, 0) / 1024)} KB
            </span>
          </div>
        )}

        {(imageError || speechError) && (
          <div className="px-1.5 pt-1 text-xs text-destructive">{imageError ?? speechError}</div>
        )}

        {/* In flow above the textarea, not an overlay: the box grows and the
            transcript gives up the space, so the list can never cover the line
            being typed or the send button. */}
        {slashOpen && (
          <div className="scroll-y mb-1 max-h-[38dvh] border-b border-border pb-1">
            {slashMatches.map((command, i) => (
              <button
                key={command}
                ref={i === slashIndex ? activeSlashRef : undefined}
                type="button"
                // Keeps the phone's keyboard up: without it, tapping a row
                // blurs the textarea first and the menu closes under the finger.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => insertCommand(command)}
                className={`flex w-full items-center rounded-lg px-2 py-2 text-left font-mono text-[13px] ${
                  i === slashIndex ? 'bg-secondary text-foreground' : 'text-muted-foreground'
                }`}
              >
                /{command}
              </button>
            ))}
          </div>
        )}

        <textarea
          ref={textareaRef}
          rows={1}
          value={text}
          disabled={disabled}
          onChange={(event) => setText(event.target.value)}
          // Screenshots arrive on the clipboard as a file and nothing else —
          // there is no text form to lose, so the default insertion is
          // suppressed. When a paste carries both (a picture copied off a web
          // page), the browser offers it as a file here too and an <img> tag is
          // not something this box can use anyway.
          onPaste={(event) => {
            const files = [...(event.clipboardData?.files ?? [])]
            if (files.length === 0) return
            event.preventDefault()
            void addImages(files)
          }}
          onKeyDown={(event) => {
            // With the menu up, the arrows pick a command and Enter takes it —
            // the opposite of what the keys do otherwise, which is the
            // convention everywhere else and what makes this usable without a
            // touch screen.
            if (slashOpen) {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setSlashIndex((i) => Math.min(i + 1, slashMatches.length - 1))
                return
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault()
                setSlashIndex((i) => Math.max(i - 1, 0))
                return
              }
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                insertCommand(slashMatches[slashIndex])
                return
              }
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              send()
            }
          }}
          placeholder={running ? '追加指令（输入当前任务）…' : '给代理下达任务…'}
          // 16px, not 15px: below 16px iOS Safari zooms the viewport when the
          // field takes focus (the rule at the top of styles.css).
          className="scroll-y max-h-[140px] min-h-[38px] w-full resize-none bg-transparent px-2 py-1.5 text-[16px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
        />

        <div className="flex items-center gap-1">
          {/* Was a hand-rolled popover with no outside-click and no Escape;
              Radix supplies both, plus focus management. */}
          <DropdownMenu open={toolsOpen} onOpenChange={setToolsOpen}>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={disabled}
                aria-label="添加图片或语音输入"
                className={`tap -ml-1.5 rounded-full text-muted-foreground ${
                  toolsOpen ? 'bg-secondary text-foreground' : ''
                }`}
              >
                <Plus className="size-5" />
              </Button>
            </DropdownMenuTrigger>
            {/* z-30, not the default z-50: this menu belongs below the full
                screen diff overlay (z-40), same as before the migration. */}
            <DropdownMenuContent side="top" align="start" className="z-30 w-36">
              <DropdownMenuItem disabled={preparing || disabled} onSelect={() => fileRef.current?.click()}>
                <ImageIcon className="size-4" />
                图片
              </DropdownMenuItem>
              {speechSupported() && (
                <DropdownMenuItem disabled={disabled} onSelect={toggleDictation}>
                  <Mic className="size-4" />
                  语音输入
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Permission mode. The levels that take away a stopping point get a
              warning glyph and colour -- the safe ones are the quiet default and
              should not compete for attention. */}
          <div className="relative shrink-0">
            <span className="pointer-events-none absolute left-2 top-1/2 z-10 -translate-y-1/2">{permissionGlyph}</span>
            <Select value={permission} onValueChange={(value) => onPermissionChange(value as PermissionCard)}>
              <SelectTrigger
                aria-label="权限"
                className={`${BARE_TRIGGER} w-[6rem] px-0 pl-6 ${
                  permissionWarns ? 'text-warning' : 'text-muted-foreground'
                }`}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" side="top" align="start">
                {cards.map((card) => (
                  <SelectItem key={card} value={card}>
                    {PERMISSIONS[card].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Model and effort read as one chip: "GPT-5.6-Luna 极高" with a
              single chevron. They stay two <select>s because they are two
              independent choices -- merging them into one list would tie the
              effort options to whichever model happened to be listed first.
              The model takes whatever is left over and ellipsizes: it is the
              one label here whose length is not ours to choose. */}
          <div className="relative flex min-w-0 flex-1 items-center justify-end">
            <Select
              value={model || MODEL_DEFAULT}
              onValueChange={(value) => onModelChange(value === MODEL_DEFAULT ? '' : value)}
            >
              <SelectTrigger
                aria-label="模型"
                disabled={disabled || models.length === 0}
                /* justify-end: the base is justify-between, which with the
                   chevron hidden would push the value to the left edge. */
                className={`${BARE_TRIGGER} min-w-0 flex-1 justify-end px-2 text-right text-foreground/90 disabled:opacity-50`}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" side="top" align="end" className="max-w-[75vw]">
                <SelectItem value={MODEL_DEFAULT}>默认模型</SelectItem>
                {model && !models.some((item) => item.id === model) && <SelectItem value={model}>{model}</SelectItem>}
                {models.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.displayName || item.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={effort || EFFORT_AUTO}
              onValueChange={(value) => onEffortChange(value === EFFORT_AUTO ? '' : value)}
            >
              <SelectTrigger
                aria-label="思考强度"
                disabled={disabled || effortOptions.length === 0}
                className={`${BARE_TRIGGER} w-[3.5rem] shrink-0 pl-1 pr-5 text-foreground/90 disabled:opacity-50`}
              >
                <SelectValue placeholder="自动" />
              </SelectTrigger>
              <SelectContent position="popper" side="top" align="end">
                {/* Radix renders an EMPTY trigger when `value` has no matching
                    item, and `effort` need not come from this model's list: it
                    is restored from the session (`.vibemobile/*-sessions.json`)
                    and can name a level the model on screen does not offer —
                    a stale value after the model was switched, or a session
                    opened on another device. Same guard as the model select
                    above, and it has to stay the same or the chip loses half
                    its label. */}
                {effortOptions.length === 0 && <SelectItem value={EFFORT_AUTO}>自动</SelectItem>}
                {effort && !effortOptions.includes(effort) && (
                  <SelectItem value={effort}>{EFFORT_LABELS[effort] ?? effort}</SelectItem>
                )}
                {effortOptions.map((item) => (
                  <SelectItem key={item} value={item}>
                    {EFFORT_LABELS[item] ?? item}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <ChevronIcon />
          </div>

          {/* Both buttons keep `variant="default"` on purpose -- see the note
              above `showStop`. `.tap` is what holds them at 44px: the size-9
              from `size="icon"` loses to min-width/min-height in the box model.
              `active:bg-white` went away with the migration because --primary
              is now oklch(0.922), which is close enough to white that the flash
              was no longer visible; `.tap`'s scale supplies the press feedback.
              `title` was dropped too -- tooltips do not exist on touch. */}
          {showStop ? (
            <Button
              type="button"
              size="icon"
              onClick={onStop}
              className="tap shrink-0 rounded-full"
              aria-label="中断当前任务"
            >
              <Square className="size-3.5 fill-current" />
            </Button>
          ) : (
            <Button
              type="button"
              size="icon"
              onClick={send}
              disabled={!canSend}
              className="tap shrink-0 rounded-full disabled:opacity-25"
              aria-label={running ? '追加指令' : '发送'}
            >
              <ArrowUp className="size-5" />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

/* The only icon left over from the hand-drawn set: the model chip's two
 * selects hide their own chevrons (`[&>svg]:hidden`) and share this one. */
function ChevronIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground"
      aria-hidden="true"
    >
      <path d="m7 10 5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
