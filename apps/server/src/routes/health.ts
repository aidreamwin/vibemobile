import type { FastifyInstance } from 'fastify'
import type { HealthResponse } from '@vibemobile/protocol'
import { build, buildOnDisk } from '../buildInfo.js'
import type { Config } from '../config.js'
import { registry } from '../providers/registry.js'
import { terminalAvailability } from '../ws/terminal.js'

export function registerHealthRoutes(app: FastifyInstance, config: Config): void {
  // Unauthenticated on purpose: it exposes no secrets and makes "is the
  // server up?" answerable from a phone browser.
  app.get(
    '/api/health',
    async (): Promise<HealthResponse> => ({
      ok: true,
      uptime: Math.round(process.uptime()),
      // 两个戳的差别就是"重建了但没重启"，见 buildInfo.ts。每次请求现读磁盘的那份
      // 是几千字节的小文件，比这个路由里本来就要做的事（探终端可用性）便宜得多。
      build,
      buildOnDisk: buildOnDisk(),
      providers: registry.list().map((p) => ({
        id: p.id,
        ready: 'ready' in p && typeof p.ready === 'boolean' ? p.ready : null,
      })),
      roots: config.workspaceRoots,
      terminal: await terminalAvailability(config),
    }),
  )

  // Which optional features this deployment actually has. The UI uses it to
  // hide the terminal tab rather than offering a button that always fails.
  app.get('/api/features', async () => {
    const terminal = await terminalAvailability(config)
    return { terminal: terminal.enabled, terminalReason: terminal.reason ?? null }
  })
}
