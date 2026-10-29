<p align="center">
  <img src="apps/web/public/icon-192.png" width="96" alt="VibeMobile" />
</p>

# VibeMobile

在手机浏览器里远程驱动本机的编码代理。目前支持 **Codex** 和 **Claude Code**
两个后端，提供流式对话、审批弹窗、文件 Diff / 查看 / 编辑、直连终端和图片输入。

> **安全提示：VibeMobile 是单用户工具。** 登录后即可在宿主机上执行任意命令；
> 「完全访问」档等同于无人值守。**不要直接暴露到公网** —— 需要公网访问时，请
> 在前面使用 HTTPS 反向代理或安全隧道，并先阅读 [SECURITY.md](SECURITY.md)。

## English

VibeMobile is a mobile web remote control for coding agents running on your own
machine. It supports **Codex** and **Claude Code** with streaming output,
approval sheets, file diffs, a persistent terminal, and image input.

The Node backend is not optional: `codex app-server` rejects WebSocket upgrades
that carry an `Origin` header, and browsers always send one, so the backend acts
as the WS client.

Quick start:

```bash
npm ci
npm run dev            # backend 5800 · web 5802 · app-server 6800
```

Production:

```bash
npm ci
npm run build:all      # builds web AND server
npm start              # 0.0.0.0:3000
```

**Security:** this is a single-user tool that can run arbitrary commands. Never
expose it directly to the internet. See [SECURITY.md](SECURITY.md) and the
[deployment guide](docs/deployment.md). Contributions are welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md). Licensed under MIT.

## 功能

- **两个代理后端**：Codex（app-server JSON-RPC）和 Claude Code（Agent SDK），
  前端只消费归一化事件。
- **流式输出**：逐 token 增量、推理过程、工具调用、计划（todo）和用量。
- **审批**：命令 / 文件修改 / 权限请求以弹窗呈现；Claude 的
  `AskUserQuestion` 渲染成完整表单。
- **会话**：搜索、置顶、归档、重命名、删除、fork；刷新页面不影响后端执行。
- **文件**：查看代理引用到的文件、源码行号 / Markdown 预览、Diff、编辑保存
  （带乐观并发保护）。
- **终端**：直连 PTY，断开重连后仍是同一个 shell 和同一块屏幕。
- **图片**：手机相册 / 拍照输入，内容寻址落盘，转写里只传 token。
- **多机器**：Hub + 多个 runner，runner 主动连接、无需开放入站端口。
- **PWA**：可添加到主屏幕，独立窗口运行。

## 架构

```text
手机浏览器 ──HTTP/WS(局域网)──► Node 后端 ──WS(127.0.0.1)──► codex app-server
   React PWA      PIN → JWT       Fastify      JSON-RPC 客户端    （由后端 spawn 托管）
                                    ├── Claude Agent SDK（每回合一个子进程）
                                    └── node-pty（终端直连）
```

**为什么必须由后端代理**：`codex app-server` 会拒绝任何带 `Origin` 头的 WS
升级请求，而浏览器发起的 WS 一定带 `Origin`。所以浏览器无法直连 app-server，
必须由 Node 后端充当 WS 客户端。这是约束，不是取舍。

**Provider 接缝**：`apps/server/src/providers/types.ts` 的 `AgentProvider` 是唯一
抽象；`routes/` 与 `ws/hub.ts` 完全 provider-agnostic。增加一个 provider =
实现接口 + 在 `apps/server/src/index.ts` 里 `registry.register()`。

两个后端的会话模型不同（常驻进程 vs 每回合一个子进程；续接方式；插话方式；
元数据存储），详见 [docs/architecture.md](docs/architecture.md)。影响正确性的
接缝和“改错不会报错、只会静默出错”的约束集中在 [CLAUDE.md](CLAUDE.md)。

## 快速开始

要求 **Node.js 20+**（推荐 22），npm，以及至少一个已登录的代理 CLI。

### 开发

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

开发模式后端直接跑源码（tsx），前端由 Vite 热更新，不需要先构建。

### 生产

```bash
npm ci
npm run build:all      # 注意：只跑 npm run build 只会构建前端
npm start              # 默认 0.0.0.0:3000
```

首次启动会自动生成 16 位强密码（大小写字母、数字与符号）作为 PIN 并打印在日志里。想固定 PIN 就设置
`VIBEMOBILE_PIN`。手机连同一个网络，打开日志里的局域网地址即可。

### Docker

```bash
cp .env.example .env
docker compose up -d --build
docker compose logs -f
```

### Windows 服务 / PM2 / 多机器

完整步骤和验证判据见 [docs/deployment.md](docs/deployment.md)：

- Windows：`scripts\windows\install-service.bat`
- Linux/macOS：`npm run release` + `deploy/install.mjs`
- 多机器：[docs/multi-runner.md](docs/multi-runner.md)

## 验证

