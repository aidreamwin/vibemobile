/**
 * Git facts about a workspace root, used by every provider's `listProjects`.
 *
 * Shared rather than duplicated because the two providers must agree: a
 * project shown as a git repo under Codex and not under Claude would be a
 * confusing inconsistency with no meaningful cause.
 */
export async function readGitInfo(dir: string): Promise<{ isRepo: boolean; branch: string | null }> {
  const { execFile } = await import('node:child_process')
  const run = (args: string[]) =>
    new Promise<string>((resolve, reject) => {
      execFile('git', args, { cwd: dir, timeout: 5_000, windowsHide: true }, (err, stdout) => {
        if (err) reject(err)
        else resolve(stdout.trim())
      })
    })
  try {
    const branch = await run(['rev-parse', '--abbrev-ref', 'HEAD'])
    return { isRepo: true, branch }
  } catch {
    return { isRepo: false, branch: null }
  }
}
