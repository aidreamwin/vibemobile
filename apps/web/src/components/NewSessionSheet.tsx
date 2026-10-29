import { useEffect, useState } from 'react'
import { ChevronRight, FolderOpen } from 'lucide-react'
import type {
  ApprovalPolicy,
  ModelInfo,
  Project,
  ProviderId,
  ProviderStatus,
  SandboxMode,
  SessionSummary,
} from '@vibemobile/protocol'
import { Button } from './ui/button'
import Field from './Field'
import SelectField from './SelectField'
import { api } from '../lib/api'
import { PERMISSIONS, permissionCardsFor, type PermissionCard } from '../lib/permission'
import Sheet from './Sheet'
import DirectoryPickerSheet from './DirectoryPickerSheet'

/**
 * Sandbox and approval policy are the two settings that actually change what
 * the agent can do to the machine, so the labels spell out the consequence
 * rather than the protocol enum.
 */
const SANDBOXES: { value: SandboxMode; label: string; hint: string }[] = [
  { value: 'read-only', label: '只读', hint: '只能看，不能改任何文件' },
  { value: 'workspace-write', label: '可写工作区', hint: '能改目录内文件，联网需授权' },
  { value: 'danger-full-access', label: '完全访问', hint: '不限目录、不限联网，谨慎使用' },
]

const POLICIES: { value: ApprovalPolicy; label: string; hint: string }[] = [
  { value: 'untrusted', label: '严格', hint: '任何写入或联网都要先问你' },
  { value: 'on-request', label: '按需', hint: '代理自己判断，必要时才问' },
  { value: 'never', label: '从不询问', hint: '全部自动放行，不再弹窗' },
]

const PERMISSION_HINTS: Record<PermissionCard, string> = {
  ask: '需要授权时先向你确认',
  readonly: '仅查看，不修改文件',
  auto: '由 Claude 自动判断工具权限',
  unattended: '不限目录、不限联网，谨慎使用',
}

