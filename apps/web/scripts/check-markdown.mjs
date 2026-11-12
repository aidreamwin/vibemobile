/** Real browser regression checks for Markdown streaming and Mermaid effects. */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import Markdown from '/src/components/Markdown.tsx';
import '/src/styles.css';
import mermaid from 'mermaid';
window.renderCalls = [];
const original = mermaid.render.bind(mermaid);
mermaid.render = (id, code, ...rest) => {
  window.renderCalls.push({id, code});
  return original(id, code, ...rest);
};
const root = createRoot(document.getElementById('root'));
window.renderMarkdown = text => flushSync(() => root.render(React.createElement(Markdown, {text})));
`

const server = await createServer({
  root: fileURLToPath(new URL('../', import.meta.url)),
  server: { host: '127.0.0.1', port: 5173, strictPort: false, open: false },
  plugins: [
    {
      name: 'markdown-browser-check',
      resolveId(id) {
        if (id === '/__markdown-entry.js') return '\0markdown-browser-entry'
      },
      load(id) {
        if (id === '\0markdown-browser-entry') return entry
      },
      configureServer(vite) {
        vite.middlewares.use('/__markdown-check', async (_req, res) => {
          res.setHeader('Content-Type', 'text/html')
          res.end(
            await vite.transformIndexHtml(
              '/__markdown-check',
              '<html><div id="root"></div><script type="module" src="/__markdown-entry.js"></script></html>',
            ),
          )
        })
      },
    },
  ],
})

let browser
try {
  await server.listen()
  const executablePath = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ].find(existsSync)
  // Other platforms use Playwright's installed Chromium.
  browser = await chromium.launch({ executablePath, headless: true })
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__markdown-check`)
  await page.waitForFunction(() => typeof window.renderMarkdown === 'function')

  const render = (text) => page.evaluate((value) => window.renderMarkdown(value), text)
  const diagram = '```mermaid\ngraph TD\n  A --> B\n```'
  const svg = page.locator('#root svg[id^="vm-mermaid-"]')
  await render(diagram)
  await svg.waitFor()
  const originalId = await svg.getAttribute('id')
  for (let i = 0; i < 8; i++) await render(`${diagram}\n\nAppended text ${i}`)
  assert.equal(await svg.getAttribute('id'), originalId, 'unchanged diagrams must retain their SVG')
  assert.equal(await page.evaluate(() => window.renderCalls.length), 1, 'appending prose must not draw again')

  const source = page.getByRole('button', { name: '源码', exact: true })
  await source.click()
  await render(`${diagram}\n\nMore streamed text`)
  assert.equal(await page.locator('#root pre').count(), 1, 'source mode must survive streaming updates')
  assert.equal(await svg.count(), 0)
  await page.getByRole('button', { name: '图表', exact: true }).click()
  await svg.waitFor()

  const beforeChange = await page.evaluate(() => window.renderCalls.length)
  await render(diagram.replace('A --> B', 'A --> C'))
  await page.waitForFunction(() => {
    const labels = document.querySelector('#root svg[id^="vm-mermaid-"] .nodes')
    return labels?.textContent?.includes('C')
  })
  assert.equal(await page.evaluate(() => window.renderCalls.length), beforeChange + 1, 'changed diagrams must redraw')

  await render('```mermaid\nnot a valid diagram\n```')
  await page.getByText('图表渲染失败', { exact: true }).waitFor()
  await page.getByRole('button', { name: '源码', exact: true }).click()
  assert.equal(await page.locator('#root pre code').textContent(), 'not a valid diagram')
  assert.equal(
    await page.locator('body > div[id^="dvm-mermaid-"]').count(),
    0,
    'parse errors must clean up temporary SVGs',
  )
  await render(diagram)
  await page.getByRole('button', { name: '图表', exact: true }).click()
  await svg.waitFor()

  await render('---\n"title": "Hello"\n标题: 示例\nname: demo\n---\n# Body')
  assert.deepEqual(await page.locator('#root dt').allTextContents(), ['title', '标题', 'name'])
  await render('---\nname: demo\ntags: [broken\n---\n# Body')
  assert.equal(await page.locator('#root pre code').textContent(), 'name: demo\ntags: [broken')
  assert.equal(await page.locator('#root h1').textContent(), 'Body')
  assert.deepEqual(errors, [], 'no uncaught browser errors')
  console.log('PASS: Mermaid streaming, source mode, code updates, error recovery and YAML headers')
} finally {
  await browser?.close()
  await server.close()
}
