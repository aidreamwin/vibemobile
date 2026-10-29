# PM2 部署包、更新包与 runner 包

三个产物都由 `npm run release` 在**构建机**上生成，分发到**目标机**后再安装。包里是纯源码和 Node 脚本：没有 `node_modules`、没有 `dist`、没有 Codex CLI，也没有任何证书或 PIN。原因很直接 —— `node-pty` 是原生模块、Codex CLI 和 Claude CLI 都是按平台解析的，只有目标机自己执行 `npm ci` 才能装对。

| 包 | 用途 | 目标机执行 |
| --- | --- | --- |
| `vibemobile-hub-<server>-w<web>-<commit>.tar.gz` | 新机器首次安装 Hub（浏览器入口 + 默认 runner） | `deploy/install.mjs --role=hub` |
| `vibemobile-update-<server>-w<web>-<commit>.tar.gz` | 已有安装的完整替换升级 | `deploy/update.mjs --target=...` |
| `vibemobile-runner-<server>-<commit>.tar.gz` | 远端执行机（只连 Hub，不提供 Web） | `deploy/install.mjs --role=runner` |

**Hub 包和更新包是同一份字节**（更新包只是换了个文件名，`manifest.json` 里标了 `identicalTo: "hub"`）。两者都能用于首次安装，也都能用于升级；`RELEASE.json` 里的 `contents` 都是 `hub`。runner 包是另一份，去掉了前端源码，只保留 `apps/web/package.json` 以维持 npm workspace 与 lockfile 一致。

## 1. 构建产物

在仓库根执行：

```bash
npm run release                  # release/ 下三个包 + SHA256SUMS + manifest.json
npm run release -- --skip-verify # 跳过测试和构建（不推荐）
npm run release -- --allow-dirty # 允许未提交改动，文件名会带 -dirty-<时间>
npm run release -- --kind=runner # 只出 runner 包
npm run release -- --out=/tmp/vbm-release --force
```

默认会先跑 `npm test` 和 `npm run build:all`，确认发布的是可构建的源码。产物名里的 `<commit>` 是 12 位提交号。分发时至少把 `SHA256SUMS` 一起带走。

目标平台是 Linux x64、Linux arm64、Windows x64。因为包里是源码，一份产物同时适用于三者，不需要交叉编译。

## 2. 目标机前提

- **Node.js ≥ 20** 和 npm（安装脚本会优先使用当前 Node 自带的 npm）。
- **PM2**：`npm i -g pm2`，或在安装时加 `--install-pm2`。
- **Linux 额外需要 C++ 工具链**：`node-pty@1.1.0` 只为 darwin/win32 提供预编译产物，Linux 必须现场编译。
  - Debian/Ubuntu：`sudo apt-get install -y build-essential python3`
  - Fedora/RHEL：`sudo dnf install -y gcc-c++ make python3`
  - Alpine：`sudo apk add --no-cache build-base python3`
- **Agent 凭据**：用实际运行 PM2 的那个用户先执行一次 `codex login`；用 Claude 的话再运行一次 `claude`。凭据来自 `~/.codex` 和 `~/.claude`，不是安装脚本传进去的环境变量。不要用 SYSTEM / root 跑服务，否则读不到用户的凭据。
- 安装依赖需要网络（npm registry），Linux 编译 node-pty 还需要下载 Node headers。

安装脚本会在 `npm ci` 之前检查这些条件，缺工具链时直接给出上面的安装命令，而不是让你对着一大段 node-gyp 报错猜。

## 3. 安装 Hub

把包解压到一个**长期保留**的目录，例如 `/opt/vibemobile`。安装根目录就是解压目录：`vibemobile.env`、`ecosystem.config.cjs`、`data/` 都会生成在这里。

```bash
mkdir -p /opt/vibemobile
tar -xzf vibemobile-hub-0.1.14-w0.1.24-abc123.tar.gz -C /opt/vibemobile
cd /opt/vibemobile

# 明文 HTTP/WS（局域网或前面有反向代理）
node deploy/install.mjs --role=hub --port=3000 \
  --workspace=/srv/projects --pin=123456

# 或者由 Hub 自己提供 HTTPS/WSS（生成私有 CA + 服务器证书）
node deploy/install.mjs --role=hub --port=3000 \
  --workspace=/srv/projects --pin=123456 --tls
```

