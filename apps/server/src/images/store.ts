/**
 * Content-addressed storage for the pictures a user sends to an agent.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Both agents store the image bytes the user sent — Codex in its rollout, Claude
 * in its session JSONL — and both echo them back. Neither echo used to be read:
 * `mapEvents` filtered the user message down to its text parts, so a phone that
 * sent a screenshot saw only the caption it typed ("描述图片") and no way to
 * check the picture the agent was actually describing.
 *
 * The bytes therefore already exist on disk, twice over, in files that are NOT
 * ours to touch. So this store only ever READS from the agents' files and writes
 * to its own directory: `.vibemobile/images/`. Nothing here ever writes to
 * `~/.codex` or `~/.claude`.
 *
 * ── Why content-addressed ───────────────────────────────────────────────────
 * The same picture can be sent repeatedly, and the same transcript is re-read on
 * every reconnect. Hashing the decoded bytes makes both cases collapse to one
 * file and one token, and makes the token immutable — which is what justifies
 * the one-year cache header the route serves. It also means a live event and a
 * later replay of that same event resolve to an identical token, so a thumbnail
 * never flickers or reloads.
 *
 * A useful consequence, and the reason there is no pruning here: the whole
 * directory is a pure cache. Deleting it is always safe, because re-reading a
 * transcript reconstructs it. See `put` for why that also makes pruning
 * pointless rather than merely absent.
 *
 * ── Shape ───────────────────────────────────────────────────────────────────
 * One file per distinct image, named `<sha256[:32]>.<ext>`. The extension is
 * part of the token because `get` has to answer with a Content-Type and the
 * bytes alone cannot tell it which one; without it, `get` would have to probe
 * four candidate extensions per request or keep a sidecar index. It also makes
 * "the token contains no path separator" a structural property of the format
 * rather than a rule someone has to remember.
 *
 * ── Instances ───────────────────────────────────────────────────────────────
 * Unlike `SessionPrefsStore`, this class holds no in-memory state — the
 * filesystem is the entire state. That is why the providers and the image route
 * each construct their own instance from the same `stateDir` instead of one
 * being threaded through: two instances cannot disagree about anything, because
 * neither remembers anything. Compare `providers/sessionPrefs.ts`, which caches
 * its parsed file and therefore must be a single object per file.
 *
 * Everything here fails soft. An unwritable state directory, a corrupt data
 * URL, an oversized image: all of them cost that one picture, never the turn it
 * arrived on. The agents' own files are the durable copy; this is a cache.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { AgentInput } from '@vibemobile/protocol'

/** Extension (and therefore the token's suffix) for each mime we accept. */
const EXTENSIONS: Record<string, { ext: string; mime: string }> = {
  'image/jpeg': { ext: 'jpg', mime: 'image/jpeg' },
  'image/png': { ext: 'png', mime: 'image/png' },
  'image/webp': { ext: 'webp', mime: 'image/webp' },
  'image/gif': { ext: 'gif', mime: 'image/gif' },
}

/** token -> mime, built from the table above so the two cannot drift. */
const MIMES: Record<string, string> = Object.fromEntries(Object.values(EXTENSIONS).map(({ ext, mime }) => [ext, mime]))

const TOKEN = /^[a-f0-9]{32}\.(jpg|png|webp|gif)$/
const DATA_URL = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.*)$/s

/**
 * A single decoded image may not exceed this. The client compresses to
 * `MAX_BYTES = 1_500_000` (`apps/web/src/lib/image.ts`), but that is the
 * client's promise about itself, not a guarantee the server can rely on — this
 * side is reachable by anything that speaks the WebSocket protocol.
 */
const MAX_BYTES = 10 * 1024 * 1024

/**
 * How many images one message may carry. Also enforced client-side (the
 * composer counts what it is holding), so this only bounds a hand-written
 * frame — but "the client promises" is not a guarantee, and this side is
 * reachable by anything that speaks the WebSocket protocol.
 *
 * The client-side cap alone was not enough, and the gap was invisible: the
 * limit was enforced on the way *out* of a transcript (re-reading a picture the
 * agent recorded) and nowhere on the way in, so an over-stuffed message reached
 * the agent intact and only lost its pictures when it was read back. See
 * `capImages`.
 */
export const MAX_PER_MESSAGE = 8

