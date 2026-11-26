# 一键安装与升级

[VibeMobile GitHub Release](https://github.com/aidreamwin/vibemobile/releases) 中提供 Hub、Runner 的安装脚本和发布包。

## 安装 Hub

在 Hub 机器切换到需要管理的项目目录，执行以下命令。

```sh
curl -LsSf https://github.com/aidreamwin/vibemobile/releases/latest/download/hub-install.sh | sh
```

Windows PowerShell：

```powershell
& ([scriptblock]::Create((curl.exe -LsSf 'https://github.com/aidreamwin/vibemobile/releases/latest/download/hub-install.ps1' | Out-String)))
```

- 默认启动 Hub 和本机 Runner，浏览器端口为 3000。
- 安装器自动准备 Node.js 22+、PM2、Linux 原生模块构建依赖，安装项目依赖并构建服务。
- 默认工作区为执行命令时的目录。安装结束后显示访问地址和首次生成的 PIN。
- 在受信任的局域网或 VPN 内访问 Hub。HTTPS 可在首次安装时通过 `--tls` 启用，或配置反向代理。
- 代理 CLI 的登录凭据来自运行服务的用户。按需完成 Codex、Claude Code 等 CLI 的登录。

## 安装 Runner

1. 登录 Hub，在「设置 → 执行机器 → 添加执行机」创建连接令牌。
2. 在 Runner 机器切换到项目目录，运行安装命令。

```sh
curl -LsSf https://github.com/aidreamwin/vibemobile/releases/latest/download/runner-install.sh | sh
```

Windows PowerShell：

```powershell
& ([scriptblock]::Create((curl.exe -LsSf 'https://github.com/aidreamwin/vibemobile/releases/latest/download/runner-install.ps1' | Out-String)))
```

3. 输入 Hub 浏览器地址，例如 `http://192.168.1.10:3000` 或 `https://hub.example.com`，再粘贴连接令牌。安装器将 HTTP/HTTPS 地址转换为 WS/WSS。连接令牌包含 Runner ID，旧版独立 token 会额外询问 ID。
4. 使用 Hub 私有 CA 时，提供 CA 公钥证书路径。在 Hub 执行机器列表查看连接状态。

Runner 主动连接 Hub，默认私有服务端口为 5901。

## 升级已有安装

再次执行相同的安装命令，确认 `Upgrade this installation? [y/N]`。安装器先构建新版本、切换服务并检查健康状态，失败时尝试回滚。PIN、Runner 凭据、会话数据、工作区和端口配置在升级时保留。

- 默认识别当前用户的安装目录和 PM2 应用 `vibemobile` / `vibemobile-runner`。
- 自定义目录的旧 PM2 安装可使用 `--target=<原安装根目录>`；安装根目录包含 `vibemobile.env`。
- `--yes` 用于无人值守升级。重复安装相同版本会复用已有构建。
- 指定版本时将 URL 中的 `latest/download` 改为 `download/<版本标签>`。

## 自定义安装

```sh
curl -LsSf https://github.com/aidreamwin/vibemobile/releases/latest/download/hub-install.sh | sh -s -- \
  --workspace=/srv/projects --port=8080 --tls

curl -LsSf https://github.com/aidreamwin/vibemobile/releases/latest/download/runner-install.sh | sh -s -- \
  --hub-url=https://hub.example.com --runner-id=runner-b --runner-token-file=/path/to/token
```

PowerShell 可在安装命令后追加相同的参数，例如 `'--workspace=D:\code'`。

| 参数 | 用途 |
| --- | --- |
| `--target` | 安装根目录 |
| `--workspace` | 首次安装的工作区，多目录用 `:`（Windows 用 `;`）分隔 |
| `--pm2-name` | 自定义 PM2 应用名称 |
| `--port` | Hub 浏览器端口 |
| `--runner-port` / `--codex-port` / `--opencode-port` | 私有端口，同机多个实例时使用不同端口 |
| `--tls` / `--public-host` | Hub 原生 TLS 及附加域名 |
| `--hub-url` / `--runner-id` / `--runner-token-file` / `--hub-ca` | Runner 首装配置 |
| `--yes` | 自动确认升级 |
| `--no-start` | 只准备部署文件 |
| `--allow-root` | 明确允许以 root 用户安装 Hub |

## 文件与管理

- Linux/macOS 默认目录为 `${XDG_DATA_HOME:-$HOME/.local/share}/vibemobile/hub` 和 `runner`。
- Windows 默认目录为 `%LOCALAPPDATA%\vibemobile\hub` 和 `runner`。
- 安装根的 `vibemobile.env` 保存配置，`data/` 保存状态和日志，`releases/` 保存版本，`active-release.json` 记录当前版本。
- Linux/macOS 自动安装的 Node.js 位于用户数据目录，PM2 位于 `~/.local/bin`。新终端需要时执行 `export PATH="$HOME/.local/bin:$PATH"`。
- 通过 `pm2 status`、`pm2 logs` 和 `pm2 restart <name> --update-env` 管理服务。Windows 的自启及手工部署参数见 [PM2 部署](pm2-release.md) 和 [部署指南](deployment.md)。
- 安装时需访问 GitHub Release、npm registry，缺少 Node.js 时访问 nodejs.org。Linux 缺少 C++ 工具链时安装器使用 apt/dnf/yum/apk，普通用户可能需要 sudo。官方 Node.js 二进制运行需兼容的系统库。
