import { describe, expect, it } from 'vitest'
import { ApiError } from './api'
import { runnerAdminError, runnerEnvBlock } from './runnerAdmin'

describe('runner admin helpers', () => {
  it('builds the exact env lines copied to the runner machine', () => {
    expect(runnerEnvBlock('runner-abc', 'deadbeef')).toBe(
      'VIBEMOBILE_RUNNER_ID=runner-abc\nVIBEMOBILE_RUNNER_TOKEN=deadbeef',
    )
  })

  it('translates stable server codes and falls back to the message', () => {
    expect(runnerAdminError(new ApiError('x', 400, 'invalid_runner_name'))).toContain('名称')
    expect(runnerAdminError(new ApiError('x', 409, 'runner_default'))).toContain('默认')
    expect(runnerAdminError(new ApiError('x', 409, 'runner_limit'))).toContain('上限')
    expect(runnerAdminError(new ApiError('boom', 500))).toBe('boom')
    expect(runnerAdminError(new Error('plain'))).toBe('plain')
  })
})
