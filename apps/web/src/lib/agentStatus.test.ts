import { describe, expect, it } from 'vitest'
import type { AgentRuntimeStatus, ProviderStatus } from '@vibemobile/protocol'
import { agentStatus } from './agentStatus'

const missing: AgentRuntimeStatus = {
  id: 'opencode',
  displayName: 'OpenCode',
  active: null,
  source: 'missing',
  supported: '~2.2.0',
  satisfied: false,
  installed: [],
  updating: false,
  error: null,
}
const provider: ProviderStatus = {
  id: 'opencode',
  displayName: 'OpenCode',
  available: true,
  version: 'opencode 2.2.5 (windows)',
}

describe('settings agent status', () => {
  it('shows an available external service even without a local runtime', () => {
    expect(agentStatus(missing, provider)).toMatchObject({ label: '可用', version: '2.2.5', tone: '' })
  })
  it('prefers the installed runtime version to SDK or verbose probe output', () => {
    expect(agentStatus({ ...missing, active: '2.2.6' }, provider).version).toBe('2.2.6')
  })
  it('reports missing installation only when no service is available', () => {
    expect(agentStatus(missing, { ...provider, available: false }).label).toBe('未安装')
  })
  it('distinguishes missing credentials from service availability', () => {
    expect(agentStatus(missing, { ...provider, authenticated: false }).label).toBe('未登录')
  })
  it('reports failed checks and in-progress updates explicitly', () => {
    expect(agentStatus(missing, provider, null).label).toBe('检查失败')
    expect(agentStatus({ ...missing, updating: true }, provider, null).label).toBe('更新中')
  })
  it('shows available updates without treating every installed service as current', () => {
    expect(agentStatus({ ...missing, active: '2.2.5' }, provider, '2.2.6').label).toBe('可更新')
  })
})
