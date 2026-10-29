# 多 Runner（Hub / Runner）

VibeMobile 可以把「浏览器入口」和「真正执行代理的机器」分开：一台机器运行
Hub，其他机器运行 runner 并主动连接 Hub。runner 不需要公网 IP，也不需要开放
入站端口。原有的单机 `npm start` 继续可用。

## 结构

```text
浏览器 ──HTTP(S)/WS(S)──► Hub ──runner 主动建立的 WS/WSS──► runner 本机服务
                                                             ├── Codex
                                                             ├── Claude
                                                             ├── 文件
                                                             └── PTY
```

Hub 只提供登录、静态 Web、runner 名单和转发；provider、文件、图片、PTY 全部
留在 runner。浏览器按 `/r/<runnerId>/...` 选择机器，每个标签页只连接一台
runner；本地会话 / 审批 id 不跨 runner 混用。

## 数据与恢复

- Agent 凭据、源码、历史、偏好、图片缓存和 PTY 都留在 runner。
- Hub 的登录状态独立持久化；runner 名单由配置文件提供，第一阶段不需要数据库。
- WS/WSS 断开时清理传输请求与代理 socket，独立 runner 的执行服务继续运行。
- 浏览器靠现有的订阅 / 历史 / 审批重放 / PTY 快照恢复可见状态。
- **没有事件可靠补发或 exactly-once 保证。** 超时或断线的执行命令不会自动重试；
  用户应先检查历史与运行状态再决定是否操作。

## 代码入口

| 文件 | 职责 |
|---|---|
| `apps/server/src/distributed/hub.ts` | Hub 启动、默认 runner 子进程及退出清理 |
| `apps/server/src/distributed/hubApp.ts` | 登录、runner 名单、凭据认证、同源检查、转发、静态资源 |
| `apps/server/src/distributed/runner.ts` | 独立 runner，启动私有本机执行服务 |
| `apps/server/src/distributed/bridge.ts` | 主动 WS/WSS、重连、本机 HTTP/WS 桥接 |
| `apps/server/src/distributed/tunnel.ts` / `wire.ts` | 多路复用、超时、路径/头白名单、消息和队列限制 |
| `apps/web/src/lib/runner.ts` | URL 作用域和存储键隔离 |
| `apps/web/src/components/RunnerSelector.tsx` | 机器选择、在线状态 |

浏览器先在 Hub 登录，再跳转默认机器 `/r/local/`。切换机器执行整页导航，避免
旧会话、审批和内存缓存泄漏到另一台机器；旧回合继续执行。不同标签页可以同时
打开不同机器。

## 本机启动

```bash
npm run build:all
npm run start:hub
```

访问 `http://127.0.0.1:5900`。未设置 PIN 时在 Hub 日志中查看自动生成值。默认
同时启动 `local` runner（私有 API 回环 5901，Codex 6900）。

开发时可以直接跑 TS：

```bash
npm run dev:hub
npm run dev:runner
```

Hub 使用已构建的前端。若使用 Vite，设置 `VIBEMOBILE_BACKEND=http://127.0.0.1:5900`，
并给 Hub 设置对应 Vite 地址的 `VIBEMOBILE_PUBLIC_ORIGIN`。

开发真实 Agent 时，使用独立的 `CODEX_HOME`、`CLAUDE_CONFIG_DIR` 和工作区，防止
与既有服务打开同一个 Agent 会话。

## 添加远程 runner

**在设置页添加（推荐）。** 用浏览器登录 Hub → 设置 → 执行机器 → 添加执行机，
填写名称后立即显示一次性令牌和 runner ID，复制按钮把两行环境变量一起复制走。
关闭面板后令牌无法再次查看，丢失时在列表里「刷新令牌」重新生成（旧令牌立即失效、
在线连接会断开）。删除执行机同样立即吊销令牌并断开连接。

名单由 Hub 写入它的状态目录（未设置 `VIBEMOBILE_RUNNERS_FILE` 时是
`<stateDir>/runners.json`，Docker 下也就是 `hub-data` 卷），改动即时生效，不需要
重启。**不要同时用命令行改同一个文件**：Hub 是唯一写入者，外部修改要等重启才可见，
而且下一次页面操作会按内存里的名单重写文件。

命令行方式仍适用于无浏览器的场景（Hub 已停止时写入同一个文件）：

```bash
node scripts/create-runner.mjs --id=runner-b --name=机器B --file=/path/to/runners.json
```

明文 token 只输出一次，文件里只有 SHA-256。用这种方式新增/删除后需要重启 Hub。
如果 `VIBEMOBILE_RUNNERS_FILE` 指向宿主挂载文件，该文件必须**可写**，否则页面上的
创建/刷新/删除会返回 `runner_store_unwritable`。

runner 机器上构建相同版本，设置：

```bash
export VIBEMOBILE_HUB_URL="wss://vibe.example.com"
export VIBEMOBILE_RUNNER_ID="runner-b"
export VIBEMOBILE_RUNNER_TOKEN="<生成的独立 token>"
export VIBEMOBILE_ROOTS="/srv/projects"
npm run start:runner
```

跨机器同时支持 WS 与 WSS。局域网可以直接用 `ws://<hub-lan-ip>:5900`，无需
配置 TLS。使用 WS/WSS 都需要 runner ID 和 token；runner 不开放入站端口。

本机执行服务另有随机私有 token，只有 bridge 持有；Hub 登录 Cookie、runner
长期 token 都不会转发到该服务。

