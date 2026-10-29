# 部署

四种方式，按场景选一个。首次部署前请先读 [SECURITY.md](../SECURITY.md) 的
安全部署清单：**不要把本服务直接暴露到公网。**

## 端口

| 端口 | 用途 |
|---|---|
| `3000` | 部署的服务（Windows 服务 / PM2 / Docker），HTTP / 原生 HTTPS |
| `8788` | 部署的服务 spawn 的 codex app-server |
| `5800` | 开发模式的后端 |
| `5802` | 开发模式的前端（Vite） |
| `6800` | 开发模式的 codex app-server |
| `6811` / `6812` | 一次性测试脚本各自的 app-server |

规律：**3xxx / 5xxx 是浏览器直接访问的 HTTP，68xx 是 codex app-server。**
Claude Code 不占端口，它每回合现起一个子进程。

开发和部署**必须**分开。supervisor 用轮询 `/readyz` 判断 app-server 就绪，这个
探测只认端口、不认进程；端口撞上会静默接到别人的 app-server 上。`npm run dev`
会在启动前预检端口，被占就报错退出。

## 怎么知道部署的是不是最新代码

设置页把前后端两半并排显示：

- **前端（本页）**：服务从磁盘实时读的 bundle，重建后刷新即生效。
- **服务端（进程）**：进程启动时载入的 dist，重建后必须重启。

`+未提交` 表示构建时工作区有未提交改动。提交号不一致说明只重建了一半。
`/api/health` 同时返回 `build` 和 `buildOnDisk`，两者不等时页面会提示
「已重建但未重启」。

## 方式一：直接跑（前台）

```bash
npm ci
npm run build:all      # 前端 + 后端；只跑 npm run build 只会构建前端
npm start              # 默认 0.0.0.0:3000
```

首次启动会自动生成 16 位强密码（大小写字母、数字与符号）作为 PIN 并打印在日志里，也可以在日志里看到手机访问地址。
想固定 PIN 就设置 `VIBEMOBILE_PIN`。

开发时不要用 `npm start`（会和常驻服务抢 3000 端口），改用：

```bash
npm run dev            # 后端 5800 · 前端 5802 · app-server 6800
npm run dev:server     # 只起后端
npm run dev:web        # 只起前端
```

端口被占用时整段换掉：

```bash
node scripts/dev.mjs --server-port=5900 --codex-port=6901 --web-port=5902
```

Vite 绑在 `0.0.0.0`，开发模式也能用手机连 —— 地址是启动横幅里打印的 Network 行。

## 方式二：Windows 服务（后台常驻）

把 VibeMobile 注册成 Windows 服务：开机自启、崩溃自动拉起、没有 CMD 窗口、
日志落盘。

```bat
:: 右键“以管理员身份运行”；直接双击也行，脚本会自己请求提权
scripts\windows\install-service.bat
```

脚本依次做：构建前后端 → 从 npm 取 `nssm.exe` → 注册服务 → 询问当前账户密码 →
启动并打印手机访问地址和 PIN。密码只作为服务凭据交给 NSSM，不写进脚本、配置
或日志。

常用操作：

```bat
scripts\windows\install-service.bat -DryRun           :: 只看它要做什么，不碰系统
scripts\windows\install-service.bat -Port 8080        :: 换端口
scripts\windows\install-service.bat -Pin 123456       :: 固定 PIN
scripts\windows\install-service.bat -Force            :: 重装
scripts\windows\uninstall-service.bat                 :: 卸载
```

日志在 `.vibemobile\logs\service.out.log` 和 `service.err.log`。

**验证分三层，只有第三层是权威判据：**

```bat
sc.exe query VibeMobile        :: 1. 注册了吗
sc.exe qc VibeMobile           :: 2. 配置对不对（看 BINARY_PATH_NAME / START_TYPE）
curl http://localhost:3000/api/health   :: 3. 应用真的活着吗
```

NSSM 是代持服务的：node 崩溃时它会立刻重试拉起，SCM 仍显示 RUNNING。只有
`/api/health` 有响应才算成功。同一个启动横幅在 `service.out.log` 里反复出现
就是崩溃循环，去 `.err.log` 找原因。

更新已装好的服务：

```powershell
.\scripts\windows\update-service.bat          # 增量：只重建改动过的那一半
.\scripts\windows\update-service.ps1 -DryRun  # 先预览
.\scripts\windows\update-service.ps1 -All     # 全量重建并重启
```

它靠 `.vibemobile\last-deploy.json` 记录的上次 commit 计算差集。**先构建、后
重启**：构建失败时线上仍跑着上一个可用版本；只有健康检查通过才更新部署记录。

## 方式三：PM2（Linux/macOS 后台常驻）

推荐直接用发布包：

```bash
npm run release
```

