# 一键安装与升级

Hub 提供统一的浏览器入口并自带本机 Runner。需要管理多台开发机器时，在其他机器上添加远程 Runner。以下命令从最新发布的 GitHub Release 下载并校验对应的部署包。[查看 Release 版本与资产](https://github.com/aidreamwin/vibemobile/releases)

## 安装前准备

- 在各台机器的终端中切换到希望管理的项目目录，该目录默认为首次安装的工作区。
- 使用实际运行服务的普通用户账户。Linux/macOS 需要 `curl`、`sh`、`tar` 和 `sha256sum` 或 `shasum`，Windows 需要 PowerShell、`curl.exe` 和 `tar.exe`。
- 安装器自动准备 Node.js 22+、PM2 和项目依赖。安装需要访问 GitHub Releases、npm registry，缺少 Node.js 时还需访问 nodejs.org。Linux 缺少 C++ 构建工具链时，安装器可通过 apt/dnf/yum/apk 准备依赖，普通用户可能需要 sudo。系统需能运行官方 Node.js 二进制。
- 按需使用运行服务的用户登录 Codex、Claude Code 等代理 CLI。

## 安装 Hub

在 Hub 机器上运行对应平台的命令。

**Linux / macOS**

```sh
curl -LsSf https://github.com/aidreamwin/vibemobile/releases/latest/download/hub-install.sh | sh
```

**Windows PowerShell**

```powershell
& ([scriptblock]::Create((curl.exe -LsSf 'https://github.com/aidreamwin/vibemobile/releases/latest/download/hub-install.ps1' | Out-String)))
```

首次安装会构建并启动 Hub 和本机 Runner，默认浏览器端口为 `3000`。终端会输出访问方式及 PIN。可先在 Hub 机器打开 `http://127.0.0.1:3000`，手机或其他机器使用 Hub 的局域网地址访问。

在受信任的局域网或 VPN 内使用。HTTPS 可在首次安装时通过 `--tls` 启用，也可配置 HTTPS 反向代理。详见 [Hub TLS 部署](hub-tls.md)。

## 安装 Runner

1. 登录 Hub，在「设置 → 执行机器 → 添加执行机」填写名称，点击「生成令牌」，再点击「复制连接令牌」。令牌包含 Runner ID，只显示一次。
2. 在远程 Runner 机器切换到项目目录，运行对应平台的命令。

   **Linux / macOS**

   ```sh
   curl -LsSf https://github.com/aidreamwin/vibemobile/releases/latest/download/runner-install.sh | sh
   ```

   **Windows PowerShell**

   ```powershell
   & ([scriptblock]::Create((curl.exe -LsSf 'https://github.com/aidreamwin/vibemobile/releases/latest/download/runner-install.ps1' | Out-String)))
   ```

3. 按终端提示输入 Runner 可以访问的 Hub 地址（例如 `http://192.168.1.10:3000` 或 `https://hub.example.com`），然后粘贴刚复制的连接令牌并按 Enter。令牌输入过程隐藏内容。

   ```text
   Hub address:
   Connection token (ID:token or token):
   ```

   安装器将 HTTP/HTTPS 地址转换为 WS/WSS。旧版独立 token 还需填写 Runner ID。HTTPS Hub 使用公开受信任的证书时，在 CA 路径提示处按 Enter。使用私有 CA 时，填写 Runner 机器上的 CA 公钥证书路径。

4. 安装器自动构建并启动 Runner。回到 Hub 执行机器列表，确认新执行机显示「在线」。Runner 主动连接 Hub，默认私有服务端口为 `5901`，无需为远程 Runner 开放入站端口。

## 升级已有安装

在原安装用户的终端中再次执行对应角色的安装命令。安装器识别已有安装后会显示当前版本、下载版本及确认提示。

```text
Upgrade this installation? [y/N]
```

- 输入 `y` 确认升级。安装器先构建新版本，再切换服务并检查健康状态，失败时尝试回滚。
- 输入 `n` 或直接按 Enter 保留当前安装。
- PIN、Runner 凭据、会话数据、工作区和端口配置在升级时保留。Runner 升级沿用原连接配置。
- 安装器默认识别当前用户的安装目录和 PM2 应用 `vibemobile` / `vibemobile-runner`。
- 自定义目录的旧 PM2 安装可使用 `--target=<原安装根目录>`，安装根目录包含 `vibemobile.env`。
- `--yes` 用于无人值守升级。重复安装相同版本会复用已有构建。
- 指定版本时将 URL 中的 `latest/download` 改为 `download/<版本标签>`。

## 自定义安装与无人值守升级

Linux/macOS 可在管道末端使用 `sh -s --` 传入选项。

```sh
curl -LsSf https://github.com/aidreamwin/vibemobile/releases/latest/download/hub-install.sh | sh -s -- \
  --workspace=/srv/projects --port=8080 --tls

curl -LsSf https://github.com/aidreamwin/vibemobile/releases/latest/download/runner-install.sh | sh -s -- \
  --hub-url=https://hub.example.com --runner-token-file=/path/to/connection-token

# 自动确认 Hub 升级
curl -LsSf https://github.com/aidreamwin/vibemobile/releases/latest/download/hub-install.sh | sh -s -- --yes
```

以上 Runner 示例使用包含 `ID:token` 的连接令牌文件。若文件仅含独立 token，同时传入 `--runner-id`。私有 CA 可通过 `--hub-ca` 指定。

PowerShell 可在安装命令后追加相同参数。

```powershell
& ([scriptblock]::Create((curl.exe -LsSf 'https://github.com/aidreamwin/vibemobile/releases/latest/download/hub-install.ps1' | Out-String))) '--workspace=D:\code' '--port=8080'
```

| 参数 | 用途 |
| --- | --- |
| `--target` | 安装根目录 |
| `--workspace` | 首次安装的工作区，多目录用 `:`（Windows 用 `;`）分隔 |
| `--pm2-name` | 自定义 PM2 应用名称 |
| `--port` | Hub 浏览器端口 |
| `--runner-port` / `--codex-port` / `--opencode-port` | 私有端口，默认 Hub 本机 Runner 为 Hub 端口 + 1，远程 Runner 为 `5901`，Codex 为 `6900`，OpenCode 为 `6920` |
| `--tls` / `--public-host` | Hub 原生 TLS 及附加域名 |
| `--hub-url` / `--runner-id` / `--runner-token-file` / `--hub-ca` | Runner 首装配置 |
| `--yes` | 自动确认升级 |
| `--no-start` | 只准备部署文件 |
| `--allow-root` | 明确允许以 root 用户安装 Hub |

## 安装目录与服务管理

- Linux/macOS 默认目录为 `${XDG_DATA_HOME:-$HOME/.local/share}/vibemobile/hub` 与 `${XDG_DATA_HOME:-$HOME/.local/share}/vibemobile/runner`。
- Windows 默认目录为 `%LOCALAPPDATA%\vibemobile\hub` 与 `%LOCALAPPDATA%\vibemobile\runner`。
- 安装根的 `vibemobile.env` 保存配置，`data/` 保存状态和日志，`releases/` 保存版本，`active-release.json` 记录当前版本。
- Linux/macOS 自动安装的 Node.js 位于用户数据目录，PM2 位于 `~/.local/bin`。新终端需要时执行 `export PATH="$HOME/.local/bin:$PATH"`。Windows 可将用户 npm 安装目录加入 PATH。

在原安装用户的终端中使用 PM2 查看和管理服务。

```sh
pm2 status
pm2 logs vibemobile --lines 50
pm2 logs vibemobile-runner --lines 50
```

需要开机自动恢复 PM2 服务时，Linux/macOS 运行 `pm2 startup` 并按提示配置，再执行 `pm2 save`。Windows 可配置任务计划程序运行 `pm2 resurrect`。手工部署和服务管理详见 [PM2 部署](pm2-release.md) 和 [部署指南](deployment.md)。

## 常见问题

| 现象 | 检查方式 |
| --- | --- |
| 安装脚本下载返回 HTTP `404` | 在 [GitHub Releases](https://github.com/aidreamwin/vibemobile/releases) 确认存在已发布版本，且包含对应安装脚本。维护者可查看 [发布流程](releasing.md)。 |
| 提示 `Interactive input requires a terminal` | 在具备交互能力的终端运行。自动升级使用 `--yes`，Runner 无人值守安装使用 `--hub-url` 与 `--runner-token-file` 等选项。 |
| 端口已被使用 | 通过 `--port`、`--runner-port`、`--codex-port`、`--opencode-port` 选择空闲且互不重复的端口。 |
| 依赖安装或构建失败 | 检查 GitHub、npm registry、Node.js 下载源的网络连通性及系统构建工具链。 |
| Runner 已启动但在 Hub 中显示离线 | 确认 Hub 地址能从 Runner 访问、连接令牌有效、HTTPS 证书受信任，查看 `pm2 logs vibemobile-runner --lines 50`。 |
