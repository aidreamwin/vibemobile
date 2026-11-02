import fs from 'node:fs'
import path from 'node:path'
import type { BuildInfo, UpdateManager, UpdateScope } from '@vibemobile/protocol'
import type { Config } from '../config.js'

export interface DeploymentInfo {
  scope: UpdateScope
  role: 'hub' | 'runner'
  sharedInstall: boolean
  manager: UpdateManager
  supported: boolean
  reason: string | null
  manualCommand: string | null
  /** PM2 process name; null when this deployment is not PM2-managed. */
  pm2Name: string | null
}

/** Minimal `KEY=VALUE` reader, matching `deploy/lib/common.mjs` and `node --env-file`. */
export function readEnvFile(file: string): Record<string, string> {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return {}
  }
  const values: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const value = trimmed.slice(eq + 1).trim()
    values[trimmed.slice(0, eq).trim()] =
      value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value
  }
  return values
}

function isDocker(): boolean {
  return fs.existsSync('/.dockerenv')
}

/**
 * What this process is, how it can be restarted, and whether that is supported.
 *
 * The role comes from `<installDir>/vibemobile.env`, not from `process.env`:
 * the Hub spawns its default runner with the Hub's environment, so the child
 * would otherwise report itself as the Hub. The explicit child marker from
 * `hub.ts` is what distinguishes "ships with the Hub" from a real runner.
 */
export function deploymentInfo(config: Config, build: BuildInfo): DeploymentInfo {
  const env = readEnvFile(path.join(config.installDir, 'vibemobile.env'))
  const role: 'hub' | 'runner' = env.VIBEMOBILE_ROLE === 'runner' || env.VIBEMOBILE_HUB_URL ? 'runner' : 'hub'
  const sharedInstall = process.env.VIBEMOBILE_DEFAULT_RUNNER_CHILD === '1'
  const pm2Name = process.env.VIBEMOBILE_PM2_NAME?.trim() || null
  const pm2Detected = process.env.pm_id !== undefined || process.env.NODE_APP_INSTANCE !== undefined
  const docker = isDocker()

  let manager: UpdateManager = 'unknown'
  if (docker) manager = 'docker'
  else if (pm2Name && pm2Detected) manager = 'pm2'
  else if (process.platform === 'win32') manager = 'nssm'

  const scope: UpdateScope = sharedInstall || role === 'runner' ? 'runner' : pm2Name ? 'hub' : 'standalone'

  const manualCommand = docker
    ? 'docker compose pull && docker compose up -d'
    : process.platform === 'win32'
      ? 'scripts\\windows\\update-service.bat'
      : `node deploy/update.mjs --target=${config.installDir}`

  let reason: string | null = null
  if (sharedInstall) reason = 'update_via_hub'
  else if (docker) reason = 'docker'
  else if (!config.update.enabled) reason = 'update_disabled'
  else if (manager === 'pm2') reason = null
  else if (build.builtAt === null) reason = 'development_mode'
  else if (process.platform === 'win32') reason = 'windows_service'
  else reason = 'standalone'

  return {
    scope,
    role,
    sharedInstall,
    manager,
    supported: manager === 'pm2' && !sharedInstall && config.update.enabled,
    reason,
    manualCommand,
    pm2Name,
  }
}
