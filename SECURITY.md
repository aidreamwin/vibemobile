# 安全策略

## English summary

VibeMobile is a **single-user** tool: one PIN protects an entry point that can run
arbitrary commands on the host. Anyone who can authenticate is expected to have
full control of that machine. Do not expose it directly to the public internet;
put HTTPS and an authenticated reverse proxy or tunnel in front of it, and never
set `VIBEMOBILE_NO_AUTH=true` on a reachable interface.

Please report vulnerabilities privately through the hosting platform's Security
Advisories / private vulnerability reporting, not in a public issue. Include the
affected version, reproduction steps, impact, and any suggested fix. We aim to
acknowledge reports within seven days.

## 支持的版本

当前开源版本为 `0.1.x`，前端和后端各自使用独立版本号（见 [docs/releasing.md](docs/releasing.md)）。
安全修复进入最新版本，不保证为更早版本回补。

## 报告漏洞

**不要在公开 issue 中披露未修复的安全问题。**

请使用代码托管平台（GitHub）的 **Private vulnerability reporting / Security
Advisories** 私下报告，并在报告中包含：

- 受影响的前端 / 后端版本（设置页 → 版本，或 `/api/health`）
- 复现步骤和所需前置条件
- 影响范围（认证绕过、命令执行、路径逃逸、信息泄露等）
- 你建议的修复方向（如果有）

我们尽量在 **7 天内确认收到**，修复可用后会与你协调披露时间。请给修复和
部署留出合理时间，不要在公开渠道抢先披露。

## 威胁模型

VibeMobile 是**单用户**工具：一个 PIN 对应一个能在宿主机上执行命令的代理入口。
它**不是**多租户服务，也**不**试图在登录后的用户之间做隔离。

### 明确的设计边界（不是漏洞）

- 不提供多用户、角色、ACL、配额或按用户隔离。
- 登录后的用户可以打开终端、让代理执行任意命令；「完全访问」档等同于无人值守。
- 代理自身的错误、幻觉、数据删除、资源消耗不由本应用负责。
- 设置 `VIBEMOBILE_NO_AUTH=true` 后，任何能连上端口的人都能操作机器 —— 这是
  显式的部署选择，不是认证绕过。
- 已经拿到宿主机文件系统或进程权限的攻击者不在防护范围内。

### 需要认真防护的面

- 认证绕过、PIN 暴力破解、JWT 伪造 / 过期 / 撤销
- 路径逃逸：`workspaceRoots` 之外的文件读取、写入、Diff
- WebSocket 同源校验，审批与终端会话的跨会话串线
- 图片 token 的路径注入，以及 SVG 等可执行内容导致的 XSS
- PIN、JWT 签名密钥、代理凭据进入日志、构建产物或 git 历史
- 依赖供应链：Codex CLI 的版本锁定、npm lockfile、构建脚本

## 安全部署清单

- **不要直接暴露到公网。** 需要公网访问时，在前面使用 HTTPS 反向代理或安全隧道。
- 设置足够强的 PIN；不要在可访问的部署上设置 `VIBEMOBILE_NO_AUTH`。
- 保护状态目录（默认 `.vibemobile/`）：它包含 JWT 签名密钥、PIN 和会话存档。
- 只有在**真的**位于反向代理 / 隧道之后时才设置 `VIBEMOBILE_TRUST_PROXY`；
  这个开关会让登录限流信任客户端可伪造的 `X-Forwarded-For`。
- 以最小权限账户运行服务，`VIBEMOBILE_ROOTS` 只包含代理真正需要访问的目录。
- 不需要终端时设置 `VIBEMOBILE_TERMINAL=off`。
- 手机丢失时，删除状态目录中的 `state.json` 并重启服务：这会生成新的 PIN 和
  JWT 签名密钥，现有登录态全部失效。
- 升级 Codex CLI 前先读 [docs/releasing.md](docs/releasing.md)：app-server 协议
  没有版本协商，跨版本可能出现静默字段漂移。

## 依赖与第三方组件

- Codex CLI 版本精确固定在根 `package.json` 的 `devDependencies`，不由本仓库维护。
- Claude Code 通过 `@anthropic-ai/claude-agent-sdk` 调用，CLI 随包分发。
- `apps/server/src/distributed/fixtures/` 里的证书和私钥是**公开、一次性**的测试
  夹具，不能用于任何部署；详见该目录的 README。