```bash
npm run lint           # Biome
npm run typecheck      # 前后端 tsc（server 的 scripts/ 也包含在内）
npm test               # vitest：server + web
npm run test:coverage  # 覆盖率报告
npm run build:all      # 两端生产构建
```

单元测试覆盖映射、权限、分页、转写读取、图片、文件读写等纯逻辑；浏览器交互和
真实协议另有集成脚本：

```bash
# 不需要先起服务（脚本自己 spawn CLI）
npm run test:approval
npm run smoke
npx tsx apps/server/scripts/smoke-image.ts
npx tsx apps/server/scripts/smoke-claude.ts
npx tsx apps/server/scripts/test-claude.ts

# 需要服务在跑（<PIN> 是登录 PIN）
npm run test:hub -- <PIN>
npm run test:terminal -- <PIN>
npm run smoke:browser -- <PIN>
node apps/web/scripts/smoke-claude-browser.mjs <PIN>
```

脚本各自钉住的东西和前置条件见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 权限档位

输入框上的权限项**每回合**决定沙箱和审批策略，并覆盖建会话时的预设。四档：

| 档位 | Claude | Codex | 说明 |
|---|---|---|---|
| 按需确认 | `default` | `workspace-write` + `on-request` | 需要时弹审批 |
| 只读 | `plan` | `read-only` | 只读探索 |
| 自动判断 | `auto` | — | Claude 专属；**不弹审批**，判不了时直接拦掉动作 |
| 完全访问 | `bypassPermissions` | `danger-full-access` | **无人值守**，不再有任何确认 |

- 读不到会话当前档位时一律兜底到「按需确认」，绝不填「上次选过的那档」。
- 「自动判断」不向手机抛审批，屏幕上看不出它放过了什么；它也不能在建会话时选。
- 「完全访问」是本应用里唯一能让一部手机拿到无限制机器权限的入口。

详细约束和已知边界见 [docs/limitations.md](docs/limitations.md)。

## 项目结构

```text
apps/server/src/
  codex/          AppServerClient · supervisor · mapEvents · permission
  claude/         ClaudeProvider · transcript · mapClaudeEvents / mapUtils
                  · runtime · turnInput · permission
  providers/      AgentProvider 抽象 · registry · sessionPrefs · 分页
  images/         用户图片的内容寻址存储
  ws/             hub（事件扇出）· terminal（PTY 桥）
  routes/         REST：auth / sessions / files / images / health
  distributed/    Hub / runner / bridge / tunnel
apps/web/src/
  pages/          Sessions · Chat · Files · Terminal · Settings · Login
  components/     Composer · ApprovalSheet · FileBody / FileViewer / FileEditor
  lib/            store（流式缓冲）· ws（重连）· api · fileLink · permission
packages/protocol/src/
  events.ts       归一化 AgentEvent 契约（手写）
  api.ts          REST DTO（手写）
  generated/      Codex app-server 生成类型（gitignore，仅作协议参考）
```

## 文档

| 文档 | 内容 |
|---|---|
| [docs/architecture.md](docs/architecture.md) | 架构、数据流、provider 接缝、分页、图片、终端 |
| [docs/deployment.md](docs/deployment.md) | 四种部署方式、环境变量、健康检查 |
| [docs/limitations.md](docs/limitations.md) | 已知限制和行为边界 |
| [docs/multi-runner.md](docs/multi-runner.md) | Hub / runner 多机器模式 |
| [docs/hub-tls.md](docs/hub-tls.md) | 原生 TLS、私有 CA、Nginx |
| [docs/releasing.md](docs/releasing.md) | 版本号、打包、Codex CLI 升级流程 |
| [docs/error-reporting.md](docs/error-reporting.md) | 代理失败、重试与错误卡片 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 开发、测试、PR 约定 |
| [SECURITY.md](SECURITY.md) | 威胁模型、漏洞报告、安全部署清单 |
| [CHANGELOG.md](CHANGELOG.md) | 变更记录 |
| [CLAUDE.md](CLAUDE.md) | 面向编码代理的实现约束和操作手册 |

## 已知限制（摘要）

- 新建会话时选的沙箱会被输入框上的权限项覆盖；9 种组合里有 6 种在输入框上
  表达不出来。
- Claude 检测不到桌面端 CLI 的并发写入。
- 「完全访问」等同于无人值守；「自动判断」不弹审批。
- 图片缓存不跟随会话删除，也没有容量上限（整个删掉永远安全）。
- Codex 的 `request_user_input` 链路只验证了一半。
- 新建但未发消息的 Codex 会话，服务重启后找不回来。
- UI 目前只有中文；未在真机 iOS Safari / Android Chrome 上完整验证。

完整说明见 [docs/limitations.md](docs/limitations.md)。

## 贡献

欢迎 issue 和 PR。开始之前请读 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题
请按 [SECURITY.md](SECURITY.md) 私下报告，不要公开披露未修复的漏洞。

## License

[MIT](LICENSE)
