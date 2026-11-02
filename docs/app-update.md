# 应用一键升级（PM2）

- 在网页里点「升级」即可更新 VibeMobile 本体；不需要 `npm ci`、构建或重启命令。
- 仅支持 **PM2** 部署（Windows / Linux）。Docker 与 Windows 服务（NSSM）会在设置页显示手动命令。
- 代理运行时（Codex / Claude）的升级见 [agent-runtime.md](agent-runtime.md)，两者独立。

## 工作原理

```text
UI → POST /api/system/update
   → 写 <stateDir>/update-request.json（URL/sha/版本，无 token）
   → 以独立 PM2 进程启动 deploy/self-update.mjs
   → 下载 → sha256 → 解压到临时目录
   → 新包的 deploy/update.mjs：npm ci → 构建 → PM2 切换 → 健康检查 → 失败回滚
   → 阶段写 <stateDir>/update-job.json；新进程启动后据此报告结果
```

更新器是独立 PM2 进程（`<pm2Name>-updater`），不是应用的子进程：`pm2 delete` 会杀掉进程树。

## 首次配置（一次性）

已部署的旧版本没有这个功能，第一次仍需手动升级到包含 `deploy/self-update.mjs` 的版本：

1. 下载并解压新的 hub/runner 包到安装根**之外**。
2. 在 `<install>/vibemobile.env` 增加：

```text
VIBEMOBILE_UPDATE=on
VIBEMOBILE_INSTALL_DIR=<install root>
VIBEMOBILE_UPDATE_API_URL=https://gitlab.example/api/v4
VIBEMOBILE_UPDATE_PROJECT_ID=dyb%2Fvibemobile
VIBEMOBILE_UPDATE_PACKAGE_NAME=vibemobile
VIBEMOBILE_UPDATE_TOKEN=<read_api + read_package_registry>   # 公开项目可留空
# 内网明文 GitLab 才需要：
# VIBEMOBILE_UPDATE_ALLOW_HTTP=1
```

3. `node <extracted>/deploy/update.mjs --target=<install>`
4. 重启后设置页出现「应用升级」；之后就是一键。

`deploy/install.mjs` 也支持 `--update-api-url` / `--update-project-id` / `--update-token-file` / `--update-package-name` / `--update-allow-http`，新装机可直接写入。

## 更新源（GitLab Generic Package Registry）

- `.gitlab-ci.yml` 的 `release_package` job 在默认分支和 tag 上运行 `scripts/release.mjs`，把
  `manifest.json`、`SHA256SUMS`、hub/runner 包上传到
  `<CI_API_V4_URL>/projects/<id>/packages/generic/vibemobile/<version>/`。
- 应用查询最新包（按创建时间），读 `manifest.json`，按角色选 `artifacts.hub` 或 `artifacts.runner`。
- 版本比较：Hub 比 server + web；runner 只比 server（runner 包没有 web 构建）。
- 客户端只能触发，不能传 URL、版本或角色；token 只在服务端环境里。

## 升级期间

| 阶段 | 含义 |
|---|---|
| 下载中 / 校验中 / 解压中 | 拉取并验证发布包 |
| 安装依赖（较慢）/ 构建中 | 在 `releases/<stamp>` 里准备新版本，旧进程继续服务 |
| 正在重启 | PM2 切换并重启；页面会短暂断线 |
| 健康检查 | 新版本 `/api/health`、端口就绪 |
| 已回滚 | 新版本没起来，自动恢复旧 ecosystem |

- Codex 正在跑的回合会随进程重启中断；升级入口有二次确认。
- 升级结果写在 `<stateDir>/update-job.json`，新进程重启后按 `build.version` 对账。
- 日志：`<stateDir>/update-job.log`；设置页的「详情」显示末尾。

## Hub 与 runner

- Hub 根页面（`/`）的按钮更新 Hub 本身；`/r/<id>/` 的按钮更新该 runner。
- Hub 的默认 runner 与 Hub 共用安装目录，标记为 `sharedInstall`：它不单独升级，随 Hub 一起。
- 远程 runner 需要自己的 `vibemobile.env` 与 update token；Hub 不会替它保存凭据。

## 安全

- 所有更新接口要求登录；POST 额外做同源检查（runner 隧道请求没有 Origin，由 service token 保护）。
- 下载包必须匹配 manifest 的 sha256；解压后 `RELEASE.json` 的角色/版本必须匹配；拒绝 `dirty` 包。
- 优先 HTTPS；`VIBEMOBILE_UPDATE_ALLOW_HTTP=1` 只用于可信内网并自行承担风险。
- 信任边界是 GitLab 本身：sha256 防损坏，不防源被攻破。

## 排障

```bash
curl -s http://localhost:3000/api/system/update   # 状态、latest、job、feedError
pm2 describe <pm2Name>                           # 当前 release
pm2 logs <pm2Name>-updater                       # 更新器自身
cat <stateDir>/update-job.log
```

- `update_not_configured`：检查 `VIBEMOBILE_UPDATE_*`。
- `feed_unauthorized`：token 缺 `read_api` / `read_package_registry`。
- `update_via_hub`：这是 Hub 的默认 runner，请升级 Hub。
- 回滚后旧版本仍在 `releases/`；手工兜底用 `data/backups/<stamp>/ecosystem.config.cjs`。
