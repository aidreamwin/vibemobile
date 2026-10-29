/**
 * Claude reload-safety smoke test, driven through a real browser.
 *
 * The requirement this exists to prove: **a browser refresh must not affect
 * backend execution.** That is easy to claim and easy to get wrong, because it
 * is not one behaviour but three that have to hold at once —
 *
 *   1. the turn keeps running on the server (nothing is tied to the socket),
 *   2. the reloaded page knows a turn is running, so its stop button works
 *      rather than rendering enabled and doing nothing, and
 *   3. a pending approval is still on screen, because the turn is suspended
 *      inside `canUseTool` waiting for an answer nobody can now give.
 *
 * The other browser script (`smoke-browser.mjs`) covers Codex and the general
 * screens; this one is Claude-specific and asserts the three above by actually
 * reloading the page mid-turn.
 *
 * A fourth phase covers a different bug, for the same reason it has to live
 * here: 完全访问 was not surviving the trip through the UI. The permission the
 * composer sends is the one that takes effect, and the picker used to start on
 * 按需确认 regardless of what the session was created with — so the first
 * message downgraded it and the sheets the user had just opted out of came
 * back. The picker's own label is asserted, because a file write alone would
 * pass even if the user had re-selected the card by hand. That phase also counts
 * the rungs in the picker's menu — four for Claude, 自动判断 among them, the one
 * card no other provider's session is offered.
 *
 *   node apps/web/scripts/smoke-claude-browser.mjs <PIN> [--headed]
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'

const BASE = process.env.VIBEMOBILE_URL ?? 'http://127.0.0.1:3000'
const PIN = process.env.VIBEMOBILE_PIN ?? process.argv[2]
const HEADED = process.argv.includes('--headed')
if (!PIN || PIN.startsWith('--')) {
  console.error('usage: node scripts/smoke-claude-browser.mjs <PIN> [--headed]')
  process.exit(2)
}

/** Where the approval turn is told to write. Deleted at the end. */
const PROBE = path.resolve('vibemobile-reload-probe.txt')
/** Where the 完全访问 turn is told to write. Deleted at the end. */
const OPEN_PROBE = path.resolve('vibemobile-full-access-probe.txt')

const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]
const browserPath = CANDIDATES.find((p) => existsSync(p))
if (!browserPath) {
  console.error('no Edge or Chrome found; skipping browser smoke test')
  process.exit(3)
}

const PORT = 9334
const profile = mkdtempSync(path.join(tmpdir(), 'vibemobile-claude-smoke-'))

const browser = spawn(
  browserPath,
  [
    ...(HEADED ? [] : ['--headless=new']),
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--window-size=390,844', // iPhone 14 Pro logical size
    'about:blank',
  ],
  { stdio: 'ignore' },
)

const failures = []
const consoleErrors = []
let cdp
let seq = 0
const pending = new Map()

const cleanup = () => {
  try {
    cdp?.close()
  } catch {
    /* already closed */
  }
  browser.kill()
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {
    /* windows file locks; harmless */
  }
  try {
    rmSync(PROBE, { force: true })
  } catch {
    /* left behind only if the turn never ran */
  }
}

// Guarded: the two calls at the bottom are not exclusive, so without this the
// success path would print "PASS" right after a failure and the exit code would
// be a race between two timers.
let finishing = false
const finish = (code, message) => {
  if (finishing) return
  finishing = true
  console.log(message)
  cleanup()
  setTimeout(() => process.exit(code), 200)
}

/** Record a pass/fail without throwing, so one broken step does not hide the rest. */
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(name)
}

async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      /* browser still starting */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('browser did not expose a debugging target')
}

