import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isLoopbackUrl,
  isSupportedVersion,
  OpencodeService,
  parseServiceRecord,
  serviceFileCandidates,
} from './server.js'

const dirs: string[] = []

function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbm-opencode-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function serviceFile(dir: string, value: Record<string, unknown>): string {
  const file = path.join(dir, 'service.json')
  fs.writeFileSync(file, JSON.stringify(value))
  return file
}

function infoFetch(pid: number, version = '2.2.5'): typeof fetch {
  return (async () => new Response(JSON.stringify({ version, pid }), { status: 200 })) as unknown as typeof fetch
}

describe('service records', () => {
  it('parses only usable records', () => {
    expect(parseServiceRecord({ url: 'http://127.0.0.1:1', pid: 2, password: 'p' })).toEqual({
      url: 'http://127.0.0.1:1',
      pid: 2,
      password: 'p',
    })
    expect(parseServiceRecord({ url: 'http://127.0.0.1:1' })).toEqual({ url: 'http://127.0.0.1:1' })
    expect(parseServiceRecord({ pid: 2 })).toBeNull()
    expect(parseServiceRecord('nope')).toBeNull()
  })

  it('finds the state file without hardcoded home paths', () => {
    expect(serviceFileCandidates('/x/service.json')).toEqual([path.resolve('/x/service.json')])
    const env = { XDG_STATE_HOME: '/xdg', LOCALAPPDATA: '/local' } as NodeJS.ProcessEnv
    const expected = [
      path.join('/xdg', 'opencode', 'service.json'),
      path.join(os.homedir(), '.local', 'state', 'opencode', 'service.json'),
    ]
    if (process.platform === 'win32') expected.push(path.join('/local', 'opencode', 'service.json'))
    expect(serviceFileCandidates(undefined, env)).toEqual(expected)
  })

  it('only accepts loopback HTTP URLs', () => {
    expect(isLoopbackUrl('http://127.0.0.1:1')).toBe(true)
    expect(isLoopbackUrl('http://localhost:1')).toBe(true)
    expect(isLoopbackUrl('https://example.test')).toBe(false)
    expect(isLoopbackUrl('ws://127.0.0.1:1')).toBe(false)
    expect(isLoopbackUrl('nope')).toBe(false)
  })

  it('gates the experimental API on major.minor', () => {
    expect(isSupportedVersion('2.2.5')).toBe(true)
    expect(isSupportedVersion('2.2.9')).toBe(true)
    expect(isSupportedVersion('2.3.0')).toBe(false)
    expect(isSupportedVersion('3.2.0')).toBe(false)
    expect(isSupportedVersion('nope')).toBe(false)
  })
})

describe('OpencodeService', () => {
  it('attaches to a live service and never spawns', async () => {
    const dir = temp()
    const file = serviceFile(dir, {
      url: 'http://127.0.0.1:28894',
      pid: 42,
      password: 'pw',
      version: '2.2.5',
    })
    const spawnImpl = vi.fn()
    const service = new OpencodeService({
      port: 1,
      serviceFile: file,
      fetchImpl: infoFetch(42),
      spawnImpl: spawnImpl as never,
    })
    await expect(service.ensure()).resolves.toBe('http://127.0.0.1:28894')
    expect(service.mode).toBe('attach')
    expect(service.password).toBe('pw')
    expect(spawnImpl).not.toHaveBeenCalled()
    await service.stop()
  })

  it('refuses to spawn a second server when the observed version is unsupported', async () => {
    const dir = temp()
    const file = serviceFile(dir, { url: 'http://127.0.0.1:28894', pid: 42 })
    const spawnImpl = vi.fn()
    const service = new OpencodeService({
      port: 1,
      serviceFile: file,
      fetchImpl: infoFetch(42, '2.3.0'),
      spawnImpl: spawnImpl as never,
    })
    await expect(service.ensure()).rejects.toThrow(/unsupported/)
    expect(spawnImpl).not.toHaveBeenCalled()
  })

  it('spawns and stops a private server', async () => {
    const dir = temp()
    const spawnImpl = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & {
        pid: number
        exitCode: number | null
        signalCode: string | null
        stdout: PassThrough
        stderr: PassThrough
        kill: () => void
      }
      child.pid = 123
      child.exitCode = null
      child.signalCode = null
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = () => {
        child.exitCode = 0
        child.emit('exit', 0, null)
      }
      return child
    })
    const service = new OpencodeService({
      port: 6820,
      noAttach: true,
      serviceFile: path.join(dir, 'missing.json'),
      fetchImpl: infoFetch(123),
      spawnImpl: spawnImpl as never,
    })
    await expect(service.ensure()).resolves.toBe('http://127.0.0.1:6820')
    expect(service.mode).toBe('managed')
    expect(service.isOwned).toBe(true)
    expect(spawnImpl).toHaveBeenCalledOnce()
    const args = spawnImpl.mock.calls[0] as unknown as [string, string[]]
    expect(args[1]).toContain('serve')
    expect(args[1]).toContain('--hostname')
    await service.stop()
    expect(service.mode).toBe('none')
  })
})
