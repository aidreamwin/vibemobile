import { describe, expect, it } from 'vitest'
import { claudeProfileOptions, codexProfileLaunch, opencodeProfileEnv } from './profileRuntime.js'
import type { StoredAgentProfile } from './profiles.js'
import { getStaticTOMLValue, parseTOML } from 'toml-eslint-parser'

function providerConfig(args: string[]): Record<string, unknown> {
  return getStaticTOMLValue(parseTOML(args.find((arg) => arg.startsWith('model_providers=')) ?? '')) as Record<
    string,
    unknown
  >
}

const profile: StoredAgentProfile = {
  id: 'profile-0123456789abcdef',
  name: 'Gateway',
  baseUrl: 'https://gateway.example.test/v1',
  apiKey: 'private-test-token',
  model: 'custom-model',
  models: ['custom-model'],
  updatedAt: 1,
}

describe('agent profile launch overrides', () => {
  it('passes Codex credentials through child environment, never command line', () => {
    const launch = codexProfileLaunch(profile, 'OpenAI')
    expect(launch.args.join(' ')).not.toContain(profile.apiKey)
    expect(launch.args).toContain('model_provider="OpenAI"')
    expect(providerConfig(launch.args)).toMatchObject({
      model_providers: { OpenAI: { env_key: 'VIBEMOBILE_CODEX_API_KEY', wire_api: 'responses' } },
    })
    expect(launch.env.VIBEMOBILE_CODEX_API_KEY).toBe(profile.apiKey)
    expect(codexProfileLaunch()).toEqual({ args: [], env: {} })
  })

  it('keeps the same native provider identity across gateway profile switches', () => {
    for (const providerId of ['OpenAI', 'openai', 'custom', 'gateway.with.dots']) {
      const first = codexProfileLaunch(profile, providerId)
      const second = codexProfileLaunch({ ...profile, baseUrl: 'https://second.example.test/v1' }, providerId)
      expect(first.args).toContain(`model_provider=${JSON.stringify(providerId)}`)
      expect(second.args).toContain(`model_provider=${JSON.stringify(providerId)}`)
      expect(providerConfig(second.args)).toMatchObject({
        model_providers: { [providerId]: { base_url: 'https://second.example.test/v1' } },
      })
    }
  })

  it('uses Claude settings without replacing the SDK process environment', () => {
    const options = claudeProfileOptions(profile)
    expect(options).not.toHaveProperty('env')
    expect(options.settings?.env).toMatchObject({
      ANTHROPIC_BASE_URL: profile.baseUrl,
      ANTHROPIC_AUTH_TOKEN: profile.apiKey,
      ANTHROPIC_API_KEY: '',
    })
    expect(options.model).toBe(profile.model)
    expect(claudeProfileOptions()).toEqual({})
  })

  it('preserves OpenCode native providers and MCP configuration in the child override', () => {
    const native = { mcp: { local: { command: ['test'] } }, provider: { existing: { name: 'Existing' } } }
    const env = opencodeProfileEnv(profile, JSON.stringify(native))
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '')
    expect(config.mcp).toEqual(native.mcp)
    expect(config.provider.existing).toEqual(native.provider.existing)
    expect(config.provider.vibemobile.options).toEqual({ baseURL: profile.baseUrl, apiKey: profile.apiKey })
    expect(config.model).toBe('vibemobile/custom-model')
    expect(opencodeProfileEnv(undefined, '{invalid')).toEqual({})
  })

  it('rejects malformed native OpenCode content instead of discarding it', () => {
    for (const content of ['{invalid', 'null', '[]', '"string"']) {
      expect(() => opencodeProfileEnv(profile, content)).toThrow('agent_profile_opencode_config_invalid')
    }
  })
})
