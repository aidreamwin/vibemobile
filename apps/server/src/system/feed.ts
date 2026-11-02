import type { UpdateReleaseInfo } from '@vibemobile/protocol'
import type { Config } from '../config.js'

const FEED_TIMEOUT_MS = 10_000
const VERSION_RE = /^\d+\.\d+\.\d+$/
const SHA_RE = /^[a-f0-9]{64}$/
const FILE_RE = /^[A-Za-z0-9._-]+$/

export class FeedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'FeedError'
  }
}

export interface FeedRelease {
  /** Registry package version, used to build artifact URLs. */
  version: string
  createdAt: string | null
  info: UpdateReleaseInfo
  url: string
}

/**
 * GitLab Generic Package Registry client.
 *
 * The registry is the only source of truth: the client never supplies a URL or
 * a version. A manifest is accepted only if every field the updater relies on
 * is well-formed, so a truncated or hand-edited upload fails closed.
 */
export class UpdateFeed {
  #cache?: { at: number; release: FeedRelease }
  #inflight?: Promise<FeedRelease>

  constructor(
    private readonly config: Config,
    private readonly role: 'hub' | 'runner',
  ) {}

  configured(): boolean {
    return this.config.update.enabled && Boolean(this.config.update.apiUrl && this.config.update.projectId)
  }

  async latest(force = false): Promise<FeedRelease> {
    if (!this.configured()) {
      throw new FeedError('update_not_configured', 'update feed is not configured')
    }
    const now = Date.now()
    if (!force && this.#cache && now - this.#cache.at < this.config.update.ttlMs) {
      return this.#cache.release
    }
    if (this.#inflight) return this.#inflight
    this.#inflight = this.#fetchRelease()
      .then((release) => {
        this.#cache = { at: Date.now(), release }
        return release
      })
      .finally(() => {
        this.#inflight = undefined
      })
    return this.#inflight
  }

  async #fetchRelease(): Promise<FeedRelease> {
    const { apiUrl, projectId, packageName, token } = this.config.update
    if (!apiUrl || !projectId) throw new FeedError('update_not_configured', 'update feed is not configured')

    const api = apiUrl.replace(/\/+$/, '')
    if (!this.config.update.allowHttp && !api.startsWith('https://')) {
      throw new FeedError('feed_insecure', 'update feed must use HTTPS unless VIBEMOBILE_UPDATE_ALLOW_HTTP=1')
    }
    // Accept a numeric project id or an already URL-encoded path.
    const project = /^\d+$/.test(projectId) || /%2f/i.test(projectId) ? projectId : encodeURIComponent(projectId)
    const headers: Record<string, string> = token ? { 'PRIVATE-TOKEN': token } : {}

    const listUrl =
      `${api}/projects/${project}/packages?package_type=generic` +
      `&package_name=${encodeURIComponent(packageName)}&order_by=created_at&sort=desc&per_page=1`
    const packages = await this.#json(listUrl, headers)
    if (!Array.isArray(packages) || packages.length === 0) {
      throw new FeedError('feed_empty', 'no packages found in the update feed')
    }
    const first = packages[0] as { version?: unknown; created_at?: unknown }
    const version = typeof first.version === 'string' ? first.version : ''
    if (!version) throw new FeedError('feed_invalid', 'the latest package has no version')
    const createdAt = typeof first.created_at === 'string' ? first.created_at : null

    const base = `${api}/projects/${project}/packages/generic/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`
    const manifest = (await this.#json(`${base}/manifest.json`, headers)) as {
      format?: unknown
      serverVersion?: unknown
      webVersion?: unknown
      commit?: unknown
      dirty?: unknown
      artifacts?: Record<string, { file?: unknown; sha256?: unknown; bytes?: unknown; contents?: unknown }>
    }

    if (!manifest || manifest.format !== 1) throw new FeedError('feed_invalid', 'unsupported manifest format')
    if (manifest.dirty === true) throw new FeedError('feed_dirty', 'the published release is marked dirty')
    if (typeof manifest.serverVersion !== 'string' || !VERSION_RE.test(manifest.serverVersion)) {
      throw new FeedError('feed_invalid', 'manifest serverVersion is invalid')
    }
    if (typeof manifest.webVersion !== 'string' || !VERSION_RE.test(manifest.webVersion)) {
      throw new FeedError('feed_invalid', 'manifest webVersion is invalid')
    }

    const role = this.role
    const artifact = manifest.artifacts?.[role]
    if (!artifact) throw new FeedError('feed_invalid', `manifest has no ${role} artifact`)
    const file = typeof artifact.file === 'string' ? artifact.file : ''
    const sha256 = typeof artifact.sha256 === 'string' ? artifact.sha256 : ''
    const bytes = typeof artifact.bytes === 'number' ? artifact.bytes : 0
    if (!FILE_RE.test(file)) throw new FeedError('feed_invalid', 'artifact file must be a basename')
    if (!SHA_RE.test(sha256)) throw new FeedError('feed_invalid', 'artifact sha256 is invalid')
    if (!Number.isFinite(bytes) || bytes <= 0) throw new FeedError('feed_invalid', 'artifact size is invalid')
    if (artifact.contents !== role) {
      throw new FeedError('feed_invalid', `artifact contents ${String(artifact.contents)} do not match ${role}`)
    }

    return {
      version,
      createdAt,
      url: `${base}/${encodeURIComponent(file)}`,
      info: {
        serverVersion: manifest.serverVersion,
        webVersion: manifest.webVersion,
        commit: typeof manifest.commit === 'string' && manifest.commit ? manifest.commit : null,
        createdAt,
        artifact: { role, file, sha256, bytes },
      },
    }
  }

  async #json(url: string, headers: Record<string, string>): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS)
    try {
      const response = await fetch(url, { headers, signal: controller.signal })
      if (response.status === 401 || response.status === 403) {
        throw new FeedError('feed_unauthorized', 'update feed rejected the token')
      }
      if (!response.ok) throw new FeedError('feed_unreachable', `update feed returned HTTP ${response.status}`)
      return await response.json()
    } catch (error) {
      if (error instanceof FeedError) throw error
      throw new FeedError('feed_unreachable', `update feed is unreachable: ${(error as Error).message}`)
    } finally {
      clearTimeout(timer)
    }
  }
}
