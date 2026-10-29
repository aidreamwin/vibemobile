# Changelog

VibeMobile 的后端和前端使用**独立版本号**，分别记录在
`apps/server/package.json` 和 `apps/web/package.json`。本文件记录仓库层面的
变更；更早的逐条改动见 git 历史。

## Unreleased

当前 workspace 版本：`server 0.1.24` / `web 0.1.38`。

### Added

- `LICENSE`（MIT）。
- `SECURITY.md`：威胁模型、漏洞报告渠道和安全部署清单。
- `CONTRIBUTING.md`：开发、验证、PR 和版本号约定。
- `CHANGELOG.md`、`docs/releasing.md`：版本与发布流程。
- GitHub Actions CI、issue 模板、PR 模板。
- Biome 格式化 / lint、覆盖率配置、`typecheck` 脚本。
- `docs/architecture.md`、`docs/deployment.md`、`docs/limitations.md`。

### Security

- 升级 `fastify` 到 5.12.7、`@fastify/static` 到 10.1.6（修复目录遍历 /
  路径规范化相关的 4 个 advisory）、`@modelcontextprotocol/sdk` 到 1.32.1，
  以及传递依赖 `fast-uri`、`brace-expansion`。
- 升级 `vitest` / `@vitest/coverage-v8` 到 4.1.12，修复 tinypool 与
  `@vitest/mocker` 的 devDependency 漏洞；`npm audit`（含 devDependencies）
  现在为 0。
- `@fastify/static` 10 的静态注册 / SPA fallback / 路径穿越请求已用独立脚本
  验证，未启动 3000 服务。

### Changed

- 重写 README，面向第一次接触项目的开发者：安全警告前置、修正快速开始、
  移除内部环境信息。
- 拆分后端 `ClaudeProvider` 的运行时 / 转写 / 输入流模块，拆分
  `mapClaudeEvents` 的纯映射工具。
- 拆分前端 `Chat` 和 `Sessions` 页面中的展示组件。
- 服务端构建拆分为 `tsconfig.build.json`，测试文件不再进入 `dist/`；
  `scripts/` 纳入类型检查。
- 前端非首页路由改为 `React.lazy`，并把 React / Radix / Markdown / xterm
  拆成独立 vendor chunk；首屏入口从单个约 1 MB bundle 降到约 300 kB，
  终端和 Markdown 只在打开对应页面时加载。
- 清理全部 a11y lint 警告（按钮 `type`、SVG 替代文本、非交互元素事件），
  确有理由的保留项用带说明的 `biome-ignore`。
- 清理文档中的主机名、内网地址、进程号和内部路径。

### Fixed

- README 的「直接跑」快速开始没有构建后端，干净 clone 上 `npm start` 会失败。
- README 中的测试数量已过期；改为描述测试分层，不再硬编码数量。
- 路由中 `sandbox` / `approvalPolicy` 的 `any` 类型改为协议枚举。
- Claude：显式开启自动压缩，并按模型上下文窗口留 20% 余量；首回合从模型目录
  的 `[1m]` 标记推断。修复 DeepSeek 1M 会话在工具密集回合超过
  1,048,576 token 硬上限、返回 400 `maximum context length` 的问题。

## 历史版本

当前发布版本请查看两个 workspace 的 `package.json`。最近的用户可见变更包括：

- 代理失败与重试的可见性、部署安全恢复（server 0.1.21 / web 0.1.35）。
- 转写按条目预算分页（`items`），替代固定轮数。
- Claude 转写跨压缩边界完整读取。
- 会话列表显示创建时间。
