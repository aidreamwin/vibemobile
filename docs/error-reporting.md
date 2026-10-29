# 代理错误展示与安全更新

Claude 实时 SDK 的 `system/api_retry` 使用 snake_case 字段，历史 JSONL 的 `system/api_error` 使用 camelCase；两者归一化为重试提示与可折叠的“自动重试记录”。合成 API 错误没有流式 delta，必须直接生成错误卡片。Codex 的 `error.willRetry` 使用相同界面，另存有界诊断记录供刷新后查看。重试不表示回合结束，收到正常输出后移除实时提示，保留历史记录。

失败后在输入框上方显示“重试上一条”，仅点击后才重新提交最后一条用户指令，使用当前输入框的权限、模型和推理档位；原图片读取失败时停止提交并提示重新选择图片。

上一条仅有失败诊断、没有实际回复或工具执行内容时，同样文字与图片的重试复用原消息气泡；保留重试及错误记录，实时与刷新后的历史显示一致。有实际回复或修改过输入时保留独立消息。

`turn.completed.error` 必须显示为错误卡片，不能仅改变内部状态；之后的 `session.status=idle` 不能清除失败原因。Claude 历史按 `isApiErrorMessage` 恢复失败卡片，Codex 历史保留 `turn.error`。界面刷新后仍显示失败原因和“本轮失败”。SDK 子进程未返回 result 就退出时按失败结束，不能永远显示运行中。

验证：`npm test`；两端 TypeScript 构建；`node apps/web/scripts/smoke-errors.mjs <web-dist> <截图目录>` 在隔离的假 HTTP/WS 服务中验证手机布局、重试、失败和刷新，不运行真实代理。

## Windows 更新

当前服务由 NSSM 托管，不能依赖服务内部的会话去完成自己的重启。先在服务目录外构建候选产物，再让 SYSTEM 计划任务运行 `scripts/windows/safe-restart.ps1`。SYSTEM 只管理服务；NSSM 服务的登录账户、环境、凭据不变。

任务目录包含 `server/`、`web/`、脚本副本、`job.json`、`baseline.json` 和 `expected.json`。job 记录 `root/service/node/nssm`；两个健康检查配置记录 `root/stateDir/ca/url/runners/versions/timeoutMs`，不保存密钥。健康检查在进程内读取现有签名密钥，仅用于本机只读验证，不输出凭据。

先以 `-VerifyOnly` 运行独立计划任务，通过后再执行更新。脚本有界停止服务、保留旧 dist、安装候选产物，然后检查 HTTPS、版本、Codex ready、runner 连接、会话读取和前端资源；失败时自动恢复旧 dist 并再次验证。停止卡住时只终止已核验身份的 NSSM 及其子进程。结果写入任务目录 `result.json`，旧版本保留供人工恢复。

验证记录请写在对应的 PR / Release 中，不要在本文件里记录带机器标识的部署细节。
