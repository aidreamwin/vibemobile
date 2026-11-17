import { describe, expect, it } from 'vitest'
import type { AgentProfilesResponse, NativeAgentProfile } from '@vibemobile/protocol'
import { currentProvider } from './currentProvider'

function fixture(): AgentProfilesResponse {
  const native: NativeAgentProfile = {
    id: 'native',
    name: '执行机现有配置',
    baseUrl: null,
    model: null,
    models: [],
    hasApiKey: false,
    active: true,
    updatedAt: 0,
    sourcePath: 'config.toml',
    exists: true,
    revision: '1',
    providerId: 'custom',
    providers: [{ id: 'custom', name: 'Custom API', baseUrl: null, hasApiKey: true, models: [] }],
    modelAliases: {},
    keyEditable: true,
    keySource: null,
  }
  return {
    data: { codex: [], claude: [], opencode: [] },
    active: { codex: null, claude: null, opencode: null },
    native: { codex: native, claude: { ...native, providerId: null }, opencode: { ...native } },
  }
}

describe('current provider', () => {
  it('uses the active managed profile rather than the native configuration', () => {
    const profiles = fixture()
    profiles.active.codex = 'managed'
    profiles.data.codex = [{ ...profiles.native!.codex, id: 'managed', name: 'Managed API' }]
    expect(currentProvider('codex', profiles)).toEqual({ name: 'Managed API' })
    profiles.active.codex = 'missing'
    expect(currentProvider('codex', profiles)).toBeNull()
  })

  it('shows a native provider name and key, including built-in providers', () => {
    const profiles = fixture()
    expect(currentProvider('codex', profiles)).toEqual({ name: 'Custom API', id: 'custom' })
    profiles.native!.codex.providerId = 'openai'
    expect(currentProvider('codex', profiles)).toEqual({ name: 'openai' })
    expect(currentProvider('opencode', profiles)).toEqual({ name: 'Custom API', id: 'custom' })
  })

  it('shows only the host for a native endpoint without a provider key', () => {
    const profiles = fixture()
    profiles.native!.claude.baseUrl = 'https://user:secret@api.example.com/v1?key=secret'
    expect(currentProvider('claude', profiles)).toEqual({ name: 'api.example.com' })
    profiles.native!.claude.baseUrl = 'invalid'
    expect(currentProvider('claude', profiles)).toBeNull()
  })

  it('does not guess when a provider is unknown, unreadable or externally managed', () => {
    const profiles = fixture()
    expect(currentProvider('other', profiles)).toBeNull()
    expect(currentProvider(undefined, profiles)).toBeNull()
    profiles.native!.codex.error = 'agent_native_unreadable'
    expect(currentProvider('codex', profiles)).toBeNull()
    profiles.limitations = { opencode: 'External service' }
    expect(currentProvider('opencode', profiles)).toBeNull()
    delete profiles.native
    expect(currentProvider('claude', profiles)).toBeNull()
  })
})
