import ToolbarRow, { ToolbarIdentity } from '../components/ToolbarRow'
import RunnerSelector from '../components/RunnerSelector'
import AgentProfilesSection from '../components/AgentProfilesSection'
import { useCallback, useEffect, useState } from 'react'
import {
  ArrowUpCircle,
  ChevronRight,
  FolderOpen,
  LoaderCircle,
  LogOut,
  MoreVertical,
  Plus,
  RefreshCw,
  Settings as SettingsIcon,
} from 'lucide-react'
import type {
  AgentRuntimeId,
  AgentRuntimeStatus,
  HealthResponse,
  ProviderStatus,
  RunnerInfo,
  UpdateStatus,
} from '@vibemobile/protocol'
import { errorLabel, jobRunning, phaseLabel, useSystemStore } from '../lib/system'
import CopyButton from '../components/CopyButton'
import { Hint } from '../components/ui/tooltip'
import { api } from '../lib/api'
import { agentStatus } from '../lib/agentStatus'
import { runnerId, runnerSwitchUrl } from '../lib/runner'
import { runnerAdminError, runnerEnvBlock } from '../lib/runnerAdmin'
import { WEB_BUILD, buildLabel, builtAtLabel, halvesDiverge, serverRestartPending, uptimeLabel } from '../lib/build'
import { socket, type ConnectionState } from '../lib/ws'
import { useWorkspaceStore } from '../lib/workspace'
import DirectoryPickerSheet from '../components/DirectoryPickerSheet'
import Sheet from '../components/Sheet'
import Field from '../components/Field'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'

const CONN_TEXT: Record<ConnectionState, { label: string; tone: string }> = {
  open: { label: '已连接', tone: 'text-success' },
  connecting: { label: '连接中…', tone: 'text-warning' },
  closed: { label: '未连接', tone: 'text-destructive' },
}

/**
 * The command that fixes "not logged in", per provider.
 *
 * Written out rather than derived from the provider id because the two agents
 * do not both take a `login` subcommand: telling someone to run `claude login`
 * sends them to a command that does not exist. The follow-up text is separate
 * because Claude logs in interactively rather than as a one-shot command.
 */
const LOGIN_COMMAND: Record<string, string> = {
  codex: 'codex login',
  claude: 'claude',
  opencode: 'opencode auth login',
}

const LOGIN_FOLLOW_UP: Record<string, string> = {
  // Both paths matter, and they are not interchangeable: `claude` walks you
  // through an OAuth login against Anthropic, while a proxied/gateway setup
  // authenticates from `~/.claude/settings.json` and never logs in at all. The
  // second is the one that fails silently — no credentials, and a model list
  // that quietly reverts to the CLI's built-in catalogue.
  claude:
    '并在其中完成登录；若走内网代理或网关，改在服务器上配置它的 ~/.claude/settings.json（ANTHROPIC_BASE_URL 与凭据）',
  opencode: '并按提示选择要接入的模型提供方；VibeMobile 也可以直接使用无需凭据的免费模型',
}

/**
 * Sheets are mutually exclusive, and which one is open is page state: the list
 * and the API calls live here, only the form/copy feedback lives in the sheet.
 */
type RunnerSheet =
  | { kind: 'create' }
  | { kind: 'secret'; id: string; name: string; token: string; source: 'created' | 'rotated' }
  | { kind: 'menu'; runner: RunnerInfo }
  | { kind: 'rotate'; runner: RunnerInfo }
  | { kind: 'delete'; runner: RunnerInfo }

