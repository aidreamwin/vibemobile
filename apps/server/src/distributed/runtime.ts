import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
export const statePath = (...parts: string[]) => path.join(repoRoot, '.multi-runner', ...parts)

export function port(value: string | undefined, fallback: number, role: 'hub' | 'runner' = 'runner'): number {
  const result = value === undefined ? fallback : Number(value)
  if (
    !Number.isInteger(result) ||
    result < 1024 ||
    result > 65535 ||
    (result === 3000 && role !== 'hub') ||
    result === 8788
  )
    throw new Error('distributed port must be 1024..65535; 3000 is Hub-only and 8788 is reserved')
  return result
}

// Connect rather than bind: Windows permits wildcard/specific-address duplicate binds.
export async function assertFree(ports: number[]): Promise<void> {
  if (new Set(ports).size !== ports.length) throw new Error('runner ports must be different')
  for (const value of ports) {
    const occupied = await new Promise<boolean>((resolve) => {
      const socket = net.connect(value, '127.0.0.1')
      const done = (result: boolean) => {
        socket.destroy()
        resolve(result)
      }
      socket.once('connect', () => done(true))
      socket.once('error', () => done(false))
      socket.setTimeout(800, () => done(true))
    })
    if (occupied) throw new Error(`port ${value} is occupied; refusing to attach to another service`)
  }
}
