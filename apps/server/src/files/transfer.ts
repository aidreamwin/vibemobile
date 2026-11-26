import fs from 'node:fs/promises'
import path from 'node:path'
import type { FastifyReply } from 'fastify'
import { resolveInside, WorkspaceError } from './workspace.js'

const VIDEO_MIMES = new Map([
  ['.mp4', 'video/mp4'],
  ['.m4v', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.ogv', 'video/ogg'],
  ['.ogg', 'video/ogg'],
  ['.mov', 'video/quicktime'],
])

export function isFileTransferPath(value: string): boolean {
  return /^\/api\/files\/(?:download|video)(?:\?|$)/.test(value)
}

export function byteRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim())
  if (!match || size === 0 || (!match[1] && !match[2])) return null
  const first = Number(match[1])
  const last = Number(match[2])
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return null
  if (!match[1]) return last > 0 ? { start: Math.max(0, size - last), end: size - 1 } : null
  const end = match[2] ? Math.min(last, size - 1) : size - 1
  return first < size && first <= end ? { start: first, end } : null
}

export async function sendFileTransfer(
  roots: string[],
  filePath: string,
  video: boolean,
  range: string | undefined,
  head: boolean,
  reply: FastifyReply,
) {
  const file = resolveInside(roots, filePath)
  const mime = video ? VIDEO_MIMES.get(path.extname(file).toLowerCase()) : 'application/octet-stream'
  if (!mime) throw new WorkspaceError('unsupported video format', 415)
  if (!(await fs.stat(file).catch(() => null))?.isFile()) throw new WorkspaceError('not a file', 404)
  const handle = await fs.open(file, 'r').catch(() => null)
  if (!handle) throw new WorkspaceError('not a file', 404)
  let streaming = false
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new WorkspaceError('not a file', 404)
    reply
      .type(mime)
      .header('Accept-Ranges', 'bytes')
      .header('Cache-Control', 'private, max-age=0')
      .header('X-Content-Type-Options', 'nosniff')
      .header('ETag', `"${stat.ino}-${stat.size}-${stat.mtimeMs}"`)
    if (!video) {
      const encoded = encodeURIComponent(path.basename(file)).replace(
        /['()*]/g,
        (character) => '%' + character.charCodeAt(0).toString(16),
      )
      reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encoded}`)
    }
    const bounds = range ? byteRange(range, stat.size) : null
    if (range && !bounds) return reply.header('Content-Range', `bytes */${stat.size}`).code(416).send()
    const length = bounds ? bounds.end - bounds.start + 1 : stat.size
    reply.header('Content-Length', length)
    if (bounds) reply.code(206).header('Content-Range', `bytes ${bounds.start}-${bounds.end}/${stat.size}`)
    if (head || length === 0) return reply.send()
    const stream = handle.createReadStream({ start: bounds?.start ?? 0, end: bounds?.end ?? stat.size - 1 })
    streaming = true
    return reply.send(stream)
  } finally {
    if (!streaming) await handle.close()
  }
}