/**
 * Drop images beyond `MAX_PER_MESSAGE` from one outgoing message.
 *
 * Lives beside the constant because the two are one rule: an entry point that
 * imported the number without this function is how the gap above came to exist.
 *
 * Text is never dropped — an image that did not fit must not take the
 * instruction with it — and the survivors keep their order.
 */
export function capImages(input: AgentInput[]): AgentInput[] {
  let seen = 0
  return input.filter((part) => {
    if (part.type !== 'image') return true
    seen += 1
    return seen <= MAX_PER_MESSAGE
  })
}

/** Counter making each temp file name unique within this process. */
let tempCounter = 0

export class ImageStore {
  #dir: string
  #log?: (line: string) => void

  constructor(dir: string, log?: (line: string) => void) {
    this.#dir = dir
    this.#log = log
  }

  /**
   * Persist one `data:` URL and return its token, or `null` if it is not
   * something we will store.
   *
   * Rejection is a return value rather than a throw on purpose: the callers are
   * transcript mappers, and a malformed image must cost that image alone. It is
   * also the norm rather than an error — `svg` is refused deliberately (see
   * below), and re-`put`ting an image another message already stored is the
   * common path, not a failure.
   *
   * Why there is no size cap on the directory: every read of a transcript
   * re-puts every image it contains, so anything deleted to stay under a limit
   * is restored by the next read. A limit would only ever be enforced against a
   * session someone is looking at — the thumbnails would break and the disk
   * would refill. Growth is bounded by the number of distinct images ever sent,
   * which for a single-user app is nothing, and the directory can be deleted
   * wholesale at any time (it rebuilds itself). See README 已知限制.
   */
  put(dataUrl: string): string | null {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return null

    const match = DATA_URL.exec(dataUrl)
    if (!match) return null
    const [, declaredMime, base64] = match

    // Whitelist, not a denylist: `image/svg+xml` must never be served. An SVG
    // is a script, this route is same-origin with the app, and the app holds
    // an authenticated session — that combination is an XSS primitive. Only
    // formats that are inert when rendered by an <img> are accepted.
    const format = EXTENSIONS[declaredMime!.toLowerCase()]
    if (!format) return null

    // `Buffer.from` ignores non-base64 characters, so a malformed string
    // decodes to something rather than throwing. Length is checked after, so
    // over-long input is rejected before a large allocation happens in hash.
    const bytes = Buffer.from(base64!, 'base64')
    if (bytes.length === 0 || bytes.length > MAX_BYTES) return null

    // Hash the DECODED bytes, not the base64 text: the same image sent by two
    // clients with different encodings (padding, line breaks) is one image.
    const id = `${crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 32)}.${format.ext}`
    const file = path.join(this.#dir, id)

    try {
      // Dedupe: the overwhelmingly common case after the first send, and the
      // only case during a transcript re-read.
      if (fs.existsSync(file)) return id

      fs.mkdirSync(this.#dir, { recursive: true })
      // A fixed `.tmp` name would have two processes writing the same picture
      // truncate each other — and during development there genuinely are two
      // (the dev server and the deployed service share this directory).
      const tmp = `${file}.${process.pid}.${tempCounter++}.tmp`
      fs.writeFileSync(tmp, bytes, { flag: 'wx', mode: 0o600 })
      fs.renameSync(tmp, file)
      return id
    } catch (err) {
      // Windows antivirus holding a freshly written file is the realistic
      // cause (EPERM/EBUSY on rename); a read-only state directory is another.
      // Either way the picture is simply not stored, and the caller omits it.
      this.#log?.(`could not store image ${id}: ${(err as Error).message}`)
      return null
    }
  }

  /**
   * Resolve a token to a file on disk.
   *
   * The token is validated as a whole before any path is built, so a request
   * for `../../.vibemobile/state.json` fails the pattern and never reaches the
   * filesystem. Nothing that came from a client is ever joined onto a path.
   */
  get(id: string): { path: string; mime: string } | null {
    if (typeof id !== 'string' || !TOKEN.test(id)) return null
    const file = path.join(this.#dir, id)
    try {
      if (!fs.statSync(file).isFile()) return null
    } catch {
      // Missing is the ordinary outcome for an image sent before the store
      // existed, or one whose directory was cleared. Not worth a log line.
      return null
    }
    return { path: file, mime: MIMES[id.slice(33)]! }
  }
}
