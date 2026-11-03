/**
 * Where the agent binaries live and how to find the one in use.
 *
 * Two sources, in priority order:
 *   1. a runtime pack under `<agentsDir>/<id>/current` (installed by the update
 *      route without touching the app's node_modules);
 *   2. the copy that shipped in node_modules / the Claude SDK.
 *
 * Resolution happens at spawn time, never at startup: replacing `current` must
 * take effect on the next Codex app-server respawn and the next Claude turn.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { AgentRuntimeId } from '@vibemobile/protocol'
import { AGENT_RUNTIMES } from './manifest.js'

const require = createRequire(import.meta.url)

export interface ResolvedCommand {
  cmd: string
  args: string[]
}

const CODEX_PLATFORM: Record<string, { package: string; triple: string; file: string }> = {
  'linux-x64': { package: '@openai/codex-linux-x64', triple: 'x86_64-unknown-linux-musl', file: 'codex' },
  'linux-arm64': { package: '@openai/codex-linux-arm64', triple: 'aarch64-unknown-linux-musl', file: 'codex' },
  'darwin-x64': { package: '@openai/codex-darwin-x64', triple: 'x86_64-apple-darwin', file: 'codex' },
  'darwin-arm64': { package: '@openai/codex-darwin-arm64', triple: 'aarch64-apple-darwin', file: 'codex' },
  'win32-x64': { package: '@openai/codex-win32-x64', triple: 'x86_64-pc-windows-msvc', file: 'codex.exe' },
  'win32-arm64': { package: '@openai/codex-win32-arm64', triple: 'aarch64-pc-windows-msvc', file: 'codex.exe' },
}

/**
 * opencode ships one wrapper package plus per-platform optional deps. The
 * wrapper's postinstall picks the right one (AVX2 vs baseline) and copies it
 * to `bin/opencode(.exe)`; that copy is what a runtime pack should use first.
 * If postinstall was skipped, the platform package is the fallback.
 */
const OPENCODE_PLATFORM: Record<string, string> = {
  'linux-x64': '@opencode/cli-linux-x64',
  'linux-arm64': '@opencode/cli-linux-arm64',
  'linux-x64-musl': '@opencode/cli-linux-x64-musl',
  'linux-arm64-musl': '@opencode/cli-linux-arm64-musl',
  'darwin-x64': '@opencode/cli-darwin-x64',
  'darwin-arm64': '@opencode/cli-darwin-arm64',
  'win32-x64': '@opencode/cli-windows-x64',
  'win32-arm64': '@opencode/cli-windows-arm64',
}

const CLAUDE_PLATFORM: Record<string, { package: string; file: string }> = {
  'linux-x64': { package: '@anthropic-ai/claude-code-linux-x64', file: 'claude' },
  'linux-arm64': { package: '@anthropic-ai/claude-code-linux-arm64', file: 'claude' },
  'linux-x64-musl': { package: '@anthropic-ai/claude-code-linux-x64-musl', file: 'claude' },
  'linux-arm64-musl': { package: '@anthropic-ai/claude-code-linux-arm64-musl', file: 'claude' },
  'darwin-x64': { package: '@anthropic-ai/claude-code-darwin-x64', file: 'claude' },
  'darwin-arm64': { package: '@anthropic-ai/claude-code-darwin-arm64', file: 'claude' },
  'win32-x64': { package: '@anthropic-ai/claude-code-win32-x64', file: 'claude.exe' },
  'win32-arm64': { package: '@anthropic-ai/claude-code-win32-arm64', file: 'claude.exe' },
}

/**
 * The range forms the manifest uses: an exact version or a tilde range.
 *
 * Written out instead of pulling in semver: the manifest is a closed set of two
 * strings and a dependency on the full grammar would be more surface than the
 * check needs. Prereleases are not supported and never appear here.
 */
export function satisfiesRange(version: string, range: string): boolean {
  const parse = (value: string): number[] =>
    value
      .replace(/^[~^]/, '')
      .split(/[.+-]/)
      .slice(0, 3)
      .map((part) => Number(part))
  const [major, minor, patch] = parse(version)
  if (major === undefined || minor === undefined || patch === undefined) return false
  if (![major, minor, patch].every(Number.isInteger)) return false
  if (range.startsWith('~')) {
    const [rmajor, rminor, rpatch] = parse(range)
    return major === rmajor && minor === rminor && patch >= (rpatch ?? 0)
  }
  return version === range
}

function platformKey(): string {
  return `${process.platform}-${process.arch}`
}

function isMusl(): boolean {
  if (process.platform !== 'linux') return false
  const report = process.report?.getReport?.() as { header?: { glibcVersionRuntime?: unknown } } | undefined
  return report != null && report.header?.glibcVersionRuntime === undefined
}

function claudePlatformKey(): string {
  return isMusl() ? `${platformKey()}-musl` : platformKey()
}

