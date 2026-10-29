#!/usr/bin/env node
/**
 * 开发模式启动器：同时跑「后端(tsx watch) + 前端(vite dev)」。
 *
 * 为什么需要这个文件，而不是在 package.json 里写一行 `A & B`：
 *
 * 1. npm 在 Windows 上用 **cmd.exe** 执行脚本（即使你是从 git bash 调 npm）。
 *    于是两件事都不成立：
 *      - `PORT=5800 cmd` 这种环境变量前缀是 bash 语法，cmd 会报
 *        「'PORT' 不是内部或外部命令」；
 *      - `A & B` 在 cmd 里是**顺序**执行，不是并行。后端是 `tsx watch`，
 *        永不退出，所以前端永远起不来 —— 原脚本在 Windows 上就是这么坏的。
 *
 * 2. 端口按用途分段，开发和部署彻底分开：
 *
 *      3000 / 8788   部署段（HTTP / codex app-server，常驻，由 Windows 服务持有）
 *      5800 / 5802   开发段（后端 / 前端 Vite）
 *      6800          开发段的 codex app-server
 *      6811 / 6812   一次性测试脚本各自的 app-server
 *
 *    app-server 单独拎到 6800，而不是跟在 5800 后面排 5801：它和 HTTP 是两种
 *    东西，挤在 5800/5801/5802 连号一排时，看日志很难一眼分清哪个是网页、
 *    哪个是 JSON-RPC。分开之后就一句话：3xxx/5xxx 是浏览器访问的 HTTP，
 *    68xx 是 codex app-server。（部署段那个 8788 是历史遗留、没跟着挪 ——
 *    它在另一个段里且离得够远，而挪它要重配并重启正在跑的 Windows 服务。）
 *
 *    这层隔离不是洁癖，是为了让失败**变响亮**。看 supervisor 怎么判断
 *    app-server 就绪的：它 spawn 一个 `codex app-server --listen ws://…:端口`，
 *    然后轮询 `http://…:端口/readyz` —— 这个 fetch 只认端口，不认是谁在应答。
 *    所以开发端口一旦和已部署服务的 app-server（8788）撞上：
 *
 *      - 新起的 app-server 绑定失败、随即退出；
 *      - 但 /readyz 已经被**服务那个** app-server 应答了，supervisor 据此
 *        判定「就绪」，把 WS 客户端接到服务身上。两个后端共用一个 app-server，
 *        会互相抢会话锁。
 *
 *    而且这是个竞态：子进程先死就先抛错（响亮），先应答就静默接上 ——
 *    同一份代码时而报错时而不报，最难查。HTTP 端口撞上同理：Vite 会把 /api
 *    代理到服务的 3000，你看到一个完全正常的界面，背后却是部署的旧构建产物。
 *
 *    分段之后这两条路都不通了：6800 上没有别的东西在听，接不上就是接不上。
 *
 * 用法：
 *   node scripts/dev.mjs              两个都起
 *   node scripts/dev.mjs --only=server
 *   node scripts/dev.mjs --only=web
 *   node scripts/dev.mjs --server-port=5900 --codex-port=5901 --web-port=5902
 */
import { spawn } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/**
 * 命令行参数优先于环境变量。
 * 参数形式在这里很重要：`VAR=x cmd` 只在 bash 里合法，cmd 要用 `set VAR=x`。
 * 给参数就能让提示在两种 shell 里都能直接粘贴执行。
 */
function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : undefined
}

const SERVER_PORT = Number(arg('server-port') ?? process.env.VIBEMOBILE_DEV_PORT ?? 5800)
const CODEX_PORT = Number(arg('codex-port') ?? process.env.VIBEMOBILE_DEV_CODEX_PORT ?? 6800)
const WEB_PORT = Number(arg('web-port') ?? process.env.VIBEMOBILE_DEV_WEB_PORT ?? 5802)

const only = arg('only') ?? ''
const wantServer = only !== 'web'
const wantWeb = only !== 'server'

// 直接跑 JS 入口，不经过 npm。
//
// Node 22+ 拒绝在不带 shell:true 的情况下 spawn .cmd/.bat（CVE-2024-27980
// 的修复，Windows 批处理参数注入），所以 `spawn('npm.cmd', …)` 会抛 EINVAL；
// 而加 shell:true 等于把那个洞请回来。直接调 node + JS 入口两者都避开了，
// 顺带少两个进程，Ctrl+C 时也更容易收干净。
const TSX_CLI = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const VITE_CLI = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')

