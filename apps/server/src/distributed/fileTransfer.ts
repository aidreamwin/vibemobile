import { Readable } from 'node:stream'
import type { FastifyReply } from 'fastify'
import { byteRange } from '../files/transfer.js'
import type { RunnerTunnel } from './tunnel.js'
import { MAX_BODY, RESPONSE_HEADERS, TRANSFER_HEADERS } from './wire.js'

// Each tunnel response remains bounded. The HTTP stream requests the next
// range only as the browser consumes data, including during video seeking.
export async function relayFileTransfer(
  tunnel: RunnerTunnel,
  path: string,
  range: string | undefined,
  head: boolean,
  reply: FastifyReply,
) {
  const metadata = await tunnel.request('HEAD', path)
  if (metadata.status !== 200) return reply.code(metadata.status).send({ error: 'cannot access file' })
  const size = Number(metadata.headers['content-length'])
  const revision = metadata.headers.etag
  if (!Number.isSafeInteger(size) || size < 0 || !revision) {
    return reply.code(502).send({ error: 'invalid file metadata' })
  }
  for (const name of [...RESPONSE_HEADERS, ...TRANSFER_HEADERS]) {
    if (metadata.headers[name] && name !== 'content-length') reply.header(name, metadata.headers[name])
  }
  const bounds = range ? byteRange(range, size) : null
  if (range && !bounds) return reply.code(416).header('Content-Range', `bytes */${size}`).send()
  const start = bounds?.start ?? 0
  const end = bounds?.end ?? size - 1
  reply.header('Content-Length', end - start + 1)
  if (bounds) reply.code(206).header('Content-Range', `bytes ${start}-${end}/${size}`)
  if (head || size === 0) return reply.send()
  async function* chunks() {
    const chunkSize = Math.min(MAX_BODY, 1024 * 1024)
    for (let offset = start; offset <= end && !reply.raw.destroyed; offset += chunkSize) {
      const last = Math.min(end, offset + chunkSize - 1)
      const response = await tunnel.request('GET', path, undefined, `bytes=${offset}-${last}`)
      const body = Buffer.from(response.body, 'base64')
      if (
        response.status !== 206 ||
        response.headers.etag !== revision ||
        response.headers['content-range'] !== `bytes ${offset}-${last}/${size}` ||
        body.length !== last - offset + 1
      ) {
        throw new Error('file changed or transfer failed')
      }
      yield body
    }
  }
  return reply.send(Readable.from(chunks(), { objectMode: false }))
}
