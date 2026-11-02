import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BuildInfo } from '@vibemobile/protocol'
import type { Config } from '../config.js'
import { deploymentInfo, readEnvFile } from './manager.js'

const dirs: string[] = []
const built: BuildInfo = { version: '0.1.31', commit: 'abc', dirty: false, builtAt: 1 }

function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbm-manager-'))
  dirs.push(dir)
  return dir
}

function config(installDir: string, enabled = true): Config {
  return {
    installDir,
    update: { enabled, packageName: 'vibemobile', allowHttp: false, ttlMs: 0, downloadTimeoutMs: 0 },
  } as unknown as Config
}

function writeEnv(dir: string, body: string): void {
  fs.writeFileSync(path.join(dir, 'vibemobile.env'), body)
}

afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('readEnvFile', () => {
  it('reads the same minimal syntax as the deploy scripts', () => {
    const dir = temp()
    writeEnv(dir, '# comment\nA=1\nB="two words"\nC=\n')
    expect(readEnvFile(path.join(dir, 'vibemobile.env'))).toEqual({ A: '1', B: 'two words', C: '' })
  })
})

describe('deploymentInfo', () => {
  it('recognises a PM2 Hub and enables updates', () => {
    vi.stubEnv('VIBEMOBILE_PM2_NAME', 'vibemobile')
    vi.stubEnv('NODE_APP_INSTANCE', '0')
    const dir = temp()
    writeEnv(dir, 'VIBEMOBILE_ROLE=hub\n')
    const info = deploymentInfo(config(dir), built, { docker: false })
    expect(info).toMatchObject({ manager: 'pm2', scope: 'hub', role: 'hub', supported: true, reason: null })
  })

  it('recognises a PM2 runner', () => {
    vi.stubEnv('VIBEMOBILE_PM2_NAME', 'runner-a')
    vi.stubEnv('NODE_APP_INSTANCE', '0')
    const dir = temp()
    writeEnv(dir, 'VIBEMOBILE_ROLE=runner\nVIBEMOBILE_HUB_URL=wss://hub.example\n')
    expect(deploymentInfo(config(dir), built, { docker: false })).toMatchObject({
      manager: 'pm2',
      scope: 'runner',
      role: 'runner',
    })
  })

  it('marks the Hub default runner as shared and not independently updatable', () => {
    vi.stubEnv('VIBEMOBILE_PM2_NAME', 'vibemobile')
    vi.stubEnv('NODE_APP_INSTANCE', '0')
    vi.stubEnv('VIBEMOBILE_DEFAULT_RUNNER_CHILD', '1')
    const dir = temp()
    writeEnv(dir, 'VIBEMOBILE_ROLE=hub\n')
    expect(deploymentInfo(config(dir), built, { docker: false })).toMatchObject({
      scope: 'runner',
      sharedInstall: true,
      supported: false,
      reason: 'update_via_hub',
    })
  })

  it('detects Docker even when PM2-looking env is present', () => {
    vi.stubEnv('VIBEMOBILE_PM2_NAME', 'vibemobile')
    vi.stubEnv('NODE_APP_INSTANCE', '0')
    const dir = temp()
    writeEnv(dir, 'VIBEMOBILE_ROLE=hub\n')
    expect(deploymentInfo(config(dir), built, { docker: true })).toMatchObject({
      manager: 'docker',
      supported: false,
      reason: 'docker',
    })
  })

  it('refuses to self-update outside PM2', () => {
    const dir = temp()
    writeEnv(dir, 'VIBEMOBILE_ROLE=hub\n')
    const info = deploymentInfo(config(dir), built, { docker: false })
    expect(info.supported).toBe(false)
    expect(info.manualCommand).toBeTruthy()
  })

  it('honours the off switch', () => {
    vi.stubEnv('VIBEMOBILE_PM2_NAME', 'vibemobile')
    vi.stubEnv('NODE_APP_INSTANCE', '0')
    const dir = temp()
    writeEnv(dir, 'VIBEMOBILE_ROLE=hub\n')
    expect(deploymentInfo(config(dir, false), built, { docker: false })).toMatchObject({
      supported: false,
      reason: 'update_disabled',
    })
  })
})
