# 贡献指南

## English summary

Contributions are welcome. Use Node.js 20+ (22 recommended), run `npm ci`, then
`npm run dev`. Before opening a pull request run `npm run lint`,
`npm run typecheck`, and `npm test`; `npm run build:all` must also succeed.
Never run tests against a deployed service on port 3000 — start an isolated
server or use `npm run dev`, which uses separate ports.

The two apps carry independent versions: bump `apps/server/package.json` when the
backend changes and `apps/web/package.json` when the frontend changes. The Codex
CLI version is pinned deliberately; do not upgrade it in a drive-by change.

## 开始之前

- **Node.js 20 或更高版本**（推荐 22，见 `.nvmrc`），npm，git。
- 需要本机已登录至少一个代理：Codex（`codex login`）或 Claude Code
  （`claude`）。没有登录态也能开发，只是对应会话无法真正执行回合。
- **不要在 3000 端口上的部署服务上做测试。** 如果需要真实服务，用
  `npm run dev`（默认 5800/5802/6800），或者用独立端口和独立状态目录另起
  一套，例如：

  ```bash
  PORT=5900 \
  VIBEMOBILE_STATE_DIR=/tmp/vibemobile-dev-state \
  VIBEMOBILE_ROOTS=/path/to/workspace \
  CODEX_PORT=6900 \
  npx tsx apps/server/src/index.ts
  ```

  不要停止、重启或重建正在 3000 端口运行的部署产物。

## 本地开发

```bash
npm ci
npm run dev            # 后端 5800 · 前端 5802 · app-server 6800
npm run dev:server     # 只起后端
npm run dev:web        # 只起前端
```

端口被占用时整段换掉：

```bash
node scripts/dev.mjs --server-port=5900 --codex-port=6901 --web-port=5902
```

开发模式下后端直接跑源码（tsx），前端由 Vite 热更新；不需要先构建。

## 验证

提交前至少跑：

```bash
npm run lint           # Biome
npm run typecheck      # 前后端 tsc（包含 server 的 scripts/）
npm test               # vitest：server + web
npm run build:all      # 前后端生产构建
```

需要覆盖率时：

```bash
npm run test:coverage  # 两个 workspace 各自输出 coverage/
```

### 集成 / 冒烟脚本

这些脚本会 spawn 真实的 CLI 或需要服务在跑，**不包含在 `npm test` 里**：

| 命令 | 前置条件 |
|---|---|
| `npm run test:approval` | 已登录的 Codex CLI |
| `npm run smoke` | 已登录的 Codex CLI（app-server 协议 go/no-go） |
| `npx tsx apps/server/scripts/smoke-claude.ts` | 已登录的 Claude Code CLI |
| `npx tsx apps/server/scripts/test-claude.ts` | 已登录的 Claude Code CLI（全链路） |
| `npx tsx apps/server/scripts/smoke-image.ts` | 已登录的 Codex CLI |
| `npm run test:hub -- <PIN>` | 服务在跑 |
| `npm run test:terminal -- <PIN>` | 服务在跑 |
| `npm run smoke:browser -- <PIN>` | 服务在跑，且已构建前端；需要无头 Edge |

`smoke:browser` 依赖本机安装的 Edge，所以没有放进 CI；改动前端交互时请手动跑
一次，或按脚本里的注释改用别的浏览器驱动。

## 代码结构

- 架构与关键约束：[docs/architecture.md](docs/architecture.md)
- 面向编码代理的操作手册：[CLAUDE.md](CLAUDE.md)（包含很多“写错了不会报错、
  只会静默出错”的接缝说明）
- 部署：[docs/deployment.md](docs/deployment.md)
- 已知限制：[docs/limitations.md](docs/limitations.md)

改动 provider 相关代码前，务必先读 `apps/server/src/providers/types.ts` 和
`docs/architecture.md` 的 provider 接缝一节。

## 代码风格

- 使用 **Biome** 做格式化和 lint：`npm run format` / `npm run lint`。
- TypeScript `strict` 已开启。**不要用 `@ts-ignore` 或 `as any` 绕过类型问题**；
  协议边界确实需要 `any` 时，加注释说明为什么。
- 注释优先解释“为什么”和“这条约束不写会怎么坏”，而不是复述代码。
- 中文、英文注释都可以；同一个文件里尽量保持一致。
- Windows 脚本有硬约束：`.ps1` 必须带 UTF-8 BOM，`.bat` 必须是纯 ASCII。
- 改动前端交互后，除了单测，尽量跑一次 `smoke:browser` 或对应的浏览器脚本。

## 提交 Pull Request

- 一个 PR 做一件事；把行为变化和纯重构分开。
- 行为变化需要测试。新增纯逻辑优先放成可单测的模块。
- 更新相关文档；如果改了对外契约、命令或部署方式，同步更新 README / docs。
- **改了代码要抬版本号**：
  - 只改后端 → `apps/server/package.json` 的 `version` 末位 +1
  - 只改前端 → `apps/web/package.json` 的 `version` 末位 +1
  - 同时改了 `packages/protocol` 或两边 → 两个都抬
  - 只改文档 / 注释不算
- **不要顺手升级 Codex CLI**。它精确固定在 `0.162.1`，协议没有版本协商；
  升级需要单独评估并重跑 `npm run gen:codex-types`。
- 不要在 PR 里提交 `.vibemobile/`、`certs/`、`release/`、`runner-credentials.json`
  或任何真实凭据。

## 报告安全问题

见 [SECURITY.md](SECURITY.md)。不要在公开 issue 中披露未修复的漏洞。
