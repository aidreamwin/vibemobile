import { create } from 'zustand'
import type { UpdateJob, UpdatePhase, UpdateStatus } from '@vibemobile/protocol'
import { api } from './api'

const PHASE_LABELS: Record<UpdatePhase, string> = {
  queued: '准备中',
  downloading: '下载中',
  verifying: '校验中',
  extracting: '解压中',
  installing: '安装依赖（较慢）',
  building: '构建中',
  restarting: '正在重启',
  healthcheck: '健康检查',
  done: '完成',
  rolling_back: '回滚中',
  rolled_back: '已回滚',
  failed: '失败',
}

const ERROR_LABELS: Record<string, string> = {
  update_running: '已有升级正在进行',
  update_not_supported: '当前部署方式不支持一键升级',
  update_via_hub: '该执行机随 Hub 一起升级',
  update_not_available: '已经是最新版本',
  update_not_configured: '还没有配置更新源',
  feed_unavailable: '连接更新源失败，请检查网络',
  feed_unauthorized: '更新源鉴权失败',
  feed_invalid: '更新包信息无效',
  feed_dirty: '发布包标记为 dirty，不能安装',
  update_dirty_release: '发布包无效，不能安装',
  update_start_failed: '启动升级失败',
  origin_not_allowed: '请求来源不被允许',
  update_not_started: '升级没有启动成功',
  update_lost: '升级进程中断',
  update_timeout: '升级超时',
  update_failed: '升级失败，已回到原版本',
  update_checksum_mismatch: '更新包校验失败',
  update_size_mismatch: '更新包大小不符',
  update_archive_unsafe_path: '更新包路径不安全',
  rollback_failed: '升级失败，且回滚未成功',
  no_previous_release: '升级失败，没有可回滚的版本',
}

export function phaseLabel(phase: UpdatePhase | undefined): string {
  return phase ? PHASE_LABELS[phase] : '准备中'
}

export function errorLabel(error: unknown): string {
  if (typeof error === 'string') return ERROR_LABELS[error] ?? error
  const code = (error as { code?: unknown })?.code
  if (typeof code === 'string' && ERROR_LABELS[code]) return ERROR_LABELS[code]
  return (error as Error)?.message || '升级失败'
}

export function jobRunning(job: UpdateJob | null | undefined): boolean {
  return job?.status === 'queued' || job?.status === 'running'
}

interface SystemState {
  current: UpdateStatus | null
  hub: UpdateStatus | null
  loading: boolean
  currentError: string | null
  hubError: string | null
  load: (options?: { hub?: boolean; force?: boolean }) => Promise<void>
  start: (hub?: boolean) => Promise<void>
}

/**
 * App-update state shared by the banner and Settings.
 *
 * `current` is scoped by the URL (Hub on `/`, a runner under `/r/<id>/`);
 * `hub` is always the Hub process, so a runner page can still offer the Hub
 * row. The feeds are separate: each host has its own state and env.
 */
export const useSystemStore = create<SystemState>((set) => ({
  current: null,
  hub: null,
  loading: false,
  currentError: null,
  hubError: null,

  load: async ({ hub = false, force = false } = {}) => {
    set({ loading: true })
    try {
      const status = force
        ? hub
          ? await api.hubCheckSystemUpdate()
          : await api.checkSystemUpdate()
        : hub
          ? await api.hubSystemUpdate()
          : await api.systemUpdate()
      set(
        hub ? { hub: status, hubError: null, loading: false } : { current: status, currentError: null, loading: false },
      )
    } catch (error) {
      set(hub ? { hubError: errorLabel(error), loading: false } : { currentError: errorLabel(error), loading: false })
    }
  },

  start: async (hub = false) => {
    set({ loading: true })
    try {
      if (hub) await api.hubStartSystemUpdate()
      else await api.startSystemUpdate()
      const status = hub ? await api.hubSystemUpdate() : await api.systemUpdate()
      set(
        hub ? { hub: status, hubError: null, loading: false } : { current: status, currentError: null, loading: false },
      )
    } catch (error) {
      const message = errorLabel(error)
      set(hub ? { hubError: message, loading: false } : { currentError: message, loading: false })
      throw error
    }
  },
}))
