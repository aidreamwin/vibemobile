import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { codexNativeModelProvider } from './codexNativeProvider.js'

const homes: string[] = []
function home(config?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-provider-'))
  homes.push(dir)
  if (config !== undefined) fs.writeFileSync(path.join(dir, 'config.toml'), config)
  return dir
}

afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of homes.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('Codex native provider identity', () => {
  it('preserves the configured key and casing without mistaking nested settings for it', () => {
    expect(
      codexNativeModelProvider(home('model_provider = "OpenAI"\n[model_providers.OpenAI]\nname = "Gateway"\n')),
    ).toBe('OpenAI')
    expect(codexNativeModelProvider(home('[profiles.work]\nmodel_provider = "custom"\n'))).toBe('openai')
  })

  it('uses the Codex built-in default when config or provider is absent', () => {
    expect(codexNativeModelProvider(home())).toBe('openai')
    expect(codexNativeModelProvider(home('model = "example"\n'))).toBe('openai')
  })

  it('respects CODEX_HOME instead of reading an unrelated user configuration', () => {
    vi.stubEnv('CODEX_HOME', home('model_provider = "work.gateway"\n'))
    expect(codexNativeModelProvider()).toBe('work.gateway')
  })

  it('does not silently replace an unreadable or malformed config with another provider', () => {
    expect(() => codexNativeModelProvider(home('model_provider = ['))).toThrow()
    const dir = home()
    fs.mkdirSync(path.join(dir, 'config.toml'))
    expect(() => codexNativeModelProvider(dir)).toThrow()
  })
})
