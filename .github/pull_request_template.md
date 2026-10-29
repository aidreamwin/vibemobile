## 改动内容

<!-- 一句话说明这个 PR 做了什么，以及为什么需要它。 -->

## 验证

- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build:all`
- [ ] 涉及前端交互时，已跑浏览器冒烟（或说明为什么没有）
- [ ] 涉及真实代理行为时，已跑对应的 `test:*` / `smoke:*` 脚本（或说明为什么没有）

## 版本号

- [ ] 后端有代码改动 → 已抬高 `apps/server/package.json`
- [ ] 前端有代码改动 → 已抬高 `apps/web/package.json`
- [ ] 只改文档 / 注释 / 测试，不需要抬版本
- [ ] 没有升级 Codex CLI 的固定版本（如需要，请单独说明并附验证结果）

## 安全

- [ ] 没有提交 `.vibemobile/`、`certs/`、`release/`、`runner-credentials.json` 或任何凭据
- [ ] 日志、截图、测试夹具中没有真实 PIN / token / 主机名 / 内网地址
- [ ] 涉及权限档位、终端、文件写入或认证时，已说明对安全边界的影响

## 文档

- [ ] 已更新受影响的 README / docs（契约、命令、部署方式、已知限制）
