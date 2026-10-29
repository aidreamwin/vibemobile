/**
 * End-to-end check that a picture the user sends comes back on the transcript.
 *
 * This is the one thing unit tests cannot cover: the field name the app-server
 * uses when it ECHOES a user message. The outbound path sends `{type:'image',
 * url}`; the echo arrives as `{type:'image', image_url}` (captured from a real
 * rollout, and the reason `mapEvents.test.ts` was rewritten). If the two ever
 * agree in the other direction, only a real app-server will say so.
 *
 * Goes through `CodexProvider` rather than raw JSON-RPC on purpose: the
 * provider is what wires `normalizeItem` to the `ImageStore`, so this covers
 * the seam between them, not just the protocol underneath it.
 *
 * Success criteria:
 *   1. the live user item carries `images: ['<32 hex>.png']`
 *   2. exactly ONE item is emitted for the message — no separate `imageView`
 *      alongside it (which would render the screenshot twice)
 *   3. that token reads back byte-identical from the store
 *   4. `getTranscript` resolves the same image to the SAME token, so opening
 *      the session later neither re-transfers nor flickers
 *
 * Usage: npx tsx apps/server/scripts/smoke-image.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentEvent } from '@vibemobile/protocol'
import { CodexProvider } from '../src/codex/CodexProvider.js'
import { ImageStore } from '../src/images/store.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../..')

// A 1x1 PNG. Small, but real bytes with a real hash.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

// A scratch state dir, so the run never touches `.vibemobile/` — and so the
// store under test is the only thing in it.
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-smoke-image-'))

const provider = new CodexProvider({
  // 6813 = the next free one-shot port in the 68xx band (see scripts/dev.mjs).
  port: 6813,
  workspaceRoots: [ROOT],
  stateDir,
  onLog: (line) => {
    if (/error|warn/i.test(line)) console.log(`  [codex] ${line}`)
  },
})

const store = new ImageStore(path.join(stateDir, 'images'))

function fail(reason: string): never {
  console.error(`\n[smoke-image] FAILED: ${reason}`)
  provider.stop().finally(() => {
    fs.rmSync(stateDir, { recursive: true, force: true })
    process.exit(1)
  })
  throw new Error(reason)
}

async function main() {
  await provider.start()

  console.log('=== creating session ===')
  const session = await provider.createSession({ cwd: ROOT })
  console.log({ id: session.id })

  const items: AgentEvent[] = []
  let userItem: any = null
  let done = false

  provider.subscribe(async (event) => {
    if (event.kind === 'item.started' || event.kind === 'item.completed') {
      if (event.threadId !== session.id) return
      items.push(event)
      const item: any = (event as any).item
      if (item?.kind === 'message' && item.role === 'user') {
        userItem = item
        console.log(
          `\n  <<< ${event.kind} user message: text=${JSON.stringify(item.text)} images=${JSON.stringify(item.images)}`,
        )
      } else if (item?.kind === 'image') {
        console.log(`\n  <<< ${event.kind} imageView item: ${String(item.url).slice(0, 40)}…`)
      }
    }
    if ((event as any).kind === 'turn.completed') done = true
  })

  console.log('=== sending an image with a caption ===')
  await provider.startTurn(session.id, [
    { type: 'image', url: `data:image/png;base64,${PNG_B64}` },
    { type: 'text', text: '说明这张图是什么，一句话。' },
  ])

  const deadline = Date.now() + 120_000
  while (!done && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200))

  if (!done) fail('turn never completed within 120s')
  if (!userItem) fail('no user message item was emitted at all')
  if (!userItem.images?.length) {
    fail(`the user item carried no images — the echo shape may have changed. item: ${JSON.stringify(userItem)}`)
  }

  const token = String(userItem.images[0])
  if (!/^[a-f0-9]{32}\.png$/.test(token)) fail(`token ${token} is not <sha32>.png`)

  // 2. No `imageView` twin. The app-server echoes the attachment as part of the
  // user message; a second item carrying the same picture would render it twice.
  const extras = items.filter((e: any) => e.item?.kind === 'image')
  if (extras.length) fail(`expected no imageView items, saw ${extras.length}`)

  // 3. Byte-for-byte.
  const found = store.get(token)
  if (!found) fail(`the store cannot resolve its own token ${token}`)
  const stored = fs.readFileSync(found.path).toString('base64')
  if (stored !== PNG_B64) fail(`stored bytes differ from what was sent (${stored.length} vs ${PNG_B64.length} chars)`)

  // 4. Replay agreement.
  const transcript = await provider.getTranscript(session.id)
  const replayMessage: any = transcript?.turns
    .flatMap((t: any) => t.items)
    .find((i: any) => i.kind === 'message' && i.role === 'user')
  if (!replayMessage) fail('the transcript contains no user message')
  if (replayMessage.images?.[0] !== token) {
    fail(`replay resolved to ${JSON.stringify(replayMessage.images)}, live said ${token}`)
  }

  console.log(`\n${'-'.repeat(60)}`)
  console.log(`[smoke-image] token        : ${token}`)
  console.log(`[smoke-image] mime         : ${found.mime}`)
  console.log(`[smoke-image] stored bytes : ${stored.length} base64 chars, identical to what was sent`)
  console.log(`[smoke-image] replay       : same token`)

  await provider.stop()
  fs.rmSync(stateDir, { recursive: true, force: true })
  console.log('\n[smoke-image] PASSED — a sent image survives to the transcript.')
  process.exit(0)
}

main().catch(async (err) => {
  console.error('\n[smoke-image] FATAL:', err)
  await provider.stop().catch(() => {})
  fs.rmSync(stateDir, { recursive: true, force: true })
  process.exit(1)
})
