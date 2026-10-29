/**
 * Headless browser smoke test.
 *
 * Loads the built SPA the way a phone would, logs in through the real endpoint,
 * walks the main screens, and fails on any uncaught exception or console error.
 * That is the only way to catch React-level breakage — the server can be
 * perfectly healthy while the client throws on first render.
 *
 *   node apps/web/scripts/smoke-browser.mjs <PIN> [--headed]
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'

const BASE = process.env.VIBEMOBILE_URL ?? 'http://127.0.0.1:3000'
const PIN = process.env.VIBEMOBILE_PIN ?? process.argv[2]
const HEADED = process.argv.includes('--headed')
const NO_AGENT = process.argv.includes('--no-agent')
if (!PIN || PIN.startsWith('--')) {
  console.error('usage: node scripts/smoke-browser.mjs <PIN> [--headed]')
  process.exit(2)
}

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

const PORT = 9333
const profile = mkdtempSync(path.join(tmpdir(), 'vibemobile-smoke-'))

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
}

// Guarded, because the two calls at the bottom of this file are not exclusive:
// `finish(1, ...)` schedules its exit but does not stop the module, so the
// success path used to run as well and print "FAIL: 1 problem(s)" immediately
// followed by "PASS". The exit code was then a race between the two timers,
// which is the worst kind of green.
let finishing = false
const finish = (code, message) => {
  if (finishing) return
  finishing = true
  console.log(message)
  cleanup()
  setTimeout(() => process.exit(code), 200)
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

/** Evaluate an expression in the page and return its JSON value. */
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
  // The window never actually gets focus in headless, and keys dispatched to
  // the terminal (step 5) are dropped without this.
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })

  // ---- 1. anonymous visit shows the login screen ----
  await send('Page.navigate', { url: `${BASE}/` })
  await waitFor(`!!document.querySelector('input[inputmode], input[type=password], input')`, 'login form')
  const loginText = await evaluate('document.body.innerText.slice(0, 200)')
  console.log(`  login screen: ${JSON.stringify(loginText.replace(/\s+/g, ' ').slice(0, 80))}`)

  // ---- 2. authenticate through the real endpoint ----
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
  console.log('  logged in')

  // ---- 3. the sessions screen renders after a reload ----
  await send('Page.navigate', { url: `${BASE}/` })
  await waitFor(`document.body.innerText.includes('会话')`, 'sessions screen')
  // The nav bar only renders once the app is past the auth gate.
  await waitFor(`document.body.innerText.includes('设置')`, 'bottom nav')
  const sessionText = await evaluate('document.body.innerText.replace(/\\s+/g, " ").slice(0, 160)')
  console.log(`  sessions screen: ${JSON.stringify(sessionText.slice(0, 90))}`)

  // ---- 4. walk each tab and make sure it renders something ----
  for (const [route, marker] of [
    ['/files', '文件'],
    ['/terminal', 'Ctrl'],
    ['/settings', '访问范围'],
  ]) {
    await send('Page.navigate', { url: `${BASE}${route}` })
    await new Promise((r) => setTimeout(r, 1200))
    const ok = await evaluate(`document.body.innerText.includes(${JSON.stringify(marker)})`)
    if (ok) {
      console.log(`  ${route.padEnd(11)} ok`)
    } else {
      failures.push(`${route} did not render (missing ${JSON.stringify(marker)})`)
      console.log(`  ${route.padEnd(11)} FAILED`)
    }
  }

  // ---- 5. the terminal actually gets a shell, and keeps it ----
  await send('Page.navigate', { url: `${BASE}/terminal` })
  const gotPrompt = await waitFor(
    `!!document.querySelector('.xterm-rows') && document.querySelector('.xterm-rows').innerText.length > 0`,
    'terminal output',
    20_000,
  )
  if (gotPrompt) {
    const termText = await evaluate(
      `document.querySelector('.xterm-rows').innerText.replace(/\\s+/g,' ').trim().slice(0, 60)`,
    )
    console.log(`  terminal rendered: ${JSON.stringify(termText)}`)
  }

  // The shell belongs to the server, not to this page. Run something, leave the
  // tab the way the bottom nav does, come back — and the screen is still there.
  // This is a full page load, so the only thing that can put the marker back on
  // screen is the server's own mirror; a client-side cache cannot do it.
  const termMarker = `VM_PERSIST_${Date.now()}`
  // xterm only accepts a synthetic input event that looks like real typing:
  // `inputType: 'insertText'` and a `data` payload, or `_inputEvent` drops it.
  const typed = await evaluate(`
    (() => {
      const ta = document.querySelector('.xterm-helper-textarea')
      if (!ta) return false
      ta.focus()
      const text = 'echo ${termMarker}'
      ta.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
      return true
    })()
  `)
  if (!typed) {
    failures.push('terminal input element missing')
  } else {
    for (const type of ['keyDown', 'keyUp']) {
      await send('Input.dispatchKeyEvent', {
        type,
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
        ...(type === 'keyDown' ? { text: '\r' } : {}),
      })
    }
  }
  const marked = await waitFor(
    `(document.querySelector('.xterm-rows')?.innerText ?? '').includes(${JSON.stringify(termMarker)})`,
    'the marker to run in the terminal',
    15_000,
  )
  if (marked) console.log(`  terminal ran: ${termMarker}`)

  const terminalStorageKey = `('vibemobile.terminalId' + ((/^\\/r\\/([a-zA-Z0-9_-]+)(?:\\/|$)/.exec(location.pathname)?.[1]) ? '.' + /^\\/r\\/([a-zA-Z0-9_-]+)(?:\\/|$)/.exec(location.pathname)[1] : ''))`
  const idBefore = await evaluate(`sessionStorage.getItem(${terminalStorageKey})`)
  await send('Page.navigate', { url: `${BASE}/` })
  await waitFor(`document.body.innerText.includes('会话')`, 'sessions screen')
  await send('Page.navigate', { url: `${BASE}/terminal` })

  const returned = await waitFor(
    `(document.querySelector('.xterm-rows')?.innerText ?? '').includes(${JSON.stringify(termMarker)})`,
    'the same shell to come back with its screen',
    20_000,
  )
  const idAfter = await evaluate(`sessionStorage.getItem(${terminalStorageKey})`)
  console.log(`  terminal id: ${idBefore} -> ${idAfter}`)
  if (returned && idBefore && idBefore !== idAfter) {
    failures.push(`the terminal id changed across a tab switch (${idBefore} -> ${idAfter})`)
  }

  // ---- 6. the file browser comes back where you left it ----
  // A client-side round trip, not a reload: this is the page's own memory, and
  // a full page load would reset it — so the nav links get clicked.
  const fileState = `(() => {
    const el = document.querySelector('div.scroll-y')
    if (!el) return null
    return {
      top: Math.round(el.scrollTop),
      rows: el.querySelectorAll('ul li').length,
      loading: el.innerText.includes('加载中'),
      head: (document.querySelector('header')?.innerText ?? '').replace(/\\s+/g, ' ').trim(),
    }
  })()`
  // "Back where it was" is the whole assertion, so it is also the wait: there is
  // no fixed delay that is both quick and safe, because the restore runs in a
  // layout effect after the fetch resolves. Comparing all three fields is
  // deliberate — an offset that survives on top of a screen that did not is
  // exactly the bug this step exists for.
  const cameBack = (before) => `(() => {
    const now = ${fileState}
    if (!now || now.loading) return false
    return now.head === ${JSON.stringify(before.head)} &&
      now.rows === ${before.rows} &&
      now.top === ${before.top}
  })()`

  const roundTrip = async (before, label) => {
    await evaluate(`[...document.querySelectorAll('nav a')].find((a) => a.innerText.trim() === '会话').click()`)
    await new Promise((r) => setTimeout(r, 800))
    await evaluate(`[...document.querySelectorAll('nav a')].find((a) => a.innerText.trim() === '文件').click()`)
    await waitFor(cameBack(before), `the ${label} to come back where it was`, 10_000)
    return evaluate(fileState)
  }

  await send('Page.navigate', { url: `${BASE}/files` })
  await waitFor(`((${fileState})?.rows ?? 0) > 0`, 'file listing')
  // As far as this workspace root allows: a root with fewer rows than fit on
  // screen cannot scroll at all, and then there is no position to keep.
  await evaluate(`(() => {
    const el = document.querySelector('div.scroll-y')
    el.scrollTop = Math.max(el.scrollHeight - el.clientHeight, 0)
  })()`)
  await new Promise((r) => setTimeout(r, 300))
  const listBefore = await evaluate(fileState)
  if (listBefore.top === 0) {
    // Printed rather than silently passed: a workspace root whose listing fits
    // on one screen has no position to lose, and this step proves nothing there.
    console.log('  file position: skipped (this workspace root does not scroll)')
  } else {
    const listAfter = await roundTrip(listBefore, 'file list')
    console.log(`  file list scroll: ${listBefore.top} -> ${listAfter?.top}`)
    if (listAfter?.top !== listBefore.top) {
      failures.push(`the file list lost its position across a tab switch (${listBefore.top} -> ${listAfter?.top})`)
    }
  }

  // And the screen itself, not just the offset: open whatever the first row is
  // (the listing sorts directories first) and leave the tab.
  await evaluate(`(() => {
    const el = document.querySelector('div.scroll-y')
    el.scrollTop = 0
    el.querySelector('ul li button').click()
  })()`)
  const opened = await waitFor(
    `((${fileState})?.loading === false) && ((${fileState})?.head ?? '') !== ${JSON.stringify(listBefore.head)}`,
    'a file or directory to open',
  )
  if (opened) {
    const viewBefore = await evaluate(fileState)
    const viewAfter = await roundTrip(viewBefore, 'opened file')
    console.log(`  open view: ${JSON.stringify(viewBefore.head.slice(0, 40))}`)
    if (viewAfter?.head !== viewBefore.head) {
      failures.push(
        `the file browser came back to a different screen (${JSON.stringify(viewBefore.head)} -> ${JSON.stringify(viewAfter?.head)})`,
      )
    }
  }

  if (!NO_AGENT) {
    // ---- 7. create a session from the UI and drive a real turn ----
    // The point of the whole app: type on a phone, watch the agent stream back.
    await send('Page.navigate', { url: `${BASE}/` })
    await waitFor(`document.body.innerText.includes('会话')`, 'sessions screen')

    const openedSheet = await evaluate(`
    (() => {
      const fab = document.querySelector('button[aria-label="新建会话"]')
      if (!fab) return false
      fab.click()
      return true
    })()
  `)
    if (!openedSheet) {
      failures.push('new-session button missing')
    } else if (await waitFor(`document.body.innerText.includes('新建会话')`, 'new session sheet')) {
      // Pick the strictest approval policy so a shell command is guaranteed to
      // need a human. Without this the agent may just answer.
      const choseStrict = await evaluate(`
      (() => {
        const el = [...document.querySelectorAll('button')].find(b => b.textContent.includes('严格'))
        if (!el) return false
        el.click()
        return true
      })()
    `)
      if (!choseStrict) console.log('  (warning: could not select the strict approval policy)')

      // `create()` reads `approvalPolicy` from its render closure, so the 开始
      // button must not be clicked until the click above has re-rendered —
      // otherwise the session is created with the previous policy and no
      // approval is ever requested.
      await new Promise((r) => setTimeout(r, 300))
      const strictSelected = await evaluate(`
      [...document.querySelectorAll('button')].some(b => b.textContent.includes('严格') && b.textContent.includes('✓'))
    `)
      console.log(`  strict policy selected: ${strictSelected}`)

      const started = await evaluate(`
      (() => {
        const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '开始')
        if (!button) return false
        button.click()
        return true
      })()
    `)
      if (!started) {
        failures.push('new-session sheet had no 开始 button')
      } else if (await waitFor(`/^(?:\\/r\\/[^/]+)?\\/chat\\//.test(location.pathname)`, 'chat screen', 25_000)) {
        console.log(`  session created: ${await evaluate('location.pathname')}`)

        // The pathname changes on navigation, before React has rendered the
        // composer — wait for the element itself, not the route.
        await waitFor(`!!document.querySelector('textarea')`, 'composer', 25_000)

        // This session is Codex (the default provider), so its permission menu
        // must carry three rungs and not 自动判断 — that one is Claude's
        // `permissionMode: 'auto'`, which the app-server has no meaning for.
        // `smoke-claude-browser.mjs` asserts the four-item list on the other side.
        await evaluate(`document.querySelector('[aria-label="权限"]')?.click()`)
        await new Promise((r) => setTimeout(r, 400))
        const permissionMenu = await evaluate(
          `[...document.querySelectorAll('[role="option"]')].map((o) => o.textContent.trim())`,
        )
        if (
          Array.isArray(permissionMenu) &&
          permissionMenu.length === 3 &&
          !permissionMenu.some((t) => t.includes('自动判断'))
        ) {
          console.log(`  Codex permission menu: ${permissionMenu.join(' / ')}`)
        } else {
          failures.push(
            `the Codex permission menu should be three cards and no 自动判断 — got ${JSON.stringify(permissionMenu)}`,
          )
        }
        // Escape, not a click: picking an item would change what the turn below
        // sends with.
        await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
        await new Promise((r) => setTimeout(r, 300))

        const marker = `BROWSER_${Date.now()}`
        const typed = await evaluate(`
        (() => {
          const el = document.querySelector('textarea')
          if (!el) return false
          // React tracks its own value; bypass it via the native setter or the
          // input event is ignored as a no-op.
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
          setter.call(el, 'Reply with exactly ${marker}. Do not use any tools.')
          el.dispatchEvent(new Event('input', { bubbles: true }))
          return true
        })()
      `)
        if (!typed) {
          failures.push('composer textarea missing')
        } else {
          await new Promise((r) => setTimeout(r, 250))
          await evaluate(`document.querySelector('button[aria-label="发送"]')?.click()`)

          // Text arrives as deltas, so poll for the marker rather than wait for
          // a single settled render.
          const streamed = await waitFor(
            `document.body.innerText.includes(${JSON.stringify(marker)})`,
            `streamed reply containing ${marker}`,
            90_000,
          )
          if (streamed) {
            console.log(`  agent reply streamed into the DOM`)
            // The stream must also settle: `item.completed` replaces the buffer.
            await waitFor(`!document.querySelector('.caret')`, 'streaming to finish', 60_000)
            console.log('  stream settled')
          }
        }
      }
    }

    // ---- 8. the approval round trip, in the UI ----
    //
    // The composer has to be moved to 只读 before anything is typed, or this
    // section waits forever for a sheet that will never appear.
    //
    // What decides whether the agent asks is the rung on the COMPOSER, not the
    // preset chosen in the new-session sheet — the sheet's choice is superseded
    // from the first message on, because `startTurn` recomputes the mode from
    // these two fields on every turn. This step used to rely on having picked
    // 严格 at creation, which does nothing: the session ran at 按需确认, a plain
    // `echo` was auto-approved, and the wait below timed out on a healthy run.
    //
    // Radix's trigger opens on a plain `.click()` and its items select on one
    // too: its pointer-type guard is seeded to "touch", so a synthetic click
    // takes the touch branch rather than the mouse one that needs a real
    // pointerdown.
    await evaluate(`document.querySelector('[aria-label="权限"]')?.click()`)
    await new Promise((r) => setTimeout(r, 400))
    const readOnlyPicked = await evaluate(`
    (() => {
      const option = [...document.querySelectorAll('[role="option"]')]
        .find((o) => o.textContent.trim().startsWith('只读'))
      if (!option) return false
      option.click()
      return true
    })()
  `)
    await new Promise((r) => setTimeout(r, 400))
    const readOnlyShown = await evaluate(
      `(document.querySelector('[aria-label="权限"]')?.textContent ?? '').includes('只读')`,
    )
    console.log(`  composer permission -> 只读: picked=${readOnlyPicked} shown=${readOnlyShown}`)
    if (!readOnlyShown) {
      failures.push('could not put the composer on 只读 — the approval step below needs it')
    }

    // Wait for the composer to be idle first. Waiting on `.caret` disappearing is
    // not the same thing: if the whole reply arrives inside one frame the caret
    // is never observed, that wait passes instantly, and the message below gets
    // typed while the turn is still running — at which point the send button has
    // been swapped for the stop button and the click does nothing.
    const idle = await waitFor(`!!document.querySelector('button[aria-label="发送"]')`, 'composer idle', 90_000)
    if (!idle) {
      const buttons = await evaluate(`
      [...document.querySelectorAll('button')].map(b => b.getAttribute('aria-label') || b.textContent.trim().slice(0, 24)).join(' | ')
    `)
      console.log(`  composer state at failure: ${buttons}`)
    }

    const approvalMarker = `APPROVAL_${Date.now()}`
    const asked = await evaluate(`
    (() => {
      const el = document.querySelector('textarea')
      if (!el) return false
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      setter.call(el, 'Run this exact shell command and show me its output: echo ${approvalMarker}')
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()
  `)

    if (!asked) {
      failures.push('could not drive the composer for the approval test')
    } else {
      await new Promise((r) => setTimeout(r, 400))
      const clickState = await evaluate(`
      (() => {
        const btn = document.querySelector('button[aria-label="发送"]')
        const el = document.querySelector('textarea')
        if (btn) btn.click()
        return {
          sendButton: !!btn,
          disabled: btn ? btn.disabled : null,
          textareaValue: el ? el.value.slice(0, 60) : null,
        }
      })()
    `)
      console.log(`  send click: ${JSON.stringify(clickState)}`)

      // A click that does nothing and a turn that starts but never asks for
      // approval look identical from outside, so check which one happened: the
      // composer clears on a successful send.
      const sendCleared = await waitFor(
        `(document.querySelector('textarea')?.value ?? 'x').length === 0`,
        'composer to clear after send',
        10_000,
      )
      console.log(`  composer cleared after click: ${sendCleared}`)

      const sheetShown = await waitFor(`document.body.innerText.includes('等待你的授权')`, 'approval sheet', 90_000)
      if (sheetShown) {
        const sheetText = await evaluate(
          `document.body.innerText.replace(/\\s+/g,' ').match(/等待你的授权.{0,120}/)?.[0] ?? ''`,
        )
        console.log(`  approval sheet: ${JSON.stringify(sheetText.slice(0, 100))}`)

        const accepted = await evaluate(`
        (() => {
          const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith('允许'))
          if (!btn) return false
          btn.click()
          return true
        })()
      `)
        if (!accepted) {
          failures.push('approval sheet had no 允许 button')
        } else {
          console.log('  tapped 允许')
          // The sheet must disappear on the server's `approval.resolved`, which
          // only arrives if the answer actually reached the agent.
          const dismissed = await waitFor(
            `!document.body.innerText.includes('等待你的授权')`,
            'sheet dismissal',
            30_000,
          )
          if (!dismissed) {
            // The sheet reports a failed answer inline; surface it rather than
            // leaving the next reader to guess why nothing happened.
            const sheetError = await evaluate(`
            document.body.innerText.replace(/\\s+/g,' ').match(/等待你的授权.{0,200}/)?.[0] ?? ''
          `)
            console.log(`  sheet still open: ${JSON.stringify(sheetError.slice(0, 160))}`)
          }

          // Assert against the transcript, not the DOM: the prompt we sent
          // contains the marker too, so `innerText.includes(marker)` is satisfied
          // by the user's own message and would pass even if nothing ever ran.
          //
          // Poll, because the sheet dismisses as soon as the approval resolves —
          // which is before the command it approved has actually run.
          //
          // The check is "a command completed successfully in this turn", not
          // "its output contains the marker": codex runs the script through
          // stdin (`powershell.exe -NoProfile -`), so the command line need not
          // mention `echo`, and it has been seen to report exitCode 0 with an
          // empty aggregatedOutput even when the command did produce output.
          const readCommand = `
          fetch((/^\\/r\\/[^/]+/.exec(location.pathname)?.[0] ?? '') + '/api/sessions/' + location.pathname.split('/').pop(), { credentials: 'include' })
            .then(r => r.json())
            .then(t => (t.turns ?? []).flatMap(x => x.items ?? []))
            .then(items => {
              const cmd = items.find(i => i.kind === 'command' && i.exitCode === 0)
              return cmd ? { exitCode: cmd.exitCode, output: (cmd.output ?? '').trim().slice(0, 60) } : null
            })
        `
          let ran = null
          const deadline = Date.now() + 90_000
          while (!ran && Date.now() < deadline) {
            ran = await evaluate(readCommand)
            if (!ran) await new Promise((r) => setTimeout(r, 1_000))
          }
          if (ran) {
            console.log(`  approved command completed: ${JSON.stringify(ran)}`)
          } else {
            failures.push('no command completed in the turn after the approval')
          }
        }
      }
    }

    // ---- 9. the session list: a search that filters, and a pin that reorders ----
    //
    // Both are new interactions on a page whose only other coverage is "it
    // rendered", and both fail silently in the same way: a debounced query that
    // never fires leaves a perfectly normal-looking unfiltered list, and a pin
    // that never reaches the row's sort order simply does nothing. This project
    // has no jsdom, so a component test cannot see either — this is the only
    // place they are observed at all.
    await send('Page.navigate', { url: `${BASE}/` })
    await waitFor(`document.body.innerText.includes('会话')`, 'sessions screen')
    await waitFor(`document.querySelectorAll('[data-session-id]').length > 1`, 'session rows', 20_000)

    const rowIds = () =>
      evaluate(`[...document.querySelectorAll('[data-session-id]')].map((el) => el.dataset.sessionId)`)
    /** Open the actions sheet of one row, by id. */
    const openMenu = (id) =>
      evaluate(`
      (() => {
        const row = document.querySelector('li[data-session-id=' + ${JSON.stringify(JSON.stringify(id))} + ']')
        const more = row?.querySelector('[aria-label="更多操作"]')
        if (!more) return false
        more.click()
        return true
      })()
    `)

    // A query that matches nothing, because that is the assertion with no room
    // for a false pass: "the list got shorter" can happen by luck, "the list is
    // empty and says so" cannot.
    await evaluate(`document.querySelector('[aria-label="搜索会话"]')?.click()`)
    await waitFor(`!!document.querySelector('[aria-label="搜索会话标题"]')`, 'the search field')
    const searchTyped = await evaluate(`
    (() => {
      const el = document.querySelector('[aria-label="搜索会话标题"]')
      if (!el) return false
      // React tracks its own value; assigning through the prototype setter is
      // what makes the dispatched event look like real typing to it.
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(el, 'zzzz-no-such-session-zzzz')
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()
  `)
    if (searchTyped) {
      // Past the debounce AND the round trip, which is why the wait is on the
      // outcome rather than on a delay.
      const filtered = await waitFor(
        `document.body.innerText.includes('没有匹配')`,
        'the search to empty the list',
        15_000,
      )
      console.log(`  search narrowed the list to nothing: ${filtered}`)
      if (!filtered) {
        const still = await evaluate(`document.querySelectorAll('[data-session-id]').length`)
        failures.push(`the search box did not filter the list (${still} rows still shown)`)
      }
    } else {
      failures.push('could not type into the search field')
    }

    await evaluate(`document.querySelector('[aria-label="关闭搜索"]')?.click()`)
    const restored = await waitFor(
      `document.querySelectorAll('[data-session-id]').length > 1`,
      'the full list to come back after clearing',
      15_000,
    )
    if (!restored) failures.push('clearing the search did not bring the list back')

    // ---- the pin ----
    // The LAST row, not the first: the order is "recently touched", so pinning
    // the top row would produce the same list and prove nothing.
    const before = await rowIds()
    const pinned = before[before.length - 1]
    if (!(await openMenu(pinned))) failures.push('the last row has no actions button')
    await waitFor(`document.body.innerText.includes('置顶（排在最前）')`, 'the actions sheet')
    await evaluate(
      `[...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('置顶'))?.click()`,
    )
    const movedUp = await waitFor(
      `document.querySelector('[data-session-id]')?.dataset.sessionId === ${JSON.stringify(pinned)}`,
      'the pinned row to jump to the top',
      15_000,
    )
    console.log(`  pinned ${String(pinned).slice(0, 8)} to the top: ${movedUp}`)
    if (!movedUp) failures.push('pinning a row did not move it to the top of the list')

    // Undone, so a run against the deployed service leaves no trace — the pin
    // lives in `sessionPrefs.ts` and nothing else would ever clear it.
    if (movedUp) {
      await openMenu(pinned)
      await waitFor(`document.body.innerText.includes('取消置顶')`, 'the actions sheet for the pinned row')
      await evaluate(
        `[...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('取消置顶'))?.click()`,
      )
      const movedBack = await waitFor(
        `document.querySelector('[data-session-id]')?.dataset.sessionId !== ${JSON.stringify(pinned)}`,
        'unpinning to put the row back',
        15_000,
      )
      console.log(`  unpinned: ${movedBack}`)
      if (!movedBack) failures.push('unpinning did not put the row back where it was')
    }
  } else console.log('  model turns, approval execution and session mutations skipped (--no-agent)')
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
finish(0, 'PASS: browser smoke test ok')
