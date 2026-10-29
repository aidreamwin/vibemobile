import { describe, expect, it } from 'vitest'
import type { BuildInfo } from '@vibemobile/protocol'
import { buildLabel, builtAtLabel, halvesDiverge, serverRestartPending, uptimeLabel } from './build'

const at = (iso: string) => new Date(iso).getTime()

const stamp = (over: Partial<BuildInfo> = {}): BuildInfo => ({
  version: '0.1.0',
  commit: '11a3943',
  dirty: false,
  builtAt: at('2026-09-18T14:02:00'),
  ...over,
})

describe('buildLabel', () => {
  it('shows version and commit', () => {
    expect(buildLabel(stamp())).toBe('0.1.0 · 11a3943')
  })

  it('marks a build from a dirty tree — the commit alone would lie', () => {
    expect(buildLabel(stamp({ dirty: true }))).toBe('0.1.0 · 11a3943+未提交')
  })

  it('does not invent a commit when the build could not see git', () => {
    expect(buildLabel(stamp({ commit: null }))).toBe('0.1.0')
    expect(buildLabel(stamp({ commit: null, dirty: true }))).toBe('0.1.0')
  })
})

describe('builtAtLabel', () => {
  it('formats month-day and time', () => {
    expect(builtAtLabel(stamp())).toBe('09-18 14:02')
  })

  it('reports no build at all for a dev run', () => {
    expect(builtAtLabel(stamp({ builtAt: null }))).toBeNull()
  })
})

describe('uptimeLabel', () => {
  it('is quiet right after a restart', () => {
    expect(uptimeLabel(3)).toBe('刚刚启动')
    expect(uptimeLabel(89)).toBe('刚刚启动')
  })

  it('counts minutes, then hours and minutes, then days', () => {
    expect(uptimeLabel(600)).toBe('已运行 10 分钟')
    expect(uptimeLabel(3 * 3600 + 5 * 60)).toBe('已运行 3 小时 5 分')
    expect(uptimeLabel(50 * 3600)).toBe('已运行 2 天 2 小时')
  })

  it('says nothing when uptime is unknown', () => {
    expect(uptimeLabel(undefined)).toBeNull()
    expect(uptimeLabel(null)).toBeNull()
  })
})

describe('halvesDiverge', () => {
  it('flags two halves built from different commits', () => {
    expect(halvesDiverge(stamp(), stamp({ commit: 'aaaaaaa' }))).toBe(true)
  })

  it('is quiet when they match', () => {
    expect(halvesDiverge(stamp(), stamp({ dirty: true }))).toBe(false)
  })

  it('treats different abbreviation lengths of the same commit as equal', () => {
    // release 包存 12 位，开发树是 git 默认的 7 位。
    expect(halvesDiverge(stamp({ commit: '41ca611' }), stamp({ commit: '41ca611a2593' }))).toBe(false)
    expect(halvesDiverge(stamp({ commit: '41ca611a2593' }), stamp({ commit: '41ca611' }))).toBe(false)
  })

  it('never compares against a build that could not see git', () => {
    // Docker: no .git in the image, so "unknown" must not read as "different".
    expect(halvesDiverge(stamp({ commit: null }), stamp())).toBe(false)
    expect(halvesDiverge(stamp(), stamp({ commit: null }))).toBe(false)
    expect(halvesDiverge(stamp(), null)).toBe(false)
    expect(halvesDiverge(stamp(), undefined)).toBe(false)
  })
})

describe('serverRestartPending', () => {
  it('flags a rebuild that never got restarted', () => {
    expect(serverRestartPending(stamp(), stamp({ builtAt: at('2026-09-18T15:00:00') }))).toBe(true)
    expect(serverRestartPending(stamp(), stamp({ commit: 'bbbbbbb' }))).toBe(true)
    expect(serverRestartPending(stamp(), stamp({ version: '0.2.0' }))).toBe(true)
  })

  it('flags the first stamp appearing under a running process', () => {
    // dist built by hand (`tsc`), then a real build lands while the service runs.
    expect(serverRestartPending(stamp({ builtAt: null, commit: null }), stamp())).toBe(true)
  })

  it('is quiet when the file has not moved', () => {
    expect(serverRestartPending(stamp(), stamp())).toBe(false)
    // dirty alone is not a difference: it rides along with an otherwise identical build.
    expect(serverRestartPending(stamp(), stamp({ dirty: true }))).toBe(false)
  })

  it('is quiet in development, where there is no file to compare', () => {
    expect(serverRestartPending(stamp({ builtAt: null }), null)).toBe(false)
    expect(serverRestartPending(stamp({ builtAt: null }), undefined)).toBe(false)
  })
})
