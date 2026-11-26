import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import { ndJsonStream, type ClientApp, type ClientConnection } from '@agentclientprotocol/sdk'

const cliShutdowns = new WeakMap<ClientConnection, Promise<void>>()

/** Closing the transport is asynchronous. Wait for the native front to exit. */
export async function closeCli(connection: ClientConnection) {
  connection.close()
  await (cliShutdowns.get(connection) ?? connection.closed)
}

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
  gateway = false,
  unattended = false,
  workerMode = true,
): Promise<ClientConnection> {
  const env = gateway
    ? { ...process.env, AGY_ACP_ENABLE_GATEWAY_AUTH: 'true' }
    : apiKey
      ? { ...process.env, GEMINI_API_KEY: apiKey, GOOGLE_GEMINI_BASE_URL: baseUrl || undefined }
      : process.env
  // The monolithic ACP server resumes every interrupted conversation at startup.
  // Native session workers isolate execution from discovery and history loading.
  const args = ['acp']
  if (workerMode) args.push('--process-per-session')
  if (unattended) args.push('--dangerously-skip-permissions')
  const child = spawn(bin, args, { cwd, env, windowsHide: true })
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()))
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
  const shutdown = connection.closed.then(async () => {
    // EOF lets the ACP front reap its session workers. Fall back to terminating
    // the front if the CLI does not shut down on its own.
    if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end()
    const timer = setTimeout(() => child.kill(), 2_000)
    try {
      await exited
    } finally {
      clearTimeout(timer)
    }
  })
  cliShutdowns.set(connection, shutdown)
  return connection
}

export const deadline = (ms = 10_000) => ({ cancellationSignal: AbortSignal.timeout(ms), stopWaitingOnCancel: true })
