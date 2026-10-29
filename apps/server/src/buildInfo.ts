/**
 * 这个服务进程跑的是哪一次构建。
 *
 * **读一次就定住** —— 这是整个功能的关键，不是实现细节：后端 `dist` 是进程启动
 * 时载入的，重建 dist 而不重启服务，跑的还是旧代码（README 里那个"新前端 + 旧后端"
 * 静默不一致态）。所以进程里这份戳必须在启动时定格，界面才能把"进程载入的"和
 * "磁盘上躺着的"并排显示，一眼看出"重建了没重启"。若改成每次请求现读磁盘，
 * 这个区分就消失了，字段也就没用了。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BuildInfo } from '@vibemobile/protocol'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** 构建产物里是 `dist/version.json`（`postbuild` 写的）；开发时 HERE 是 src。 */
const STAMP = path.join(HERE, 'version.json')
const IN_DIST = path.basename(HERE) === 'dist'

/**
 * 把 `version.json` 的文本变成可信的戳，形状不对就当没有。
 *
 * 导出是为了单测能直接喂坏数据。它读的是构建产出的文件、不是用户输入，但这条
 * 代码在**启动路径**上 —— 一个坏文件绝不能让服务起不来，所以这里一个字段一个
 * 字段地验，而不是 `as BuildInfo` 了事。
 */
export function parseStamp(raw: string): BuildInfo | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const stamp = parsed as Partial<BuildInfo> | null
  if (!stamp || typeof stamp.version !== 'string') return null
  return {
    version: stamp.version,
    commit: typeof stamp.commit === 'string' && stamp.commit ? stamp.commit : null,
    dirty: stamp.dirty === true,
    builtAt: typeof stamp.builtAt === 'number' ? stamp.builtAt : null,
  }
}

function readStamp(file: string): BuildInfo | null {
  try {
    return parseStamp(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function versionOfPackage(): string {
  try {
    const { version } = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'))
    return typeof version === 'string' && version ? version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * 现场问 git —— 只在开发模式下用。
 *
 * 这里和 `scripts/build-info.mjs` 各有一份读 git 的代码，是**不得已**：那份是
 * 构建期用的，而 `scripts/` 既在 `rootDir: src` 之外、也不进 Docker 的运行阶段，
 * 编译出来的 dist 够不到它。两者只需要在 `commit` 上可比（都是 `rev-parse --short`
 * 的输出），不需要逐字节一致；字段含义若改，两边一起改。
 */
function gitFacts(): { commit: string | null; dirty: boolean } {
  const run = (args: string[]): string | null => {
    try {
      return execFileSync('git', args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      }).trim()
    } catch {
      return null
    }
  }
  // 先问仓库根，再显式 `-C` 回去：`git status --porcelain` 是从 cwd 往下数的，
  // 而这个进程的 cwd 是 apps/server（npm 跑 workspace 脚本时就是如此），
  // 那样只会统计到后端目录下的改动，前端改了没提交就漏掉了。
  const top = run(['rev-parse', '--show-toplevel'])
  if (!top) return { commit: null, dirty: false }
  const commit = run(['-C', top, 'rev-parse', '--short', 'HEAD'])
  const status = run(['-C', top, 'status', '--porcelain'])
  return { commit, dirty: status !== null && status.length > 0 }
}

function stampAtStartup(): BuildInfo {
  const stamped = readStamp(STAMP)
  if (stamped) return stamped

  // 没有戳只有两种情形，必须分开：
  //  - 开发模式（HERE 是 src）：现场读 git 是准的；
  //  - dist 是手工 `tsc` 出来的（`npm run build` 一定会写戳）：这时读 git 可能
  //    读到别的树，不如不读 —— 一个挂不上的提交号比没有提交号更有害。
  const live = IN_DIST ? null : gitFacts()
  return {
    version: versionOfPackage(),
    commit: live?.commit ?? null,
    dirty: live?.dirty ?? false,
    // null 就是"没有构建过程"，界面据此显示开发模式。
    builtAt: null,
  }
}

/**
 * 进程启动时定格的那份戳。**不要**把它做成函数 —— 那会毁掉本文件开头说的区分。
 */
export const build: BuildInfo = stampAtStartup()

/**
 * 磁盘上现在躺着的那份戳：和 `build` 不同就说明"重建了没重启"。
 * 开发模式下没有这个文件，返回 null（界面据此不显示这一行）。
 */
export function buildOnDisk(): BuildInfo | null {
  if (!IN_DIST) return null
  return readStamp(STAMP)
}
