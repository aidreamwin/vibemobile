/**
 * Workspace-scoped filesystem access.
 *
 * Every path that reaches the filesystem goes through `resolveInside()`. The
 * agent can be pointed at arbitrary directories, so the web UI must not become
 * a way to read `C:\Users\...\.ssh` from a phone.
 */
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import { realpathSync, type Dirent } from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import type { FileContent, FileEntry } from '@vibemobile/protocol'
import { applyEol, detectEol, toLf } from './eol.js'

export class WorkspaceError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
    /**
     * A machine-readable reason, for the few failures the client must handle
     * differently rather than merely display — today only `file_changed`, whose
     * correct response is to re-read and let the user decide, not to retry.
     *
     * Optional on purpose: unset responses are byte-identical to the ones this
     * route produced before, so adding it changed no existing behaviour.
     */
    readonly code?: string,
  ) {
    super(message)
  }
}

/** Windows and macOS compare paths case-insensitively. */
const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin'

function normalizeForCompare(p: string): string {
  const resolved = path.resolve(p)
  return CASE_INSENSITIVE ? resolved.toLowerCase() : resolved
}

function isInside(child: string, parent: string): boolean {
  const c = normalizeForCompare(child)
  const p = normalizeForCompare(parent)
  if (c === p) return true
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep)
}

/**
 * Resolve `candidate` (absolute, or relative to `root`) and assert it stays
 * inside one of the allowed roots.
 *
 * Resolves symlinks on the part of the path that exists so a symlink inside a
 * root cannot be used to escape it.
 */
export function resolveInside(roots: string[], candidate: string, root?: string): string {
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new WorkspaceError('path is required')
  }
  if (candidate.includes('\0')) {
    throw new WorkspaceError('invalid path')
  }

  const base = root ?? roots[0]
  if (!base) throw new WorkspaceError('no workspace roots configured')

  const absolute = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(base, candidate)

  // Cheap lexical check first — catches `..` traversal.
  if (!roots.some((r) => isInside(absolute, r))) {
    throw new WorkspaceError('path is outside the allowed workspace roots', 403)
  }

  // Then resolve symlinks. `realpath` needs the path to exist; walk up to the
  // nearest existing ancestor and re-append the rest.
  const real = realpathOfNearestExisting(absolute)
  if (!roots.some((r) => isInside(real, realpathOfNearestExisting(r)))) {
    throw new WorkspaceError('path escapes the allowed workspace roots via a link', 403)
  }

  return absolute
}

function realpathOfNearestExisting(target: string): string {
  let current = path.resolve(target)
  const trailing: string[] = []
  for (;;) {
    try {
      const real = realpathSync(current)
      return trailing.length ? path.join(real, ...trailing) : real
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return path.resolve(target) // hit the drive root
      trailing.unshift(path.basename(current))
      current = parent
    }
  }
}

// ------------------------------------------------------------------ reading

export async function listDirectory(
  roots: string[],
  dirPath: string,
  opts: { showHidden?: boolean } = {},
): Promise<FileEntry[]> {
  const dir = resolveInside(roots, dirPath)
  // The encoding has to be explicit: without it @types/node widens the result
  // to Dirent<Buffer> and every `entry.name` becomes a Buffer.
  let entries: Dirent<string>[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true, encoding: 'utf8' })
  } catch (err) {
    throw new WorkspaceError(`cannot read directory: ${(err as Error).message}`, 404)
  }

  const out: FileEntry[] = []
  for (const entry of entries) {
    if (!opts.showHidden && entry.name.startsWith('.')) continue
    // Skip noise that would dominate a phone screen.
    if (entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    let size: number | undefined
    if (entry.isFile()) {
      try {
        size = (await fs.stat(full)).size
      } catch {
        /* races are fine */
      }
    }
    out.push({
      name: entry.name,
      path: full,
      type: entry.isDirectory() ? 'directory' : 'file',
      size,
    })
  }

  out.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return out
}

/** Resolve and verify a directory before handing it to Codex or a shell. */
export async function resolveDirectory(roots: string[], candidate: string): Promise<string> {
  const directory = resolveInside(roots, candidate)
  const stat = await fs.stat(directory).catch(() => null)
  if (!stat?.isDirectory()) throw new WorkspaceError('working directory does not exist or is not a directory', 404)
  return directory
}

const MAX_FILE_BYTES = 512 * 1024

/** Short digest used as `FileContent.rev`; 64 bits is far past what a
 *  concurrent-edit window needs. */
function revisionOf(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16)
}

