/**
 * Does the session listing still list, and do the archive filter and the title
 * search do what `routes/sessions.ts` assumes?
 *
 *   npx tsx apps/server/scripts/probe-listing.ts [needle]
 *
 * Reads the REAL stores of both CLIs — that is the point, because the filter
 * runs against real titles rather than fixtures. Read-only: Claude's archive
 * flag goes to a throwaway prefs directory, so nothing here can hide a session
 * from the phone.
 */
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ClaudeProvider } from '../src/claude/ClaudeProvider.js'
import { CodexProvider } from '../src/codex/CodexProvider.js'

const prefsDir = mkdtempSync(path.join(os.tmpdir(), 'vm-probe-prefs-'))
const needle = process.argv[2] ?? null

const show = (rows: { id: string; title: string; pinned?: boolean; archived?: boolean }[]) =>
  rows
    .slice(0, 6)
    .map(
      (s) => `  ${s.id.slice(0, 8)}  ${JSON.stringify(s.title)}${s.pinned ? ' PIN' : ''}${s.archived ? ' ARCH' : ''}`,
    )
    .join('\n')

const claude = new ClaudeProvider({ workspaceRoots: [process.cwd()], stateDir: prefsDir })
await claude.start()

console.log('=== Claude ===')
const all = await claude.listSessions({ limit: 200 })
console.log(`unarchived: ${all.length}\n${show(all)}`)
const arch = await claude.listSessions({ limit: 200, archived: true })
console.log(`archived: ${arch.length}\n${show(arch)}`)

// Round trip through the provider, on a real id, then undo it.
const victim = all[0]
if (victim) {
  await claude.archiveSession(victim.id, true)
  const hidden = await claude.listSessions({ limit: 200 })
  const inArchive = await claude.listSessions({ limit: 200, archived: true })
  console.log(
    `archive round trip: gone from the list=${!hidden.some((s) => s.id === victim.id)} present in the archive=${inArchive.some((s) => s.id === victim.id)}`,
  )
  await claude.pinSession(victim.id, true)
  const pinned = (await claude.listSessions({ limit: 200, archived: true })).find((s) => s.id === victim.id)
  console.log(`pin round trip: ${pinned?.pinned === true}`)
  await claude.pinSession(victim.id, false)
  await claude.archiveSession(victim.id, false)
  const back = await claude.listSessions({ limit: 200 })
  console.log(`unarchive round trip: back in the list=${back.some((s) => s.id === victim.id)}`)
}

for (const term of [needle, ...(needle ? [needle.toUpperCase(), needle.toLowerCase()] : [])].filter(
  Boolean,
) as string[]) {
  const hits = await claude.listSessions({ limit: 200, search: term })
  console.log(`search ${JSON.stringify(term)} -> ${hits.length}\n${show(hits)}`)
}
console.log(`search "" (absent) -> ${(await claude.listSessions({ limit: 200, search: '' })).length}`)
console.log(`search nonsense -> ${(await claude.listSessions({ limit: 200, search: 'zzzz-nope-zzzz' })).length}`)

// `hasMore` is the truncation notice, and the only way to see it is against a
// session with more turns than the page. Picked by asking every session for one
// turn and keeping the first that comes back with one.
/**
 * Two pages through the cursor. The turn ids are not comparable across pages
 * (Claude's are positional), so the first item of each turn is the identity,
 * and what matters is that the second page is disjoint and older.
 */
async function paging(provider: ClaudeProvider | CodexProvider, id: string) {
  const key = (turn: any) => turn.items[0]?.id ?? turn.id
  const first = await provider.getTranscript(id, { limit: 2 })
  const seen = new Set((first?.turns ?? []).map(key))
  let turns = first?.turns.length ?? 0
  let cursor = first?.nextCursor ?? null
  let pages = 1
  let overlap = 0
  // Bounded so a cursor that never terminates shows up as `exhausted=false`
  // instead of hanging the probe.
  while (cursor && pages < 60) {
    const next = await provider.getTranscript(id, { limit: 2, cursor })
    for (const turn of next?.turns ?? []) {
      const k = key(turn)
      if (seen.has(k)) overlap++
      else seen.add(k)
      turns++
    }
    pages++
    cursor = next?.nextCursor ?? null
  }
  console.log(
    `  paged: pages=${pages} turns=${turns} overlap=${overlap} ` +
      `exhausted=${cursor === null} firstHasMore=${first?.hasMore === true}`,
  )
}

console.log('\n=== transcript paging (Claude) ===')
for (const s of all.slice(0, 30)) {
  const full = await claude.getTranscript(s.id)
  const n = full?.turns.length ?? 0
  if (n < 2) continue
  const one = await claude.getTranscript(s.id, { limit: 1 })
  console.log(
    `  ${s.id.slice(0, 8)}: ${n} turns | limit=1 -> ${one?.turns.length} turn(s) hasMore=${one?.hasMore ?? false} | unrestr. hasMore=${full?.hasMore ?? false}`,
  )
  await paging(claude, s.id)
  break
}

console.log('\n=== Codex ===')
// Port 6880, not the usual 6800, and that is the point: the deployed service
// keeps its own app-server on 6800 for the whole life of the process, and two
// app-servers cannot share one port. See the port-segmentation note in
// CLAUDE.md — a probe that tried to reuse it would fail to start.
const codex = new CodexProvider({ workspaceRoots: [process.cwd()], stateDir: prefsDir, port: 6880 })
await codex.start()
const cAll = await codex.listSessions({ limit: 200 })
console.log(`unarchived: ${cAll.length}\n${show(cAll)}`)
if (needle) {
  const cHits = await codex.listSessions({ limit: 200, search: needle })
  console.log(`search ${JSON.stringify(needle)} -> ${cHits.length}\n${show(cHits)}`)
}
console.log(`search nonsense -> ${(await codex.listSessions({ limit: 200, search: 'zzzz-nope-zzzz' })).length}`)
console.log(`archived listing -> ${(await codex.listSessions({ limit: 200, archived: true })).length}`)

console.log('\n=== transcript paging (Codex) ===')
for (const s of cAll.slice(0, 30)) {
  const full = await codex.getTranscript(s.id)
  const n = full?.turns.length ?? 0
  if (n < 2) continue
  const one = await codex.getTranscript(s.id, { limit: 1 })
  console.log(
    `  ${s.id.slice(0, 8)}: ${n} turns | limit=1 -> ${one?.turns.length} turn(s) hasMore=${one?.hasMore ?? false} | unrestr. hasMore=${full?.hasMore ?? false}`,
  )
  await paging(codex, s.id)
  break
}

await codex.stop()
await claude.stop()
process.exit(0)