/** `<pack>/node_modules/<pkg>/package.json` → its version, or null. */
export function readPackVersion(packRoot: string, pkg: string): string | null {
  try {
    const file = path.join(packRoot, 'node_modules', ...pkg.split('/'), 'package.json')
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : null
  } catch {
    return null
  }
}

/** The Codex native binary inside an installed pack, if the optional platform package landed. */
export function codexBinaryInPack(packRoot: string): string | null {
  const target = CODEX_PLATFORM[platformKey()]
  if (!target) return null
  const binary = path.join(packRoot, 'node_modules', target.package, 'vendor', target.triple, 'bin', target.file)
  return existsSync(binary) ? binary : null
}

/**
 * The Claude CLI inside an installed pack.
 *
 * The platform package's binary comes first: the wrapper package's `bin/claude`
 * is a placeholder that only becomes the native binary after its postinstall
 * runs, and postinstall is exactly what a hardened npm setup may skip.
 */
export function claudeBinaryInPack(packRoot: string): string | null {
  const target = CLAUDE_PLATFORM[claudePlatformKey()]
  if (target) {
    const native = path.join(packRoot, 'node_modules', target.package, target.file)
    if (existsSync(native)) return native
  }
  const bin = path.join(
    packRoot,
    'node_modules',
    '@anthropic-ai',
    'claude-code',
    'bin',
    process.platform === 'win32' ? 'claude.exe' : 'claude',
  )
  return existsSync(bin) ? bin : null
}

function opencodeFileName(): string {
  return process.platform === 'win32' ? 'opencode.exe' : 'opencode'
}

/**
 * The opencode binary inside an installed pack.
 *
 * The wrapper's postinstall output wins: it is the variant that was selected
 * for this CPU (AVX2 vs baseline). The per-platform package is the fallback for
 * an install whose scripts were skipped.
 */
export function opencodeBinaryInPack(packRoot: string): string | null {
  const file = opencodeFileName()
  const wrapper = path.join(packRoot, 'node_modules', '@opencode', 'cli', 'bin', file)
  if (existsSync(wrapper)) return wrapper
  const target = OPENCODE_PLATFORM[claudePlatformKey()]
  if (target) {
    const native = path.join(packRoot, 'node_modules', target, 'bin', file)
    if (existsSync(native)) return native
    const baseline = path.join(packRoot, 'node_modules', `${target}-baseline`, 'bin', file)
    if (existsSync(baseline)) return baseline
  }
  return null
}

export function hasBinary(id: AgentRuntimeId, packRoot: string): boolean {
  if (id === 'codex') return codexBinaryInPack(packRoot) !== null
  if (id === 'claude') return claudeBinaryInPack(packRoot) !== null
  return opencodeBinaryInPack(packRoot) !== null
}

/**
 * Find an executable on PATH.
 *
 * Windows has to be explicit: Node's `spawn` does not consult PATHEXT, so the
 * npm shim (`opencode.cmd`) would not run when passed as `'opencode'`. Prefer
 * the real `.exe`; wrap a `.cmd` with the command interpreter.
 */
