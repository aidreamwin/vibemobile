# 代理运行时（Agent Runtime Pack）

- 代理二进制不再和应用发布绑定。升级 Codex / Claude / OpenCode 只换一个目录，不跑 `npm ci`、不重建应用。
- 应用代码本身的升级仍走 [deployment.md](deployment.md) 的流程；这里只解决高频的代理 CLI 更新。

## 布局

```text
<stateDir>/agents/
  codex/
    0.166.0/            # npm 安装出来的独立目录
    current -> 0.166.0  # Windows junction / POSIX symlink
  claude/
    2.1.316/
    current -> 2.1.316
  opencode/
    2.2.5/
    current -> 2.2.5
```

`stateDir` 默认 `.vibemobile/`；`VIBEMOBILE_AGENTS_DIR` 可整体覆盖。目录随 `stateDir` 持久化（Docker 下是 `vibemobile-data` 卷）。

## 升级

设置页 →「代理运行时」→ 对应行的更新按钮。只下载到执行机器，Hub 只转发请求。

命令行等价：

```bash
npm run agents:update             # 三个都更新
npm run agents:update -- claude   # 只更新一个
```

- 版本来自 [apps/server/src/agents/manifest.ts](../apps/server/src/agents/manifest.ts)：Codex / Claude 是**补丁级范围**（如 `~0.166.0`），OpenCode 是**精确 pin**（`2.2.5`）。客户端只能选择 agent id，不能指定版本。
- 补丁升级不需要重新部署应用；minor / major 升级会改 `manifest.ts`，那一次仍需应用发布（协议措辞可能变化）。
- Codex 更新完成后会重启 app-server：**正在执行的回合会中断**。
- Claude 每回合现起子进程，**下一回合自动生效**，无需重启。
- OpenCode managed 模式更新后会重启私有 server（**当前回合中断**）；attach 模式的外部 service 不受影响，更新只对下一次 spawn 生效。
- 接口：`GET /api/agents` 查状态，`POST /api/agents/:id/update` 启动后台任务（202）；安装期间轮询前者。

## 供应商配置

- 设置页 →「Agent 配置」：按 Codex / Claude Code / OpenCode 添加、编辑、删除和启用供应商；保存与启用分开，恢复按钮切回执行机原有配置。
- 「执行机现有配置」直接读取 Agent 原始文件，显示来源路径并提供编辑：Codex `config.toml` / `auth.json` 的 API Key、Claude `settings.json` 的连接与模型别名、OpenCode 配置内的供应商 / 模型。遵循 `CODEX_HOME`、`CLAUDE_CONFIG_DIR`、`XDG_CONFIG_HOME`、`OPENCODE_CONFIG`。
- 编辑现有配置会写回原文件；修改前备份到 `<stateDir>/agent-config-backups/`，保留注释与无关设置。文件在读取后被其他程序修改时返回 409，须刷新重读。密钥不回传，留空保留；Codex `env_key` 指定的环境凭据须在执行机修改。
- 每份配置包含名称、接口地址、API Key、默认模型；OpenCode 启用时必须有接口地址和模型。Codex 使用 Responses 兼容接口，OpenCode 使用 Chat Completions 兼容接口。
- 配置存于当前 runner 的 `<stateDir>/agent-profiles.json`；Hub 仅转发，切换 runner 后管理另一台机器。
- API Key 以明文保存在执行机状态文件中，仅通过子进程配置注入，不放在 Codex 命令行参数中；接口只返回是否已保存密钥。编辑时密钥留空保留，勾选清除才删除。状态目录应仅允许运行账户访问。
- 新增供应商仅保存到 runner 状态目录；启用时覆盖子进程连接设置，恢复现有配置即移除覆盖。OAuth、MCP、会话文件均不改写。
- 启用或编辑当前配置：Codex / OpenCode 重启并中断正在进行的回合；Claude 下一回合生效。重启失败会恢复原选择并尝试恢复服务。
- Codex / OpenCode attach 到外部服务时可保存配置，不能启用；连接设置由外部服务维护。OpenCode 的 `OPENCODE_CONFIG_CONTENT` 与配置合并时须为 JSON 对象。
- 默认模型用于新建会话；已有会话继续使用其选择的模型，可在会话中手动切换。
- 接口：`GET /api/agent-profiles`、`POST /api/agent-profiles/:agent`、`PATCH /api/agent-profiles/:agent/:id`、`DELETE /api/agent-profiles/:agent/:id`、`POST /api/agent-profiles/:agent/:id/activate`；PATCH 的 `id=native` 编辑原文件（须传 `revision`），activate 的 `id=native` 恢复现有配置。

## 解析优先级

| 场景 | 使用 |
|---|---|
| 设置了 `CODEX_BIN` | 该路径（最高优先级） |
| `agents/codex/current` 有可用二进制 | 运行时包 |
| 否则 | 应用 `node_modules` 里的内置版本 |
| 最后 | PATH（Docker 的 `/opt/codex-cli`） |

Claude 只在运行时包可用时传 SDK 的 `pathToClaudeCodeExecutable`；否则用 SDK 自带的 CLI。

OpenCode 的优先级是 `OPENCODE_BIN` → `agents/opencode/current` → 内置 → PATH。
运行时包里的 `@opencode/cli` postinstall 已按 CPU 在普通 / baseline 之间选好二进制，
优先用它；Windows 的 PATH 回退会把 npm 的 `.cmd` shim 交给 `cmd.exe /d /s /c`。

`current` 在**每次 spawn 时重新解析**：Codex 重启 app-server、Claude 每个回合、OpenCode 下一次 attach/spawn 都会读到新值。

## 回滚与兼容

- 旧版本目录保留，回滚 = 把 `current` 指回旧目录（或删除 `current` 用内置版本）。
- 新 Codex 包起不来时，安装任务会自动把 `current` 切回上一版。
- `manifest.ts` 是白名单：只列经过本应用验证的版本。Codex 的 app-server 协议没有版本协商，**不要加「latest」或自动追新**。
- OpenCode 的 HTTP API 标注 experimental，所以用精确 pin；升版必须重跑 `npm run smoke:opencode` 并核对事件字段。
- 升代理版本时：改 `manifest.ts` → 跑 `npm run smoke` / `npm run test:approval` / Claude 冒烟 / `npm run smoke:opencode` → 再发布。

## 故障排查

```bash
curl http://localhost:3000/api/agents        # active / source / installed / error
```

- `source: bundled`：包没装或不可用，正在用内置版本。
- `source: missing`：两边都找不到，代理不可用。
- `error`：上一次安装失败的原因；填满错误时先看服务日志里的 `[npm]` 与 `[agents]` 行。
- 安装需要执行机器能访问 npm registry，并存在 `npm`；这一步与应用的 `node_modules` 无关。