export default function Settings({ onLogout }: { onLogout: () => void }) {
  const [providers, setProviders] = useState<ProviderStatus[]>([])
  const projects = useWorkspaceStore((state) => state.projects)
  const defaultCwd = useWorkspaceStore((state) => state.defaultCwd)
  const workspaceLoading = useWorkspaceStore((state) => state.loading)
  const workspaceError = useWorkspaceStore((state) => state.error)
  const loadWorkspace = useWorkspaceStore((state) => state.load)
  const setDefaultCwd = useWorkspaceStore((state) => state.setDefaultCwd)
  const [conn, setConn] = useState<ConnectionState>(socket.state)
  const [busy, setBusy] = useState(false)
  const [logoutAllOpen, setLogoutAllOpen] = useState(false)
  const [logoutAllBusy, setLogoutAllBusy] = useState(false)
  const [logoutAllError, setLogoutAllError] = useState<string | null>(null)
  const [pickingDirectory, setPickingDirectory] = useState(false)
  const [health, setHealth] = useState<HealthResponse | null>(null)
  // Hub-only runner management. `hub` stays false on a standalone server, which
  // is exactly what hides the section.
  const [hub, setHub] = useState(false)
  const [runners, setRunners] = useState<RunnerInfo[]>([])
  const [defaultRunner, setDefaultRunner] = useState('')
  const [runnerSheet, setRunnerSheet] = useState<RunnerSheet | null>(null)
  const [runnerName, setRunnerName] = useState('')
  const [runnerBusy, setRunnerBusy] = useState(false)
  const [runnerSheetError, setRunnerSheetError] = useState<string | null>(null)
  const [runnerCopied, setRunnerCopied] = useState(false)

  useEffect(() => socket.onState(setConn), [])

  useEffect(() => {
    let cancelled = false
    api
      .providers()
      .then((p) => {
        if (cancelled) return
        setProviders(p.data)
      })
      .catch(() => undefined)
    // Not cached or polled: the build stamps are read when the page opens, which is
    // the moment the question "is this the latest code?" is actually being asked.
    api
      .health()
      .then((h) => {
        if (cancelled) return
        setHealth(h)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const reloadRunners = useCallback(async () => {
    const result = await api.runners()
    setRunners(result.data)
    setDefaultRunner(result.default)
  }, [])

  // Hub-only: `/api/hub` 404 is the standalone server, where there is no runner
  // concept at all and the section below must stay hidden.
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setInterval> | undefined
    const refresh = () => {
      api
        .runners()
        .then((result) => {
          if (!active) return
          setRunners(result.data)
          setDefaultRunner(result.default)
        })
        .catch(() => undefined)
    }
    api
      .hubMode()
      .then(() => {
        if (!active) return
        setHub(true)
        refresh()
        // Online/offline is the point of the list; same cadence as RunnerSelector.
        timer = setInterval(refresh, 10_000)
      })
      .catch(() => undefined)
    return () => {
      active = false
      if (timer) clearInterval(timer)
    }
  }, [])

  function closeRunnerSheet() {
    setRunnerSheet(null)
    setRunnerSheetError(null)
    setRunnerCopied(false)
  }

  async function createRunner() {
    const name = runnerName.trim()
    if (!name || runnerBusy) return
    setRunnerBusy(true)
    setRunnerSheetError(null)
    try {
      const created = await api.createRunner(name)
      await reloadRunners().catch(() => undefined)
      setRunnerName('')
      setRunnerCopied(false)
      setRunnerSheet({ kind: 'secret', id: created.id, name: created.name, token: created.token, source: 'created' })
    } catch (error) {
      setRunnerSheetError(runnerAdminError(error))
    } finally {
      setRunnerBusy(false)
    }
  }

  async function rotateRunnerToken(runner: RunnerInfo) {
    if (runnerBusy) return
    setRunnerBusy(true)
    setRunnerSheetError(null)
    try {
      const rotated = await api.refreshRunnerToken(runner.id)
      await reloadRunners().catch(() => undefined)
      setRunnerCopied(false)
      setRunnerSheet({ kind: 'secret', id: rotated.id, name: rotated.name, token: rotated.token, source: 'rotated' })
    } catch (error) {
      setRunnerSheetError(runnerAdminError(error))
    } finally {
      setRunnerBusy(false)
    }
  }

  async function deleteRunner(runner: RunnerInfo) {
    if (runnerBusy) return
    setRunnerBusy(true)
    setRunnerSheetError(null)
    try {
      await api.deleteRunner(runner.id)
      await reloadRunners().catch(() => undefined)
      closeRunnerSheet()
      // The deleted runner's page has nowhere to go; leave the dead /r/<id> scope.
      if (runner.id === runnerId && defaultRunner) window.location.assign(runnerSwitchUrl(defaultRunner))
    } catch (error) {
      setRunnerSheetError(runnerAdminError(error))
    } finally {
      setRunnerBusy(false)
    }
  }

  async function copyRunnerEnv() {
    if (runnerSheet?.kind !== 'secret') return
    try {
      await navigator.clipboard.writeText(runnerEnvBlock(runnerSheet.id, runnerSheet.token))
      setRunnerCopied(true)
      setTimeout(() => setRunnerCopied(false), 2000)
    } catch {
      setRunnerSheetError('复制失败，请手动选择文本复制。')
    }
  }

  async function logout() {
    setBusy(true)
    try {
      await api.logout()
    } finally {
      // Even if the call failed, the local session is over as far as the UI is
      // concerned — the user asked to leave.
      setBusy(false)
      onLogout()
    }
  }

  /**
   * Revokes every session, including this one. Unlike `logout` this must NOT
   * treat a failed request as success: the user is asking for a server-side
   * revocation, and pretending it happened would be a security lie.
   */
  async function logoutAll() {
    setLogoutAllBusy(true)
    setLogoutAllError(null)
    try {
      await api.logoutAll()
      setLogoutAllOpen(false)
      onLogout()
    } catch (error) {
      setLogoutAllError(error instanceof Error ? error.message : String(error))
    } finally {
      setLogoutAllBusy(false)
    }
  }

  // The build stamps. `health` is null until the request lands (and stays null if it
  // fails), which the rows show as "…" rather than as a wrong answer.
  const server = health?.build
  const onDisk = health?.buildOnDisk ?? null
  const restartPending = server ? serverRestartPending(server, onDisk) : false
  const diverged = halvesDiverge(WEB_BUILD, server)
  const serverNote = !server
    ? undefined
    : [builtAtLabel(server) ? `构建于 ${builtAtLabel(server)}` : '开发模式（直接跑源码）', uptimeLabel(health?.uptime)]
        .filter(Boolean)
        .join(' · ')
  // The Hub's own default runner is not editable; only stored credentials are.
  const managedRunners = runners.filter((runner) => runner.managed === true)

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <header className="safe-top shrink-0 border-b border-border bg-background/95 backdrop-blur-xl">
        <ToolbarRow>
          <ToolbarIdentity icon={SettingsIcon} label="设置" />
          <RunnerSelector compact />
        </ToolbarRow>
      </header>

      <div className="scroll-y min-h-0 flex-1 px-3.5 pb-8">
        <div className="mx-auto max-w-2xl">
          <AgentsSection providers={providers} />

          <AgentProfilesSection />

          <SystemUpdateSection runnerName={runners.find((runner) => runner.id === runnerId)?.name} />

          <Section title="工作区">
            <div className="flex min-w-0 items-center pl-4 pr-1">
              <button
                type="button"
                onClick={() => (projects.length ? setPickingDirectory(true) : void loadWorkspace())}
                disabled={workspaceLoading}
                aria-label="选择工作目录"
                className="flex min-h-16 min-w-0 flex-1 items-center gap-3 py-3 text-left disabled:opacity-60"
              >
                <FolderOpen className="size-5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">
                    {projects.length
                      ? defaultCwd.split(/[\\/]/).filter(Boolean).pop() || defaultCwd
                      : workspaceLoading
                        ? '读取中…'
                        : '未配置目录'}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {projects.length ? '工作目录' : '点击重试'}
                  </span>
                </span>
                <ChevronRight className="mr-2 size-4 shrink-0 text-muted-foreground" />
              </button>
            </div>
            <InfoRow label="访问范围" value={<span className="tabular-nums">{projects.length} 个根目录</span>}>
              {defaultCwd && (
                <Detail label="当前目录">
                  <code>{defaultCwd}</code>
                </Detail>
              )}
              {workspaceError && <p className="text-warning">{workspaceError}</p>}
              {projects.map((project) => (
                <Detail
                  key={project.id}
                  label={project.isGitRepo ? `Git · ${project.gitBranch || '未命名分支'}` : '目录'}
                >
                  <code>{project.path}</code>
                </Detail>
              ))}
              <p>
                {projects.length
                  ? '代理可在这些根目录及其子目录内读写文件。'
                  : '在执行机器的 VIBEMOBILE_ROOTS 环境变量中配置根目录。'}
              </p>
            </InfoRow>
          </Section>

          {hub && (
            <Section title="远程执行机">
              {managedRunners.map((runner) => (
                <div key={runner.id} className="flex min-h-14 min-w-0 items-center gap-2 py-2 pl-4 pr-1">
                  <span
                    aria-hidden="true"
                    className={`size-1.5 shrink-0 rounded-full ${runner.online ? 'bg-success' : 'bg-muted-foreground'}`}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm">
                    <span className="font-medium text-foreground/90">{runner.name}</span>
                  </span>
                  <span className={`shrink-0 text-xs ${runner.online ? 'text-success' : 'text-muted-foreground'}`}>
                    {runner.online ? '在线' : '离线'}
                  </span>
                  {/* 刷新/删除很少用且不可撤销，收在操作入口里，避免误触。 */}
                  <button
                    type="button"
                    onClick={() => {
                      setRunnerSheetError(null)
                      setRunnerSheet({ kind: 'menu', runner })
                    }}
                    className="tap w-11 shrink-0 text-muted-foreground active:bg-secondary"
                    aria-label={`${runner.name} 的操作`}
                  >
                    <MoreVertical aria-hidden="true" className="mx-auto size-5" />
                  </button>
                </div>
              ))}
              <div className="px-3 py-2.5">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setRunnerName('')
                    setRunnerSheetError(null)
                    setRunnerSheet({ kind: 'create' })
                  }}
                  className="tap h-11 w-full justify-start rounded-xl text-sm text-primary"
                >
                  <Plus aria-hidden="true" className="size-4" /> 添加执行机
                </Button>
              </div>
            </Section>
          )}

          <Section title="系统">
            <InfoRow label="连接" value={<span className={CONN_TEXT[conn].tone}>{CONN_TEXT[conn].label}</span>}>
              <Detail label="访问地址">
                <code>{location.host}</code>
              </Detail>
              <Detail label="页面协议">
                <code>{location.protocol.replace(':', '').toUpperCase()}</code>
              </Detail>
              <Detail label="实时通道">{CONN_TEXT[conn].label}</Detail>
            </InfoRow>
            <InfoRow label="版本信息" value={WEB_BUILD.version}>
              <Detail label="前端版本">{WEB_BUILD.version}</Detail>
              <Detail label="前端构建">
                <code>{buildLabel(WEB_BUILD)}</code>
              </Detail>
              <p>{builtAtLabel(WEB_BUILD) ? `构建于 ${builtAtLabel(WEB_BUILD)}` : '开发模式'}</p>
              <Detail label="服务端版本">{server?.version ?? '读取中…'}</Detail>
              {server && (
                <Detail label="服务端构建">
                  <code>{buildLabel(server)}</code>
                </Detail>
              )}
              {serverNote && <p>{serverNote}</p>}
            </InfoRow>
            {restartPending && (
              <p role="status" className="px-4 py-3 text-xs text-warning">
                服务端有新构建，待重启生效。
              </p>
            )}
            {diverged && (
              <p role="status" className="px-4 py-3 text-xs text-warning">
                前后端构建提交不一致。
              </p>
            )}
          </Section>

          <Section title="安全">
            <InfoRow label="连接保护" value={location.protocol === 'https:' ? 'HTTPS' : 'HTTP'}>
              <p>登录凭据通过 httpOnly Cookie 保存。公网访问应使用 HTTPS 反向代理。</p>
            </InfoRow>
            <button
              type="button"
              onClick={() => {
                setLogoutAllError(null)
                setLogoutAllOpen(true)
              }}
              className="flex min-h-14 w-full items-center justify-between gap-3 px-4 text-left text-sm text-destructive transition-colors active:bg-destructive/10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
            >
              登出所有设备
              <ChevronRight aria-hidden="true" className="size-4 text-muted-foreground/60" />
            </button>
          </Section>

          <Section title="关于">
            <div className="flex min-h-14 items-center px-4 py-3 text-sm font-medium text-foreground/90">
              dyb出品，必属精品！
            </div>
          </Section>

          <button
            type="button"
            onClick={logout}
            disabled={busy}
            className="tap mt-8 min-h-12 w-full gap-2 rounded-2xl border border-border text-sm text-destructive active:bg-destructive/10 disabled:opacity-50"
          >
            <LogOut aria-hidden="true" className="size-4" />
            {busy ? '退出中…' : '退出登录'}
          </button>
        </div>
      </div>

      {pickingDirectory && (
        <DirectoryPickerSheet
          projects={projects}
          initialPath={defaultCwd}
          title="全局工作目录"
          onClose={() => setPickingDirectory(false)}
          onSelect={(cwd) => {
            setDefaultCwd(cwd)
            setPickingDirectory(false)
          }}
        />
      )}

      {logoutAllOpen && (
        <Sheet title="登出所有设备" onClose={() => setLogoutAllOpen(false)} dismissable={!logoutAllBusy}>
          <div className="space-y-4 px-4 pt-2 pb-4">
            <p className="text-[13px] text-foreground/85">
              所有设备（包括当前设备）的登录态都会立即失效，需要重新输入 PIN。
            </p>
            {logoutAllError && <p className="text-[12px] text-destructive">{logoutAllError}</p>}
            <Button
              type="button"
              variant="destructive"
              disabled={logoutAllBusy}
              onClick={() => void logoutAll()}
              className="tap h-auto w-full py-3.5 text-[15px]"
            >
              {logoutAllBusy ? '处理中…' : '确认登出所有设备'}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={logoutAllBusy}
              onClick={() => setLogoutAllOpen(false)}
              className="tap h-auto w-full py-3.5 text-[15px]"
            >
              取消
            </Button>
          </div>
        </Sheet>
      )}

      {runnerSheet?.kind === 'create' && (
        <Sheet title="添加执行机" onClose={closeRunnerSheet}>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void createRunner()
            }}
            className="space-y-4 px-4 pt-2 pb-4"
          >
            <Field label="名称">
              <Input
                autoFocus
                value={runnerName}
                onChange={(event) => setRunnerName(event.target.value)}
                placeholder="例如：办公室机器"
                className="h-auto py-3 text-[15px]"
              />
            </Field>
            {runnerSheetError && <p className="text-[12px] text-destructive">{runnerSheetError}</p>}
            <Button
              type="submit"
              disabled={runnerBusy || !runnerName.trim()}
              className="tap h-auto w-full py-3.5 text-[15px]"
            >
              {runnerBusy ? '生成中…' : '生成令牌'}
            </Button>
          </form>
        </Sheet>
      )}

      {runnerSheet?.kind === 'secret' && (
        <Sheet title={runnerSheet.source === 'created' ? '执行机已添加' : '令牌已刷新'} onClose={closeRunnerSheet}>
          <div className="space-y-4 px-4 pt-2 pb-4">
            <p className="text-[12px] text-warning">令牌只显示这一次，关闭后无法再次查看；丢失只能在列表里刷新。</p>
            <pre className="scroll-x rounded-xl border border-border bg-secondary/60 p-3 text-[12px] leading-relaxed text-foreground/90">
              <code>{runnerEnvBlock(runnerSheet.id, runnerSheet.token)}</code>
            </pre>
            {runnerSheetError && <p className="text-[12px] text-destructive">{runnerSheetError}</p>}
            <Button type="button" onClick={() => void copyRunnerEnv()} className="tap h-auto w-full py-3.5 text-[15px]">
              {runnerCopied ? '已复制' : '复制 ID 和令牌'}
            </Button>
            <p className="text-[12px] text-muted-foreground">
              把这两行写进执行机的 .env.runner，然后运行 <code>docker compose -f docker-compose.runner.yml up -d</code>
              。
            </p>
            <Button
              type="button"
              variant="secondary"
              onClick={closeRunnerSheet}
              className="tap h-auto w-full py-3.5 text-[15px]"
            >
              完成
            </Button>
          </div>
        </Sheet>
      )}

      {runnerSheet?.kind === 'menu' && (
        <Sheet title={runnerSheet.runner.name} label="执行机操作" onClose={closeRunnerSheet}>
          <div className="space-y-2 px-4 pt-2 pb-4">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setRunnerSheet({ kind: 'rotate', runner: runnerSheet.runner })}
              className="tap h-auto w-full py-3.5 text-[15px]"
            >
              刷新令牌
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => setRunnerSheet({ kind: 'delete', runner: runnerSheet.runner })}
              className="tap h-auto w-full py-3.5 text-[15px]"
            >
              删除执行机
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={closeRunnerSheet}
              className="tap h-auto w-full py-3.5 text-[15px]"
            >
              取消
            </Button>
          </div>
        </Sheet>
      )}

      {runnerSheet?.kind === 'rotate' && (
        <Sheet title="刷新令牌" onClose={closeRunnerSheet}>
          <div className="space-y-4 px-4 pt-2 pb-4">
            <p className="text-[13px] text-foreground/85">
              「{runnerSheet.runner.name}」的旧令牌会立即失效，正在连接的执行机会断开。需要在执行机上更新
              VIBEMOBILE_RUNNER_TOKEN 并重启容器。
            </p>
            {runnerSheetError && <p className="text-[12px] text-destructive">{runnerSheetError}</p>}
            <Button
              type="button"
              variant="destructive"
              disabled={runnerBusy}
              onClick={() => void rotateRunnerToken(runnerSheet.runner)}
              className="tap h-auto w-full py-3.5 text-[15px]"
            >
              {runnerBusy ? '刷新中…' : '确认刷新'}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={closeRunnerSheet}
              className="tap h-auto w-full py-3.5 text-[15px]"
            >
              取消
            </Button>
          </div>
        </Sheet>
      )}

      {runnerSheet?.kind === 'delete' && (
        <Sheet title="删除执行机" onClose={closeRunnerSheet} dismissable={false}>
          <div className="space-y-4 px-4 pt-2 pb-4">
            <p className="text-[13px] text-foreground/85">
              删除「{runnerSheet.runner.name}」后，它的连接会立即断开，令牌同时作废。
            </p>
            {runnerSheetError && <p className="text-[12px] text-destructive">{runnerSheetError}</p>}
            <Button
              type="button"
              variant="destructive"
              disabled={runnerBusy}
              onClick={() => void deleteRunner(runnerSheet.runner)}
              className="tap h-auto w-full py-3.5 text-[15px]"
            >
              {runnerBusy ? '删除中…' : '确认删除'}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={closeRunnerSheet}
              className="tap h-auto w-full py-3.5 text-[15px]"
            >
              取消
            </Button>
          </div>
        </Sheet>
      )}
    </div>
  )
}

