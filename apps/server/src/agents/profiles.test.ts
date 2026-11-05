import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentProfileError, AgentProfileStore } from './profiles.js'

const dirs: string[] = []

function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbm-agent-profiles-'))
  dirs.push(dir)
  return dir
}

function codexId(store: AgentProfileStore): string {
  const id = store.response().data.codex[0]?.id
  if (!id) throw new Error('expected saved Codex profile')
  return id
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('runner agent profiles', () => {
  it('persists profiles while masking keys in the response', async () => {
    const dir = temp()
    const store = new AgentProfileStore(dir)
    await store.create('codex', {
      name: '公司网关',
      baseUrl: 'https://api.example.test/v1',
      apiKey: 'secret',
      model: 'model-a',
      models: ['model-a', 'model-b'],
      modelContextWindows: { 'model-a': 200000 },
    })
    const profile = store.response().data.codex[0]
    expect(profile).toBeDefined()
    if (!profile) return
    expect(profile).toMatchObject({
      name: '公司网关',
      baseUrl: 'https://api.example.test/v1',
      model: 'model-a',
      models: ['model-a', 'model-b'],
      modelContextWindows: { 'model-a': 200000 },
      hasApiKey: true,
      active: false,
    })
    expect(JSON.stringify(store.response())).not.toContain('secret')
    await store.activate('codex', profile.id)
    const restored = new AgentProfileStore(dir)
    expect(restored.current('codex')).toMatchObject({ id: profile.id, apiKey: 'secret', modelContextWindows: { 'model-a': 200000 } })
  })

  it('preserves a key when editing other fields and supports clearing it', async () => {
    const store = new AgentProfileStore(temp())
    await store.create('claude', { name: 'one', apiKey: 'keep-me' })
    const id = store.response().data.claude[0]?.id
    expect(id).toBeDefined()
    if (!id) return
    await store.activate('claude', id)
    await store.update('claude', id, { name: 'two' })
    expect(store.current('claude')).toMatchObject({ name: 'two', apiKey: 'keep-me' })
    await store.update('claude', id, { apiKey: '' })
    expect(store.current('claude')?.apiKey).toBe('')
  })

  it('rolls a failed apply back to the previous durable selection', async () => {
    const apply = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('restart failed'))
      .mockResolvedValueOnce(undefined)
    const store = new AgentProfileStore(temp(), { apply })
    await store.create('codex', { name: 'one' })
    const id = store.response().data.codex[0]?.id
    expect(id).toBeDefined()
    if (!id) return
    await expect(store.activate('codex', id)).rejects.toMatchObject({ code: 'agent_profile_apply_failed' })
    expect(store.response().active.codex).toBeNull()
    expect(apply).toHaveBeenCalledTimes(2)
  })

  it('rejects URLs containing credentials or query strings', async () => {
    const store = new AgentProfileStore(temp())
    await expect(store.create('opencode', { name: 'bad', baseUrl: 'https://u:p@example.test' })).rejects.toMatchObject(
      new AgentProfileError('invalid_agent_profile_url'),
    )
    await expect(
      store.create('opencode', { name: 'bad', baseUrl: 'https://example.test?key=x' }),
    ).rejects.toMatchObject(new AgentProfileError('invalid_agent_profile_url'))
  })

  it('only applies active profile changes and keeps runner stores isolated', async () => {
    const apply = vi.fn(async () => {})
    const dir = temp()
    const runner = new AgentProfileStore(dir, { apply })
    const otherRunner = new AgentProfileStore(temp())
    await runner.create('codex', { name: 'one' })
    const id = codexId(runner)
    await runner.update('codex', id, { model: 'custom' })
    expect(apply).not.toHaveBeenCalled()
    await runner.activate('codex', id)
    await runner.update('codex', id, { model: 'updated' })
    expect(apply).toHaveBeenCalledTimes(2)
    await expect(runner.remove('codex', id)).rejects.toMatchObject({ code: 'agent_profile_active' })
    await runner.activate('codex', null)
    expect(new AgentProfileStore(dir).current('codex')).toBeUndefined()
    expect(otherRunner.response().data.codex).toEqual([])
    expect(runner.response().data.claude).toEqual([])
  })

  it('rejects concurrent mutations while a service switch is pending', async () => {
    let finish: (() => void) | undefined
    const apply = () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
    const store = new AgentProfileStore(temp(), { apply })
    await store.create('codex', { name: 'one' })
    const pending = store.activate('codex', codexId(store))
    await Promise.resolve()
    await expect(store.create('claude', { name: 'two' })).rejects.toMatchObject({ code: 'agent_profile_busy' })
    finish?.()
    await pending
    expect(store.response().data.claude).toEqual([])
  })

  it('does not persist a selection when preflight rejects an external service', async () => {
    const dir = temp()
    const store = new AgentProfileStore(dir, {
      beforeApply: () => {
        throw new AgentProfileError('agent_profile_external_service', 409)
      },
    })
    await store.create('codex', { name: 'one' })
    await expect(store.activate('codex', codexId(store))).rejects.toMatchObject({ statusCode: 409 })
    expect(new AgentProfileStore(dir).response().active.codex).toBeNull()
  })

  it('preserves memory when persistence fails and refuses to overwrite a corrupt store', async () => {
    const dir = temp()
    const store = new AgentProfileStore(dir)
    const file = path.join(dir, 'agent-profiles.json')
    fs.mkdirSync(file)
    await expect(store.create('claude', { name: 'one' })).rejects.toMatchObject({
      code: 'agent_profile_store_unwritable',
    })
    expect(store.response().data.claude).toEqual([])
    fs.rmdirSync(file)
    fs.writeFileSync(file, '{broken')
    expect(() => new AgentProfileStore(dir)).toThrow('agent_profile_store_invalid')
    expect(fs.readFileSync(file, 'utf8')).toBe('{broken')
  })
})
