import type { Settings } from '@anthropic-ai/claude-agent-sdk'
import { AgentProfileError, type StoredAgentProfile } from './profiles.js'

export type AgentConnection = () => StoredAgentProfile | undefined

/** Stable provider id used for models supplied by a managed OpenCode profile. */
export const OPENCODE_PROFILE_PROVIDER = 'vibemobile'

/** Profile fields historically stored a bare model id; accept API composite ids too. */
export function opencodeProfileModelId(value?: string): string | undefined {
  if (!value) return undefined
  const prefix = `${OPENCODE_PROFILE_PROVIDER}/`
  return value.startsWith(prefix) ? value.slice(prefix.length) : value
}

export function opencodeProfileModelRef(value?: string): string | undefined {
  const model = opencodeProfileModelId(value)
  return model ? `${OPENCODE_PROFILE_PROVIDER}/${model}` : undefined
}

/** Overrides are scoped to the runner's children; native login/MCP files stay intact. */
export function codexProfileLaunch(profile?: StoredAgentProfile): { args: string[]; env: NodeJS.ProcessEnv } {
  if (!profile) return { args: [], env: {} }
  const values: Record<string, string | boolean> = {}
  const env: NodeJS.ProcessEnv = {}
  if (profile.baseUrl || profile.apiKey) {
    // Codex app-server filters thread/list by the active provider key. Keep
    // profile overrides under the user's existing `custom` key so runner can
    // see and resume sessions created by desktop Codex.
    const prefix = 'model_providers.custom'
    values.model_provider = 'custom'
    values[`${prefix}.name`] = profile.name
    values[`${prefix}.base_url`] = profile.baseUrl || 'https://api.openai.com/v1'
    values[`${prefix}.wire_api`] = 'responses'
    values[`${prefix}.requires_openai_auth`] = false
    if (profile.apiKey) {
      values[`${prefix}.env_key`] = 'VIBEMOBILE_CODEX_API_KEY'
      env.VIBEMOBILE_CODEX_API_KEY = profile.apiKey
    }
  }
  if (profile.model) values.model = profile.model
  return { args: Object.entries(values).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]), env }
}

/** --settings has priority over user settings without replacing the SDK environment. */
export function claudeProfileOptions(profile?: StoredAgentProfile): { settings?: Settings; model?: string } {
  if (!profile) return {}
  const env: Record<string, string> = {}
  if (profile.baseUrl) env.ANTHROPIC_BASE_URL = profile.baseUrl
  if (profile.apiKey) {
    env.ANTHROPIC_AUTH_TOKEN = profile.apiKey
    // Prevent a key in user settings from competing with the selected bearer token.
    env.ANTHROPIC_API_KEY = ''
  }
  if (profile.model) env.ANTHROPIC_MODEL = profile.model
  return { settings: { env }, ...(profile.model ? { model: profile.model } : {}) }
}

/** OpenCode 2.2 accepts the v1 provider shape and migrates it to its native schema. */
export function opencodeProfileEnv(profile?: StoredAgentProfile, nativeContent?: string): NodeJS.ProcessEnv {
  if (!profile) return {}
  let native: { provider?: Record<string, unknown>; [key: string]: unknown } = {}
  if (nativeContent) {
    try {
      native = JSON.parse(nativeContent) as typeof native
      if (!native || typeof native !== 'object' || Array.isArray(native)) throw new Error('object required')
    } catch {
      throw new AgentProfileError('agent_profile_opencode_config_invalid')
    }
  }
  const model = opencodeProfileModelId(profile.model)
  const content = {
    ...native,
    provider: {
      ...native.provider,
      vibemobile: {
        name: profile.name,
        npm: '@ai-sdk/openai-compatible',
        options: { baseURL: profile.baseUrl, apiKey: profile.apiKey },
        ...(model ? { models: { [model]: { name: model } } } : {}),
      },
    },
    ...(model ? { model: `${OPENCODE_PROFILE_PROVIDER}/${model}` } : {}),
  }
  return { OPENCODE_CONFIG_CONTENT: JSON.stringify(content) }
}