const UPDATE_REASONS: Record<string, string> = {
  docker: 'Docker · 宿主机更新',
  windows_service: 'Windows 服务 · 更新脚本',
  development_mode: '开发模式',
  standalone: '不支持一键升级',
  update_disabled: '更新已关闭',
  update_via_hub: '随 Hub 升级',
}

function SystemUpdateSection({ runnerName }: { runnerName?: string }) {
  const { current, hub, loading, currentError, hubError, load, start } = useSystemStore()
  const [confirming, setConfirming] = useState<'current' | 'hub' | null>(null)
  const [starting, setStarting] = useState(false)
  const inRunner = Boolean(runnerId)
  const running = jobRunning(current?.job) || jobRunning(hub?.job)

  useEffect(() => {
    void load()
    if (inRunner) void load({ hub: true })
  }, [load, inRunner])

  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => {
      void load()
      if (inRunner) void load({ hub: true })
    }, 1500)
    return () => clearInterval(timer)
  }, [running, load, inRunner])

  const target = confirming === 'hub' ? hub : current

  async function confirm() {
    setStarting(true)
    try {
      await start(confirming === 'hub')
      setConfirming(null)
    } catch {
      // The row renders the store's error.
    } finally {
      setStarting(false)
    }
  }

  return (
    <>
      <Section title="更新">
        {!current && <div className="px-4 py-3 text-sm text-muted-foreground">{currentError ?? '加载中…'}</div>}
        {current && (
          <UpdateRow
            status={current}
            label={inRunner ? (current.sharedInstall ? '本机执行机' : runnerName || '当前执行机') : 'Hub'}
            error={currentError}
            loading={loading}
            onCheck={() => void load({ force: true })}
            onUpgrade={() => setConfirming('current')}
          />
        )}
        {inRunner && hub && (
          <UpdateRow
            status={hub}
            label="Hub"
            error={hubError}
            loading={loading}
            onCheck={() => void load({ hub: true, force: true })}
            onUpgrade={() => setConfirming('hub')}
          />
        )}
      </Section>

      {confirming && target && (
        <Sheet title="升级 VibeMobile" onClose={() => setConfirming(null)} dismissable={!starting}>
          <div className="space-y-4 px-4 pt-2 pb-4">
            <p className="text-[13px] text-foreground/85">
              将升级到 {target.latest?.serverVersion ?? '新版本'}
              。服务会重启，正在执行的任务会中断；失败会自动回到原版本。
            </p>
            <Button
              type="button"
              disabled={starting}
              onClick={() => void confirm()}
              className="tap h-auto w-full py-3.5 text-[15px]"
            >
              {starting ? '正在启动…' : '确认升级'}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={starting}
              onClick={() => setConfirming(null)}
              className="tap h-auto w-full py-3.5 text-[15px]"
            >
              取消
            </Button>
          </div>
        </Sheet>
      )}
    </>
  )
}