会生成 Hub 包、更新包和 runner 包（纯源码 + 安装脚本）。目标机解压后：

```bash
node deploy/install.mjs --role=hub --port=3000 \
  --workspace=/srv/projects --pin=123456
```

升级：

```bash
node deploy/update.mjs --target=/opt/vibemobile
```

完整参数、TLS、runner 和回滚说明见 [pm2-release.md](pm2-release.md) 和
[deploy/README.md](../deploy/README.md)。

手动路线：构建机执行 `npm ci && npm run build:all`，把 `package.json`、
`package-lock.json`、两个 workspace 的 `package.json` 和 `dist/` 打包到目标机；
**不要打包 `node_modules`、`.vibemobile` 或 `~/.codex`**。目标机安装依赖后：

```bash
npm ci
npx codex login          # 使用哪个代理就登录哪个
export VIBEMOBILE_PIN=123456
export VIBEMOBILE_ROOTS=/absolute/path/to/workspace
export VIBEMOBILE_STATE_DIR=/var/lib/vibemobile
pm2 start apps/server/dist/index.js --name vibemobile --cwd "$PWD" --time
pm2 save
```

`--cwd` 指向部署目录。更新代码后重新构建，再
`pm2 restart vibemobile --update-env`。

## 方式四：Docker

```bash
cp .env.example .env
docker compose up -d --build
docker compose logs -f      # 看自动生成的 PIN（若未在 .env 指定）
```

- 状态持久化在 `vibemobile-data` volume，工作区挂载到 `/app/workspace`。
- 两个代理的登录态都不在镜像里：需要时挂载 `~/.codex` 和 `~/.claude`，或提供
  `ANTHROPIC_*` 等环境变量。
- Codex CLI 在构建阶段单独装到 `/opt/codex-cli`，因为它在根
  `devDependencies` 里，会被 `npm prune --omit=dev` 删掉。版本从
  `package.json` 读取，不在 Dockerfile 里另写一份。
- 多 runner / Hub 模式见 [multi-runner.md](multi-runner.md)、
  [hub-tls.md](hub-tls.md)。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `VIBEMOBILE_PIN` | 自动生成 | 登录 PIN。设了就用它 |
| `VIBEMOBILE_NO_AUTH` | — | ⚠️ 真值则完全关闭鉴权，任何能访问端口的人都能操作机器 |
| `VIBEMOBILE_ROOTS` | 当前目录 | 代理可操作的目录白名单，多个用 `;` 或 `:` 分隔 |
| `VIBEMOBILE_HOST` / `PORT` | `0.0.0.0` / `3000` | 监听地址 |
| `VIBEMOBILE_STATE_DIR` | `./.vibemobile` | 密钥 / PIN / 会话存档目录 |
| `VIBEMOBILE_SESSION_TTL_MS` | 7 天 | 登录态有效期；支持多设备同时登录；修改 PIN 或「登出所有设备」会让旧 token 立即失效 |
| `VIBEMOBILE_TRUST_PROXY` | 关 | 只有真的在反向代理 / 隧道后面才开；开启后登录限流信任 `X-Forwarded-For` |
| `VIBEMOBILE_SECURE_COOKIE` | 关 | 前面有 TLS 终结时设 `1` |
| `VIBEMOBILE_TERMINAL` | 开 | 设为 `off` 关闭终端直连 |
| `VIBEMOBILE_SHELL` | Windows 为 `powershell.exe` | 终端使用的 shell |
| `VIBEMOBILE_TERMINAL_IDLE_MS` | 30 分钟 | shell 在无人连接后多久回收 |
| `VIBEMOBILE_LOG` | `info` | `silent` / `info` / `debug` |
| `CODEX_WS_URL` | — | 附加到已有的 app-server，而不是自己 spawn |
| `CODEX_PORT` / `CODEX_BIN` | `8788` / PATH | 自建 app-server 时的端口与可执行文件 |

**`VIBEMOBILE_TRUST_PROXY` 默认关闭是承重的。** 登录限流按客户端地址计数；开启
后它信任客户端自己写的 `X-Forwarded-For`，任何人轮换这个头就能对登录 PIN 做
无限次猜测。只有前面真的有人设置这个头时才开。

## 健康检查

```bash
curl http://localhost:3000/api/health
```

```json
{
  "ok": true,
  "uptime": 241,
  "providers": [
    { "id": "codex", "ready": true },
    { "id": "claude", "ready": null }
  ],
  "roots": ["<workspace-root>"],
  "terminal": { "enabled": true }
}
```

- Codex 的 `ready` 来自 app-server supervisor。
- **Claude 的 `ready` 恒为 `null`，不是故障。** 判断 Claude 请用
  `/api/providers`：`available` 会真的起一次 CLI，`authenticated` 看
  `account.tokenSource`。
