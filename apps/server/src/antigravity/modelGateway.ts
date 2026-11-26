import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { pipeline } from 'node:stream/promises'
import { EnvHttpProxyAgent, request } from 'undici'
import type { StoredAgentProfile } from '../agents/profiles.js'

export function geminiModelsUrl(baseUrl: string) {
  const base = baseUrl || 'https://generativelanguage.googleapis.com'
  return `${base}${/\/v1(?:beta)?$/.test(base) ? '' : '/v1beta'}/models`
}

export function supplierModels(profile?: StoredAgentProfile) {
  return [...new Set([profile?.model, ...(profile?.models ?? [])].filter((id): id is string => Boolean(id)))]
}

// Stable aliases preserve supplier variants that ACP otherwise canonicalizes.
// agy 1.5.17 also uses the Gemini prefix to recognize vision-capable models.
export function acpModelId(model: string) {
  return `gemini-vm-${createHash('sha256').update(model).digest('hex')}`
}

export async function startModelGateway(profile: StoredAgentProfile, models: string[], generationBlocked = false) {
  const byAcpId = new Map(
    models.flatMap((id) => {
      const alias = acpModelId(id)
      return [
        [alias, id],
        [alias.slice('gemini-'.length), id],
      ] as const
    }),
  )
  const catalog = JSON.stringify({
    models: models.map((id) => ({
      name: `models/${acpModelId(id)}`,
      displayName: id,
      inputTokenLimit: profile.modelContextWindows?.[id],
      supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
    })),
  })
  const token = randomBytes(32).toString('hex')
  const upstream = geminiModelsUrl(profile.baseUrl)
  const dispatcher = new EnvHttpProxyAgent()
  const server = createServer(async (req, res) => {
    if (req.headers['x-goog-api-key'] !== token) {
      res.writeHead(401).end()
      return
    }
    const [pathname, query] = (req.url ?? '').split('?')
    if (req.method === 'GET' && pathname === '/v1beta/models') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(catalog)
      return
    }
    // AGY can start an interrupted turn while authenticating, before ACP has
    // selected the saved model. A recovery client only reconciles native state.
    if (generationBlocked && req.method === 'POST') {
      res.writeHead(400, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          error: { code: 400, status: 'FAILED_PRECONDITION', message: '会话正在恢复，请重新发送消息。' },
        }),
      )
      return
    }
    const match =
      /^\/v1beta\/models\/((?:gemini-)?vm-[a-f0-9]+):(streamGenerateContent|generateContent|countTokens)$/.exec(
        pathname,
      )
    const model = match && byAcpId.get(match[1])
    if (req.method !== 'POST' || !match || !model) {
      res.writeHead(404).end()
      return
    }
    const abort = new AbortController()
    res.on('close', () => abort.abort())
    try {
      const url = new URL(`${upstream}/${encodeURIComponent(model)}:${match[2]}`)
      if (new URLSearchParams(query).get('alt') === 'sse') url.searchParams.set('alt', 'sse')
      const headers: Record<string, string> = { 'content-type': 'application/json', 'x-goog-api-key': profile.apiKey }
      for (const name of ['user-agent', 'x-goog-api-client', 'accept', 'content-encoding', 'content-length']) {
        const value = req.headers[name]
        if (typeof value === 'string') headers[name] = value
      }
      const response = await request(url, {
        method: 'POST',
        headers,
        body: req,
        dispatcher,
        signal: abort.signal,
        maxRedirections: 0,
      })
      for (const name of ['content-type', 'content-encoding', 'retry-after', 'x-request-id']) {
        const value = response.headers[name]
        if (typeof value === 'string') res.setHeader(name, value)
      }
      res.writeHead(response.statusCode)
      await pipeline(response.body, res)
    } catch {
      if (res.headersSent) res.destroy()
      else
        res.writeHead(502, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            error: { code: 502, status: 'UNAVAILABLE', message: '无法连接到配置的 Gemini 供应商。' },
          }),
        )
    }
  })
  server.once('close', () => {
    void dispatcher.destroy()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    byAcpId,
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    headers: { 'x-goog-api-key': token },
    enableGeneration() {
      generationBlocked = false
    },
    close() {
      server.close()
      server.closeAllConnections()
    },
  }
}
