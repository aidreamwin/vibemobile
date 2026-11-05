import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseTOML, getStaticTOMLValue } from 'toml-eslint-parser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeAgentConfigStore } from './nativeConfig.js'
import { AgentProfileStore } from './profiles.js'

const dirs: string[] = []
function setup(env: NodeJS.ProcessEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbm-native-config-'))
  dirs.push(dir)
  const write = (relative: string, text: string) => {
    const file = path.join(dir, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
    return file
  }
  const store = new NativeAgentConfigStore(path.join(dir, 'state'), { home: dir, env })
  return { dir, write, store }
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('native agent configuration', () => {
  it('reads the machine files and redacts credentials from every provider', () => {
    const { write, store } = setup()
    write(
      '.codex/config.toml',
      'model_provider="custom"\nmodel="model-c"\n[model_providers.custom]\nbase_url="https://codex.example.test/v1"\n',
    )
    write('.codex/auth.json', '{"OPENAI_API_KEY":"codex-private"}')
    write(
      '.claude/settings.json',
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: 'https://claude.example.test',
          ANTHROPIC_AUTH_TOKEN: 'claude-private',
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'sonnet-custom',
        },
      }),
    )
    write(
      '.config/opencode/opencode.json',
      JSON.stringify({
        provider: {
          gateway: {
            options: { baseURL: 'https://oc.example.test/v1', apiKey: 'oc-private' },
            models: { 'model-o': { name: 'Custom' } },
          },
        },
      }),
    )
    const codex = store.read('codex', true)
    expect(codex).toMatchObject({
      baseUrl: 'https://codex.example.test/v1',
      model: 'model-c',
      providerId: 'custom',
      hasApiKey: true,
    })
    const claude = store.read('claude', true)
    expect(claude.modelAliases).toEqual({ ANTHROPIC_DEFAULT_SONNET_MODEL: 'sonnet-custom' })
    expect(claude.hasApiKey).toBe(true)
    const opencode = store.read('opencode', true)
    expect(opencode).toMatchObject({ providerId: 'gateway', baseUrl: 'https://oc.example.test/v1', hasApiKey: true })
    expect(opencode.providers[0]?.models).toEqual(['model-o'])
    expect(JSON.stringify([codex, claude, opencode])).not.toContain('private')
  })

  it('edits Claude connection fields and aliases while preserving comments, hooks and MCP', () => {
    const { dir, write, store } = setup()
    const original =
      '{\n // keep this comment\n "env": { "ANTHROPIC_AUTH_TOKEN": "saved", "ANTHROPIC_DEFAULT_SONNET_MODEL": "old", "OTHER": "keep" },\n "mcpServers": {"local":{"command":"test"}}, "hooks": {"Stop":[]}, "theme":"dark"\n}\n'
    const file = write('.claude/settings.json', original)
    store.update('claude', {
      revision: store.read('claude', true).revision,
      baseUrl: 'https://new.example.test',
      modelAliases: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'new' },
    })
    const text = fs.readFileSync(file, 'utf8')
    expect(text).toContain('// keep this comment')
    expect(text).toContain('"OTHER": "keep"')
    expect(text).toContain('"mcpServers"')
    expect(text).toContain('"hooks"')
    expect(store.read('claude', true)).toMatchObject({
      hasApiKey: true,
      baseUrl: 'https://new.example.test',
      modelAliases: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'new' },
    })
    const backup = fs.readdirSync(path.join(dir, 'state/agent-config-backups'))[0]
    expect(fs.readFileSync(path.join(dir, 'state/agent-config-backups', backup ?? '', 'settings.json'), 'utf8')).toBe(
      original,
    )
    store.update('claude', { revision: store.read('claude', true).revision, apiKey: '' })
    expect(store.read('claude', true).hasApiKey).toBe(false)
  })

  it('edits Codex TOML and its API key without changing OAuth, MCP or permission settings', () => {
    const { write, store } = setup()
    const file = write(
      '.codex/config.toml',
      'model_provider="custom"\nmodel="old"\nmodel_reasoning_effort="high"\n[model_providers.custom]\nname="custom"\nbase_url="https://old.example.test/v1"\nwire_api="responses"\n[mcp_servers.test]\ncommand="test"\n[windows]\nsandbox="elevated"\n',
    )
    const authFile = write('.codex/auth.json', '{"OPENAI_API_KEY":"old-key","tokens":{"access_token":"oauth-keep"}}')
    const undo = store.update('codex', {
      revision: store.read('codex', true).revision,
      baseUrl: 'https://new.example.test/v1',
      model: 'new',
      apiKey: 'new-key',
    })
    const config = getStaticTOMLValue(parseTOML(fs.readFileSync(file, 'utf8')))
    expect(config).toMatchObject({
      model: 'new',
      model_reasoning_effort: 'high',
      mcp_servers: { test: { command: 'test' } },
      windows: { sandbox: 'elevated' },
    })
    expect(JSON.parse(fs.readFileSync(authFile, 'utf8'))).toEqual({
      OPENAI_API_KEY: 'new-key',
      tokens: { access_token: 'oauth-keep' },
    })
    undo()
    expect(store.read('codex', true).model).toBe('old')
    expect(JSON.parse(fs.readFileSync(authFile, 'utf8')).OPENAI_API_KEY).toBe('old-key')
  })

  it('edits one OpenCode provider and default model while keeping other providers and comments', () => {
    const { write, store } = setup()
    const file = write(
      '.config/opencode/opencode.jsonc',
      '{\n// keep\n"provider":{"one":{"options":{"baseURL":"https://one.example.test","apiKey":"secret"},"models":{"a":{"name":"A"}}},"two":{"options":{"apiKey":"other-secret"}}},"mcp":{"test":{"command":["test"]}},\n}\n',
    )
    store.update('opencode', {
      revision: store.read('opencode', true).revision,
      providerId: 'one',
      baseUrl: 'https://updated.example.test',
      model: 'a',
    })
    const text = fs.readFileSync(file, 'utf8')
    expect(text).toContain('// keep')
    expect(text).toContain('other-secret')
    expect(text).toContain('"mcp"')
    expect(store.read('opencode', true)).toMatchObject({
      model: 'a',
      providerId: 'one',
      baseUrl: 'https://updated.example.test',
      hasApiKey: true,
    })
  })

  it('manages OpenCode model ids while preserving existing model options', () => {
    const { write, store } = setup()
    const file = write(
      '.config/opencode/opencode.json',
      JSON.stringify({
        provider: {
          gateway: {
            options: { baseURL: 'https://oc.example.test' },
            models: { existing: { name: 'Existing', limit: { context: 1000 } }, remove: { name: 'Remove' } },
          },
        },
        model: 'gateway/existing',
      }),
    )
    const native = store.read('opencode', true)
    store.update('opencode', { revision: native.revision, models: ['existing', 'added'] })
    const updated = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(updated.provider.gateway.models).toEqual({
      existing: { name: 'Existing', limit: { context: 1000 } },
      added: { name: 'added' },
    })
  })

  it('rejects stale revisions and malformed files without overwriting them', () => {
    const { write, store } = setup()
    const file = write('.claude/settings.json', '{}')
    const revision = store.read('claude', true).revision
    fs.writeFileSync(file, '{"theme":"changed elsewhere"}')
    expect(() => store.update('claude', { revision, model: 'new' })).toThrow('agent_native_changed')
    expect(fs.readFileSync(file, 'utf8')).toBe('{"theme":"changed elsewhere"}')
    fs.writeFileSync(file, '{broken')
    expect(store.read('claude', true).error).toBe('agent_native_invalid')
    expect(() => store.update('claude', { revision, model: 'new' })).toThrow('agent_native_invalid')
    expect(fs.readFileSync(file, 'utf8')).toBe('{broken')
    expect(store.read('codex', true).error).toBeUndefined()
  })

  it('merges layered OpenCode files and edits the overriding file without rewriting the base', () => {
    const { write, store } = setup()
    const base =
      '{"provider":{"gateway":{"options":{"baseURL":"https://base.example.test","apiKey":"secret"},"models":{"a":{"name":"A"}}}},"mcp":{"test":{}}}'
    const baseFile = write('.config/opencode/opencode.json', base)
    const override = write('.config/opencode/opencode.jsonc', '{ // override\n"model":"gateway/a"\n}')
    const native = store.read('opencode', true)
    expect(native).toMatchObject({
      baseUrl: 'https://base.example.test',
      model: 'a',
      hasApiKey: true,
      sourcePath: override,
    })
    store.update('opencode', { revision: native.revision, baseUrl: 'https://override.example.test' })
    expect(fs.readFileSync(baseFile, 'utf8')).toBe(base)
    expect(store.read('opencode', true)).toMatchObject({ baseUrl: 'https://override.example.test', hasApiKey: true })
  })

  it('honors agent directory overrides and protects environment-sourced Codex credentials', () => {
    const { dir, write } = setup()
    const file = write('override/config.toml', 'model_provider="custom"\n[model_providers.custom]\nenv_key="MY_KEY"\n')
    const store = new NativeAgentConfigStore(path.join(dir, 'state'), {
      home: dir,
      env: { CODEX_HOME: path.dirname(file), MY_KEY: 'environment-private' },
    })
    const native = store.read('codex', true)
    expect(native).toMatchObject({ sourcePath: file, hasApiKey: true, keyEditable: false, keySource: 'env:MY_KEY' })
    expect(() => store.update('codex', { revision: native.revision, apiKey: 'replacement' })).toThrow(
      'agent_native_env_key',
    )
    expect(fs.readFileSync(file, 'utf8')).toContain('MY_KEY')
  })

  it('restores original files when restarting with edited native settings fails', async () => {
    const { dir, write, store } = setup()
    const original = '{"model":"old"}'
    const file = write('.claude/settings.json', original)
    const apply = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('restart failed'))
      .mockResolvedValueOnce(undefined)
    const profiles = new AgentProfileStore(path.join(dir, 'state'), { apply })
    await expect(
      profiles.editNative('claude', () =>
        store.update('claude', { revision: store.read('claude', true).revision, model: 'new' }),
      ),
    ).rejects.toThrow('agent_profile_apply_failed')
    expect(fs.readFileSync(file, 'utf8')).toBe(original)
    expect(apply).toHaveBeenCalledTimes(2)
  })
})
