const ERROR_LABELS: Record<string, string> = {
  invalid_antigravity_api_key: '请输入 Gemini API Key。',
  antigravity_turn_running: 'Antigravity 正在处理一个回合，请在结束后重试。',
  invalid_agent_profile_name: '请输入 1–100 个字符的配置名称。',
  invalid_agent_profile_url: '请输入有效的 HTTP 或 HTTPS 接口地址。',
  invalid_agent_profile_value: '密钥或模型名称过长。',
  agent_profile_not_found: '这份配置已不存在，请刷新后重试。',
  agent_profile_active: '请先切换到其他配置，再删除这份配置。',
  agent_profile_busy: '另一项配置操作正在进行，请稍后重试。',
  agent_profile_limit: '每个 Agent 最多保存 100 份配置。',
  agent_profile_opencode_required: 'OpenCode 的供应商需要填写接口地址和模型名称。',
  agent_profile_opencode_config_invalid: '执行机的 OPENCODE_CONFIG_CONTENT 必须是有效的 JSON 对象。',
  agent_profile_external_service:
    '当前连接的是外部服务。配置可保存，请在外部服务中管理连接，或改用执行机托管的服务后启用。',
  agent_profile_apply_failed: '配置启用失败，已恢复原配置。请检查 Agent 服务后重试。',
  agent_profile_restore_failed: '配置应用失败，原选择已恢复，但服务未能恢复。请检查执行机上的服务状态。',
  agent_profile_store_unwritable: '执行机上的配置无法写入，请检查状态目录权限。',
  agent_profile_store_unreadable: '无法读取执行机上的配置文件。',
  agent_profile_store_invalid: '执行机上的配置文件格式有误，请先修复文件。',
  agent_native_changed: '配置文件已被其他程序修改。请关闭编辑面板，刷新后重试。',
  agent_native_invalid: '现有配置文件格式有误，无法安全编辑。请先在执行机修复文件。',
  agent_native_unreadable: '无法读取现有配置文件，请检查执行机上的文件权限。',
  agent_native_unwritable: '无法保存现有配置文件，请检查文件权限。',
  agent_native_backup_failed: '原配置备份失败，未修改现有配置。请检查状态目录权限。',
  agent_native_provider_missing: '请选择现有供应商；要使用新供应商，请先添加配置。',
  agent_native_env_key: '此供应商从环境变量读取密钥，请在执行机上修改该环境变量。',
  agent_profile_models_unavailable: '无法获取模型列表，请检查接口地址和密钥。',
  agent_profile_models_timeout: '获取模型列表超时，请稍后重试。',
}

export function agentProfileErrorLabel(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return ERROR_LABELS[message] ?? message
}