Windows（PowerShell，先解压到 `D:\vibemobile`）：

```powershell
cd D:\vibemobile
node deploy\install.mjs --role=hub --port=3000 --workspace=D:\code --pin=123456
```

常用参数：

| 参数 | 说明 |
| --- | --- |
| `--workspace=<dir>` | **必需**。代理只能读写这里面的文件。多个目录在 Linux 用 `:`、Windows 用 `;` 分隔 |
| `--port` | Hub 浏览器端口，默认 3000 |
| `--runner-port` | 默认 runner 的私有回环端口，默认 `--port + 1` |
| `--codex-port` | 默认 runner 的 Codex app-server 端口，默认 6900 |
| `--pin` / `--pin-file` | 固定 PIN。不给则首次启动随机生成，并打印在日志和安装结果里 |
| `--tls` | 生成私有 CA 与证书，启用原生 HTTPS/WSS |
| `--public-host` | 追加证书 SAN 和允许的 Origin，可重复 |
| `--public-origin` | 直接指定逗号分隔的 Origin 允许列表，覆盖自动推导 |
| `--data-dir` | 状态、证书、日志的根，默认 `<安装根>/data` |
| `--pm2-name` | PM2 应用名，默认 `vibemobile` |
| `--no-default-runner` | 只跑 Hub；要求 `--runners-file` 指向非空名单 |
| `--no-start` | 只安装、构建、写配置，不启动 PM2 |
| `--dry-run` | 打印计划，不写文件、不装依赖 |
| `--install-pm2` | 缺少 PM2 时自动 `npm i -g pm2` |

安装完成后会打印访问地址、PIN、日志命令，以及远程 runner 的注册方法。

### 生成的文件

```text
/opt/vibemobile/
  apps/...                      # 源码与构建产物
  vibemobile.env                # 0600，含 PIN；升级时保持不变
  ecosystem.config.cjs          # 0600，PM2 配置
  data/
    hub/state.json              # JWT 密钥、PIN 哈希、自动生成的 PIN
    default-runner/             # 默认 runner 的会话偏好与图片
    runners/runners.json        # 远程 runner 名单（只有 token 的 SHA-256）
    certs/                      # 仅 --tls：ca.pem / ca.crt / hub-cert.pem / hub-key.pem
    logs/                       # PM2 的 stdout/stderr
  releases/                     # 首次安装没有；update.mjs 之后才出现
```

`vibemobile.env` 是唯一的配置源。`ecosystem.config.cjs` 在启动时读取它，所以改完环境变量执行：

```bash
pm2 restart vibemobile --update-env
```

## 4. 安装 runner

先在 Hub 上生成一台机器的身份。命令只把 token 的 SHA-256 写进名单，明文 token 只输出这一次：

```bash
cd /opt/vibemobile
node scripts/create-runner.mjs --id=runner-b --name=机器B
# 输出 VIBEMOBILE_RUNNER_ID 和 VIBEMOBILE_RUNNER_TOKEN
```

把 token 保存到 runner 机器上的一个 0600 文件，然后：

```bash
mkdir -p /opt/vibemobile-runner
tar -xzf vibemobile-runner-0.1.14-abc123.tar.gz -C /opt/vibemobile-runner
cd /opt/vibemobile-runner

node deploy/install.mjs --role=runner \
  --workspace=/srv/projects \
  --hub-url=wss://hub.lan:3000 \
  --runner-id=runner-b \
  --runner-token-file=/root/runner-b.token \
  --hub-ca=/path/to/ca.pem
```

- `ws://` 用于局域网明文；`wss://` 用于 Hub 原生 TLS 或反向代理。
- 私有 CA 必须给 `--hub-ca`，且只分发 CA 公钥证书；**CA 私钥永远留在 Hub 机器上**。
- runner 只主动外连 Hub，不开放任何入站端口。它的私有执行服务监听 `127.0.0.1:5901`（可用 `--runner-port` 改）。
- 同一台机器上同时跑 Hub 和独立 runner 时，给 runner 换一套 `--runner-port` / `--codex-port`。

