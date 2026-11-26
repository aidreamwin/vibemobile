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

构建戳里的提交号和构建时间由构建脚本自动填入。维护者按改动范围更新版本号，再创建发布标签，使新旧构建可在设置页区分。

## 发布前检查

```bash
npm ci
npm audit --audit-level=low   # 生产依赖和 devDependencies 都应为 0
npm run lint
npm run typecheck
npm test
npm run test:deploy
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

## GitHub Actions 自动发布

### 首次配置

在 GitHub 仓库的 **Settings → Actions → General → Actions permissions** 中启用 Actions，并允许工作流使用以下 GitHub 官方 Actions。

- `actions/checkout@v4`
- `actions/setup-node@v4`
- `actions/upload-artifact@v4`
- `actions/download-artifact@v4`

可以选择允许 GitHub 创建的 Actions，或将这四项加入许可列表。如果仓库受组织策略限制，在相应层级配置许可。发布作业使用 GitHub 提供的 `github.token`，并在工作流中声明了 `contents: write` 权限。[GitHub Actions 仓库设置](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository)

### 主分支滚动开发版（latest）

每次推送 `main` 时，[CI 工作流](https://github.com/aidreamwin/vibemobile/actions/workflows/ci.yml) 在 lint、类型检查、单测、部署测试和构建通过后打包，`publish-latest` 作业更新标签 `latest` 对应的 GitHub 预发行版。也可在 Actions → CI → Run workflow 选择 `main` 手动重新构建。

- 预发行版包含完整 Hub、Runner、Update 包和两种平台的安装脚本，标签指向该次构建的提交。
- 发布作业串行更新 `latest`，已经落后于主分支的构建会跳过发布。每轮压缩包以提交号和构建 ID 命名，上传新压缩包后再更新安装入口，并保留上一轮的压缩包，方便安装过程中的并发下载。
- 开发版设置为 Pre-release 并显式排除在 GitHub 的 Latest 正式发行版选择之外。正式安装使用 `releases/latest/download/`，开发测试显式使用 `releases/download/latest/`。
- 滚动更新需要 `latest` 标签及其 Release 资产允许修改。启用禁止修改发布资产或移动标签的仓库策略时，滚动更新会被 GitHub 拒绝。[GitHub Release immutability](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)

在 [latest 开发版](https://github.com/aidreamwin/vibemobile/releases/tag/latest) 查看当前主分支快照，通过 [一键安装与升级](quick-install.md) 中的开发版命令安装。

### 发布一个新正式版本

1. 确认前后端版本号、变更记录和发布前检查结果。将提交推送到 `main`，在 [CI](https://github.com/aidreamwin/vibemobile/actions/workflows/ci.yml) 中确认检查通过。
2. 给同一提交创建仓库级版本标签，并推送标签。以服务端 `0.1.62`、前端 `0.1.103` 为例。

   ```bash
   git tag v0.1.62-0.1.103
   git push origin refs/tags/v0.1.62-0.1.103
   ```

3. 在 [Release 工作流](https://github.com/aidreamwin/vibemobile/actions/workflows/release.yml) 中查看进度。`build` 作业执行 lint、类型检查、部署测试、单元测试、构建、打包及校验，`publish` 作业上传发布资产，完成后将 Release 公开并设为 Latest。

已存在的标签可以通过 Actions → Release → Run workflow 手动触发。构建失败或草稿发布中断后可重新运行，已公开的 Release 会直接结束发布步骤。后续版本使用新的标签。

### 发布资产

每个正式版本以及 `latest` 开发版的当前构建均包含以下 9 个资产。`latest` 另保留上一轮的压缩包，当前构建以 `manifest.json` 为准。

| 资产 | 用途 |
| --- | --- |
| `vibemobile-hub-*.tar.gz` | Hub 及 Web、本机 Runner 的完整部署包 |
| `vibemobile-runner-*.tar.gz` | 远程 Runner 的部署包 |
| `vibemobile-update-*.tar.gz` | Hub 手工升级包 |
| `hub-install.sh`、`hub-install.ps1` | Linux/macOS 和 Windows 的 Hub 安装入口 |
| `runner-install.sh`、`runner-install.ps1` | Linux/macOS 和 Windows 的 Runner 安装入口 |
| `manifest.json` | 版本、提交号和资产清单 |
| `SHA256SUMS` | 发布包及安装脚本的 SHA-256 校验和 |

安装脚本内的包下载地址固定到该次发布的压缩包，并校验 SHA-256。全部资产上传成功后，`releases/latest/download/` 下的安装命令指向最新正式发行版，`releases/download/latest/` 下的安装命令指向最新主分支开发版。

### 发布后验收

打开 [最新正式发行版](https://github.com/aidreamwin/vibemobile/releases/latest) 和 [latest 开发版](https://github.com/aidreamwin/vibemobile/releases/tag/latest)，确认相应构建的资产齐全，并检查安装入口。

```sh
curl -LsSf -o /dev/null https://github.com/aidreamwin/vibemobile/releases/latest/download/hub-install.sh
curl -LsSf -o /dev/null https://github.com/aidreamwin/vibemobile/releases/latest/download/runner-install.sh

curl -LsSf -o /dev/null https://github.com/aidreamwin/vibemobile/releases/download/latest/hub-install.sh
curl -LsSf -o /dev/null https://github.com/aidreamwin/vibemobile/releases/download/latest/runner-install.sh
```

在独立测试环境按照 [一键安装与升级](quick-install.md) 完成 Hub 首装并登录，添加远程 Runner 并确认在线。分别重复执行安装命令，验证拒绝升级时保留当前安装，确认升级后服务恢复且配置和状态数据仍可用。

若 Actions 显示 `Startup failure` 并提示 `actions/... are not allowed`，检查上述 Actions 许可配置。若安装地址返回 `404`，确认 Release 已发布且对应安装脚本已上传。

## 本地打包

```bash
npm run release                       # 全部三类包
npm run release -- --kind=runner      # 只打 runner
npm run release -- --allow-dirty      # 允许未提交改动（不推荐）
npm run release -- --skip-verify      # 跳过测试/构建（不推荐）
npm run release -- --release-url=https://github.com/aidreamwin/vibemobile/releases/download/v0.1.62-0.1.103
```

默认生成三类源码压缩包、资产清单和校验和。传入 `--release-url` 后，同时生成指向指定下载目录的四个一键安装脚本。产物位于 `release/`（已加入 `.gitignore`）。

压缩包包含目标机安装与更新所需的项目源码、依赖清单和部署脚本。目标机执行 `npm ci` 和构建，使 `node-pty`、Codex CLI、Claude CLI 与目标平台匹配。`node_modules`、`dist` 和部署密钥在打包时排除。

安装与升级：

```bash
node deploy/install.mjs --role=hub --port=3000 --workspace=/srv/projects --pin=123456
node deploy/update.mjs --target=/opt/vibemobile
```

完整说明见 [pm2-release.md](pm2-release.md) 和 [deploy/README.md](../deploy/README.md)。

## Git 标签

建议使用以下版本标签。

- 仓库级发布使用 `v<server版本>-<web版本>`，例如 `v0.1.21-0.1.35`，推送后触发 Release 工作流。
- `latest` 标签由主分支 CI 自动更新到通过检查的构建提交。
- 单独标记前后端版本可使用 `server-v0.1.21` / `web-v0.1.35`。

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
