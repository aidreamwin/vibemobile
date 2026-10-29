# 版本与发布

## 两套独立版本号

VibeMobile 的后端和前端各自使用 `package.json` 里的 `version`：

- 后端：`apps/server/package.json`
- 前端：`apps/web/package.json`
- 根 `package.json` 的 `version` 不参与部署判断。

这不是疏漏，而是为了让「只重建了一半」在设置页里一眼可见：`0.1.21 / 0.1.35`
这样的组合本身就说明两半的构建次数不同。

### 什么时候抬版本号

- 只改后端 → 抬高 `apps/server/package.json`，末位 +1。
- 只改前端 → 抬高 `apps/web/package.json`，末位 +1。
- 改了 `packages/protocol` 或两边都改 → 两个都抬。
- 只改文档、注释、测试不算代码变更，不必抬。

构建戳里的提交号和构建时间由构建脚本自动填入；**版本号是唯一靠人的一步**。
不抬号，新构建和上一版在设置页里就分不出来。

## 发布前检查

```bash
npm ci
npm audit --audit-level=low   # 生产依赖和 devDependencies 都应为 0
npm run lint
npm run typecheck
npm test
npm run build:all
```

可选但推荐：

```bash
npm run test:coverage
npm run smoke                 # 已登录 Codex
npx tsx apps/server/scripts/smoke-claude.ts
npm run test:approval
```

涉及前端交互时，按 [CONTRIBUTING.md](../CONTRIBUTING.md) 的说明跑一次浏览器
冒烟。CI 会执行 lint、typecheck、单测和两端构建。

## 打包

```bash
npm run release                       # 全部三类包
npm run release -- --kind=runner      # 只打 runner
npm run release -- --allow-dirty      # 允许未提交改动（不推荐）
npm run release -- --skip-verify      # 跳过测试/构建（不推荐）
```

产物在 `release/`（已 gitignore），包含纯源码和安装脚本；`node_modules`、
`dist` 和所有密钥都不会进入包。目标机执行 `npm ci` 和构建，这样 `node-pty`、
Codex CLI、Claude CLI 都与目标平台匹配。

安装与升级：

```bash
node deploy/install.mjs --role=hub --port=3000 --workspace=/srv/projects --pin=123456
node deploy/update.mjs --target=/opt/vibemobile
```

完整说明见 [pm2-release.md](pm2-release.md) 和 [deploy/README.md](../deploy/README.md)。

## Git 标签

建议的约定：

- 仓库级发布：`v<server版本>-<web版本>`，例如 `v0.1.21-0.1.35`；
- 或者分别打 `server-v0.1.21` / `web-v0.1.35`。

仓库里历史遗留的 `v1.0` 标签早于当前版本方案，不代表当前发布版本。发布时请
在 GitHub Release 说明里写清两个 workspace 的版本号和主要变更，并同步更新
[CHANGELOG.md](../CHANGELOG.md)。

## Codex CLI 升级流程

Codex CLI 在根 `package.json` 中**精确固定**（不带 `^`）。app-server 协议没有
版本协商，跨版本字段可能静默漂移，所以升级必须是一次单独的、可验证的改动：

1. 先获得维护者同意，单独开 PR，不要混在功能改动里。
2. 修改根 `package.json` 的 `@openai/codex` 版本。
3. `npm ci`
4. `npm run gen:codex-types` 重新生成 `packages/protocol/src/generated/`
   （该目录已 gitignore，只作为协议参考）。
5. 在本地 diff 生成产物，逐条核对字段和措辞变化。
6. 跑 `npm run smoke`、`npm run test:approval`、`npx tsx apps/server/scripts/smoke-image.ts`。
7. 更新 [limitations.md](limitations.md) 中任何受影响的“按文案识别”说明。

Dockerfile 从 `package.json` 读取版本，不要另写一份。

## 回滚

- 前端：重新部署上一版 `apps/web/dist` 即可，不需要重启后端。
- 后端：部署上一版 `apps/server/dist` 并重启服务。
- PM2 / 发布包：`deploy/update.mjs` 失败时会自动恢复旧 `dist`；旧版本目录会保留。
- Windows：`scripts/windows/update-service.ps1` 同样保留旧 `dist` 并在健康检查
  失败时恢复。

回滚后确认 `/api/health` 的 `build` 与 `buildOnDisk` 一致，设置页显示的是预期
版本。