局域网直接访问时，Hub 设置 `VIBEMOBILE_PUBLIC_ORIGIN=http://<hub-lan-ip>:5900`、
`VIBEMOBILE_SECURE_COOKIE=0`。Docker Hub 额外设置 `HUB_BIND=0.0.0.0`。

## 配置

| 变量 | 默认 / 说明 |
|---|---|
| `PORT` | Hub 5900 |
| `VIBEMOBILE_RUNNER_PORT` | runner 私有 HTTP 5901 |
| `CODEX_PORT` | runner Codex 6900；分布式入口忽略外部 `CODEX_WS_URL` |
| `VIBEMOBILE_STATE_DIR` | Hub `.multi-runner/hub`；独立 runner `.multi-runner/runners/<id>` |
| `VIBEMOBILE_DEFAULT_RUNNER_STATE_DIR` | Hub 托管默认 runner 的状态路径 |
| `VIBEMOBILE_DEFAULT_RUNNER` | 默认启用；`off` 表示只运行 Hub |
| `VIBEMOBILE_DEFAULT_RUNNER_ID` / `_NAME` | `local` / 本机 |
| `VIBEMOBILE_RUNNERS_FILE` | 远程名单 JSON 文件 |
| `VIBEMOBILE_HUB_URL` | runner 连接地址，`ws://` 或 `wss://` |
| `VIBEMOBILE_PUBLIC_ORIGIN` | 浏览器入口源；逗号分隔的允许列表，不带尾部 `/` |
| `VIBEMOBILE_SECURE_COOKIE` | HTTPS 部署设 `1` |
| `VIBEMOBILE_HOST` | Hub 默认 `0.0.0.0`；runner 始终回环监听 |
| `VIBEMOBILE_HUB_TLS` | `off`（默认）或 `on` |
| `VIBEMOBILE_HUB_TLS_CERT_FILE` / `_KEY_FILE` | Hub 原生 TLS 的证书链和私钥 |
| `VIBEMOBILE_HUB_CA_FILE` | runner 仅信任指定 PEM CA |
| `VIBEMOBILE_DEFAULT_RUNNER_HUB_URL` | 默认 runner 使用的地址，协议必须匹配 Hub TLS 模式 |

同一机器运行多个 runner 时，HTTP 端口、Codex 端口、状态目录和必要的 Agent
配置目录都要分别设置。runner 私有端口会拒绝 3000/8788，避免接入已有的单机
服务。

## 部署

局域网可直接使用 HTTP/WS，也可以由程序加载证书提供 HTTPS/WSS；公网可以沿用
Nginx 证书。完整配置见 [hub-tls.md](hub-tls.md)。

- **Hub**：`docker compose -f docker-compose.hub.yml up -d --build`。设置
  `VIBEMOBILE_PIN`；默认仅发布宿主机回环 5900，前面使用 Caddy 或 nginx。
  示例见 [Caddyfile.multi-runner.example](Caddyfile.multi-runner.example)、
  [nginx.example.conf](nginx.example.conf)（含 X-Forwarded-For
  覆盖、登录限流与安全响应头）。
- **远程 runner**：`docker compose -f docker-compose.runner.yml up -d --build`。
  设置 Hub URL、runner ID、token 和宿主机工作区目录。无需发布端口。
- **Windows 远程 runner**：运行 `scripts\windows\install-runner-service.bat`，用
  NSSM 注册成 Windows 服务 —— 没有命令行窗口、开机自启、崩溃自动拉起。脚本会
  依次询问 Hub 地址、runner ID 和 token（token 输入不回显）。卸载用
  `nssm remove VibeMobileRunner confirm` 或 services.msc。
- 给容器中的默认 / 远程 runner 挂载各自的 Agent 配置目录，确保 CLI 已登录。
- Docker Hub 加远程名单：默认无需配置，设置页写入 `hub-data` 卷里的
  `<stateDir>/runners.json`。要在宿主机保留副本时，先创建
  `runner-credentials.json`，启用 Compose 内注明的**可写**挂载并设置
  `HUB_RUNNERS_FILE=/app/runner-credentials.json`。文件里只有摘要，不能提交仓库。
- systemd / NSSM / launchd：分别托管
  `node apps/server/dist/distributed/hub.js` 和
  `node apps/server/dist/distributed/runner.js`，使用对应账户运行，保证工作区和
  Agent 凭据可读。
- HTTPS 入口只转发到 Hub，不直接开放 runner 端口；反代要允许 WebSocket。
  默认不信任转发 IP 头；开启 `VIBEMOBILE_TRUST_PROXY` 时必须限制 Hub 只能由
  可信反代访问。

## 传输约束

- 协议版本 `vibemobile-runner-v1`。
- 每 runner 最多 64 个并发 HTTP 和 64 个 WS。
- HTTP 请求/响应上限 8 MiB，通道帧上限 12 MiB，发送缓冲上限 24 MiB。
- HTTP 120 秒超时；只转发执行 API 和 `/ws`、`/ws/terminal`，不会转发任意地址、
  登录接口或用户 Cookie。
- 同一 runner ID 只能有一个活连接，重复进程被拒。
- 断线使用指数退避重连；心跳识别半开连接。
- Hub 重启不会终止独立远程 runner 的本机服务；Hub 托管的默认 runner 随 Hub
  正常退出。runner 进程重启不能恢复 PTY。

## 后续范围

以下能力**尚未实现**：

- 跨 runner 的会话聚合、SQLite 索引和离线完整历史
- 一次性配对码（目前是设置页里的一次性令牌展示）
- 执行操作的持久幂等账本和结果查询
- 事件序号、补发与一致性快照
- 独立应用预览域名和 HTTP/WS 隧道
- 多用户、资源 ACL、审计与配额
