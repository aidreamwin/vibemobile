/**
 * vite 注入的模块。
 *
 * `virtual:build-info` 由 `vite.config.ts` 的 `buildInfoPlugin` 提供，导出这一页的
 * 构建戳（字段定义见 `scripts/build-info.mjs`，与 protocol 的 `BuildInfo` 一致）。
 *
 * 用虚拟模块而不是 `define`：`define` 只在 `vite build` 时替换，`vite dev` 下那个
 * 标识符会原样留在代码里（实测），于是开发模式会显示一个假的 "unknown"。
 */
declare module 'virtual:build-info' {
  import type { BuildInfo } from '@vibemobile/protocol'
  export const BUILD: BuildInfo
}