function UpdateRow({
  status,
  label,
  error,
  loading,
  onCheck,
  onUpgrade,
}: {
  status: UpdateStatus
  label: string
  error: string | null
  loading: boolean
  onCheck: () => void
  onUpgrade: () => void
}) {
  const job = status.job
  const running = jobRunning(job)
  const failed = job?.status === 'failed' || job?.status === 'rolled_back'
  const currentVersion = status.current.serverVersion
  const latest = status.latest?.serverVersion

  let line: string
  if (status.sharedInstall) line = '跟随 Hub 更新'
  else if (!status.supported) line = UPDATE_REASONS[status.reason ?? ''] ?? '不支持一键升级'
  else if (running) line = phaseLabel(job?.phase)
  else if (failed) line = job?.status === 'rolled_back' ? '已回滚' : '升级失败'
  else if (status.feedError === 'update_not_configured') line = '未配置更新源'
  else if (status.feedError) line = '无法检查更新'
  else if (status.updateAvailable && latest) line = '可更新'
  else line = '已是最新'

  return (
    <div>
      <InfoRow
        label={label}
        value={
          <span className={failed ? 'text-destructive' : status.updateAvailable ? 'text-primary' : ''}>{line}</span>
        }
        action={
          status.supported &&
          !status.sharedInstall &&
          (running ? (
            <LoaderCircle aria-label="升级中" className="size-4 shrink-0 animate-spin text-muted-foreground" />
          ) : status.updateAvailable ? (
            <Hint content={`升级到 ${latest}`}>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                className="tap size-11 text-primary"
                disabled={loading}
                onClick={onUpgrade}
                aria-label="升级"
              >
                <ArrowUpCircle className="size-4" />
              </Button>
            </Hint>
          ) : status.feedError === 'update_not_configured' ? null : (
            <Hint content="检查更新">
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                className="tap size-11"
                disabled={loading}
                onClick={onCheck}
                aria-label="检查更新"
              >
                <RefreshCw className="size-4" />
              </Button>
            </Hint>
          ))
        }
      >
        <Detail label="当前版本">{currentVersion}</Detail>
        <Detail label="更新状态">{line}</Detail>
        {latest && <Detail label="可用版本">{latest}</Detail>}
        {status.feedError === 'update_not_configured' && <p>请在执行机配置更新源。</p>}
        {!status.supported && !status.sharedInstall && status.manualCommand && (
          <div className="flex items-start gap-2 rounded-xl bg-secondary p-3">
            <code className="min-w-0 flex-1 break-all text-xs">{status.manualCommand}</code>
            <CopyButton getText={() => status.manualCommand ?? ''} label="复制更新命令" />
          </div>
        )}
      </InfoRow>
      {status.feedError && status.feedError !== 'update_not_configured' && (
        <p className="px-4 pb-3 text-xs text-destructive">{errorLabel(status.feedError)}</p>
      )}
      {error && <p className="px-4 pb-3 text-xs text-destructive">{error}</p>}
      {failed && job?.error && <p className="px-4 pb-3 text-xs text-destructive">{errorLabel(job.error)}</p>}

      {status.logTail && (failed || running) && (
        <details className="mt-0.5">
          <summary className="cursor-pointer text-[11px] text-muted-foreground">详情</summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all text-[10px] text-muted-foreground">
            {status.logTail}
          </pre>
        </details>
      )}
    </div>
  )
}

