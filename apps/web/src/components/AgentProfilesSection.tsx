import { useCallback, useEffect, useState } from 'react'
import { Check, ChevronRight, LoaderCircle, MoreVertical, Pencil, Plus, Server, Trash2, X } from 'lucide-react'
import type { AgentProfile, AgentProfilesResponse, AgentRuntimeId, NativeAgentProfile } from '@vibemobile/protocol'
import { api } from '../lib/api'
import SelectField from './SelectField'
import Sheet from './Sheet'
import { Button } from './ui/button'
import { Input } from './ui/input'

const AGENTS: { id: AgentRuntimeId; name: string }[] = [
  { id: 'codex', name: 'Codex' },
  { id: 'claude', name: 'Claude' },
  { id: 'opencode', name: 'OpenCode' },
]

const ERROR_LABELS: Record<string, string> = {
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
}

function isNative(profile?: AgentProfile): profile is NativeAgentProfile {
  return Boolean(profile && 'sourcePath' in profile)
}

function errorLabel(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return ERROR_LABELS[message] ?? message
}

type Panel =
  | { kind: 'edit'; profile?: AgentProfile }
  | { kind: 'menu'; profile: AgentProfile }
  | { kind: 'delete'; profile: AgentProfile }
  | { kind: 'activate'; profile?: AgentProfile }

const EMPTY_DATA: AgentProfilesResponse = {
  data: { codex: [], claude: [], opencode: [] },
  active: { codex: null, claude: null, opencode: null },
}

function editorSnapshot(
  name: string,
  baseUrl: string,
  model: string,
  providerId: string,
  aliases: Record<string, string>,
  models: string[],
) {
  return JSON.stringify([
    name.trim(),
    baseUrl.trim(),
    model.trim(),
    providerId,
    Object.entries(aliases)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, value.trim()]),
    [...models].sort(),
  ])
}

