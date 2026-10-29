/**
 * 这个页面是哪次构建出来的，以及它和服务器那一半是否对得上。
 *
 * 后端也有一份自己的戳（`apps/server/src/buildInfo.ts`），两边的差别是刻意的：
 * 前端 dist 由服务器**从磁盘实时读**，重建即生效；后端 dist 是**进程启动时载入**的，
 * 重建了不重启跑的还是旧的。所以"部署的是不是最新代码"有两个独立答案，设置页
 * 把它们并排显示，再由这里的几个纯函数给出结论。
 */
import type { BuildInfo } from '@vibemobile/protocol'
import { BUILD } from 'virtual:build-info'

/**
 * 这个页面是哪次构建出来的。
 *
 * 由 vite 配置里的虚拟模块注入（见 `apps/web/vite.config.ts` 的 `buildInfoPlugin`），
 * 开发模式下没有构建过程，`builtAt` 为 null —— 设置页据此显示"开发模式"。
 */
export const WEB_BUILD: BuildInfo = BUILD

/** `0.1.0 · 11a3943+未提交`；没有 git 时只有版本号，不编造提交号。 */
export function buildLabel(build: BuildInfo): string {
  if (!build.commit) return build.version
  return `${build.version} · ${build.commit}${build.dirty ? '+未提交' : ''}`
}

/** 构建时间 `09-18 14:02`；没有构建过程（开发模式）时返回 null。 */
export function builtAtLabel(build: BuildInfo): string | null {
  if (build.builtAt === null) return null
  const at = new Date(build.builtAt)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/** 服务端那行的第二行：它启动多久了。"刚重启过"和"跑了一周"是两种处境。 */
export function uptimeLabel(seconds: number | undefined | null): string | null {
  if (seconds === undefined || seconds === null) return null
  if (seconds < 90) return '刚刚启动'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `已运行 ${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `已运行 ${hours} 小时 ${minutes % 60} 分`
  return `已运行 ${Math.floor(hours / 24)} 天 ${hours % 24} 小时`
}

/**
 * 两半的提交号不同 —— 其中一半不是同一次提交构建的。
 *
 * 任一为 null 就不比：Docker 构建里没有 `.git`，null 的意思是"不知道"，把它当成
 * "不同"会在每次容器部署时都报一个假警告。
 */
export function halvesDiverge(web: BuildInfo, server: BuildInfo | null | undefined): boolean {
  if (!web.commit || !server?.commit) return false
  // 同一个提交的两半可能缩写长度不同：release 包的 RELEASE.json 存 12 位，
  // 开发树走 git 默认的 7 位。全等比较会把它们误报成「提交不一致」。
  return !(web.commit.startsWith(server.commit) || server.commit.startsWith(web.commit))
}

/**
 * 磁盘上的后端比进程里的新 —— **重建了但没重启**。
 *
 * 两个戳读的是同一个文件，所以只要 (版本, 提交, 构建时间) 里有一项不同，就说明
 * 这个文件在进程启动之后被换成新的了；不存在"只差一点，不算"的情形，因此这里
 * 逐项比对而不是挑一项。可空性两边一起比，因为"先前没有戳、现在有了"同样意味着
 * 磁盘变过（例如 dist 是手工 `tsc` 出来的，后来才走了一次正经构建）。
 */
export function serverRestartPending(loaded: BuildInfo, onDisk: BuildInfo | null | undefined): boolean {
  if (!onDisk) return false
  return onDisk.version !== loaded.version || onDisk.commit !== loaded.commit || onDisk.builtAt !== loaded.builtAt
}
