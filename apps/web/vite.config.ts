/// <reference types="node" />
import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { buildInfo } from '../../scripts/build-info.mjs'

/** Where the build stamp is delivered from — see `buildInfoPlugin`. */
const BUILD_INFO_ID = 'virtual:build-info'

/**
 * 构建戳（见 scripts/build-info.mjs）以前端模块的形式注入。
 *
 * **为什么不是 `define`。** `define` 只在 `vite build` 时替换，`vite dev` 下那个标识符
 * 原样留在代码里（实测：dev 吐出来的模块里 `__BUILD_INFO__` 还是它自己），于是开发模式
 * 下页面会显示一个 "unknown" —— 一个**只在开发时出现的假值**，正是最难发现的那种不一致。
 * 虚拟模块在 serve 和 build 下走的是同一条路，开发时也能看到真实版本号。
 *
 * `serve` 下没有构建这回事，所以 `builtAt` 传 null：那时候给一个"构建时间"等于让人以为
 * 手上这页是构建产物，而这个字段存在的意义恰恰是防止这类错觉。
 */
function buildInfoPlugin(builtAt: number | null): Plugin {
  const stamp = {
    ...buildInfo({ packageJson: fileURLToPath(new URL('./package.json', import.meta.url)) }),
    builtAt,
  }
  const resolved = `\0${BUILD_INFO_ID}`
  return {
    name: 'vibemobile:build-info',
    resolveId: (id) => (id === BUILD_INFO_ID ? resolved : null),
    load: (id) => (id === resolved ? `export const BUILD = ${JSON.stringify(stamp)}` : null),
  }
}

// 默认指向开发段的后端（5800），不是已部署服务的 3000。
// 开发后端没起来时宁可连接被拒 —— 指向 3000 会静默代理到已部署的服务，
// 界面一切正常但跑的是部署的旧构建产物。
// 真要对着已部署的服务调前端，显式设 VIBEMOBILE_BACKEND 即可。
const BACKEND = process.env.VIBEMOBILE_BACKEND ?? 'http://127.0.0.1:5800'

export default defineConfig(({ command }) => ({
  plugins: [react(), tailwindcss(), buildInfoPlugin(command === 'build' ? Date.now() : null)],
  server: {
    // host:true binds 0.0.0.0 so a phone on the same WiFi can reach the dev server.
    host: true,
    // 5802 属于开发段（见 scripts/dev.mjs 顶部的端口分配表）。
    // 默认值只在绕过 dev.mjs 直接跑 vite 时生效；可覆盖，方便开第二份。
    port: Number(process.env.VIBEMOBILE_DEV_WEB_PORT ?? 5802),
    // 端口被占就报错退出，不要自动 +1。
    // 默认行为会悄悄换到 5803 并打印出来，而 dev.mjs 横幅上写的仍是 5802，
    // 两个地址对不上。更糟的是实测过：Vite 占着 5802 时，另一个 Node 监听器
    // 仍能绑上同一地址（Windows 的 SO_REUSEADDR 语义允许绑定已占用的地址），
    // 于是两个进程抢同一个端口，谁收到连接是不确定的。
    strictPort: true,
    proxy: {
      '/api': { target: BACKEND, changeOrigin: true },
      '/ws': { target: BACKEND, ws: true, changeOrigin: true },
      '/r': {
        target: BACKEND,
        ws: true,
        changeOrigin: true,
        bypass: (req) => (/^\/r\/[^/]+\/(api|ws)(\/|\?|$)/.test(req.url ?? '') ? undefined : req.url),
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // Phones on a LAN parse these; keep the bundle lean. 500 kB catches a
    // page or dependency that has crept back into the initial chunk; the
    // largest chunk after splitting is ~300 kB (entry).
    chunkSizeWarningLimit: 500,
    rollupOptions: {
      output: {
        // Route-level lazy imports already split the pages; this keeps the
        // shared vendor code cacheable instead of duplicating it per page.
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom', 'zustand'],
          'vendor-radix': ['radix-ui'],
          'vendor-markdown': ['react-markdown', 'remark-gfm'],
          'vendor-xterm': ['@xterm/xterm', '@xterm/addon-fit'],
        },
      },
    },
  },
  test: {
    // Vitest 4 no longer excludes build output by default.
    exclude: [...configDefaults.exclude, '**/dist/**', '**/coverage/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}'],
    },
  },
}))