export default function AgentProfilesSection() {
  const [data, setData] = useState<AgentProfilesResponse>(EMPTY_DATA)
  const [selected, setSelected] = useState<AgentRuntimeId>('codex')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [panel, setPanel] = useState<Panel | null>(null)
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [clearKey, setClearKey] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [providerId, setProviderId] = useState('')
  const [modelAliases, setModelAliases] = useState<Record<string, string>>({})
  const [providerModels, setProviderModels] = useState<string[]>([])
  const [newModel, setNewModel] = useState('')
  const [editingKey, setEditingKey] = useState(false)
  const [confirmClearKey, setConfirmClearKey] = useState(false)
  const [initialValues, setInitialValues] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await api.agentProfiles())
      setLoaded(true)
      setError(null)
    } catch (err) {
      setError(errorLabel(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const agent = AGENTS.find((item) => item.id === selected) ?? AGENTS[0]
  const profiles = data.data[selected]
  const active = profiles.find((profile) => profile.active)
  const limitation = data.limitations?.[selected]
  const native = data.native?.[selected]
  const nativeEditor = panel?.kind === 'edit' && isNative(panel.profile) ? panel.profile : undefined
  const selectedProvider = nativeEditor?.providers.find((provider) => provider.id === providerId)
  const savedKey =
    nativeEditor && selectedProvider ? selectedProvider.hasApiKey : panel?.kind === 'edit' && panel.profile?.hasApiKey
  const keyEditable = !nativeEditor || nativeEditor.providerId !== providerId || nativeEditor.keyEditable
  const changed = Boolean(
    panel?.kind === 'edit' &&
      (!panel.profile ||
        clearKey ||
        apiKey.trim() ||
        editorSnapshot(name, baseUrl, model, providerId, modelAliases, providerModels) !== initialValues),
  )

  function edit(profile?: AgentProfile) {
    const aliases = isNative(profile) ? { ...profile.modelAliases } : {}
    const models =
      isNative(profile) && profile.providerId
        ? (profile.providers.find((item) => item.id === profile.providerId)?.models ?? [])
        : []
    setInitialValues(
      editorSnapshot(
        profile?.name ?? '',
        profile?.baseUrl ?? '',
        profile?.model ?? '',
        isNative(profile) ? (profile.providerId ?? '') : '',
        aliases,
        models,
      ),
    )
    setEditingKey(false)
    setConfirmClearKey(false)
    setName(profile?.name ?? '')
    setBaseUrl(profile?.baseUrl ?? '')
    setApiKey('')
    setModel(profile?.model ?? '')
    setShowKey(false)
    setClearKey(false)
    setProviderId(isNative(profile) ? (profile.providerId ?? '') : '')
    setModelAliases(isNative(profile) ? { ...profile.modelAliases } : {})
    setProviderModels(
      isNative(profile) && profile.providerId
        ? (profile.providers.find((item) => item.id === profile.providerId)?.models ?? [])
        : [],
    )
    setNewModel('')
    setError(null)
    setPanel({ kind: 'edit', profile })
  }

  async function action(run: () => Promise<AgentProfilesResponse>, close = true) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      setData(await run())
      if (close) setPanel(null)
    } catch (err) {
      setError(errorLabel(err))
    } finally {
      setBusy(false)
    }
  }

  function save() {
    if (busy || !changed || panel?.kind !== 'edit' || (!nativeEditor && !name.trim())) return
    const body = {
      ...(nativeEditor ? {} : { name: name.trim() }),
      baseUrl: baseUrl.trim(),
      model: model.trim(),
      ...(clearKey ? { apiKey: '' } : apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      ...(nativeEditor
        ? {
            revision: nativeEditor.revision,
            ...(providerId ? { providerId } : {}),
            modelAliases,
            ...(selected === 'opencode' ? { models: providerModels } : {}),
          }
        : {}),
    }
    void action(() =>
      panel.profile ? api.updateAgentProfile(selected, panel.profile.id, body) : api.createAgentProfile(selected, body),
    )
  }

  return (
    <section className="mt-6" aria-label="Agent 配置">
      <div className="flex items-center justify-between px-1 pb-2">
        <h2 className="text-xs font-medium text-muted-foreground">Agent 配置</h2>
      </div>
      <div className="surface-list overflow-hidden shadow-sm">
        <fieldset
          className="m-2 grid min-w-0 grid-cols-3 gap-1 rounded-xl border-0 bg-background/50 p-1"
          aria-label="选择 Agent"
        >
          {AGENTS.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={selected === item.id}
              onClick={() => {
                setSelected(item.id)
                setError(null)
              }}
              className={`tap min-h-11 min-w-0 rounded-lg px-2 text-[13px] transition-colors focus-visible:outline-2 focus-visible:outline-ring ${selected === item.id ? 'bg-secondary font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {item.name}
            </button>
          ))}
        </fieldset>

        {!loading && loaded && native && (
          <div className="space-y-2 border-b border-border/70 px-4 py-3">
            <div className="flex items-center gap-3">
              <div
                className={`flex size-7 shrink-0 items-center justify-center rounded-full ${native.active && !limitation ? 'bg-success/10 text-success' : 'bg-secondary text-muted-foreground'}`}
                aria-hidden="true"
              >
                {native.active && !limitation ? <Check className="size-3.5" /> : <Server className="size-3.5" />}
              </div>
              <div className="min-w-0 flex-1 space-y-1">
                <p className="truncate text-sm font-medium">现有配置</p>
                {native.active && !limitation && <span className="sr-only">正在使用</span>}
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || Boolean(native.error)}
                onClick={() => edit(native)}
                className="h-11 shrink-0 rounded-xl px-3 text-[13px]"
              >
                <Pencil className="size-3.5" />
                编辑
              </Button>
            </div>
            {native.error && (
              <p role="alert" className="text-xs text-destructive">
                {ERROR_LABELS[native.error] ?? native.error}
              </p>
            )}
            {active && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy || Boolean(limitation)}
                onClick={() => {
                  setError(null)
                  setPanel({ kind: 'activate' })
                }}
                className="h-11 rounded-xl text-[13px]"
              >
                使用现有配置
              </Button>
            )}
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center gap-2 px-4 py-7 text-xs text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" /> 读取配置中…
          </div>
        ) : !loaded ? (
          <p className="px-4 py-6 text-center text-xs text-muted-foreground">配置读取失败，请重试。</p>
        ) : profiles.length ? (
          <div className="divide-y divide-border/70">
            {profiles.map((profile) => (
              <div key={profile.id} className="flex min-w-0 items-center gap-2 py-3 pl-4 pr-1">
                <div
                  className={`flex size-7 shrink-0 items-center justify-center rounded-full ${profile.active && !limitation ? 'bg-success/10 text-success' : 'bg-secondary text-muted-foreground'}`}
                >
                  {profile.active && !limitation ? <Check className="size-3.5" /> : <Server className="size-3.5" />}
                </div>
                <button
                  type="button"
                  onClick={() => edit(profile)}
                  className="min-h-11 min-w-0 flex-1 rounded-lg text-left focus-visible:outline-2 focus-visible:outline-ring"
                  aria-label={`编辑 ${profile.name}`}
                >
                  <span className="block truncate text-[13px] font-medium">{profile.name}</span>
                </button>
                {!profile.active && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || Boolean(limitation)}
                    onClick={() => {
                      setError(null)
                      setPanel({ kind: 'activate', profile })
                    }}
                    className="h-11 rounded-xl px-3 text-[13px]"
                  >
                    启用
                  </Button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setError(null)
                    setPanel({ kind: 'menu', profile })
                  }}
                  className="tap min-h-11 w-11 shrink-0 rounded-xl text-muted-foreground"
                  aria-label={`${profile.name} 的操作`}
                >
                  <MoreVertical className="mx-auto size-4" />
                </button>
              </div>
            ))}
          </div>
        ) : null}

        <div className="px-3 py-2.5">
          <Button
            type="button"
            variant="ghost"
            onClick={() => edit()}
            disabled={loading || busy || !loaded}
            className="h-11 w-full justify-start rounded-xl px-3 text-sm text-primary"
          >
            <Plus className="size-4" /> 添加供应商
          </Button>
          {limitation && <p className="mt-2 text-xs text-warning">{ERROR_LABELS[limitation] ?? limitation}</p>}
        </div>
        {error && !panel && (
          <p role="alert" className="px-4 pb-3 text-xs text-destructive">
            {error}{' '}
            <button type="button" onClick={() => void load()} className="underline">
              重试
            </button>
          </p>
        )}
      </div>

      {panel?.kind === 'edit' && (
        <Sheet
          title={nativeEditor ? `${agent.name} 配置` : `${panel.profile ? '编辑' : '添加'} ${agent.name} 供应商`}
          onClose={() => setPanel(null)}
          dismissable={!busy}
          footer={
            <div className="space-y-3">
              {error && (
                <p role="alert" className="text-xs text-destructive">
                  {error}
                </p>
              )}
              {panel.profile?.active && changed && (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {nativeEditor && limitation
                    ? '保存后需在外部服务中重新加载配置。'
                    : selected === 'claude'
                      ? '新配置从下一回合生效。'
                      : '保存将重启服务，中断正在进行的回合。'}
                </p>
              )}
              <Button
                type="submit"
                form="agent-profile-editor"
                disabled={
                  busy ||
                  !changed ||
                  Boolean(!nativeEditor && !name.trim()) ||
                  Boolean(!nativeEditor && panel.profile?.active && limitation)
                }
                className="h-12 w-full rounded-xl text-sm"
              >
                {busy ? (
                  <>
                    <LoaderCircle className="size-4 animate-spin" /> 保存中…
                  </>
                ) : panel.profile ? (
                  '保存'
                ) : (
                  '添加供应商'
                )}
              </Button>
            </div>
          }
        >
          <form
            id="agent-profile-editor"
            onSubmit={(event) => {
              event.preventDefault()
              save()
            }}
            className="px-4 pt-3 pb-5"
          >
            <fieldset disabled={busy} className="m-0 min-w-0 space-y-5 border-0 p-0">
              {!nativeEditor && (
                <label htmlFor="agent-profile-name" className="block space-y-2 text-xs text-muted-foreground">
                  <span>
                    配置名称 <span className="text-destructive">*</span>
                  </span>
                  <Input
                    id="agent-profile-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="例如：公司网关、个人 API"
                    maxLength={100}
                    required
                    className="h-12 rounded-xl text-base md:text-base"
                  />
                </label>
              )}
              {nativeEditor && nativeEditor.providers.length > 0 && (
                <div className="space-y-2 text-xs text-muted-foreground">
                  <span>供应商</span>
                  <SelectField
                    value={providerId}
                    onChange={(id) => {
                      const provider = nativeEditor.providers.find((item) => item.id === id)
                      setProviderId(id)
                      setBaseUrl(provider?.baseUrl ?? '')
                      setModel(id === nativeEditor.providerId ? (nativeEditor.model ?? '') : '')
                      setProviderModels(provider?.models ?? [])
                      setApiKey('')
                      setShowKey(false)
                      setClearKey(false)
                      setEditingKey(false)
                      setConfirmClearKey(false)
                    }}
                    options={nativeEditor.providers.map((provider) => ({ value: provider.id, label: provider.name }))}
                    ariaLabel="供应商"
                    disabled={busy}
                  />
                </div>
              )}
              <label htmlFor="agent-profile-model" className="block space-y-2 text-xs text-muted-foreground">
                <span>默认模型</span>
                <Input
                  value={model}
                  id="agent-profile-model"
                  onChange={(event) => setModel(event.target.value)}
                  placeholder="留空使用默认模型"
                  list={selectedProvider ? 'agent-native-models' : undefined}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  className="h-12 rounded-xl font-mono text-base md:text-base"
                />
              </label>
              <label htmlFor="agent-profile-base-url" className="block space-y-2 text-xs text-muted-foreground">
                <span>接口地址</span>
                <Input
                  value={baseUrl}
                  id="agent-profile-base-url"
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder={selected === 'claude' ? 'https://api.anthropic.com' : 'https://api.example.com/v1'}
                  inputMode="url"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  className="h-12 rounded-xl font-mono text-base md:text-base"
                />
              </label>
              <div className="space-y-2">
                <div className="flex min-h-6 items-center justify-between gap-2">
                  <label
                    htmlFor={keyEditable && !clearKey && (!savedKey || editingKey) ? 'agent-profile-key' : undefined}
                    className="text-xs text-muted-foreground"
                  >
                    API Key
                  </label>
                  {editingKey && savedKey && (
                    <button
                      type="button"
                      className="min-h-11 px-2 text-xs text-muted-foreground"
                      onClick={() => {
                        setEditingKey(false)
                        setApiKey('')
                        setShowKey(false)
                      }}
                    >
                      取消更换
                    </button>
                  )}
                </div>
                {clearKey ? (
                  <div
                    role="status"
                    className="flex min-h-12 items-center justify-between gap-2 rounded-xl bg-secondary/50 px-3"
                  >
                    <span className="text-sm text-muted-foreground">保存后移除密钥</span>
                    <button
                      type="button"
                      onClick={() => setClearKey(false)}
                      className="min-h-11 px-2 text-sm text-primary"
                    >
                      撤销
                    </button>
                  </div>
                ) : !keyEditable || (savedKey && !editingKey) ? (
                  <div className="flex min-h-12 items-center justify-between gap-2 rounded-xl bg-secondary/50 px-3">
                    <span className="flex items-center gap-2 text-sm">
                      <Check className="size-4 text-muted-foreground" />
                      {!keyEditable ? '由环境变量管理' : '已配置密钥'}
                    </span>
                    {keyEditable && (
                      <button
                        type="button"
                        onClick={() => setEditingKey(true)}
                        className="min-h-11 px-2 text-sm text-primary"
                      >
                        更换
                      </button>
                    )}
                  </div>
                ) : (
                  <>
                    <div className="relative">
                      <Input
                        id="agent-profile-key"
                        type={showKey ? 'text' : 'password'}
                        value={apiKey}
                        onChange={(event) => setApiKey(event.target.value)}
                        placeholder={savedKey ? '输入新密钥' : '输入 API Key'}
                        autoComplete="new-password"
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        className="h-12 rounded-xl pr-16 font-mono text-base md:text-base"
                      />
                      <button
                        type="button"
                        onClick={() => setShowKey(!showKey)}
                        aria-label={showKey ? '隐藏密钥' : '显示密钥'}
                        className="absolute inset-y-0 right-0 min-w-12 px-3 text-xs text-muted-foreground"
                      >
                        {showKey ? '隐藏' : '显示'}
                      </button>
                    </div>
                    <p className="text-xs text-muted-foreground">密钥仅保存在执行机器上。</p>
                  </>
                )}
              </div>
              {selected === 'opencode' && nativeEditor && (
                <details className="group rounded-xl border border-border/70">
                  <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 px-3 text-sm [&::-webkit-details-marker]:hidden">
                    <span className="flex-1">模型管理</span>
                    <span className="text-xs text-muted-foreground">{providerModels.length} 个</span>
                    <ChevronRight className="size-4 text-muted-foreground transition-transform group-open:rotate-90" />
                  </summary>
                  <div className="space-y-3 px-3 pb-3">
                    <p className="text-xs text-muted-foreground">点选模型设为默认，最多添加 100 个。</p>
                    {providerModels.length > 0 ? (
                      <div className="divide-y divide-border/60">
                        {providerModels.map((value) => (
                          <div key={value} className="flex min-w-0 items-center gap-1">
                            <button
                              type="button"
                              className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-left"
                              onClick={() => setModel(value)}
                              aria-label={`设为默认模型 ${value}`}
                              aria-pressed={model === value}
                            >
                              <span
                                className={`min-w-0 flex-1 break-all font-mono text-sm ${model === value ? 'text-primary' : 'text-foreground/80'}`}
                              >
                                {value}
                              </span>
                              {model === value && <Check className="size-4 shrink-0 text-primary" />}
                            </button>
                            <button
                              type="button"
                              className="tap size-11 shrink-0 rounded-lg text-muted-foreground hover:text-destructive"
                              onClick={() => {
                                setProviderModels((current) => current.filter((item) => item !== value))
                                if (model === value) setModel('')
                              }}
                              aria-label={`移除模型 ${value}`}
                            >
                              <X className="size-4" />
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="py-3 text-center text-xs text-muted-foreground">暂无模型，添加一个开始使用。</p>
                    )}
                    <div className="flex gap-2">
                      <Input
                        value={newModel}
                        onChange={(event) => setNewModel(event.target.value)}
                        placeholder="输入模型 ID"
                        aria-label="新模型 ID"
                        className="h-12 min-w-0 flex-1 rounded-xl font-mono text-base md:text-base"
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        onKeyDown={(event) => {
                          if (event.key !== 'Enter') return
                          event.preventDefault()
                          const value = newModel.trim()
                          if (value && !providerModels.includes(value) && providerModels.length < 100) {
                            setProviderModels((current) => [...current, value])
                            setModel(value)
                            setNewModel('')
                          }
                        }}
                      />
                      <Button
                        type="button"
                        variant="secondary"
                        className="h-12 shrink-0 rounded-xl px-3"
                        disabled={
                          !newModel.trim() || providerModels.includes(newModel.trim()) || providerModels.length >= 100
                        }
                        onClick={() => {
                          const value = newModel.trim()
                          if (!value || providerModels.includes(value) || providerModels.length >= 100) return
                          setProviderModels((current) => [...current, value])
                          setModel(value)
                          setNewModel('')
                        }}
                        aria-label="添加模型"
                      >
                        <Plus className="size-4" />
                      </Button>
                    </div>
                  </div>
                </details>
              )}
              {selectedProvider && (
                <datalist id="agent-native-models">
                  {(selected === 'opencode' ? providerModels : selectedProvider.models).map((value) => (
                    <option key={value} value={value} />
                  ))}
                </datalist>
              )}
              <details className="group border-t border-border/70">
                <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between text-sm text-muted-foreground [&::-webkit-details-marker]:hidden">
                  高级设置
                  <ChevronRight className="size-4 transition-transform group-open:rotate-90" />
                </summary>
                <div className="space-y-4 pt-1 text-xs leading-relaxed text-muted-foreground">
                  {nativeEditor ? (
                    <p>保存会更新本机原始配置，并自动备份修改前的内容。</p>
                  ) : (
                    <p>
                      {selected === 'opencode'
                        ? '支持 OpenAI Chat Completions 兼容接口，启用前需填写接口地址和模型名称。'
                        : selected === 'codex'
                          ? '支持 OpenAI Responses 兼容接口。'
                          : '使用此供应商连接 Claude。'}
                    </p>
                  )}
                  {nativeEditor?.keySource && providerId === nativeEditor.providerId && (
                    <p className="break-all">
                      凭据来源：{nativeEditor.keySource}
                      {!keyEditable ? '。请在执行机上修改环境变量。' : ''}
                    </p>
                  )}
                  {nativeEditor && Object.keys(modelAliases).length > 0 && (
                    <div className="space-y-3">
                      <p className="font-medium text-foreground">模型别名</p>
                      {Object.entries(modelAliases).map(([key, value]) => (
                        <label key={key} htmlFor={`native-${key}`} className="block space-y-2">
                          <span>{key.replace('ANTHROPIC_DEFAULT_', '')}</span>
                          <Input
                            id={`native-${key}`}
                            value={value}
                            onChange={(event) => setModelAliases({ ...modelAliases, [key]: event.target.value })}
                            autoCapitalize="none"
                            autoCorrect="off"
                            spellCheck={false}
                            className="h-12 rounded-xl font-mono text-base md:text-base"
                          />
                        </label>
                      ))}
                    </div>
                  )}
                  {savedKey &&
                    keyEditable &&
                    !clearKey &&
                    (confirmClearKey ? (
                      <div className="space-y-2 rounded-xl bg-secondary/40 p-3">
                        <p className="text-foreground">移除密钥后可能无法使用此供应商，保存后生效。</p>
                        <div className="flex gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            className="min-h-11 flex-1 rounded-xl"
                            onClick={() => setConfirmClearKey(false)}
                          >
                            保留密钥
                          </Button>
                          <Button
                            type="button"
                            variant="destructive"
                            className="min-h-11 flex-1 rounded-xl"
                            onClick={() => {
                              setClearKey(true)
                              setApiKey('')
                              setShowKey(false)
                              setEditingKey(false)
                              setConfirmClearKey(false)
                            }}
                          >
                            确认移除
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmClearKey(true)}
                        className="min-h-11 text-sm text-destructive"
                      >
                        移除已保存的密钥
                      </button>
                    ))}
                </div>
              </details>
            </fieldset>
          </form>
        </Sheet>
      )}

      {panel?.kind === 'menu' && (
        <Sheet title={panel.profile.name} onClose={() => setPanel(null)}>
          <div className="space-y-1 px-3 pt-1 pb-4">
            <button
              type="button"
              onClick={() => edit(panel.profile)}
              className="tap min-h-12 w-full justify-start gap-3 rounded-xl px-3 text-sm active:bg-secondary"
            >
              <Pencil className="size-4 text-muted-foreground" /> 编辑配置{' '}
              <ChevronRight className="ml-auto size-4 text-muted-foreground" />
            </button>
            <button
              type="button"
              disabled={panel.profile.active}
              onClick={() => setPanel({ kind: 'delete', profile: panel.profile })}
              className="tap min-h-12 w-full justify-start gap-3 rounded-xl px-3 text-sm text-destructive active:bg-destructive/10 disabled:opacity-40"
            >
              <Trash2 className="size-4" /> 删除配置
            </button>
            {panel.profile.active && (
              <p className="px-3 text-xs text-muted-foreground">先切换到其他配置或恢复执行机原有配置，再删除此项。</p>
            )}
          </div>
        </Sheet>
      )}

      {panel?.kind === 'delete' && (
        <Sheet title="删除供应商配置" onClose={() => setPanel(null)} dismissable={!busy}>
          <div className="space-y-4 px-4 pt-2 pb-5">
            <p className="text-sm text-foreground/85">删除「{panel.profile.name}」？此操作无法撤销。</p>
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => void action(() => api.deleteAgentProfile(selected, panel.profile.id))}
              className="h-11 w-full rounded-xl"
            >
              {busy ? '删除中…' : '删除配置'}
            </Button>
          </div>
        </Sheet>
      )}

      {panel?.kind === 'activate' && (
        <Sheet
          title={panel.profile ? '启用供应商配置' : '恢复执行机原有配置'}
          onClose={() => setPanel(null)}
          dismissable={!busy}
        >
          <div className="space-y-4 px-4 pt-2 pb-5">
            <p className="text-sm text-foreground/85">
              {panel.profile
                ? `将 ${agent.name} 切换到「${panel.profile.name}」。`
                : `将 ${agent.name} 恢复为执行机原有的登录与连接设置。`}
            </p>
            <p className="text-xs text-warning">
              {selected === 'claude'
                ? '当前回合继续使用原配置，新配置从下一回合生效。'
                : '切换会重启 Agent 服务，正在进行的回合会中断。'}
            </p>
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
            <Button
              disabled={busy}
              onClick={() => void action(() => api.activateAgentProfile(selected, panel.profile?.id ?? 'native'))}
              className="h-11 w-full rounded-xl"
            >
              {busy ? (
                <>
                  <LoaderCircle className="size-4 animate-spin" /> 切换中…
                </>
              ) : (
                '确认切换'
              )}
            </Button>
          </div>
        </Sheet>
      )}
    </section>
  )
}
