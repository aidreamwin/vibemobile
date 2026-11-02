import { describe, expect, it } from 'vitest'
import { errorLabel, jobRunning, phaseLabel } from './system'

describe('update labels', () => {
  it('translates every phase to plain language', () => {
    expect(phaseLabel('downloading')).toBe('下载中')
    expect(phaseLabel('installing')).toContain('较慢')
    expect(phaseLabel('rolled_back')).toBe('已回滚')
  })

  it('maps API codes to user-facing text and passes unknown messages through', () => {
    expect(errorLabel({ code: 'update_running' })).toBe('已有升级正在进行')
    expect(errorLabel('update_via_hub')).toBe('该执行机随 Hub 一起升级')
    expect(errorLabel(new Error('network down'))).toBe('network down')
  })

  it('treats only queued/running as active', () => {
    expect(jobRunning({ status: 'running' } as never)).toBe(true)
    expect(jobRunning({ status: 'queued' } as never)).toBe(true)
    expect(jobRunning({ status: 'succeeded' } as never)).toBe(false)
    expect(jobRunning(null)).toBe(false)
  })
})
