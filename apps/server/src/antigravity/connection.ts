import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import { ndJsonStream, type ClientApp, type ClientConnection } from '@agentclientprotocol/sdk'

export function findCli(override?: string): string | undefined {
  if (override) return override
  const name = process.platform === 'win32' ? 'agy.exe' : 'agy'
  const installed =
    process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'agy', 'bin', 'agy.exe')
      : path.join(os.homedir(), '.local', 'bin', 'agy')
  return [
    ...(process.env.PATH ?? '')
      .split(path.delimiter)
      .filter(Boolean)
      .map((dir) => path.join(dir, name)),
    installed,
  ].find(existsSync)
}

export async function connectCli(
  app: ClientApp,
  cwd: string,
  bin: string,
  apiKey?: string,
  baseUrl?: string,
): Promise<ClientConnection> {
  const env = apiKey
    ? { ...process.env, GEMINI_API_KEY: apiKey, GOOGLE_GEMINI_BASE_URL: baseUrl || undefined }
    : process.env
  const child = spawn(bin, ['acp'], { cwd, env, windowsHide: true })
  child.stderr.resume()
  try {
    await once(child, 'spawn')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error('请在执行机安装 Antigravity CLI，或用 ANTIGRAVITY_BIN 指定 agy 的路径。')
    throw err
  }
  const stdout = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
  const connection = app.connect(ndJsonStream(Writable.toWeb(child.stdin), stdout))
  child.on('error', (error) => connection.close(error))
  void connection.closed.then(() => child.kill())
  return connection
}

export const deadline = (ms = 10_000) => ({ cancellationSignal: AbortSignal.timeout(ms), stopWaitingOnCancel: true })
