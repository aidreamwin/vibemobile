import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import net from 'node:net'
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

function infoFetch(pid: number, version = '2.3.0'): typeof fetch {
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
    expect(isSupportedVersion('2.3.0')).toBe(true)
    expect(isSupportedVersion('2.3.9')).toBe(true)
    expect(isSupportedVersion('2.2.5')).toBe(false)
    expect(isSupportedVersion('2.4.0')).toBe(false)
    expect(isSupportedVersion('3.3.0')).toBe(false)
    expect(isSupportedVersion('nope')).toBe(false)
  })
})

describe('OpencodeService', () => {
  it('releases a rejected child and its port before retrying', async () => {
    const listener = net.createServer()
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
    const port = (listener.address() as net.AddressInfo).port
    await new Promise<void>((resolve) => listener.close(() => resolve()))
    const children: ChildProcess[] = []
    const spawnImpl = vi.fn(() => {
      const version = children.length ? '2.3.0' : '2.2.5'
      const child = spawn(
        process.execPath,
        [
          '-e',
          `
        require('node:http').createServer((req, res) => {
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ version: '${version}', pid: process.pid }))
        }).listen(${port}, '127.0.0.1')
      `,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
      )
      children.push(child)
      return child
    })
    const service = new OpencodeService({ port, noAttach: true, spawnImpl: spawnImpl as unknown as typeof spawn })
    try {
      await expect(service.ensure()).rejects.toThrow('spawned opencode 2.2.5 is outside 2.3.x')
      expect(children[0].exitCode !== null || children[0].signalCode !== null).toBe(true)
      expect(service.isOwned).toBe(false)
      expect(service.mode).toBe('none')
      expect(service.baseUrl).toBeNull()
      expect(service.lastError).toContain('2.2.5')
      await expect(service.ensure()).resolves.toBe(`http://127.0.0.1:${port}`)
      expect(service.version).toBe('2.3.0')
      expect(spawnImpl).toHaveBeenCalledTimes(2)
    } finally {
      await service.stop()
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill()
      }
    }
  }, 15_000)

  it('preserves the spawn error instead of replacing it with a readiness error', async () => {
    const service = new OpencodeService({
      port: 1,
      noAttach: true,
      bin: path.join(temp(), 'missing-opencode'),
      fetchImpl: (async () => {
        throw new Error('offline')
      }) as typeof fetch,
    })
    service.on('error', () => {})
    await expect(service.ensure()).rejects.toThrow(/ENOENT/)
    expect(service.isOwned).toBe(false)
    expect(service.lastError).toContain('ENOENT')
    await service.stop()
  })

  it('attaches to a live service and never spawns', async () => {
    const dir = temp()
    const file = serviceFile(dir, {
      url: 'http://127.0.0.1:28894',
      pid: 42,
      password: 'pw',
      version: '2.3.0',
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
      fetchImpl: infoFetch(42, '2.2.5'),
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
