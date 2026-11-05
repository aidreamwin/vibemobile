import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import cookie from '@fastify/cookie'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentProfilesResponse } from '@vibemobile/protocol'
import type { Config } from '../config.js'
import { AgentProfileStore } from '../agents/profiles.js'
import { registerAgentProfileRoutes } from './agentProfiles.js'
import { NativeAgentConfigStore } from '../agents/nativeConfig.js'

const dirs: string[] = []
const apps: FastifyInstance[] = []

async function build(authDisabled = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbm-profile-route-'))
  dirs.push(dir)
  const app = Fastify()
  apps.push(app)
  await app.register(cookie)
  registerAgentProfileRoutes(
    app,
    { authDisabled, secret: 'test' } as Config,
    new AgentProfileStore(dir),
    undefined,
    new NativeAgentConfigStore(dir, { home: dir, env: {} }),
  )
  return app
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('runner profile API', () => {
  it('reads and edits existing native settings through the authenticated API', async () => {
    const app = await build()
    const dir = dirs.at(-1) ?? ''
    fs.mkdirSync(path.join(dir, '.claude'))
    fs.writeFileSync(
      path.join(dir, '.claude/settings.json'),
      '{"env":{"ANTHROPIC_AUTH_TOKEN":"native-secret","ANTHROPIC_BASE_URL":"https://current.example.test"},"theme":"dark"}',
    )
    const read = await app.inject('/api/agent-profiles')
    const native = read.json<AgentProfilesResponse>().native?.claude
    expect(native).toMatchObject({ baseUrl: 'https://current.example.test', hasApiKey: true, active: true })
    expect(read.body).not.toContain('native-secret')
    const updated = await app.inject({
      method: 'PATCH',
      url: '/api/agent-profiles/claude/native',
      payload: { revision: native?.revision, name: '阿里云', baseUrl: 'https://updated.example.test' },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json<AgentProfilesResponse>().native?.claude).toMatchObject({
      name: '阿里云',
      baseUrl: 'https://updated.example.test',
    })
    expect(updated.body).not.toContain('native-secret')
    expect(JSON.parse(fs.readFileSync(path.join(dir, '.claude/settings.json'), 'utf8'))).toMatchObject({
      theme: 'dark',
      env: { ANTHROPIC_AUTH_TOKEN: 'native-secret' },
    })
  })

  it('requires authentication for reads and writes', async () => {
    const app = await build(false)
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE'] as const) {
      const url = method === 'GET' ? '/api/agent-profiles' : '/api/agent-profiles/codex/profile-0123456789abcdef'
      const res = await app.inject({ method, url: method === 'POST' ? '/api/agent-profiles/codex' : url })
      expect(res.statusCode).toBe(401)
      expect(res.headers['cache-control']).toBe('no-store')
    }
  })

  it('creates, edits, enables, restores and deletes without returning the secret', async () => {
    const app = await build()
    const created = await app.inject({
      method: 'POST',
      url: '/api/agent-profiles/claude',
      payload: { name: 'Gateway', apiKey: 'private-key', model: 'custom-model' },
    })
    expect(created.statusCode).toBe(201)
    expect(created.body).not.toContain('private-key')
    const id = created.json<AgentProfilesResponse>().data.claude[0]?.id
    expect(id).toBeDefined()
    const url = `/api/agent-profiles/claude/${id}`
    const edit = await app.inject({ method: 'PATCH', url, payload: { name: 'Updated' } })
    expect(edit.json<AgentProfilesResponse>().data.claude[0]).toMatchObject({ name: 'Updated', hasApiKey: true })
    const enabled = await app.inject({ method: 'POST', url: `${url}/activate` })
    expect(enabled.json<AgentProfilesResponse>().active.claude).toBe(id)
    expect((await app.inject({ method: 'DELETE', url })).statusCode).toBe(409)
    const restored = await app.inject({ method: 'POST', url: '/api/agent-profiles/claude/native/activate' })
    expect(restored.json<AgentProfilesResponse>().active.claude).toBeNull()
    const deleted = await app.inject({ method: 'DELETE', url })
    expect(deleted.json<AgentProfilesResponse>().data.claude).toEqual([])
  })

  it('returns stable validation and missing-resource errors', async () => {
    const app = await build()
    const invalid = await app.inject({ method: 'POST', url: '/api/agent-profiles/codex', payload: { name: '' } })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json()).toEqual({ error: 'invalid_agent_profile_name' })
    expect(
      (await app.inject({ method: 'POST', url: '/api/agent-profiles/unknown', payload: { name: 'x' } })).statusCode,
    ).toBe(404)
    const missing = await app.inject({ method: 'POST', url: '/api/agent-profiles/codex/missing/activate' })
    expect(missing.statusCode).toBe(404)
    expect(missing.json()).toEqual({ error: 'agent_profile_not_found' })
  })
})
