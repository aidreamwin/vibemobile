import fs from 'node:fs'
import path from 'node:path'
import type { UpdateCurrentInfo, UpdateReleaseInfo } from '@vibemobile/protocol'

/**
 * Compare two `x.y.z` versions. Returns 0 for anything unparseable, which makes
 * the caller treat an odd feed as "no update" rather than offering a downgrade.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string): number[] | null => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim())
    if (!match) return null
    return [Number(match[1]), Number(match[2]), Number(match[3])]
  }
  const left = parse(a)
  const right = parse(b)
  if (!left || !right) return 0
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index]! > right[index]! ? 1 : -1
  }
  return 0
}

/** The web version of the release currently on disk. */
export function readWebVersion(installDir: string): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(installDir, 'apps', 'web', 'package.json'), 'utf8')) as {
      version?: unknown
    }
    return typeof raw.version === 'string' ? raw.version : null
  } catch {
    return null
  }
}

/**
 * Whether the feed release is an upgrade for this role.
 *
 * A runner package has no web build, so a web-only release must not offer an
 * update there. The Hub serves the web assets and therefore compares both.
 */
export function updateAvailable(
  role: 'hub' | 'runner',
  current: UpdateCurrentInfo,
  latest: UpdateReleaseInfo,
): boolean {
  const server = compareVersions(latest.serverVersion, current.serverVersion)
  if (server > 0) return true
  if (server < 0) return false
  if (role !== 'hub' || !current.webVersion) return false
  return compareVersions(latest.webVersion, current.webVersion) > 0
}