/**
 * Agent runtime packs: the model processes' binaries, separate from this app's
 * release. Installing one is a background npm job on the executor, so this row
 * polls while `updating` is true instead of holding a request open.
 */
function AgentsSection({ providers }: { providers: ProviderStatus[] }) {
  const [agents, setAgents] = useState<AgentRuntimeStatus[]>([])
  const [latest, setLatest] = useState<Record<string, string | null | undefined>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<AgentRuntimeId | null>(null)
  const [checking, setChecking] = useState<AgentRuntimeId | null>(null)

  const load = useCallback(async () => {
    try {
      setAgents((await api.agents()).data)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const updating = agents.some((agent) => agent.updating)
  useEffect(() => {
    if (!updating) return
    const timer = setInterval(() => void load(), 1500)
    return () => clearInterval(timer)
  }, [updating, load])

  async function check(id: AgentRuntimeId) {
    setChecking(id)
    try {
      const result = await api.checkAgent(id)
      setLatest((prev) => ({ ...prev, [id]: result.latest }))
    } catch {
      setLatest((prev) => ({ ...prev, [id]: null }))
    } finally {
      setChecking(null)
    }
  }

  async function update(id: AgentRuntimeId) {
    setBusy(id)
    setError(null)
    try {
      setAgents((await api.updateAgent(id)).data)
      setLatest((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const byId = new Map(agents.map((agent) => [agent.id, agent]))
  const ids: AgentRuntimeId[] = agents.length
    ? agents.map((agent) => agent.id)
    : providers.map((provider) => provider.id as AgentRuntimeId)

  return (
    <Section title="代理">
      {ids.length === 0 && <div className="px-4 py-3 text-sm text-muted-foreground">{error ?? '加载中…'}</div>}
      {ids.map((id) => {
        const agent = byId.get(id)
        const provider = providers.find((item) => item.id === id)
        const name = agent?.displayName ?? provider?.displayName ?? id
        const checked = latest[id]
        const newer = agent && checked && checked !== agent.active ? checked : null
        const status = agentStatus(agent, provider, checked)

        return (
          <InfoRow
            key={id}
            label={name}
            value={
              <span className="flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-1">
                <span className={status.tone}>{status.label}</span>
                {status.version && (
                  <span className="font-mono text-[11px] text-muted-foreground/70">{status.version}</span>
                )}
              </span>
            }
            action={
              agent &&
              (agent.updating ? (
                <LoaderCircle aria-label="更新中" className="size-4 shrink-0 animate-spin text-muted-foreground" />
              ) : newer ? (
                <Hint content={`升级到 ${newer}`}>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    className="tap size-11 text-primary"
                    disabled={busy === id}
                    onClick={() => void update(id)}
                    aria-label={`升级到 ${newer}`}
                  >
                    <ArrowUpCircle className="size-4" />
                  </Button>
                </Hint>
              ) : agent.satisfied ? (
                <Hint content={checked === null ? '检查失败，重试' : '检查更新'}>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    className="tap size-11"
                    disabled={checking === id}
                    onClick={() => void check(id)}
                    aria-label="检查更新"
                  >
                    <RefreshCw className={checking === id ? 'size-4 animate-spin' : 'size-4'} />
                  </Button>
                </Hint>
              ) : (
                <Hint content={agent.active ? '更新' : '安装'}>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    className="tap size-11 text-primary"
                    disabled={busy === id}
                    onClick={() => void update(id)}
                    aria-label={agent.active ? '更新' : '安装'}
                  >
                    <ArrowUpCircle className="size-4" />
                  </Button>
                </Hint>
              ))
            }
          >
            {agent?.error && <p className="text-destructive">{agent.error}</p>}
            <div className="space-y-2">
              {provider?.version && (
                <Detail label="代理版本">
                  <code>{provider.version}</code>
                </Detail>
              )}
              {provider?.detail && <Detail label="详情">{provider.detail}</Detail>}
              {agent && (
                <Detail label="运行时版本">
                  <code>{agent.active ?? '未找到'}</code>
                </Detail>
              )}
              {agent && (
                <Detail label="来源">
                  {agent.source === 'runtime' ? '运行时包' : agent.source === 'bundled' ? '内置' : '未知'}
                </Detail>
              )}
              {agent && (
                <Detail label="支持范围">
                  <code>{agent.supported}</code>
                </Detail>
              )}
              {agent?.installed?.length ? <Detail label="已安装">{agent.installed.join('、')}</Detail> : null}
              <p>
                只下载到执行机器；Codex 更新会重启 app-server，OpenCode 更新会重启它的 server（两者都会中断当前回合），
                Claude 下一回合生效；OpenCode attach 到外部 service 时，更新只对下次启动生效。
              </p>
              {provider?.available && provider.authenticated === false && (
                <p className="text-warning">
                  请在执行机器上运行 <code>{LOGIN_COMMAND[id] ?? id}</code>
                  {LOGIN_FOLLOW_UP[id] ? ` ${LOGIN_FOLLOW_UP[id]}` : ''}
                </p>
              )}
            </div>
          </InfoRow>
        )
      })}
      {error && ids.length > 0 && <div className="px-4 pb-2 text-xs text-destructive">{error}</div>}
    </Section>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6" aria-label={title}>
      <h2 className="px-1 pb-2 text-xs font-medium text-muted-foreground">{title}</h2>
      <div className="surface-list overflow-hidden divide-y divide-border/70 shadow-sm">{children}</div>
    </section>
  )
}

function InfoRow({
  label,
  value,
  action,
  children,
}: {
  label: string
  value?: React.ReactNode
  action?: React.ReactNode
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <div className="flex min-w-0 items-center">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={`${label}详情`}
          aria-haspopup="dialog"
          aria-expanded={open}
          className="flex min-h-14 min-w-0 flex-1 items-center gap-3 px-4 text-left transition-colors active:bg-secondary focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
        >
          <span className="shrink-0 text-sm font-medium text-foreground/90">{label}</span>
          <span className="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground">{value}</span>
          <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground/60" />
        </button>
        {action && <div className="shrink-0 pr-2">{action}</div>}
      </div>
      {open && (
        <Sheet title={label} closeLabel="完成" onClose={() => setOpen(false)}>
          <div className="space-y-4 px-4 pt-3 pb-6 text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
            {children}
          </div>
        </Sheet>
      )}
    </>
  )
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <div className="text-[11px] text-muted-foreground/70">{label}</div>
      <div className="text-foreground/80">{children}</div>
    </div>
  )
}