function send(method, params = {}) {
  const id = ++seq
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    cdp.send(JSON.stringify({ id, method, params }))
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out`))
    }, 30_000)
  })
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails) {
    throw new Error(`page threw: ${result.exceptionDetails.exception?.description ?? 'unknown'}`)
  }
  return result.result.value
}

async function waitFor(expression, description, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await evaluate(expression)) return true
    } catch {
      /* page may be mid-navigation */
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  failures.push(`timed out waiting for ${description}`)
  return false
}

/** Type into the composer the way React notices — the native setter, not `value =`. */
const typeInto = (text) => `
  (() => {
    const el = document.querySelector('textarea')
    if (!el) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(el, ${JSON.stringify(text)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()
`

const STOP_BUTTON = `!!document.querySelector('button[aria-label="中断当前任务"]')`
const SEND_BUTTON = `!!document.querySelector('button[aria-label="发送"]')`

/**
 * Open the new-session sheet, and do not return until it is really there.
 *
 * Waiting on the text `新建会话` is not enough: that is also the ARIA label of
 * the button that opens it, so the wait passes on the button itself and the
 * next click lands on whatever the list happens to show. `权限范围` is a label
 * only the sheet renders.
 */
async function openNewSessionSheet() {
  for (let i = 0; i < 20; i++) {
    await evaluate(`document.querySelector('button[aria-label="新建会话"]')?.click()`)
    await new Promise((r) => setTimeout(r, 400))
    if (await evaluate(`document.body.innerText.includes('权限范围')`)) return true
  }
  failures.push('timed out waiting for the new-session sheet')
  return false
}

/**
 * One radio card in the new-session sheet, found by its hint line.
 *
 * Scoped by hint rather than by label because `完全访问` is also a composer
 * option and the provider names also appear on session cards — the hints are
 * the only strings unique to this sheet.
 */
const sheetCard = (hint) => `
  [...document.querySelectorAll('button')].find(b => b.textContent.includes(${JSON.stringify(hint)}))
`

/**
 * The provider radio inside the sheet's 代理 field.
 *
 * Scoped to that field because the sheet is an overlay: the session list is
 * still in the DOM behind it, and every Claude session card there carries the
 * provider's name too. An unscoped match clicks the card — navigating into a
 * session and leaving the sheet behind.
 */
const providerOption = (name) => `
  (() => {
    const label = [...document.querySelectorAll('div')].find(
      d => d.children.length === 0 && d.textContent.trim() === '代理'
    )
    const field = label?.parentElement
    if (!field) return null
    return [...field.querySelectorAll('button')].find(b => b.textContent.includes(${JSON.stringify(name)})) ?? null
  })()
`

/** The newest turn as the server sees it — the reloaded page's own view is not evidence. */
const readLiveTurn = `
  fetch('/api/sessions/' + location.pathname.split('/').pop(), { credentials: 'include' })
    .then(r => r.json())
    .then(t => {
      const turns = t.turns ?? []
      const last = turns[turns.length - 1]
      return last
        ? { id: last.id, status: last.status, items: (last.items ?? []).length, turns: turns.length, sessionStatus: t.session?.status }
        : { turns: 0 }
    })
`

const sessionId = () => evaluate(`location.pathname.split('/').pop()`)

try {
  const target = await findTarget()
  cdp = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 })

  await new Promise((resolve, reject) => {
    cdp.once('open', resolve)
    cdp.once('error', reject)
  })

  cdp.on('message', (raw) => {
    const msg = JSON.parse(raw.toString())
    if (msg.id && pending.has(msg.id)) {
      const waiter = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) waiter.reject(new Error(msg.error.message))
      else waiter.resolve(msg.result)
      return
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails
      failures.push(`uncaught: ${d.exception?.description ?? d.text}`)
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      consoleErrors.push(msg.params.entry.text)
    }
  })

  await send('Runtime.enable')
  await send('Log.enable')
  await send('Page.enable')

  // ------------------------------------------------------- 0. authenticate
  await send('Page.navigate', { url: `${BASE}/` })
  await waitFor(`!!document.querySelector('input')`, 'login form')
  const loginResult = await evaluate(`
    fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ pin: ${JSON.stringify(PIN)} })
    }).then(r => r.status)
  `)
  if (loginResult !== 200) {
    finish(1, `FAIL: login returned ${loginResult}`)
  }

  // --------------------------------- 1. create a Claude session from the UI
  console.log('\n=== 1. create a Claude session ===')
  await send('Page.navigate', { url: `${BASE}/` })
  await waitFor(`document.body.innerText.includes('会话')`, 'sessions screen')

  const providerName = await evaluate(`
    fetch('/api/providers', { credentials: 'include' })
      .then(r => r.json())
      .then(p => (p.data.find(x => x.id === 'claude') ?? {}).displayName ?? '')
  `)
  check('the API reports a Claude provider', Boolean(providerName), providerName)

  await evaluate(`document.querySelector('button[aria-label="新建会话"]')?.click()`)
  const sheetOpen = await waitFor(`document.body.innerText.includes('新建会话')`, 'new session sheet')

  // The provider selector is the whole point of this release: before it, the
  // sheet could only ever create the provider hardcoded at the call site.
  const picked = await evaluate(`
    (() => {
      const label = [...document.querySelectorAll('div')].find(
        d => d.children.length === 0 && d.textContent.trim() === '代理'
      )
      const field = label?.parentElement
      if (!field) return 'no 代理 field'
      const option = [...field.querySelectorAll('button')].find(b => b.textContent.includes(${JSON.stringify(providerName)}))
      if (!option) return 'no Claude option'
      option.click()
      return 'clicked'
    })()
  `)
  check('the sheet offers a provider choice', picked === 'clicked', picked)

  if (sheetOpen && picked === 'clicked') {
    // The click above only reaches the session on the NEXT render — `create()`
    // reads its value from the closure it was rendered with.
    await new Promise((r) => setTimeout(r, 300))
    const selected = await evaluate(`
      [...document.querySelectorAll('button')].some(
        b => b.textContent.includes(${JSON.stringify(providerName)}) && b.textContent.includes('✓')
      )
    `)
    check('the Claude option is the selected one', selected)

    await evaluate(`
      [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '开始')?.click()
    `)
    const inChat = await waitFor(`location.pathname.startsWith('/chat/')`, 'chat screen', 25_000)
    check('a session was created and opened', inChat, inChat ? await sessionId() : 'timed out')
    if (!inChat) throw new Error('cannot continue without a session')
  } else {
    throw new Error('cannot continue without the new-session sheet')
  }

  const id = await sessionId()
  const summary = await evaluate(
    `fetch('/api/sessions/${id}', { credentials: 'include' }).then(r => r.json()).then(t => ({ provider: t.session?.provider, cwd: t.session?.cwd }))`,
  )
  check('the new session belongs to Claude', summary.provider === 'claude', summary.provider)

  await waitFor(`!!document.querySelector('textarea')`, 'composer', 25_000)

  // ------------------------------- 2. reload in the middle of a long turn
  console.log('\n=== 2. reload mid-turn ===')
  await evaluate(typeInto(`运行这条 shell 命令，等它跑完再说话：sleep 45`))
  await new Promise((r) => setTimeout(r, 250))
  await evaluate(`document.querySelector('button[aria-label="发送"]')?.click()`)

  const started = await waitFor(STOP_BUTTON, 'the turn to start (stop button)', 30_000)
  check('the turn started', started)

  // Let a couple of items land, so the reload has something to restore.
  await new Promise((r) => setTimeout(r, 6000))
  const before = await evaluate(readLiveTurn)
  check('the server has a running turn before the reload', before.status === 'inProgress', JSON.stringify(before))

  // ---- the reload itself ----
  await send('Page.navigate', { url: `${BASE}/chat/${id}` })
  await waitFor(
    `document.body.innerText.includes('会话') || !!document.querySelector('textarea')`,
    'chat screen after reload',
    25_000,
  )

  const stopBack = await waitFor(STOP_BUTTON, 'the stop button to come back after the reload', 20_000)
  // This is the assertion the `lastTurn` fix in ClaudeProvider exists for. Without
  // it the page lands with `turnId: null`, the Composer still renders a stop
  // button (it keys off `running`, not the id) and the click is a silent no-op.
  check('the reloaded page still offers a stop button', stopBack)

  const after = await evaluate(readLiveTurn)
  check('the turn is still running on the server', after.status === 'inProgress', JSON.stringify(after))
  check('the reload did not lose the turn id', after.id === before.id, `${before.id} -> ${after.id}`)
  check('the reloaded page has the transcript back', after.items > 0, `${after.items} items`)

  const stopWorks = await evaluate(`
    (() => {
      const btn = document.querySelector('button[aria-label="中断当前任务"]')
      if (!btn) return false
      btn.click()
      return true
    })()
  `)
  check('the stop button is clickable', stopWorks)

  if (stopWorks) {
    // A click that does nothing is indistinguishable from a slow interrupt, so
    // wait on the server's own verdict rather than on the button disappearing.
    let stopped = null
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      const t = await evaluate(readLiveTurn)
      if (t.status && t.status !== 'inProgress') {
        stopped = t
        break
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    // If the restored turn id were wrong, the stop would have targeted nothing
    // and the turn would still be inProgress when this deadline passed.
    check(
      'the restored stop button really stopped the turn',
      stopped?.status === 'interrupted',
      stopped ? stopped.status : 'still inProgress',
    )
  }

  // ------------------------- 3. an approval must survive a reload too
  console.log('\n=== 3. pending approval survives a reload ===')
  await waitFor(SEND_BUTTON, 'an idle composer', 60_000)

  await evaluate(typeInto(`在目录 ${summary.cwd} 下创建文件 vibemobile-reload-probe.txt，内容只有一行 hello`))
  await new Promise((r) => setTimeout(r, 250))
  await evaluate(`document.querySelector('button[aria-label="发送"]')?.click()`)

  const sheetShown = await waitFor(`document.body.innerText.includes('等待你的授权')`, 'approval sheet', 90_000)
  check('a write reaches the approval sheet', sheetShown)

  if (sheetShown) {
    // The turn is suspended inside `canUseTool` right now. Reload.
    await send('Page.navigate', { url: `${BASE}/chat/${id}` })
    await waitFor(`!!document.querySelector('textarea')`, 'chat screen after reload', 25_000)

    const stillShown = await waitFor(
      `document.body.innerText.includes('等待你的授权')`,
      'the approval sheet to be replayed after the reload',
      20_000,
    )
    // Without the hub's replay the session is stuck forever: the sheet is gone,
    // nothing can answer the request, and the turn never completes.
    check('the approval sheet is replayed to the reloaded page', stillShown)

    if (stillShown) {
      const accepted = await evaluate(`
        (() => {
          const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith('允许'))
          if (!btn) return false
          btn.click()
          return true
        })()
      `)
      check('the replayed sheet still has an allow button', accepted)

      const dismissed = await waitFor(
        `!document.body.innerText.includes('等待你的授权')`,
        'the sheet to dismiss',
        30_000,
      )
      check('the answer reached the backend', dismissed)

      // The real proof: the file the approval was for exists on disk. Checked
      // from Node, after the browser part, so a passing page cannot fake it.
      let wrote = null
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline && !existsSync(PROBE)) {
        await new Promise((r) => setTimeout(r, 1000))
      }
      if (existsSync(PROBE)) wrote = readFileSync(PROBE, 'utf8').trim()
      check('the approved write actually landed on disk', wrote === 'hello', JSON.stringify(wrote))
    }
  }

  // --------------------- 3b. a question must be answerable, not dismissable
  //
  // Reported from the phone as "claude 确实 askuser 问题": `AskUserQuestion`
  // arrives through the same callback as a permission request, so the sheet
  // offered 允许 / 拒绝 — and allowing it resolved the tool with no answer
  // attached, which the CLI reports to the model as "The user did not answer
  // the questions." A form that merely submits is not the fix; the model naming
  // the option the test tapped is. Nothing weaker distinguishes "the answer got
  // through" from "the tap looked like it worked".
  console.log('\n=== 3b. the agent asks a question and the form answers it ===')
  await waitFor(SEND_BUTTON, 'an idle composer', 60_000)

  await evaluate(
    typeInto(
      '用 AskUserQuestion 工具问我更喜欢哪个颜色。只问一个问题，选项只能有两个，' +
        'label 必须正好是 Red 和 Blue。拿到我的回答后只回复一行：COLOUR=<我选的那个 label>',
    ),
  )
  await new Promise((r) => setTimeout(r, 250))
  await evaluate(`document.querySelector('button[aria-label="发送"]')?.click()`)

  const formShown = await waitFor(`document.body.innerText.includes('等待你的回答')`, 'the question form', 90_000)
  check('a question opens a form rather than a permission sheet', formShown)

  if (formShown) {
    // Matched with `includes`, not `startsWith`: an option row renders its
    // state glyph (○ / ●) before the label, so its text begins with "○". The
    // labels are dumped on failure so a mismatch says what it actually saw
    // rather than just "false" — the difference between "the agent worded the
    // options differently" and "the options did not render" is the whole
    // diagnosis, and this check cannot tell them apart on a bare boolean.
    const shape = await evaluate(`
      (() => {
        const labels = [...document.querySelectorAll('button')].map(b => b.textContent.trim())
        return {
          labels,
          red: labels.some(t => t.includes('Red')),
          blue: labels.some(t => t.includes('Blue')),
          verdict: labels.some(t => t.startsWith('允许')),
          submitDisabled: (() => {
            const s = [...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith('提交'))
            return s ? s.disabled : null
          })(),
        }
      })()
    `)
    check('the form shows the options the agent offered', shape.red && shape.blue, JSON.stringify(shape.labels))
    check('and no verdict button to mistake for an answer', !shape.verdict)
    check('submitting is blocked until something is chosen', shape.submitDisabled === true)

    const tapped = await evaluate(`
      (() => {
        const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Blue'))
        if (!btn) return false
        btn.click()
        return true
      })()
    `)
    check('an option can be tapped', tapped)

    const submitted = await evaluate(`
      (() => {
        const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith('提交'))
        if (!btn) return 'no submit button'
        if (btn.disabled) return 'still disabled after choosing'
        btn.click()
        return true
      })()
    `)
    check('the form submits once a choice is made', submitted === true, String(submitted))

    const dismissed = await waitFor(`!document.body.innerText.includes('等待你的回答')`, 'the form to close', 30_000)
    check('the answer reached the backend', dismissed)

    const replied = await waitFor(
      `document.body.innerText.includes('COLOUR=Blue')`,
      'the model to name the option that was tapped',
      120_000,
    )
    check('the model received the choice instead of a shrug', replied)
  }

  // ------------------------------------- 4. 完全访问 must stay 完全访问
  //
  // The bug this phase exists for, reported from the phone: create a session
  // with 完全访问 and approval sheets keep appearing anyway. Nothing was wrong
  // with the mode mapping — the composer's picker held its own card, started on
  // 按需确认, and had no way to learn the session's, so the FIRST message sent
  // the guarded pair and silently downgraded the session the user had just
  // configured.
  //
  // That is a UI wiring failure, which is exactly the class the provider-level
  // script (`test-claude.ts` phase 3b) cannot see: it drives `startTurn`
  // directly and never renders a picker. So it has to be asserted here, and the
  // picker's own label is the thing to assert — a passing file write alone
  // would also pass if the user had manually re-selected the card.
  console.log('\n=== 4. 完全访问 survives the trip through the UI ===')
  rmSync(OPEN_PROBE, { force: true })

  await send('Page.navigate', { url: `${BASE}/` })
  await waitFor(`!!document.querySelector('button[aria-label="新建会话"]')`, 'sessions screen')
  const sheetUp = await openNewSessionSheet()
  check('the new-session sheet opens', sheetUp)

  // One click per round trip, exactly as phase 1 does it. Clicking the provider
  // and the sandbox card inside a single `evaluate` does not work: the provider
  // click re-renders the sheet, and a node reference taken before that click is
  // stale by the time it is clicked.
  const claudePicked = await evaluate(`
    (() => {
      const btn = ${providerOption(providerName)}
      if (!btn) return 'no Claude option'
      btn.click()
      return 'clicked'
    })()
  `)
  check('the sheet offers a provider choice', claudePicked === 'clicked', claudePicked)
  await new Promise((r) => setTimeout(r, 300))

  const openPicked = await evaluate(`
    (() => {
      const btn = ${sheetCard('不限目录、不限联网')}
      if (!btn) return 'no 完全访问 card'
      btn.click()
      return 'clicked'
    })()
  `)
  check('the sheet offers the 完全访问 card', openPicked === 'clicked', openPicked)

  if (openPicked === 'clicked') {
    // The card is a radio: if it did not register, `create()` sends the sheet's
    // default pair and this whole phase proves nothing.
    await new Promise((r) => setTimeout(r, 300))
    const cardSelected = await evaluate(`
      [...document.querySelectorAll('button')].some(
        b => b.textContent.includes('不限目录、不限联网') && b.textContent.includes('✓')
      )
    `)
    check('the 完全访问 card is the selected one', cardSelected)

    await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '开始')?.click()`)
    const opened = await waitFor(`location.pathname.startsWith('/chat/')`, 'the new chat screen', 25_000)
    check('a 完全访问 session opens', opened)
    if (!opened) throw new Error('cannot continue without the 完全访问 session')

    const openId = await sessionId()
    const reported = await evaluate(
      `fetch('/api/sessions/${openId}', { credentials: 'include' }).then(r => r.json()).then(t => ({ sandbox: t.session?.sandbox, policy: t.session?.approvalPolicy }))`,
    )
    check(
      'the session reports 完全访问',
      reported.sandbox === 'danger-full-access' && reported.policy === 'never',
      `${reported.sandbox}/${reported.policy}`,
    )

    await waitFor(`!!document.querySelector('textarea')`, 'composer', 25_000)
    // The label the user actually reads. If the picker did not seed from the
    // session it says 按需确认 here, and the very next send downgrades.
    const pickerLabel = await evaluate(`document.querySelector('[aria-label="权限"]')?.textContent?.trim() ?? ''`)
    check('the permission picker opens on 完全访问, not the default', pickerLabel.includes('完全访问'), pickerLabel)

    // The menu itself, because the trigger only shows the selected label: a
    // Codex session gets three items and a Claude one four, and 自动判断 must
    // appear only here. A synthetic click opens a Radix Select — its trigger
    // treats a click with no preceding pointerdown as touch, which is the same
    // reason every other `.click()` in this file works.
    await evaluate(`document.querySelector('[aria-label="权限"]')?.click()`)
    await new Promise((r) => setTimeout(r, 400))
    const menu = await evaluate(`[...document.querySelectorAll('[role="option"]')].map((o) => o.textContent.trim())`)
    check(
      'the permission menu offers all four rungs, 自动判断 included',
      Array.isArray(menu) && menu.length === 4 && menu.some((t) => t.includes('自动判断')),
      JSON.stringify(menu),
    )
    // Escape, not a click on an item: picking one would change the very
    // permission this phase is about to send with.
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    await new Promise((r) => setTimeout(r, 300))
    const stillOpen = await evaluate(`document.querySelectorAll('[role="option"]').length`)
    check('and the menu closes without changing the selection', stillOpen === 0, `${stillOpen} options left open`)

    await evaluate(
      typeInto(`在目录 ${summary.cwd ?? ''} 下创建文件 vibemobile-full-access-probe.txt，内容只有一行 open`),
    )
    await new Promise((r) => setTimeout(r, 250))
    await evaluate(`document.querySelector('button[aria-label="发送"]')?.click()`)

    // A sheet would show up while the write is being attempted, so watch the
    // whole turn: no sheet at any point, and the file really lands.
    let sawSheet = false
    let wrote = null
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      if (await evaluate(`document.body.innerText.includes('等待你的授权')`)) sawSheet = true
      if (existsSync(OPEN_PROBE)) {
        wrote = readFileSync(OPEN_PROBE, 'utf8').trim()
        break
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    check('a write under 完全访问 never raises an approval sheet', !sawSheet)
    check('and the write landed on disk anyway', wrote === 'open', JSON.stringify(wrote))

    await evaluate(`fetch('/api/sessions/${openId}', { method: 'DELETE', credentials: 'include' }).then(r => r.status)`)
  }
  rmSync(OPEN_PROBE, { force: true })

  // ------------------------------------------ 5. the usage chip after a turn
  //
  // Both providers have been emitting usage events since the day they were
  // written, and the client's `applyEvent` had no case for them, so the counts
  // went nowhere. The mapping is unit-tested against recorded payloads, but
  // only a real turn proves the four hops together (mapper → hub → store →
  // chip). Both halves of the design are asserted here: nothing is shown before
  // a report — a reloaded page cannot re-derive usage, and a "0" would be a
  // claim — and Claude gets no 本会话累计 row, because it has no such figure
  // and the row would have to be a zero.
  console.log('\n=== 5. the usage chip appears after a turn ===')
  await send('Page.navigate', { url: `${BASE}/chat/${id}` })
  await waitFor(`!!document.querySelector('textarea')`, 'the composer again', 25_000)
  const idleAgain = await waitFor(
    `!document.querySelector('button[aria-label="中断当前任务"]')`,
    'the session to be idle',
    60_000,
  )
  check('the session is idle before the usage turn', idleAgain)
  const chipBefore = await evaluate(`!!document.querySelector('button[aria-label="查看用量"]')`)
  check('and no chip is shown before a turn reports one', !chipBefore)

  await evaluate(typeInto('只回复两个字：收到'))
  await new Promise((r) => setTimeout(r, 250))
  await evaluate(`document.querySelector('button[aria-label="发送"]')?.click()`)

  const chipUp = await waitFor(
    `!!document.querySelector('button[aria-label="查看用量"]')`,
    'the usage chip to appear',
    120_000,
  )
  const chipLabel = chipUp
    ? await evaluate(`document.querySelector('button[aria-label="查看用量"]').textContent.trim()`)
    : 'never appeared'
  check('the chip appears once a turn has reported usage', chipUp, chipLabel)

  if (chipUp) {
    // The window is published by both backends, so the percentage is the one
    // figure that means the same thing on either of them.
    check('the chip counts the prompt against the context window', /%/.test(chipLabel), chipLabel)

    await evaluate(`document.querySelector('button[aria-label="查看用量"]').click()`)
    await new Promise((r) => setTimeout(r, 400))
    const sheet = await evaluate(`document.body.innerText`)
    check('the sheet breaks the count down', sheet.includes('上下文占用') && sheet.includes('其中命中缓存'))
    check('and omits the session total Claude cannot report', !sheet.includes('本会话累计'))
    await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '取消')?.click()`)
  }

  // ------------------------------------- 6. the slash-command menu is the CLI's
  //
  // The list is not ours to invent: it comes from the CLI's own init frame
  // (`slash_commands` minus `terminal_slash_commands`, which the SDK says phone
  // UIs must hide). Which is exactly why it needs a browser check — the chain is
  // four hops long (init frame → `#noteCommands` → `commands.updated` → store →
  // composer), and the unit tests only cover the ends of it.
  //
  // The command to verify is `usage`: `probe-slash.ts` proved the CLI expands it
  // from ordinary prompt text without a model request, so a mis-sent command
  // would be answered instantly and visibly rather than costing a turn.
  console.log('\n=== 6. the command menu comes from the CLI ===')
  await waitFor(SEND_BUTTON, 'an idle composer', 60_000)

  await evaluate(typeInto('/'))
  await new Promise((r) => setTimeout(r, 300))
  // Scoped by shape rather than by position: the rows are the only buttons in
  // the app whose whole label is a slash command.
  const SLASH_ROWS = `[...document.querySelectorAll('button')].map(b => b.textContent.trim()).filter(t => /^\\/[a-z][-a-z0-9]*$/.test(t))`
  const allRows = await evaluate(SLASH_ROWS)
  check(
    "typing a slash opens the CLI's command list",
    Array.isArray(allRows) && allRows.length > 5,
    `${allRows.length} rows: ${allRows.slice(0, 4).join(' ')}`,
  )
  // The three the SDK marks terminal-only must not be here. Asserted by absence
  // rather than by count, because the list grows with every CLI release and a
  // baked-in number would fail for no reason.
  const leaked = ['/doctor', '/color', '/reload-plugins'].filter((c) => allRows.includes(c))
  check('and hides the commands bound to the local terminal', leaked.length === 0, leaked.join(' '))
  check('the menu offers /usage', allRows.includes('/usage'))

  await evaluate(typeInto('/mod'))
  await new Promise((r) => setTimeout(r, 300))
  const filtered = await evaluate(SLASH_ROWS)
  check(
    'typing narrows the list',
    Array.isArray(filtered) && filtered.length > 0 && filtered.every((t) => t.startsWith('/mod')),
    filtered.join(' '),
  )

  if (filtered.length > 0) {
    const picked = await evaluate(`
      [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(filtered[0])})?.click() ?? null
    `)
    await new Promise((r) => setTimeout(r, 300))
    const box = await evaluate(`document.querySelector('textarea').value`)
    // A trailing space and no send: the command takes arguments (`/model opus`),
    // and a tap must not fire an action the user cannot think about first.
    check('tapping a row fills the box instead of sending', box === `${filtered[0]} `, JSON.stringify(box))
    const closed = await evaluate(SLASH_ROWS)
    check('and the menu closes once the command is named', closed.length === 0, closed.join(' '))
  }

  await evaluate(typeInto(''))

  // ------------------------------------------------------------- cleanup
  await evaluate(`fetch('/api/sessions/${id}', { method: 'DELETE', credentials: 'include' }).then(r => r.status)`)
} catch (err) {
  failures.push(`harness error: ${err.message}`)
}

console.log('')
if (consoleErrors.length) {
  console.log(`  console errors (${consoleErrors.length}):`)
  for (const line of consoleErrors.slice(0, 10)) console.log(`    - ${line.slice(0, 200)}`)
}
if (failures.length) {
  console.log('')
  for (const line of failures) console.log(`  ! ${line}`)
  finish(1, `FAIL: ${failures.length} problem(s)`)
}
finish(0, 'PASS: Claude reload-safety smoke test ok')
