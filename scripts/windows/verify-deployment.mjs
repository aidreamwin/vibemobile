// Read-only checks: never resume a session or submit work to an agent.
import fs from 'node:fs'
import https from 'node:https'
import path from 'node:path'
import { createRequire } from 'node:module'

const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8').replace(/^\uFEFF/, ''))
const require = createRequire(path.join(config.root, 'package.json'))
const jwt = require('jsonwebtoken')
const state = JSON.parse(fs.readFileSync(path.join(config.stateDir, 'state.json'), 'utf8'))
const cookie = `vibemobile_session=${jwt.sign({ sub: 'owner' }, state.secret, { algorithm: 'HS256', expiresIn: 600 })}`
const ca = fs.readFileSync(config.ca)
const get = (url) =>
  new Promise((resolve, reject) => {
    const request = https.get(`${config.url}${url}`, { ca, headers: { cookie }, timeout: 5000 }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(new Error(`${url}: HTTP ${response.statusCode}`))
        const body = Buffer.concat(chunks).toString()
        try {
          resolve(JSON.parse(body))
        } catch {
          resolve(body)
        }
      })
    })
    request.on('timeout', () => request.destroy(new Error(`${url}: timeout`)))
    request.on('error', reject)
  })

const started = Date.now()
let lastError
do {
  try {
    const hub = await get('/api/hub')
    if (hub.mode !== 'hub') throw new Error('not a Hub')
    const runners = await get('/api/runners')
    for (const id of config.runners) {
      if (!runners.data.some((runner) => runner.id === id && runner.online)) throw new Error(`${id}: offline`)
    }
    for (const [id, version] of Object.entries(config.versions)) {
      const health = await get(`/r/${id}/api/health`)
      if (
        !health.ok ||
        health.build?.version !== version ||
        JSON.stringify(health.build) !== JSON.stringify(health.buildOnDisk)
      )
        throw new Error(`${id}: build mismatch`)
      if (!health.providers.some((provider) => provider.id === 'codex' && provider.ready))
        throw new Error(`${id}: Codex not ready`)
      await get(`/r/${id}/api/sessions?provider=all&limit=1`)
    }
    const html = await get('/')
    if (typeof html !== 'string' || !html.includes('<div id="root">')) throw new Error('SPA missing')
    const asset = /src="([^"]+\.js)"/.exec(html)?.[1]
    if (!asset) throw new Error('SPA script missing')
    await get(asset)
    console.log(
      JSON.stringify({
        ok: true,
        versions: config.versions,
        online: config.runners,
        checkedAt: new Date().toISOString(),
      }),
    )
    process.exit(0)
  } catch (error) {
    lastError = error
  }
  await new Promise((resolve) => setTimeout(resolve, 1000))
} while (Date.now() - started < (config.timeoutMs ?? 90000))
console.error(`Deployment verification failed: ${lastError?.message}`)
process.exit(1)