设置页上的名单变更即时生效。只有直接改名单文件的命令行操作，才需要重启 Hub：

```bash
pm2 restart vibemobile --update-env
```

## 5. 升级（完整替换）

更新是**完整替换**，不是增量补丁。把更新包解压到安装根目录**之外**的任意位置，然后运行：

```bash
mkdir -p /tmp/vbm-update
tar -xzf vibemobile-update-0.1.15-w0.1.25-def456.tar.gz -C /tmp/vbm-update
node /tmp/vbm-update/deploy/update.mjs --target=/opt/vibemobile
```

流程：

1. 读取 `/opt/vibemobile/vibemobile.env`，推断角色、PM2 名和端口。
2. 把新源码复制到 `/opt/vibemobile/releases/<server>-w<web>-<commit>/`。
3. 在**新目录**执行 `npm ci` 和构建；旧版本继续对外服务。
4. 写指向新 release 的 `ecosystem.config.cjs`，`pm2 delete` + `pm2 start` + `pm2 save`。
5. 健康检查通过后写入 `active-release.json`，并清理过老的 release（默认保留当前 + 上一个）。
6. 健康检查失败则恢复旧配置、重启旧 release、再检查一次，然后以非零码退出。备份在 `data/backups/<stamp>/`。

`data/`、`certs/`、`vibemobile.env` 在整个过程中**不会被修改**，所以 PIN、登录状态、会话偏好、图片和 runner 身份都会保留。

演练与手动控制：

```bash
node deploy/update.mjs --target=/opt/vibemobile --dry-run
node deploy/update.mjs --target=/opt/vibemobile --no-start
# --no-start 只构建并写好配置，随后手动：
pm2 delete vibemobile; pm2 start /opt/vibemobile/ecosystem.config.cjs --update-env; pm2 save
```

手工回滚：把 `data/backups/<stamp>/ecosystem.config.cjs` 复制回安装根，然后 `pm2 delete` + `pm2 start` + 健康检查。

## 6. TLS 与手机

`--tls` 会调用 `scripts/generate-hub-certs.mjs`，生成：

| 文件 | 用途 |
| --- | --- |
| `data/certs/ca.pem` | 私有 CA 公钥；Hub 与默认 runner 的信任锚 |
| `data/certs/ca.crt` | DER 编码，给手机安装 |
| `data/certs/hub-cert.pem` | 服务器证书 + 完整链 |
| `data/certs/hub-key.pem` | 服务器私钥，不要分发 |
| `data/certs/ca-key.pem` | CA 私钥，只留在 Hub 机器 |

证书 SAN 自动包含主机名、`localhost`、`127.0.0.1`、`::1` 和生成时的所有非回环 IPv4。换网段、换主机名或需要额外地址时：

```bash
node scripts/generate-hub-certs.mjs --out=/opt/vibemobile/data/certs --san=hub.lan --force
pm2 restart vibemobile --update-env
```

或者重新运行安装脚本并加 `--force --force-certs`（会重写 `vibemobile.env`，状态仍在 `data/`）。

`VIBEMOBILE_PUBLIC_ORIGIN` 是**逗号分隔的 Origin 允许列表**，每一项必须**小写、结尾没有斜杠**。`--tls` 会自动生成主机名、回环地址和当前局域网 IPv4 的组合。IP 变了以后如果登录返回 403 `origin_not_allowed`，改这一项并重启即可。

手机信任私有 CA：

- iOS：安装 `ca.crt` 描述文件，再到「设置 → 通用 → 关于本机 → 证书信任设置」打开完全信任。
- Android：设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书。
- 不装 CA 时不要用「继续访问」绕过：页面能打开，但登录和 WS 仍然失败。

`--tls` 是在同一个端口上把 HTTP/WS 换成 HTTPS/WSS，**不会同时保留明文入口**。需要两者并存就在前面放反向代理。

## 7. 常驻与开机自启

```bash
pm2 status
pm2 logs vibemobile
pm2 restart vibemobile --update-env
pm2 delete vibemobile
```

