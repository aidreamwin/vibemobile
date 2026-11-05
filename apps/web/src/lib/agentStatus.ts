import type { AgentRuntimeStatus, ProviderStatus } from '@vibemobile/protocol'

export function agentStatus(
  agent: AgentRuntimeStatus | undefined,
  provider: ProviderStatus | undefined,
  checked?: string | null,
) {
  const version = agent?.active || provider?.version?.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0]
  const newer = Boolean(agent && checked && checked !== agent.active)
  const label = agent?.updating
    ? '更新中'
    : agent?.error
      ? '更新失败'
      : checked === null
        ? '检查失败'
        : provider?.available
          ? provider.authenticated === false
            ? '未登录'
            : newer
              ? '可更新'
              : '可用'
          : agent?.source === 'missing'
            ? '未安装'
            : provider
              ? '不可用'
              : '检查中'
  const warning = !provider?.available || provider.authenticated === false || Boolean(agent?.error) || checked === null
  return { label, version, tone: warning ? 'text-warning' : newer ? 'text-primary' : '' }
}
