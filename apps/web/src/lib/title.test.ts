import { describe, expect, it } from 'vitest'
import { routeTitle } from './title'

describe('routeTitle', () => {
  it('names each route', () => {
    expect(routeTitle('/')).toBe('会话')
    expect(routeTitle('/settings')).toBe('设置')
    expect(routeTitle('/files')).toBe('文件')
    expect(routeTitle('/terminal')).toBe('终端')
    expect(routeTitle('/chat/abc')).toBe('对话')
    expect(routeTitle('/login')).toBe('登录')
  })

  it('leaves unknown routes alone', () => {
    expect(routeTitle('/nope')).toBeNull()
  })
})