/**
 * 端口是否已被占用 —— 用「连一下」判断，不用「试绑定」。
 *
 * 试绑定在 Windows 上不可靠，实测（三种监听方式同时被占用）。决定检测结果的是
 * **对方绑在哪个地址**，不是端口号：
 *
 *   对方绑 0.0.0.0（Node 后端）    -> bind 0.0.0.0   得 EADDRINUSE  测得出来
 *                                     bind 127.0.0.1 成功           漏
 *   对方绑 127.0.0.1（app-server） -> bind 127.0.0.1 得 EADDRINUSE  测得出来
 *                                     bind 0.0.0.0   成功           漏
 *   对方绑 0.0.0.0 且开了
 *   SO_REUSEADDR（Vite）          -> 两种 bind 都成功              全漏
 *
 * 两个坑叠在一起：Windows 允许「通配地址已被占用时再绑一个具体地址」
 * （Linux 不允许），而 Windows 的 SO_REUSEADDR 语义是**允许绑定已被占用的
 * 地址**（Linux 上是 TIME_WAIT 复用），Vite 开了它，于是绑得上去。
 *
 * 连接没有这些歧义：连得上就是有人在听。上述两类监听者（0.0.0.0 和
 * 127.0.0.1）都能从 127.0.0.1 连到。
 */
function occupied(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' })
    const done = (v) => {
      s.destroy()
      resolve(v)
    }
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
    // 回环上要么立刻连上要么立刻 RST，不应超时。真超时了宁可误报占用 ——
    // 误报只会挡一下启动，漏报会放进「静默接上别人的 app-server」。
    s.setTimeout(800, () => done(true))
  })
}

/** Windows 上 npm.cmd 会再拉一层进程，只 kill 自己是留不下干净的树的。 */
function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    child.kill('SIGTERM')
  }
}

// --------------------------------------------------------------- 端口预检

const problems = []
if (wantServer) {
  if (await occupied(SERVER_PORT)) {
    problems.push(`端口 ${SERVER_PORT} 已被占用，开发后端起不来。`)
  }
  if (await occupied(CODEX_PORT)) {
    problems.push(
      `端口 ${CODEX_PORT} 已被占用。开发后端不会因此报错 —— supervisor 的 ` +
        `/readyz 探测只认端口不认进程，会被占用者应答，于是它静默接到别人的 ` +
        `app-server 上，两边互相抢会话锁。`,
    )
  }
}
if (wantWeb && (await occupied(WEB_PORT))) {
  problems.push(`端口 ${WEB_PORT} 已被占用，前端起不来。`)
}

if (problems.length) {
  const watched = [...(wantServer ? [SERVER_PORT, CODEX_PORT] : []), ...(wantWeb ? [WEB_PORT] : [])]
  console.error('\n开发模式无法启动：\n')
  for (const p of problems) console.error('  - ' + p)
  console.error('\n谁占着，以及怎么清理（Windows）：')
  console.error(`  netstat -ano | findstr ":${watched.join(' :')}"`)
  console.error('      # 末列是 PID')
  console.error('  taskkill /pid <PID> /T /F')
  console.error('      # /T 连子进程一起，别漏')
  console.error('\n或者整段退到备用端口（这种写法在 bash 和 cmd 里都能直接跑）：')
  console.error('  node scripts/dev.mjs --server-port=5900 --codex-port=6801 --web-port=5902\n')
  process.exit(1)
}

// ------------------------------------------------------------------- 启动

const children = []

function start(label, cwd, args, env) {
  const child = spawn(process.execPath, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  })
  child.on('exit', (code) => {
    // 任何一个挂了就整体退出，避免留下「半套」开发环境让人误判。
    const other = children.find((c) => c !== child)
    if (other) killTree(other)
    // 这里必须显式 exit，不能只设 process.exitCode。
    //
    // 下面注册的 SIGINT/SIGTERM 监听器在 Node 里持有 ref 的 signal handle，
    // 事件循环永远不会空 —— 只设 exitCode 的话这个启动器不会退出，而是变成
    // 一个**不占任何端口、netstat 查不到**的僵尸进程。实测：反复起停几轮就攒了
    // 5 个，而且按端口查残留完全看不见它们。
    process.exit(code ?? 1)
  })
  children.push(child)
  console.log(`  [${label}] 已启动`)
  return child
}

let shuttingDown = false
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (shuttingDown) return
    shuttingDown = true
    for (const c of children) killTree(c)
    process.exit(0)
  })
}

console.log('')
console.log('  VibeMobile 开发模式')
console.log('')
if (wantServer) console.log(`    后端   http://localhost:${SERVER_PORT}   (codex app-server :${CODEX_PORT})`)
if (wantWeb) console.log(`    前端   http://localhost:${WEB_PORT}`)
console.log('')
console.log('  已部署的服务仍在 3000 / 8788 上运行，互不干扰。')
console.log('')

if (wantServer) {
  start('server', path.join(ROOT, 'apps', 'server'), [TSX_CLI, 'watch', 'src/index.ts'], {
    PORT: String(SERVER_PORT),
    CODEX_PORT: String(CODEX_PORT),
  })
}

if (wantWeb) {
  start('web', path.join(ROOT, 'apps', 'web'), [VITE_CLI], {
    VIBEMOBILE_BACKEND: `http://127.0.0.1:${SERVER_PORT}`,
    VIBEMOBILE_DEV_WEB_PORT: String(WEB_PORT),
  })
}
