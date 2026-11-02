import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  activeAgent,
  bundledAgentVersion,
  claudeBinaryInPack,
  codexBinaryInPack,
  installedPacks,
  readPackVersion,
  resolveClaudeBin,
  resolveCodexBin,
  satisfiesRange,
} from './runtime.js'

const dirs: string[] = []

function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbm-agents-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function writePackage(pack: string, pkg: string, version: string): void {
  const file = path.join(pack, 'node_modules', ...pkg.split('/'), 'package.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ version }))
}

const CODEX_TARGETS: Record<string, { pkg: string; triple: string; file: string }> = {
  'linux-x64': { pkg: '@openai/codex-linux-x64', triple: 'x86_64-unknown-linux-musl', file: 'codex' },
  'linux-arm64': { pkg: '@openai/codex-linux-arm64', triple: 'aarch64-unknown-linux-musl', file: 'codex' },
  'darwin-x64': { pkg: '@openai/codex-darwin-x64', triple: 'x86_64-apple-darwin', file: 'codex' },
  'darwin-arm64': { pkg: '@openai/codex-darwin-arm64', triple: 'aarch64-apple-darwin', file: 'codex' },
  'win32-x64': { pkg: '@openai/codex-win32-x64', triple: 'x86_64-pc-windows-msvc', file: 'codex.exe' },
  'win32-arm64': { pkg: '@openai/codex-win32-arm64', triple: 'aarch64-pc-windows-msvc', file: 'codex.exe' },
}

const CLAUDE_TARGETS: Record<string, { pkg: string; file: string }> = {
  'linux-x64': { pkg: '@anthropic-ai/claude-code-linux-x64', file: 'claude' },
  'linux-arm64': { pkg: '@anthropic-ai/claude-code-linux-arm64', file: 'claude' },
  'darwin-x64': { pkg: '@anthropic-ai/claude-code-darwin-x64', file: 'claude' },
  'darwin-arm64': { pkg: '@anthropic-ai/claude-code-darwin-arm64', file: 'claude' },
  'win32-x64': { pkg: '@anthropic-ai/claude-code-win32-x64', file: 'claude.exe' },
  'win32-arm64': { pkg: '@anthropic-ai/claude-code-win32-arm64', file: 'claude.exe' },
}

function platformKey(): string {
  return `${process.platform}-${process.arch}`
}

function writeCodexPack(pack: string, version: string): void {
  writePackage(pack, '@openai/codex', version)
  const target = CODEX_TARGETS[platformKey()]
  if (!target) return
  const binary = path.join(pack, 'node_modules', target.pkg, 'vendor', target.triple, 'bin', target.file)
  fs.mkdirSync(path.dirname(binary), { recursive: true })
  fs.writeFileSync(binary, '')
}

function writeClaudePack(pack: string, version: string): void {
  writePackage(pack, '@anthropic-ai/claude-code', version)
  const target = CLAUDE_TARGETS[platformKey()]
  if (!target) return
  const binary = path.join(pack, 'node_modules', target.pkg, target.file)
  fs.mkdirSync(path.dirname(binary), { recursive: true })
  fs.writeFileSync(binary, '')
}

function linkCurrent(agentsDir: string, id: string, version: string): void {
  const target = path.join(agentsDir, id, version)
  fs.symlinkSync(target, path.join(agentsDir, id, 'current'), process.platform === 'win32' ? 'junction' : 'dir')
}

describe('satisfiesRange', () => {
  it('accepts newer patches on the same minor line', () => {
    expect(satisfiesRange('0.166.0', '~0.166.0')).toBe(true)
    expect(satisfiesRange('0.166.7', '~0.166.0')).toBe(true)
    expect(satisfiesRange('2.1.320', '~2.1.316')).toBe(true)
  })

  it('rejects another minor or major line', () => {
    expect(satisfiesRange('0.167.0', '~0.166.0')).toBe(false)
    expect(satisfiesRange('2.2.0', '~2.1.316')).toBe(false)
    expect(satisfiesRange('3.1.316', '~2.1.316')).toBe(false)
  })

  it('rejects an older patch and malformed input', () => {
    expect(satisfiesRange('0.166.0', '~0.166.5')).toBe(false)
    expect(satisfiesRange('nonsense', '~0.166.0')).toBe(false)
  })

  it('still understands an exact pin', () => {
    expect(satisfiesRange('1.2.3', '1.2.3')).toBe(true)
    expect(satisfiesRange('1.2.4', '1.2.3')).toBe(false)
  })
})

describe('runtime packs', () => {
  // Claude's version comes from the SDK's manifest.json, which its exports map
  // does not expose under `<pkg>/package.json` — resolving the manifest the
  // wrong way silently reports "missing" while the provider still works.
  it('reports the bundled versions', () => {
    expect(bundledAgentVersion('codex')).toMatch(/^\d+\.\d+\.\d+/)
    expect(bundledAgentVersion('claude')).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('reads the version out of a pack', () => {
    const pack = temp()
    writePackage(pack, '@openai/codex', '1.2.3')
    expect(readPackVersion(pack, '@openai/codex')).toBe('1.2.3')
    expect(readPackVersion(pack, '@openai/missing')).toBeNull()
  })

  it('finds the native binaries and ignores incomplete packs', () => {
    if (!CODEX_TARGETS[platformKey()] || !CLAUDE_TARGETS[platformKey()]) return
    const codex = temp()
    const claude = temp()
    writeCodexPack(codex, '1.2.3')
    writeClaudePack(claude, '2.1.0')
    expect(codexBinaryInPack(codex)).toContain('codex')
    expect(claudeBinaryInPack(claude)).toContain('claude')
    const empty = temp()
    expect(codexBinaryInPack(empty)).toBeNull()
    expect(claudeBinaryInPack(empty)).toBeNull()
  })

  it('lists installed versions only, newest last', () => {
    const agentsDir = temp()
    for (const version of ['0.10.0', '0.9.0']) {
      writeCodexPack(path.join(agentsDir, 'codex', version), version)
    }
    fs.mkdirSync(path.join(agentsDir, 'codex', 'current'))
    expect(installedPacks(agentsDir, 'codex')).toEqual(['0.9.0', '0.10.0'])
    expect(installedPacks(agentsDir, 'claude')).toEqual([])
  })

  it('prefers the active pack over the bundled version', () => {
    if (!CODEX_TARGETS[platformKey()]) return
    const agentsDir = temp()
    writeCodexPack(path.join(agentsDir, 'codex', '9.9.9'), '9.9.9')
    linkCurrent(agentsDir, 'codex', '9.9.9')
    expect(activeAgent(agentsDir, 'codex')).toEqual({ version: '9.9.9', source: 'runtime' })
    // No pack → the copy that shipped with the app.
    expect(activeAgent(temp(), 'codex').source).toBe('bundled')
  })

  it('resolves the Codex binary in priority order', () => {
    if (!CODEX_TARGETS[platformKey()]) return
    const agentsDir = temp()
    writeCodexPack(path.join(agentsDir, 'codex', '9.9.9'), '9.9.9')
    linkCurrent(agentsDir, 'codex', '9.9.9')

    const packed = resolveCodexBin({ agentsDir })
    expect(packed.cmd).toMatch(/codex[\\/]current/)

    // CODEX_BIN overrides everything.
    expect(resolveCodexBin({ bin: '/custom/codex', agentsDir }).cmd).toBe('/custom/codex')
  })

  it('returns the Claude pack binary only when a pack is active', () => {
    if (!CLAUDE_TARGETS[platformKey()]) return
    const agentsDir = temp()
    expect(resolveClaudeBin(undefined)).toBeNull()
    expect(resolveClaudeBin(agentsDir)).toBeNull()
    writeClaudePack(path.join(agentsDir, 'claude', '2.1.0'), '2.1.0')
    linkCurrent(agentsDir, 'claude', '2.1.0')
    expect(resolveClaudeBin(agentsDir)).toMatch(/claude[\\/]current/)
  })
})
