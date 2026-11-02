import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Config } from '../config.js'
import type { CodexProvider } from '../codex/CodexProvider.js'
import { registerAgentRoutes } from './agents.js'

const dirs: string[] = []

function tempConfig(): Config {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbm-agents-route-'))
  dirs.push(dir)
  // Only the two fields these routes read are real; the rest never runs.
  return { authDisabled: true, agentsDir: dir } as unknown as Config
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function build(startUpdate = vi.fn(() => true)) {
  const app = Fastify()
  const codex = { restartAppServer: vi.fn(async () => {}) } as unknown as CodexProvider
  registerAgentRoutes(app, tempConfig(), codex, startUpdate)
  return { app, startUpdate, codex }
}

describe('agent runtime routes', () => {
  it('reports both agents with their supported version', async () => {
    const { app } = build()
    const res = await app.inject({ method: 'GET', url: '/api/agents' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { data: { id: string; supported: string; updating: boolean }[] }
    expect(body.data.map((agent) => agent.id)).toEqual(['codex', 'claude'])
    expect(body.data[0]?.supported).toMatch(/^~\d+\.\d+\.\d+/)
    expect(body.data.every((agent) => agent.updating === false)).toBe(true)
    await app.close()
  })

  it('starts an update for a known agent and rejects an unknown one', async () => {
    const { app, startUpdate } = build()
    const ok = await app.inject({ method: 'POST', url: '/api/agents/codex/update' })
    expect(ok.statusCode).toBe(202)
    expect(startUpdate).toHaveBeenCalledWith(expect.anything(), 'codex', expect.anything())

    const missing = await app.inject({ method: 'POST', url: '/api/agents/other/update' })
    expect(missing.statusCode).toBe(404)
    await app.close()
  })

  it('answers 409 while a job is already running', async () => {
    const { app } = build(vi.fn(() => false))
    const res = await app.inject({ method: 'POST', url: '/api/agents/claude/update' })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'update_running' })
    await app.close()
  })
})