export default function NewSessionSheet({
  provider,
  providers,
  onProviderChange,
  projects,
  initialCwd,
  onCwdChange,
  onClose,
  onCreated,
}: {
  provider: ProviderId
  /** Every known provider, so the sheet can offer a choice. */
  providers?: ProviderStatus[]
  onProviderChange?: (id: ProviderId) => void
  projects: Project[]
  initialCwd: string
  onCwdChange?: (cwd: string) => void
  onClose: () => void
  onCreated: (session: SessionSummary) => void
}) {
  const [cwd, setCwd] = useState(initialCwd)
  const [model, setModel] = useState<string>('')
  const [sandbox, setSandbox] = useState<SandboxMode>('workspace-write')
  const [approvalPolicy, setApprovalPolicy] = useState<ApprovalPolicy>('on-request')
  const [claudePermission, setClaudePermission] = useState<PermissionCard>('auto')
  const [models, setModels] = useState<ModelInfo[]>([])
  const [modelsLoading, setModelsLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pickingDirectory, setPickingDirectory] = useState(false)

  useEffect(() => {
    let cancelled = false
    setModelsLoading(true)
    // Model ids are provider-specific, so a selection made for the previous
    // agent is meaningless here and would otherwise be sent as-is. Reset to
    // "默认模型" and let the server choose.
    setModel('')
    api
      .models(provider)
      .then((res) => !cancelled && setModels(res.data))
      // A provider that cannot enumerate models is not a reason to block
      // session creation — the server picks its own default.
      .catch(() => undefined)
      .finally(() => !cancelled && setModelsLoading(false))
    return () => {
      cancelled = true
    }
  }, [provider])

  async function create() {
    if (!cwd || busy) return
    setBusy(true)
    setError(null)
    try {
      const session = await api.createSession({
        provider,
        cwd,
        model: model || undefined,
        ...(provider === 'claude'
          ? {
              sandbox: PERMISSIONS[claudePermission].sandbox,
              approvalPolicy: PERMISSIONS[claudePermission].approvalPolicy,
            }
          : { sandbox, approvalPolicy }),
      })
      onCreated(session)
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  if (pickingDirectory) {
    return (
      <DirectoryPickerSheet
        projects={projects}
        initialPath={cwd || initialCwd}
        onClose={() => setPickingDirectory(false)}
        onSelect={(path) => {
          setCwd(path)
          onCwdChange?.(path)
          setPickingDirectory(false)
        }}
      />
    )
  }

  return (
    <Sheet title="新建会话" onClose={onClose}>
      <div className="space-y-5 px-4 pt-2 pb-4">
        {/* Only offered when there is a real choice. A single-provider install
            should not grow a one-option radio group. */}
        {(providers?.length ?? 0) > 1 && (
          <Field label="代理">
            <div className="space-y-1.5">
              {providers!.map((p) => (
                <Option
                  key={p.id}
                  selected={provider === p.id}
                  onClick={() => onProviderChange?.(p.id)}
                  label={p.displayName}
                  hint={p.available ? '可用' : (p.detail ?? '不可用')}
                  danger={!p.available}
                />
              ))}
            </div>
          </Field>
        )}

        <Field label="工作目录">
          <button
            type="button"
            onClick={() => setPickingDirectory(true)}
            disabled={projects.length === 0}
            className="tap flex min-h-12 w-full items-center justify-start gap-3 rounded-xl bg-secondary px-3.5 py-3 text-left disabled:opacity-50"
          >
            <FolderOpen className="size-5 shrink-0 text-primary" />
            <span className="min-w-0 flex-1 truncate text-[15px] text-foreground">
              {cwd ? cwd.split(/[\\/]/).filter(Boolean).at(-1) : '未配置工作区'}
            </span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
          </button>
          <div className="mt-1.5 flex min-w-0 items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
            <span className="mt-0.5 shrink-0 text-primary">●</span>
            <span className="min-w-0">
              <span className="block truncate font-mono text-muted-foreground">{cwd || '未选择目录'}</span>
              <span className="block">默认填入上次选择的目录，可选择允许工作区内的任意文件夹</span>
            </span>
          </div>
        </Field>

        <Field label="模型">
          <SelectField
            value={model}
            onChange={setModel}
            disabled={modelsLoading || models.length === 0}
            ariaLabel="选择模型"
            options={[
              { value: '', label: '默认模型' },
              ...models.map((item) => ({ value: item.id, label: item.displayName || item.id })),
            ]}
          />
          <div className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
            {modelsLoading
              ? '正在读取可用模型…'
              : models.length > 0
                ? model || '由服务端决定默认模型'
                : '服务端未返回模型列表，将使用默认模型'}
          </div>
        </Field>

        {provider === 'claude' ? (
          <Field label="权限">
            <div className="space-y-1.5">
              {permissionCardsFor(provider).map((card) => (
                <Option
                  key={card}
                  selected={claudePermission === card}
                  onClick={() => setClaudePermission(card)}
                  label={PERMISSIONS[card].label}
                  hint={PERMISSION_HINTS[card]}
                  danger={card === 'unattended'}
                />
              ))}
            </div>
          </Field>
        ) : (
          <>
            <Field label="权限范围">
              <div className="space-y-1.5">
                {SANDBOXES.map((option) => (
                  <Option
                    key={option.value}
                    selected={sandbox === option.value}
                    onClick={() => setSandbox(option.value)}
                    label={option.label}
                    hint={option.hint}
                    danger={option.value === 'danger-full-access'}
                  />
                ))}
              </div>
            </Field>

            <Field label="授权策略">
              <div className="space-y-1.5">
                {POLICIES.map((option) => (
                  <Option
                    key={option.value}
                    selected={approvalPolicy === option.value}
                    onClick={() => setApprovalPolicy(option.value)}
                    label={option.label}
                    hint={option.hint}
                  />
                ))}
              </div>
            </Field>
          </>
        )}

        {error && <div className="text-[12px] text-destructive">{error}</div>}

        <Button type="button" onClick={create} disabled={!cwd || busy} className="tap h-auto w-full py-3 text-[15px]">
          {busy ? '创建中…' : '开始'}
        </Button>
      </div>
    </Sheet>
  )
}

/**
 * A two-line radio card. Kept hand-rolled rather than expressed as a `Button`:
 * the base button centres its content and refuses to wrap, which is the
 * opposite of what a full-width option row with a hint needs. `ui/radio-group`
 * would be the shadcn answer, but nothing else in the app uses a radio group
 * yet and vendoring it for one screen is scope this migration does not need.
 */
function Option({
  selected,
  onClick,
  label,
  hint,
  mono,
  danger,
}: {
  selected: boolean
  onClick: () => void
  label: string
  hint?: string
  mono?: boolean
  danger?: boolean
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={`flex w-full items-start gap-2 rounded-lg border px-3 py-2.5 text-left ${
        selected ? 'border-primary bg-primary/10' : 'border-border bg-secondary active:bg-raised'
      }`}
    >
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-[14px] ${danger && selected ? 'text-destructive' : 'text-foreground'}`}>
          {label}
        </span>
        {hint && (
          <span className={`mt-0.5 block text-[11px] text-muted-foreground ${mono ? 'font-mono' : ''}`}>{hint}</span>
        )}
      </span>
      {selected && <span className="mt-0.5 shrink-0 text-primary">✓</span>}
    </button>
  )
}