Linux：

```bash
pm2 startup        # 按输出执行一次（需要 sudo）
pm2 save
```

Windows：PM2 的 `pm2 startup` 不可用。用「任务计划程序」在用户登录时执行 `pm2 resurrect`，或把 PM2 本身注册成服务。**不要**把任务计划配成 SYSTEM：那样 `~/.codex` 和 `~/.claude` 不是同一个用户的家目录，CLI 会表现为「未登录」，而不是报错。

## 8. 备份与安全

需要备份的只有：

```text
vibemobile.env
data/state.json 或 data/hub/state.json
data/default-runner/、data/runners/
data/certs/（包括 ca-key.pem）
```

`releases/` 是可重建的构建产物，备份它没有意义。

- `vibemobile.env` 里有明文 PIN 和 runner token，保持 0600，别进 git、别进网盘。
- `data/certs/ca-key.pem` 和 `hub-key.pem` 是私钥，不要发给 runner，也不要在聊天工具里传。
- runner 名单文件只含 token 哈希，可以单独备份，但也不要公开。
- 三个发布包里都不含上述任何文件；`node_modules`、`dist`、`.vibemobile`、`.multi-runner`、`certs` 也都被排除。

## 9. 与当前 3000 服务的关系

本工具链**不会**触碰已有的 NSSM 服务 `VibeMobile`。如果要把现在跑在 3000 的部署迁移到 PM2，必须在维护窗口里明确地：

1. `Stop-Service VibeMobile` 并禁用其自动启动；
2. 确认 3000/3001/8789 已释放；
3. 再运行 `install.mjs` 或把现有 `data/` 指给新安装。

PM2 和 NSSM 不能同时监听 3000。迁移前先备份 `vibemobile.env`、`data/` 和 `certs/`。

## 10. 常见问题

**`npm ci` 在 node-pty 处失败**：Linux 缺 `python3`/`make`/`g++`，或无法下载 Node headers。装工具链后重跑；离线机器需要先准备好 npm 缓存或 `npm_config_nodedir`。

**登录 403 `origin_not_allowed`**：`VIBEMOBILE_PUBLIC_ORIGIN` 里的主机名不是小写、带了尾斜杠，或当前访问地址不在列表里。浏览器发来的 Origin 永远是小写。

**端口被占**：安装和更新都会用 connect 探测端口（不是试绑定），占用了就拒绝启动，避免静默接到别的服务上。改 `--port` / `--runner-port` / `--codex-port`，或先停掉占用者。

**模型列表变成官方目录、发消息不回复**：Claude CLI 没读到凭据。检查 PM2 实际运行用户的 `~/.claude/settings.json` 的 `env` 段，而不是当前 shell 的环境变量。

**Windows 上 `spawn EINVAL` / 找不到 npm**：安装脚本已经优先使用当前 Node 自带的 `npm-cli.js`；如果 Node 是 zip 解压且被移动过，重新安装 Node 或用完整安装包。

**升级后界面仍显示旧构建**：后端 dist 是进程启动时载入的，必须重启 PM2；前端 dist 是运行时从磁盘读的。`/api/health` 同时返回 `build` 和 `buildOnDisk`，两者相等才说明进程跑的是磁盘上的那一版。

## 11. 构建机侧的验证（不碰生产 3000）

```bash
node --check scripts/release.mjs
node --check deploy/install.mjs
node --check deploy/update.mjs
npm run release -- --out=release-test --allow-dirty --skip-verify
tar -tzf release-test/vibemobile-hub-*.tar.gz | head
tar -tzf release-test/vibemobile-runner-*.tar.gz | head
```

确认列表里没有 `node_modules/`、`dist/`、`.vibemobile/`、`certs/`、`packages/protocol/src/generated/`，并且有 `deploy/install.mjs`、`deploy/update.mjs` 和 `RELEASE.json`。

完整演练：把 hub 包解压到临时目录，用 5950/5951/6950 安装（`--no-start`），手动启动后请求 `/api/hub`；再对同一目录执行 `update.mjs --dry-run`。全程不要使用 3000。
