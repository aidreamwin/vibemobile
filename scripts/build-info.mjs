/**
 * 构建戳（build stamp）：这次构建到底盖的是哪份代码。
 *
 * **不要给它加 shebang。** `scripts/dev.mjs` 那种 `#!/usr/bin/env node` 在这里会炸：
 * 本文件被 `apps/web/vite.config.ts` import，而 vite 加载配置时是把它当依赖打包的，
 * 且会为每个用到 `import.meta.url` 的模块在这份文本**前面**接一行注入代码（同一行，
 * 不换行）。于是 shebang 不再位于文件第 0 字节，而 `#!` 只有在那儿才合法 —— 报错是
 * `Syntax error "!"`，还指着一个看着完全正常的行。反正本文件只会被 `node scripts/…`
 * 调用，那个 shebang 本来也换不来什么。
 *
 * 为什么需要它：部署里的前后端是**两半**，而且天然不同步 —— 前端 `dist` 是服务
 * 运行时从磁盘实时读的（重建前端立刻生效，不用重启），后端 `dist` 是进程启动时
 * 载入的（重建了不重启，跑的还是旧的）。于是"这次部署到底是不是最新的代码"靠人
 * 看目录、比时间戳是答不上来的（README 里那个"新前端 + 旧后端"的静默不一致态就是
 * 这么发生的）。答案必须由构建自己写下来，再由界面把两半并排摆出来。
 *
 * 一份实现、两个调用方：
 *   1. `apps/server` 的 postbuild → 写出 `dist/version.json`（服务端进程启动时读它）
 *   2. `apps/web/vite.config.ts` 的 `define` → 把戳编进前端 bundle
 * 两处都走这里，是为了让两半的字段含义**不可能**漂移；否则"前端说 A、后端说 B"
 * 时你分不清是代码不同还是格式不同。
 *
 * 没有 `.git` 时（Docker 构建不复制它）一律降级成 null，绝不抛错：这只是个诊断，
 * 不能因为它让构建失败。`commit` 为 null 时界面不比对提交号，只显示版本号和构建时间。
 *
 * 用法：
 *   node scripts/build-info.mjs --out apps/server/dist/version.json
 *   node scripts/build-info.mjs                     # 打到 stdout
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 本文件就在仓库根下的 scripts/，所以仓库根是它上两级。 */
const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/**
 * 版本号取**这一半自己的** package.json（前端取 apps/web，后端取 apps/server），
 * 不取仓库根那个：那是"整个产品"的号，两半各自 bump 的话在界面上就看不出来。
 * 读不到就写 'unknown' —— 宁可显示一个诚实的怪值，也不要凭空造一个 0.0.0。
 */
export function versionFrom(packageJsonPath) {
  try {
    const { version } = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
    return typeof version === 'string' && version ? version : 'unknown'
  } catch {
    return 'unknown'
  }
}

function git(args) {
  try {
    return execFileSync('git', ['-C', REPO, ...args], {
      encoding: 'utf8',
      // stderr 丢掉：不在 git 仓库里时 git 会往 stderr 抱怨，而这是预期情形。
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

/**
 * 发布包里没有 `.git`，而它经常被解压到**另一个 git 仓库内部**（比如 release/
 * 下一个临时目录）。那时 `git -C <包根>` 会一路向上找到外层仓库，把外层仓库的
 * 提交号盖到这次构建上 —— 版本看着正常，实际说的是别人的代码。所以发布脚本写在
 * 包根的 `RELEASE.json` 优先；只有开发树（没有这个文件）才去问 git。
 */
function releaseFacts() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(REPO, 'RELEASE.json'), 'utf8'))
    if (raw && typeof raw.commit === 'string' && raw.commit) return { commit: raw.commit, dirty: raw.dirty === true }
  } catch {
    /* development tree */
  }
  return null
}

/**
 * `git status --porcelain` 是**整仓库**的，不是某个子目录的：构建戳盖的是整棵树，
 * 只统计 apps/server 会漏掉"前端改了没提交"这种情况。
 * `dirty` 在 git 不可用时必须是 false —— 那时候我们不知道，而报"有未提交改动"
 * 是凭空指控（Docker 构建就是这条路径）。
 */
export function gitFacts() {
  const fromRelease = releaseFacts()
  if (fromRelease) return fromRelease
  const commit = git(['rev-parse', '--short', 'HEAD'])
  const status = git(['status', '--porcelain'])
  return { commit, dirty: status !== null && status.length > 0 }
}

/**
 * 一份完整的戳。
 * `builtAt` 由调用方给，因为它取决于"这是不是一次构建"：`vite serve` 下没有构建
 * 这回事，那时传 null（界面据此显示"开发模式"，而不是一个假的构建时间）。
 */
export function buildInfo({ packageJson, builtAt = Date.now() }) {
  return { version: versionFrom(packageJson), ...gitFacts(), builtAt }
}

// ------------------------------------------------------------------- CLI

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--out')
  if (at !== -1 && !process.argv[at + 1]) {
    console.error('build-info: --out 后面要跟一个文件路径')
    process.exit(1)
  }
  const out = at === -1 ? null : path.resolve(process.argv[at + 1])
  // 版本号从产物旁边往上找 package.json：`dist/version.json` → `apps/server/package.json`。
  // 不依赖 npm 注入的环境变量，这样手工 `node scripts/build-info.mjs --out …` 也一样准。
  const pkg = nearestPackageJson(out ? path.dirname(out) : process.cwd())
  if (!pkg) {
    console.error('build-info: 找不到 package.json，版本号无从取起')
    process.exit(1)
  }
  const info = buildInfo({ packageJson: pkg })
  const json = `${JSON.stringify(info, null, 2)}\n`
  if (!out) {
    process.stdout.write(json)
  } else {
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, json)
    console.log(
      `build-info: ${path.relative(REPO, out)} ← ${info.version} ${info.commit ?? '(无 git)'}${info.dirty ? '+未提交' : ''}`,
    )
  }
}

function nearestPackageJson(from) {
  let dir = path.resolve(from)
  for (;;) {
    const candidate = path.join(dir, 'package.json')
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}
