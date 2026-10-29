import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from './api'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('API errors', () => {
  it('preserves the machine-readable code and human-readable message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: 'session_in_use',
            message: 'This session is open in another Codex client.',
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    )

    const result = api.openSession('thread-1')

    await expect(result).rejects.toBeInstanceOf(ApiError)
    await expect(result).rejects.toMatchObject({
      status: 409,
      code: 'session_in_use',
      message: 'This session is open in another Codex client.',
    })
  })
})
