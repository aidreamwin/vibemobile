import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { AppServerSupervisor } from './supervisor.js'

vi.mock('node:child_process', () => ({ spawn: vi.fn(), spawnSync: vi.fn() }))
vi.mock('../agents/runtime.js', () => ({ resolveCodexBin: () => ({ cmd: 'test-codex', args: [] }) }))
vi.mock('../agents/codexNativeProvider.js', () => ({ codexNativeModelProvider: () => 'openai' }))

class FakeChild extends EventEmitter {
  pid = 12345
  exitCode: number | null = null
  signalCode: string | null = null
  stdout = null
  stderr = null
  kill = vi.fn(() => {
    this.exitCode = 0
    this.emit('exit', 0, null)
    return true
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('Codex supervisor shutdown', () => {
  it('kills the Windows launcher tree and cancels the old shutdown timer before restart', async () => {
    vi.useFakeTimers()
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
    const old = new FakeChild()
    const next = new FakeChild()
    vi.mocked(spawn)
      .mockReturnValueOnce(old as unknown as ReturnType<typeof spawn>)
      .mockReturnValueOnce(next as unknown as ReturnType<typeof spawn>)
    vi.mocked(spawnSync).mockImplementation(() => {
      old.exitCode = 0
      old.emit('exit', 0, null)
      return { status: 0 } as ReturnType<typeof spawnSync>
    })
    const supervisor = new AppServerSupervisor()
    await supervisor.start()
    await supervisor.restart()
    expect(spawnSync).toHaveBeenCalledWith(
      'taskkill',
      ['/PID', '12345', '/T', '/F'],
      expect.objectContaining({ windowsHide: true }),
    )
    await vi.advanceTimersByTimeAsync(6000)
    expect(old.kill).not.toHaveBeenCalled()
    expect(next.kill).not.toHaveBeenCalled()
    vi.mocked(spawnSync).mockImplementation(() => {
      next.exitCode = 0
      next.emit('exit', 0, null)
      return { status: 0 } as ReturnType<typeof spawnSync>
    })
    await supervisor.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not touch an externally managed app-server', async () => {
    const supervisor = new AppServerSupervisor({ attachUrl: 'ws://127.0.0.1:9999' })
    await supervisor.start()
    await supervisor.restart()
    await supervisor.stop()
    expect(spawn).not.toHaveBeenCalled()
    expect(spawnSync).not.toHaveBeenCalled()
  })
})
