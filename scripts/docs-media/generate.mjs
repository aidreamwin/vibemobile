import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, loadConfigFromFile } from 'vite'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'
import gifenc from 'gifenc'
import { NOW, PROMPT, INTRO, chapters } from './fixtures.mjs'
import { startMock } from './mock.mjs'
import { chapterLayout, overviewLayout, galleryLayout } from './layout.mjs'

const { GIFEncoder, quantize, applyPalette } = gifenc

const repo = fileURLToPath(new URL('../../', import.meta.url))
const output = path.join(repo, 'docs/media')
const serve = process.argv.includes('--serve')
const args = process.argv.slice(2)
if (args.some((arg) => arg !== '--serve')) throw new Error('Usage: npm run docs:media OR npm run docs:demo')
const port = Number(process.env.VIBEMOBILE_DEMO_PORT ?? 0)
assert(Number.isInteger(port) && port >= 0 && port <= 65535, 'VIBEMOBILE_DEMO_PORT must be 0..65535')
const temporary = await mkdtemp(path.join(tmpdir(), 'vibemobile-docs-'))
let mock
let browser
try {
  const { config } = await loadConfigFromFile(
    { command: 'build', mode: 'production' },
    path.join(repo, 'apps/web/vite.config.ts'),
  )
  await build({
    ...config,
    configFile: false,
    envFile: false,
    root: path.join(repo, 'apps/web'),
    logLevel: 'error',
    plugins: [
      ...config.plugins.flat().filter((plugin) => plugin.name !== 'vibemobile:build-info'),
      {
        name: 'docs:fixed-build-info',
        resolveId: (id) => (id === 'virtual:build-info' ? '\0docs:build' : null),
        load: (id) =>
          id === '\0docs:build' ? 'export const BUILD = {version:"demo",commit:null,dirty:false,builtAt:null}' : null,
      },
    ],
    build: { ...config.build, outDir: temporary, emptyOutDir: true },
  })
  mock = await startMock(temporary, { port: serve ? port : 0, manual: !serve })
  if (serve) {
    console.log(`DEMO WORKSPACE — Open ${mock.origin}/r/demo-studio/`)
    console.log(
      'Supported: checkout conversation → send → approve → diff → source; terminal output replay. Ctrl+C stops.',
    )
    await new Promise((resolve) => {
      process.once('SIGINT', resolve)
      process.once('SIGTERM', resolve)
    })
  } else {
    const launch = { headless: true }
    if (process.env.VIBEMOBILE_DEMO_BROWSER) launch.executablePath = process.env.VIBEMOBILE_DEMO_BROWSER
    else if (process.platform === 'win32') launch.channel = 'msedge'
    try {
      browser = await chromium.launch(launch)
    } catch (cause) {
      throw new Error(
        'Browser unavailable. Run npx playwright install chromium; on Windows set VIBEMOBILE_DEMO_BROWSER to its executable if Edge is unavailable.',
        { cause },
      )
    }
    const context = await browser.newContext({
      viewport: { width: 390, height: 760 },
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true,
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      colorScheme: 'dark',
      reducedMotion: 'reduce',
      serviceWorkers: 'block',
    })
    const faults = []
    // Block all destinations except this run's mock, including analytics or
    // remote resources that could be introduced by a later frontend change.
    await context.route('**/*', (route) => {
      if (new URL(route.request().url()).origin === mock.origin) return route.continue()
      faults.push('Unexpected external request')
      return route.abort()
    })
    await context.routeWebSocket('**/*', (route) => {
      const url = new URL(route.url())
      if (url.host === new URL(mock.origin).host) route.connectToServer()
      else {
        faults.push('Unexpected external WebSocket')
        route.close()
      }
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    page.on('pageerror', (error) => faults.push(error.message))
    page.on('console', (msg) => {
      if (msg.type() === 'error') faults.push(msg.text())
    })
    await page.clock.setFixedTime(NOW)
    const layout = await browser.newPage({ viewport: { width: 1000, height: 820 }, deviceScaleFactor: 1 })
    const gif = GIFEncoder()
    const screenshots = new Map()
    const artifacts = []
    const timeline = []
    const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
    const save = async (name, bytes, dimensions = {}) => {
      await writeFile(path.join(output, name), bytes)
      artifacts.push({ file: name, bytes: bytes.length, sha256: hash(bytes), ...dimensions })
    }
    await mkdir(output, { recursive: true })
    const audit = async () => {
      const text = await page.locator('body').innerText()
      assert(
        !/(?:[A-Za-z]:[\\/]|\/Users\/|\/home\/|Administrator|192\.168\.|127\.0\.0\.1|10\.\d+\.\d+\.\d+)/i.test(text),
        'Non-demo machine information in visible UI',
      )
      assert.deepEqual(faults, [], 'Browser errors or external requests')
      assert.deepEqual(mock.faults, [], 'Unexpected API access')
    }
    const frame = async (index, delay, name) => {
      await audit()
      const png = await page.screenshot({ animations: 'disabled', caret: 'hide' })
      if (name) {
        screenshots.set(name, `data:image/png;base64,${png.toString('base64')}`)
        await save(`${name}.png`, png, { width: 390, height: 760 })
      }
      await layout.setContent(chapterLayout(`data:image/png;base64,${png.toString('base64')}`, index))
      await layout.evaluate(() => document.fonts.ready)
      const branded = await layout.screenshot()
      const rgba = PNG.sync.read(branded)
      const palette = quantize(rgba.data, 256)
      gif.writeFrame(applyPalette(rgba.data, palette), rgba.width, rgba.height, { palette, delay, repeat: 0 })
      timeline.push({ chapter: chapters[index].tag, delayMs: delay })
      if (name === 'sessions') await save('workflow-poster.png', branded, { width: 1000, height: 820 })
    }
    const waitPhase = (phase) => assert.equal(mock.phase, phase)
    await page.goto(`${mock.origin}/r/demo-studio/`)
    await page.getByText('为商品搜索补充测试', { exact: true }).waitFor()
    await frame(0, 2400, 'sessions')
    await page.getByRole('button', { name: /修复购物车总价/ }).click()
    await page.getByPlaceholder('给代理下达任务…').fill(PROMPT)
    await frame(1, 900)
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await page.getByPlaceholder('追加指令（输入当前任务）…').waitFor()
    waitPhase('working')
    // Explicit chunks and screenshot barriers keep the story independent of
    // network and agent timing. This is a UI demonstration, not a latency test.
    const chunks = ['问题已定位：', '空购物车没有初始金额。', '接下来修复计算逻辑，', '再运行测试。']
    let rendered = ''
    for (const chunk of chunks) {
      mock.delta(chunk)
      rendered += chunk
      await page.getByText(rendered, { exact: true }).waitFor()
      await frame(1, 650)
    }
    assert.equal(rendered, INTRO)
    await frame(1, 1600, 'streaming')
    mock.approve()
    await page.getByRole('heading', { name: '运行购物车测试', exact: true }).waitFor()
    await frame(2, 3200, 'approval')
    await page.getByRole('button', { name: /允许.*执行这一次/ }).click()
    await page.getByText('已修复空购物车总价。', { exact: false }).waitFor()
    waitPhase('done')
    await frame(3, 2000)
    // Refresh verifies that the mock snapshot restores transcript and diff.
    await page.reload()
    await page.getByRole('button', { name: '查看改动', exact: true }).waitFor()
    await page.getByRole('button', { name: '查看改动', exact: true }).click()
    await page.getByText('+    0,', { exact: true }).waitFor()
    await frame(3, 3200, 'diff')
    await page.getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByRole('link', { name: 'cart.ts', exact: true }).click()
    await page.getByText('export function total(items: CartItem[]) {', { exact: true }).waitFor()
    await frame(4, 2600, 'source')
    await page.getByRole('button', { name: '关闭', exact: true }).click()
    await page.goto(`${mock.origin}/r/demo-studio/terminal`)
    await page.getByText('已接回上次的终端', { exact: true }).waitFor()
    await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent?.includes('3 passed'))
    await frame(5, 2600, 'terminal')
    await page.goto(`${mock.origin}/r/demo-studio/settings`)
    await page.getByText('Agent 配置', { exact: true }).waitFor()
    await page.getByRole('group', { name: '选择 Agent' }).scrollIntoViewIfNeeded()
    await page.getByText('OpenAI 主账号', { exact: true }).waitFor()
    await frame(6, 3000, 'settings')
    gif.finish()
    await save('workflow.gif', Buffer.from(gif.bytes()), { width: 1000, height: 820 })
    await layout.setViewportSize({ width: 1600, height: 1000 })
    await layout.setContent(overviewLayout(['sessions', 'settings'].map((name) => screenshots.get(name))))
    await layout.evaluate(() => document.fonts.ready)
    await save('overview.png', await layout.screenshot(), { width: 1600, height: 1000 })
    await save('index.html', Buffer.from(galleryLayout()))
    await save(
      'manifest.json',
      Buffer.from(
        `${JSON.stringify({ reproducible: true, fixtureSha256: hash(await readFile(new URL('./fixtures.mjs', import.meta.url))), fixedTime: new Date(NOW).toISOString(), viewport: { width: 390, height: 760 }, durationMs: timeline.reduce((sum, f) => sum + f.delayMs, 0), timeline, artifacts }, null, 2)}\n`,
      ),
    )
    await audit()
    console.log(`Generated ${artifacts.length} demo artifacts in docs/media; no external requests, no browser errors.`)
  }
} finally {
  await browser?.close()
  await mock?.close()
  await rm(temporary, { recursive: true, force: true })
}