function findOnPath(name: string): ResolvedCommand | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  const candidates =
    process.platform === 'win32'
      ? [`${name}.exe`, `${name}.cmd`, name]
      : [name]
  for (const dir of dirs) {
    for (const candidate of candidates) {
      const file = path.join(dir, candidate)
      if (!existsSync(file)) continue
      if (process.platform === 'win32' && candidate.endsWith('.cmd')) {
        // Prefer the real executable behind the npm shim: it avoids cmd.exe,
        // PATHEXT, and paths containing spaces. The shim lives in a directory
        // whose sibling `node_modules` (or the parent `node_modules/.bin`) holds
        // the package.
        const roots = [dir, path.basename(dir) === '.bin' ? path.dirname(dir) : null]
        for (const root of roots) {
          if (!root) continue
          const direct = path.join(root, 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe')
          const nested = path.join(root, '@opencode', 'cli', 'bin', 'opencode.exe')
          for (const binary of [direct, nested]) {
            if (existsSync(binary)) return { cmd: binary, args: [] }
          }
        }
        return { cmd: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', file] }
      }
      return { cmd: file, args: [] }
    }
  }
  return null
}

/** The opencode entry point shipped in node_modules, if it is there at all. */
export function bundledOpenCodeBin(): ResolvedCommand | null {
  const file = opencodeFileName()
  const target = OPENCODE_PLATFORM[claudePlatformKey()]
  if (target) {
    try {
      const pkg = require.resolve(`${target}/package.json`)
      const binary = path.join(path.dirname(pkg), 'bin', file)
      if (existsSync(binary)) return { cmd: binary, args: [] }
    } catch {
      // Optional platform package absent; try the wrapper.
    }
  }
  try {
    const pkg = require.resolve('@opencode/cli/package.json')
    const binary = path.join(path.dirname(pkg), 'bin', file)
    if (existsSync(binary)) return { cmd: binary, args: [] }
  } catch {
    // Not a dependency of this repo, which is the normal case.
  }
  return null
}

/** opencode priority: explicit bin -> runtime pack -> bundled -> PATH. */
export function resolveOpencodeBin(opts: { bin?: string; agentsDir?: string } = {}): ResolvedCommand {
  if (opts.bin) return { cmd: opts.bin, args: [] }
  if (opts.agentsDir) {
    const packed = opencodeBinaryInPack(currentPackPath(opts.agentsDir, 'opencode'))
    if (packed) return { cmd: packed, args: [] }
  }
  return bundledOpenCodeBin() ?? findOnPath('opencode') ?? { cmd: 'opencode', args: [] }
}

/** `<agentsDir>/<id>/current`, the only path the rest of the server reads. */
export function currentPackPath(agentsDir: string, id: AgentRuntimeId): string {
  return path.join(agentsDir, id, 'current')
}

/** The bundled Codex entry point: native platform package, then the JS launcher, then PATH. */
export function bundledCodexBin(): ResolvedCommand | null {
  const target = CODEX_PLATFORM[platformKey()]
  if (target) {
    try {
      const pkg = require.resolve(`${target.package}/package.json`)
      const binary = path.join(path.dirname(pkg), 'vendor', target.triple, 'bin', target.file)
      if (existsSync(binary)) return { cmd: binary, args: [] }
    } catch {
      // Optional platform package absent — fall through to the JS launcher.
    }
  }
  try {
    const pkg = require.resolve('@openai/codex/package.json')
    return { cmd: process.execPath, args: [path.join(path.dirname(pkg), 'bin', 'codex.js')] }
  } catch {
    return null
  }
}

/**
 * Codex entry point.
 *
 * `bin` is an explicit override (CODEX_BIN) and wins over everything; a pack
 * comes next; the bundled install is last. The final PATH fallback is kept so a
 * Docker image that puts the CLI on PATH still works.
 */
export function resolveCodexBin(opts: { bin?: string; agentsDir?: string } = {}): ResolvedCommand {
  if (opts.bin) return { cmd: opts.bin, args: [] }
  if (opts.agentsDir) {
    const packed = codexBinaryInPack(currentPackPath(opts.agentsDir, 'codex'))
    if (packed) return { cmd: packed, args: [] }
  }
  return bundledCodexBin() ?? { cmd: 'codex', args: [] }
}

/** The Claude CLI from a runtime pack, or null to let the SDK use its bundled one. */
export function resolveClaudeBin(agentsDir?: string): string | null {
  if (!agentsDir) return null
  return claudeBinaryInPack(currentPackPath(agentsDir, 'claude'))
}

/** Version of the bundled agent (the one in node_modules), or null. */
export function bundledAgentVersion(id: AgentRuntimeId): string | null {
  if (id === 'codex') {
    try {
      const pkg = require.resolve('@openai/codex/package.json')
      const parsed = JSON.parse(readFileSync(pkg, 'utf8')) as { version?: unknown }
      return typeof parsed.version === 'string' ? parsed.version : null
    } catch {
      return null
    }
  }
  if (id === 'opencode') {
    // Not a dependency of this repo; a developer who added it should see the
    // version, and everyone else gets null until a runtime pack is installed.
    try {
      const pkg = require.resolve('@opencode/cli/package.json')
      const parsed = JSON.parse(readFileSync(pkg, 'utf8')) as { version?: unknown }
      return typeof parsed.version === 'string' ? parsed.version : null
    } catch {
      return null
    }
  }
  // The SDK's manifest names the CLI it ships, while the SDK package's own
  // version is the bridge version. The CLI is what the user sees.
  try {
    // Resolve the entry point, not `<pkg>/package.json`: the SDK's exports map
    // does not expose the manifest, so that path throws ERR_PACKAGE_PATH_NOT_EXPORTED.
    const entry = require.resolve('@anthropic-ai/claude-agent-sdk')
    const manifest = path.join(path.dirname(entry), 'manifest.json')
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : null
  } catch {
    return null
  }
}

export interface ActiveAgent {
  version: string | null
  source: 'runtime' | 'bundled' | 'missing'
}

export function activeAgent(agentsDir: string | undefined, id: AgentRuntimeId): ActiveAgent {
  if (agentsDir) {
    const pack = currentPackPath(agentsDir, id)
    if (hasBinary(id, pack)) {
      const version = readPackVersion(pack, AGENT_RUNTIMES[id].package)
      if (version) return { version, source: 'runtime' }
    }
  }
  const bundled = bundledAgentVersion(id)
  return bundled ? { version: bundled, source: 'bundled' } : { version: null, source: 'missing' }
}

/** Version directories under `<agentsDir>/<id>`, oldest-looking order kept stable. */
export function installedPacks(agentsDir: string, id: AgentRuntimeId): string[] {
  try {
    return readdirSync(path.join(agentsDir, id), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+\.\d+\.\d+/.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  } catch {
    return []
  }
}
