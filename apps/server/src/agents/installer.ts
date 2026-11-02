/**
 * Install a runtime pack and switch `current` to it.
 *
 * Runs in the background so a phone's request is not held open for the minutes
 * an npm install can take; the Settings page polls `GET /api/agents` instead.
 * One job per agent, and the version always comes from the manifest — the
 * client can only choose which agent to update.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { AgentRuntimeId, AgentRuntimeStatus } from '@vibemobile/protocol'
import type { Config } from '../config.js'
import { AGENT_IDS, AGENT_RUNTIMES, isAgentRuntimeId } from './manifest.js'
import { activeAgent, currentPackPath, hasBinary, installedPacks, readPackVersion, satisfiesRange } from './runtime.js'

const INSTALL_TIMEOUT_MS = 10 * 60 * 1000

interface Job {
  state: 'idle' | 'running' | 'error'
  error: string | null
}

const jobs = new Map<AgentRuntimeId, Job>()
const running = new Set<AgentRuntimeId>()

export interface AgentUpdateHooks {
  onLog: (line: string) => void
  /** Called after `current` points at the new pack; use it to respawn a long-lived child. */
  onInstalled?: (id: AgentRuntimeId) => Promise<void> | void
}

export function agentStatuses(config: Config): AgentRuntimeStatus[] {
  return AGENT_IDS.map((id) => {
    const spec = AGENT_RUNTIMES[id]
    const active = activeAgent(config.agentsDir, id)
    const job = jobs.get(id)
    return {
      id,
      displayName: spec.displayName,
      active: active.version,
      source: active.source,
      supported: spec.range,
      satisfied: active.version !== null && satisfiesRange(active.version, spec.range),
      installed: installedPacks(config.agentsDir, id),
      updating: running.has(id),
      error: job?.state === 'error' ? job.error : null,
    }
  })
}

/** Start installing the manifest version for `id`. Returns false when a job is already running. */
export function startAgentUpdate(config: Config, id: string, hooks: AgentUpdateHooks): boolean {
  if (!isAgentRuntimeId(id) || running.has(id)) return false
  void updateAgent(config, id, hooks).catch(() => {
    // The job already recorded the failure for the next poll.
  })
  return true
}

/** Install and switch one agent, awaiting completion. Throws on failure (also recorded in the job state). */
export async function updateAgent(config: Config, id: AgentRuntimeId, hooks: AgentUpdateHooks): Promise<void> {
  if (running.has(id)) throw new Error(`${id}: update already running`)
  // Marked before the first await, so a second caller cannot slip in.
  running.add(id)
  jobs.set(id, { state: 'running', error: null })
  const spec = AGENT_RUNTIMES[id]
  const root = path.join(config.agentsDir, id)
  try {
    const temp = path.join(root, `.install-${Date.now()}-${process.pid}`)
    fs.mkdirSync(root, { recursive: true })
    fs.rmSync(temp, { recursive: true, force: true })
    hooks.onLog(`[agents] installing ${spec.package}@${spec.range} into ${temp}`)
    try {
      await runNpm(
        [
          'install',
          '--prefix',
          temp,
          '--no-save',
          '--no-package-lock',
          '--no-audit',
          '--no-fund',
          '--foreground-scripts',
          `${spec.package}@${spec.range}`,
        ],
        hooks.onLog,
      )
      // The range is resolved by npm; the directory is named after the version
      // it actually installed, because that is what `current` must point at.
      const resolved = readPackVersion(temp, spec.package)
      if (!resolved) throw new Error(`${spec.package}@${spec.range} installed without a version`)
      if (!satisfiesRange(resolved, spec.range)) {
        throw new Error(`${spec.package}@${spec.range} resolved to ${resolved}, outside the supported range`)
      }
      if (!hasBinary(id, temp)) throw new Error(`${spec.package}@${resolved} has no usable binary`)

      const target = path.join(root, resolved)
      if (!isInstalled(id, target, spec.package, resolved)) {
        fs.rmSync(target, { recursive: true, force: true })
        fs.renameSync(temp, target)
      }

      const previous = currentTarget(config.agentsDir, id)
      switchCurrent(config.agentsDir, id, target)
      hooks.onLog(`[agents] ${id} now runs ${resolved}`)
      try {
        await hooks.onInstalled?.(id)
      } catch (err) {
        // A pack that cannot start must not stay active: the supervisor would
        // keep respawning it forever. Put the previous one back so the retry
        // picks up something that worked.
        if (previous) switchCurrent(config.agentsDir, id, previous)
        else clearCurrent(config.agentsDir, id)
        throw err
      }
    } finally {
      fs.rmSync(temp, { recursive: true, force: true })
    }
    jobs.set(id, { state: 'idle', error: null })
  } catch (err) {
    const message = (err as Error).message || String(err)
    hooks.onLog(`[agents] updating ${id} failed: ${message}`)
    jobs.set(id, { state: 'error', error: message })
    throw err
  } finally {
    running.delete(id)
  }
}

function isInstalled(id: AgentRuntimeId, dir: string, pkg: string, version: string): boolean {
  return hasBinary(id, dir) && readPackVersion(dir, pkg) === version
}

function currentTarget(agentsDir: string, id: AgentRuntimeId): string | null {
  try {
    return fs.realpathSync(currentPackPath(agentsDir, id))
  } catch {
    return null
  }
}

function clearCurrent(agentsDir: string, id: AgentRuntimeId): void {
  try {
    fs.unlinkSync(currentPackPath(agentsDir, id))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    if (process.platform === 'win32') fs.rmdirSync(currentPackPath(agentsDir, id))
    else throw err
  }
}

function switchCurrent(agentsDir: string, id: AgentRuntimeId, target: string): void {
  const link = currentPackPath(agentsDir, id)
  clearCurrent(agentsDir, id)
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
}

/**
 * Run npm.
 *
 * Deliberately not `spawn('npm.cmd', args, { shell: true })`: the install path
 * can contain spaces, and shell mode joins the arguments without quoting them.
 * When npm's CLI script can be found, Node runs it directly instead — no
 * shell, no quoting. The `.cmd` fallback is last resort.
 */
function npmCommand(): { cmd: string; prefix: string[]; shell: boolean } {
  for (const candidate of [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]) {
    if (candidate && /\.c?js$/.test(candidate) && fs.existsSync(candidate)) {
      return { cmd: process.execPath, prefix: [candidate], shell: false }
    }
  }
  return {
    cmd: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    prefix: [],
    shell: process.platform === 'win32',
  }
}

function runNpm(args: string[], onLog: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, npm_config_update_notifier: 'false' }
    const npm = npmCommand()
    const child = spawn(npm.cmd, [...npm.prefix, ...args], { windowsHide: true, env, shell: npm.shell })

    let tail = ''
    const consume = (chunk: Buffer) => {
      const text = chunk.toString()
      tail = (tail + text).slice(-4000)
      for (const line of text.split(/\r?\n/)) if (line.trim()) onLog(`[npm] ${line}`)
    }
    child.stdout?.on('data', consume)
    child.stderr?.on('data', consume)

    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`npm install timed out after ${INSTALL_TIMEOUT_MS / 1000}s`))
    }, INSTALL_TIMEOUT_MS)

    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`npm install exited with ${code}: ${tail.trim().split(/\r?\n/).pop() ?? ''}`))
    })
  })
}
