import { describe, expect, it } from 'vitest'
import type { Project } from '@vibemobile/protocol'
import { chooseDefaultCwd, isPathInside, parentPath, workspaceRootFor } from './workspace'

const projects: Project[] = [
  { id: 'one', name: 'one', path: 'D:\\code\\one', isGitRepo: true },
  { id: 'nested', name: 'nested', path: 'D:\\code\\one\\packages', isGitRepo: false },
  { id: 'two', name: 'two', path: '/srv/two', isGitRepo: false },
]

describe('workspace paths', () => {
  it('accepts subdirectories without confusing sibling prefixes', () => {
    expect(isPathInside('D:\\code\\one\\src', 'D:\\code\\one')).toBe(true)
    expect(isPathInside('d:/CODE/one/src', 'D:\\code\\one')).toBe(true)
    expect(isPathInside('D:\\code\\one-more', 'D:\\code\\one')).toBe(false)
  })

  it('uses the most specific configured root', () => {
    expect(workspaceRootFor(projects, 'D:\\code\\one\\packages\\web')?.id).toBe('nested')
  })

  it('falls back when a persisted directory is no longer allowed', () => {
    expect(chooseDefaultCwd(projects, 'D:\\removed')).toBe('D:\\code\\one')
    expect(chooseDefaultCwd(projects, '/srv/two/app')).toBe('/srv/two/app')
  })

  it('keeps a selected subdirectory as a valid future session default', () => {
    expect(chooseDefaultCwd(projects, 'D:\\code\\one\\src')).toBe('D:\\code\\one\\src')
  })

  it('walks both Windows and POSIX paths upward', () => {
    expect(parentPath('D:\\code\\one')).toBe('D:\\code')
    expect(parentPath('/srv/two/app')).toBe('/srv/two')
  })
})
