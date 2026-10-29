import ToolbarRow, { ToolbarIdentity } from '../components/ToolbarRow'
import RunnerSelector from '../components/RunnerSelector'
import { useCallback, useEffect, useState } from 'react'
import { Popover } from 'radix-ui'
import { ChevronRight, FolderOpen, Info, LogOut, MoreVertical, Settings as SettingsIcon } from 'lucide-react'
import type { BuildInfo, HealthResponse, ProviderStatus, RunnerInfo } from '@vibemobile/protocol'
import { api } from '../lib/api'
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
}

const LOGIN_FOLLOW_UP: Record<string, string> = {
  // Both paths matter, and they are not interchangeable: `claude` walks you
  // through an OAuth login against Anthropic, while a proxied/gateway setup
  // authenticates from `~/.claude/settings.json` and never logs in at all. The
  // second is the one that fails silently — no credentials, and a model list
  // that quietly reverts to the CLI's built-in catalogue.
  claude:
    '并在其中完成登录；若走内网代理或网关，改在服务器上配置它的 ~/.claude/settings.json（ANTHROPIC_BASE_URL 与凭据）',
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
          <Section title="代理">
            {providers.length === 0 && <div className="px-4 py-3 text-sm text-muted-foreground">加载中…</div>}
            {providers.map((provider) => (
              <InfoRow
                key={provider.id}
                label={provider.displayName}
                value={
                  <span
                    className={provider.available && provider.authenticated !== false ? 'text-success' : 'text-warning'}
                  >
                    {provider.available ? (provider.authenticated === false ? '未登录' : '可用') : '不可用'}
                  </span>
                }
              >
                {provider.version && (
                  <Detail label="版本">
                    <code>{provider.version}</code>
                  </Detail>
                )}
                {provider.detail && <Detail label="详情">{provider.detail}</Detail>}
                {!provider.version && !provider.detail && <p>暂无更多信息</p>}
                {provider.available && provider.authenticated === false && (
                  <p className="text-warning">
                    请在执行机器上运行 <code>{LOGIN_COMMAND[provider.id] ?? provider.id}</code>
                    {LOGIN_FOLLOW_UP[provider.id] ? ' ' + LOGIN_FOLLOW_UP[provider.id] : ''}
                  </p>
                )}
              </InfoRow>
            ))}
          </Section>

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
                  label={project.isGitRepo ? 'Git · ' + (project.gitBranch || '未命名分支') : '目录'}
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
            <Section title="执行机器">
              {managedRunners.length === 0 && (
                <p className="px-4 py-3 text-xs text-muted-foreground">
                  还没有远程执行机。添加后，把生成的两行变量写进执行机的 .env.runner。
                </p>
              )}
              {managedRunners.map((runner) => (
                <div key={runner.id} className="flex min-h-14 min-w-0 items-center gap-2 py-2 pl-4 pr-1">
                  <span
                    aria-hidden="true"
                    className={`size-1.5 shrink-0 rounded-full ${runner.online ? 'bg-success' : 'bg-muted-foreground'}`}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm">
                    <span className="font-medium text-foreground/90">{runner.name}</span>
                    <span className="ml-2 font-mono text-[11px] text-muted-foreground">{runner.id}</span>
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
              <div className="px-4 py-3">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    setRunnerName('')
                    setRunnerSheetError(null)
                    setRunnerSheet({ kind: 'create' })
                  }}
                  className="tap h-11 w-full text-[14px]"
                >
                  添加执行机
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
            <BuildRow
              label="前端"
              build={WEB_BUILD}
              note={builtAtLabel(WEB_BUILD) ? '构建于 ' + builtAtLabel(WEB_BUILD) : '开发模式（Vite 实时编译）'}
            />
            <BuildRow label="服务端" build={server} note={serverNote} />
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
            <InfoRow label="安全" value={location.protocol === 'https:' ? 'HTTPS' : 'HTTP'}>
              <p>登录凭据通过 httpOnly Cookie 保存。公网访问应使用 HTTPS 反向代理。</p>
            </InfoRow>
            <div className="flex min-h-14 items-center gap-3 pl-4 pr-1">
              <span className="min-w-0 flex-1 text-xs text-muted-foreground">让所有已登录设备立即失效</span>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setLogoutAllError(null)
                  setLogoutAllOpen(true)
                }}
                className="tap h-10 shrink-0 px-3 text-[13px]"
              >
                登出所有设备
              </Button>
            </div>
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
            className="tap mt-6 w-full gap-2 rounded-xl border border-border py-2 text-sm text-destructive active:bg-destructive/10 disabled:opacity-50"
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-5">
      <div className="px-1 pb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</div>
      <div className="surface-list divide-y divide-border shadow-sm">{children}</div>
    </div>
  )
}

function BuildRow({ label, build, note }: { label: string; build?: BuildInfo | null; note?: string }) {
  return (
    <InfoRow label={label} value={<code>{build?.version ?? '…'}</code>}>
      <Detail label="构建">
        <code>{build ? buildLabel(build) : '读取中…'}</code>
      </Detail>
      {note && <p>{note}</p>}
      <p>{label === '前端' ? '前端重建后刷新页面即可生效。' : '服务端重建后需重启进程才会生效。'}</p>
    </InfoRow>
  )
}

function InfoRow({ label, value, children }: { label: string; value?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex min-h-14 min-w-0 items-center gap-3 pl-4 pr-1">
      <span className="shrink-0 text-sm font-medium text-foreground/90">{label}</span>
      <span className="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground">{value}</span>
      <Popover.Root>
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-label={label + '详情'}
            className="tap shrink-0 rounded-xl text-muted-foreground/60 transition-colors active:bg-secondary data-[state=open]:text-primary"
          >
            <Info aria-hidden="true" className="size-4" strokeWidth={1.7} />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            aria-label={label + '详情'}
            side="top"
            align="end"
            sideOffset={6}
            collisionPadding={12}
            onOpenAutoFocus={(event) => event.preventDefault()}
            className="z-50 max-h-[var(--radix-popover-content-available-height)] w-72 max-w-[calc(100vw-24px)] overflow-y-auto rounded-xl border border-border bg-popover px-3.5 py-3 text-xs leading-relaxed text-muted-foreground shadow-xl outline-none [overflow-wrap:anywhere]"
          >
            <div className="mb-2 font-medium text-foreground">{label}</div>
            <div className="space-y-2">{children}</div>
            <Popover.Arrow className="fill-popover" width={10} height={5} />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
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
