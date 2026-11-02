import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

let cached: string | null | undefined

function npmCliPath(): string | null {
  for (const candidate of [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]) {
    if (candidate && /\.c?js$/.test(candidate) && fs.existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Resolve PM2's JS entry rather than its `.cmd` shim.
 *
 * The server is started by PM2, so the daemon exists, but the CLI is not a
 * dependency of this package. `VIBEMOBILE_PM2_BIN` is the escape hatch for
 * unusual global layouts.
 */
export function pm2Bin(): string | null {
  if (cached !== undefined) return cached
  const explicit = process.env.VIBEMOBILE_PM2_BIN?.trim()
  if (explicit && fs.existsSync(explicit)) {
    cached = explicit
    return cached
  }
  try {
    const cli = npmCliPath()
    if (cli) {
      const root = execFileSync(process.execPath, [cli, 'root', '-g'], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .trim()
        .split(/\r?\n/)
        .pop()
      if (root) {
        const bin = path.join(root, 'pm2', 'bin', 'pm2')
        if (fs.existsSync(bin)) {
          cached = bin
          return cached
        }
      }
    }
  } catch {
    // Fall through to PATH below.
  }
  cached = process.platform === 'win32' ? null : 'pm2'
  return cached
}

export interface Pm2Result {
  code: number | null
  stdout: string
  stderr: string
}

export function runPm2(args: string[], timeoutMs = 30_000): Promise<Pm2Result> {
  const bin = pm2Bin()
  if (!bin) return Promise.reject(new Error('pm2_not_found'))
  return new Promise((resolve, reject) => {
    const child =
      bin === 'pm2'
        ? spawn('pm2', args, { windowsHide: true })
        : spawn(process.execPath, [bin, ...args], { windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('pm2_timeout'))
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}