export async function readFileText(roots: string[], filePath: string): Promise<FileContent> {
  const file = resolveInside(roots, filePath)
  const stat = await fs.stat(file).catch(() => null)
  if (!stat?.isFile()) throw new WorkspaceError('not a file', 404)

  const truncated = stat.size > MAX_FILE_BYTES
  const handle = await fs.open(file, 'r')
  try {
    const length = truncated ? MAX_FILE_BYTES : stat.size
    const buf = Buffer.alloc(length)
    await handle.read(buf, 0, length, 0)
    // Reject obvious binaries rather than shipping garbage to the client.
    if (buf.includes(0)) throw new WorkspaceError('binary file', 415)
    return {
      path: file,
      text: buf.toString('utf8'),
      truncated,
      bytes: stat.size,
      // Omitted for a truncated read: the digest would cover the prefix only,
      // so a save would be compared against something that is not the file.
      // That file cannot be saved anyway (see `writeFileText`).
      ...(truncated ? {} : { rev: revisionOf(buf) }),
    }
  } finally {
    await handle.close()
  }
}

// ------------------------------------------------------------------ writing

/** Counter making each temp file name unique within this process. */
let tempCounter = 0

/**
 * Replace a file's contents, atomically, preserving its line endings.
 *
 * The contract is deliberately narrow: this edits a file that exists. It never
 * creates one (a typo in a path must not litter the repository) and never
 * touches anything the read side would refuse.
 */
export async function writeFileText(
  roots: string[],
  opts: { path: string; text: string; rev?: string },
): Promise<FileContent> {
  const file = resolveInside(roots, opts.path)
  const stat = await fs.stat(file).catch(() => null)
  // A directory, or nothing at all, is a 404 rather than a 400: from the
  // caller's point of view the thing they meant to save does not exist.
  if (!stat?.isFile()) throw new WorkspaceError('not a file', 404)
  // The same ceiling as the read, checked independently rather than assumed
  // from the client. A truncated read cannot be saved at all: the text the
  // phone holds is a prefix, so saving it would delete the file's tail.
  if (stat.size > MAX_FILE_BYTES) {
    throw new WorkspaceError(`file is larger than ${Math.round(MAX_FILE_BYTES / 1024)} KB and cannot be edited`, 413)
  }

  const current = await fs.readFile(file)

  // Optimistic concurrency, and it is not a nicety: an agent is normally
  // editing this same tree. Without the check, one save from a phone that had
  // the file open while the agent worked silently reverts all of it.
  if (opts.rev !== undefined && opts.rev !== revisionOf(current)) {
    throw new WorkspaceError('the file changed on disk since it was opened', 409, 'file_changed')
  }

  // Same two refusals as the read, restated for the write: a file we would not
  // show is not a file we may overwrite with text that came from a textarea.
  if (current.includes(0)) throw new WorkspaceError('binary file', 415)
  const decoded = current.toString('utf8')
  // The one silent encoding failure there is: bytes that are not UTF-8 decode
  // to U+FFFD, so writing anything back — even an untouched line — replaces
  // them permanently. Detected by the round trip rather than by a charset
  // library, and it catches every non-UTF-8 file including most of GBK.
  if (!Buffer.from(decoded, 'utf8').equals(current)) {
    throw new WorkspaceError('file is not UTF-8 and cannot be edited', 415)
  }

  const body = Buffer.from(applyEol(toLf(opts.text), detectEol(current)), 'utf8')

  // Temp file in the SAME directory: `rename` is only atomic within a
  // filesystem, and a temp in the OS directory turns the write into a copy that
  // a crash can leave half-done. The leading dot keeps a crashed run's leftovers
  // out of the file browser, which already hides dotfiles.
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${tempCounter++}.vbtmp`)
  try {
    await fs.writeFile(tmp, body)
    // `rename` carries the inode's place, not its mode: without this a script
    // that was `chmod +x` comes back non-executable. Windows has no such bit,
    // and `stat.mode` there is not something to write back.
    if (process.platform !== 'win32') await fs.chmod(tmp, stat.mode)
    await fs.rename(tmp, file)
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw err
  }

  // Read it back rather than describe what was written: the client rebases its
  // draft on this, so it has to be the bytes that are actually there — after the
  // line-ending restoration, which the client cannot predict.
  return readFileText(roots, file)
}

// --------------------------------------------------------------------- git

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, timeout: 30_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) reject(new WorkspaceError(stderr?.toString().trim() || err.message, 500))
        else resolve(stdout.toString())
      },
    )
  })
}

/** Working-tree diff, staged and unstaged. */
export async function gitDiff(roots: string[], root: string, filePath?: string): Promise<string> {
  const repo = resolveInside(roots, root)
  const args = ['diff', 'HEAD']
  if (filePath) args.push('--', resolveInside(roots, filePath, repo))
  try {
    return await git(args, repo)
  } catch {
    // A repo with no commits yet has no HEAD to diff against.
    const fallback = ['diff']
    if (filePath) fallback.push('--', resolveInside(roots, filePath, repo))
    return git(fallback, repo)
  }
}
