import fs, { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionPrefsStore } from './sessionPrefs.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'vibemobile-prefs-test-'))
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

const file = () => path.join(dir, 'claude-sessions.json')

describe('SessionPrefsStore', () => {
  it('remembers model and effort for a session', () => {
    const prefs = new SessionPrefsStore(file())
    prefs.set('a', { model: 'opus', effort: 'xhigh' })
    expect(prefs.get('a')).toMatchObject({ model: 'opus', effort: 'xhigh' })
  })

  it('merges a later patch instead of replacing the entry', () => {
    const prefs = new SessionPrefsStore(file())
    prefs.set('a', { model: 'opus' })
    prefs.set('a', { effort: 'low' })
    expect(prefs.get('a')).toMatchObject({ model: 'opus', effort: 'low' })
  })

  it('ignores a patch that carries nothing, so no write is wasted', () => {
    const prefs = new SessionPrefsStore(file())
    prefs.set('a', {})
    expect(prefs.get('a')).toBeUndefined()
    expect(existsSync(file())).toBe(false)
  })

  /**
   * The case the whole file exists for: the provider process is gone and a new
   * one reads what the session was last driven with.
   */
  it('survives a restart — a second store reads the same choices', () => {
    const first = new SessionPrefsStore(file())
    first.set('a', { model: 'haiku', effort: 'max' })

    const second = new SessionPrefsStore(file())
    expect(second.get('a')).toMatchObject({ model: 'haiku', effort: 'max' })
    expect(second.get('never-seen')).toBeUndefined()
  })

  it('forgets a deleted session, on disk as well as in memory', () => {
    const prefs = new SessionPrefsStore(file())
    prefs.set('a', { model: 'opus' })
    prefs.forget('a')
    expect(prefs.get('a')).toBeUndefined()
    expect(new SessionPrefsStore(file()).get('a')).toBeUndefined()
  })

  /**
   * The permission mode is the one field here that hands out unattended machine
   * access, so it gets its own coverage rather than riding along with model and
   * effort — losing it is not just a lost preference, it re-opens the approval
   * sheets the user opted out of. See the note at the top of `sessionPrefs.ts`.
   */
  it('remembers the permission mode, and survives a restart with it', () => {
    const first = new SessionPrefsStore(file())
    first.set('a', { permissionMode: 'bypassPermissions' })

    const second = new SessionPrefsStore(file())
    expect(second.get('a')).toMatchObject({ permissionMode: 'bypassPermissions' })
  })

  it('keeps the permission mode when a later patch only touches the model', () => {
    const prefs = new SessionPrefsStore(file())
    prefs.set('a', { permissionMode: 'plan' })
    prefs.set('a', { model: 'opus' })
    expect(prefs.get('a')).toMatchObject({ model: 'opus', permissionMode: 'plan' })
  })

  it('carries choices to a fork', () => {
    const prefs = new SessionPrefsStore(file())
    prefs.set('parent', { model: 'opus', effort: 'high', permissionMode: 'bypassPermissions' })
    prefs.copy('parent', 'child')
    expect(prefs.get('child')).toMatchObject({
      model: 'opus',
      effort: 'high',
      permissionMode: 'bypassPermissions',
    })
  })

  it('does nothing when copying from a session it has never seen', () => {
    const prefs = new SessionPrefsStore(file())
    prefs.copy('ghost', 'child')
    expect(prefs.get('child')).toBeUndefined()
  })

  /**
   * The Codex half of the same feature. It is the pair rather than one field
   * because the app-server keeps sandbox and approval policy independent: a
   * turn can carry one without the other (`codex/permission.ts`), so a store
   * that only kept the last sandbox would report a combination the thread was
   * never in.
   */
  it('remembers the Codex permission pair, and survives a restart with it', () => {
    const first = new SessionPrefsStore(file())
    first.set('a', { sandbox: 'danger-full-access', approvalPolicy: 'never' })

    const second = new SessionPrefsStore(file())
    expect(second.get('a')).toMatchObject({ sandbox: 'danger-full-access', approvalPolicy: 'never' })
  })

  it('keeps the Codex pair when a later patch only touches the model', () => {
    const prefs = new SessionPrefsStore(file())
    prefs.set('a', { sandbox: 'read-only', approvalPolicy: 'untrusted' })
    prefs.set('a', { model: 'gpt-5' })
    expect(prefs.get('a')).toMatchObject({
      model: 'gpt-5',
      sandbox: 'read-only',
      approvalPolicy: 'untrusted',
    })
  })

  it('carries the Codex pair to a fork', () => {
    const prefs = new SessionPrefsStore(file())
    prefs.set('parent', { model: 'gpt-5', sandbox: 'workspace-write', approvalPolicy: 'never' })
    prefs.copy('parent', 'child')
    expect(prefs.get('child')).toMatchObject({
      model: 'gpt-5',
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
    })
  })

  /**
   * Archiving is the one flag here that outlives the session's activity, and
   * these are the two directions of it. Codex keeps its archive in the
   * app-server and never writes this field; Claude has nowhere else, so for
   * Claude this file IS the archive.
   */
  it('remembers that a session is archived, and that it is not any more', () => {
    const first = new SessionPrefsStore(file())
    first.set('a', { archived: true })
    expect(new SessionPrefsStore(file()).get('a')).toMatchObject({ archived: true })

    // Unarchiving is the same call with `false` — the field is flipped, never
    // dropped, so nothing downstream has to treat "absent" and "false" as two
    // different answers.
    first.set('a', { archived: false })
    expect(new SessionPrefsStore(file()).get('a')?.archived).toBe(false)
  })

  it('remembers a pin for either provider', () => {
    const first = new SessionPrefsStore(file())
    first.set('a', { pinned: true })
    first.set('codex-thread', { sandbox: 'read-only', approvalPolicy: 'never', pinned: true })

    const second = new SessionPrefsStore(file())
    expect(second.get('a')).toMatchObject({ pinned: true })
    expect(second.get('codex-thread')).toMatchObject({ pinned: true, sandbox: 'read-only' })
  })

  /**
   * The one place these two fields differ from everything else in the store,
   * and it is the opposite of what the neighbouring tests would suggest: a fork
   * does NOT inherit them.
   *
   * They are not "how to drive this conversation" — they are how its row is
   * filed — and the fork is a new conversation the user just asked for by name.
   * Inheriting `archived` is the case that has to be pinned down: the fork would
   * be created invisible, arriving on a list that does not show it, from a
   * button whose whole promise is "continue this somewhere new".
   */
  it('does not carry archived or pinned to a fork', () => {
    const prefs = new SessionPrefsStore(file())
    prefs.set('parent', {
      model: 'opus',
      sandbox: 'read-only',
      archived: true,
      pinned: true,
    })
    prefs.copy('parent', 'child')
    expect(prefs.get('child')).toMatchObject({ model: 'opus', sandbox: 'read-only' })
    expect(prefs.get('child')?.archived).toBeUndefined()
    expect(prefs.get('child')?.pinned).toBeUndefined()
  })

  /**
   * The migration assertion. This file existed as `claude/sessionPrefs.ts` with
   * only `permissionMode`, and the deployed state directory still holds three
   * entries written in that shape — including the one session the phone has
   * driven on 完全访问. Widening the store must not cost them: widening a type
   * is exactly the change that silently turns "unreadable" into "back to the
   * default", which is the bug this whole feature is about.
   */
  it('reads an entry written before the Codex fields existed', () => {
    writeFileSync(
      file(),
      JSON.stringify({ a: { model: 'opus', effort: 'xhigh', permissionMode: 'bypassPermissions', updatedAt: 1 } }),
    )
    const prefs = new SessionPrefsStore(file())
    expect(prefs.get('a')).toMatchObject({
      model: 'opus',
      effort: 'xhigh',
      permissionMode: 'bypassPermissions',
    })
    // And it stays readable after a write from this version.
    prefs.set('a', { sandbox: 'read-only', approvalPolicy: 'on-request' })
    expect(new SessionPrefsStore(file()).get('a')).toMatchObject({
      permissionMode: 'bypassPermissions',
      sandbox: 'read-only',
      approvalPolicy: 'on-request',
    })
  })

  it('treats a corrupt file as empty rather than fatal', () => {
    writeFileSync(file(), '{ this is not json')
    const logs: string[] = []
    const prefs = new SessionPrefsStore(file(), (line) => logs.push(line))
    expect(prefs.get('a')).toBeUndefined()
    expect(logs.some((l) => l.includes('unreadable'))).toBe(true)
    // …and it recovers: the next write replaces the garbage.
    prefs.set('a', { model: 'opus' })
    expect(new SessionPrefsStore(file()).get('a')).toMatchObject({ model: 'opus' })
  })

  /**
   * The other half of "unreadable is empty", and the dangerous one: a failed
   * READ (EACCES, EBUSY) is a property of the environment, not corrupt content.
   * Caching the stand-in empty map and then writing it back would replace every
   * other session's remembered choices — a stored 完全访问 among them — with
   * the single entry being written now. The value stays usable in memory for
   * the life of the process; it just must not reach the disk.
   */
  it('does not overwrite the file when it cannot be read', () => {
    writeFileSync(file(), JSON.stringify({ a: { model: 'opus', updatedAt: 1 }, b: { model: 'sonnet', updatedAt: 2 } }))
    const logs: string[] = []
    const prefs = new SessionPrefsStore(file(), (line) => logs.push(line))

    const spy = vi.spyOn(fs, 'readFileSync')
    spy.mockImplementationOnce((() => {
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
    }) as unknown as typeof fs.readFileSync)
    prefs.set('c', { model: 'haiku' })
    spy.mockRestore()

    // Both sessions already on disk are untouched.
    expect(Object.keys(JSON.parse(readFileSync(file(), 'utf8'))).sort()).toEqual(['a', 'b'])
    // The write was refused, and said so.
    expect(logs.some((l) => l.includes('could not persist'))).toBe(true)
    // The value is still usable in memory, as the unwritable-directory case
    // also requires.
    expect(prefs.get('c')).toMatchObject({ model: 'haiku' })

    // A later read that succeeds resumes persistence — and merges rather than
    // choosing a side, so nothing is lost either way.
    prefs.set('c', { effort: 'low' })
    expect(Object.keys(JSON.parse(readFileSync(file(), 'utf8'))).sort()).toEqual(['a', 'b', 'c'])
  })

  it('keeps only the most recently written sessions', () => {
    vi.useFakeTimers()
    const prefs = new SessionPrefsStore(file())
    for (let i = 0; i < 501; i++) {
      vi.setSystemTime(1_000 + i)
      prefs.set(`s${i}`, { model: 'opus' })
    }
    expect(prefs.get('s0')).toBeUndefined()
    expect(prefs.get('s500')).toMatchObject({ model: 'opus' })
    expect(Object.keys(JSON.parse(readFileSync(file(), 'utf8'))).length).toBe(500)
  })

  /**
   * A read-only state directory must not fail a turn: preferences are the least
   * important thing this provider does, and the value is still usable in memory
   * for the life of the process.
   */
  it('survives an unwritable state directory', () => {
    const blocker = path.join(dir, 'blocker')
    writeFileSync(blocker, 'a file where a directory would have to go')
    const logs: string[] = []
    const prefs = new SessionPrefsStore(path.join(blocker, 'claude-sessions.json'), (l) => logs.push(l))

    expect(() => prefs.set('a', { model: 'opus' })).not.toThrow()
    expect(prefs.get('a')).toMatchObject({ model: 'opus' })
    expect(logs.some((l) => l.includes('could not persist'))).toBe(true)
  })

  it('is memory-only when there is no state directory', () => {
    const prefs = new SessionPrefsStore()
    prefs.set('a', { model: 'opus' })
    expect(prefs.get('a')).toMatchObject({ model: 'opus' })
  })
})
