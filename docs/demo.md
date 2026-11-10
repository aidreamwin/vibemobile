# 功能演示与素材复现

- [本地素材预览](media/index.html)：总览图、按需播放 GIF、七张原始界面截图。
- [流程 GIF](media/workflow.gif)：会话 → 发任务 → 流式输出 → 授权 → Diff → 源码 → 终端 → Provider 设置。
- 真实 React 前端，390 × 760 手机视口；流程、文案与时间固定，可重复生成。

## 场景与素材

| 素材 | 展示价值 |
|---|---|
| [总览](media/webp/overview.webp) | 用手机指挥 AI，持续推进编码任务 |
| [会话](media/webp/sessions.webp) | 统一查看 Codex、Claude Code、OpenCode 会话 |
| [流式输出](media/webp/streaming.webp) | 发送任务、查看输出与执行计划 |
| [授权](media/webp/approval.webp) | 看清命令、工作目录、原因，再允许或拒绝 |
| [Diff](media/webp/diff.webp) | 检查修改与新增测试 |
| [源码](media/webp/source.webp) | 从回答中的文件引用定位到源码 |
| [终端](media/webp/terminal.webp) | 持久终端的界面与接续提示 |
| [设置](media/webp/settings.webp) | 在 Codex、Claude Code、OpenCode 之间切换，并管理模型 |

## 重新生成

- 要求：Node.js 20+、npm；Windows 默认使用已安装的 Edge。
- 其他系统先运行 `npx playwright install chromium`。
- Windows 无 Edge：设置 `VIBEMOBILE_DEMO_BROWSER` 为 Chromium / Chrome 可执行文件路径。

```bash
npm ci
npm run docs:media
npm run docs:media:webp
```

- 输出：`docs/media/webp/`；覆盖同名素材并清理代码生成的 PNG；手工提供的理念配图和架构图也会转换到该目录，缺失的 PNG 自动忽略；不修改业务源码、生产 `dist/`、本机服务或 Git 暂存区。
- `docs:media:webp` 默认调用 PATH 中的 `ffmpeg`，使用 `-quality 95`；未加入 PATH 时，将 `VIBEMOBILE_FFMPEG` 设置为 ffmpeg 可执行文件路径。
- [manifest.json](media/manifest.json)：固定时间、视口、分镜时长、fixture 哈希、产物尺寸与 SHA-256。
- 流程、文字、数据固定；浏览器 / 系统字体版本不同可能改变像素与文件哈希，不保证跨平台逐字节相同。

## 调整第一版

| 修改内容 | 位置 |
|---|---|
| 对话、项目名、路径、Diff、测试输出、分镜文案 | `scripts/docs-media/fixtures.mjs` |
| 总览 / GIF 排版、颜色、本地预览 | `scripts/docs-media/layout.mjs` |
| 操作顺序、停留时间、截图断点 | `scripts/docs-media/generate.mjs` |
| REST / WS、状态恢复、终端回放 | `scripts/docs-media/mock.mjs` |

```bash
npm run docs:demo
```

- 打开命令打印的本地地址；只监听回环接口；`Ctrl+C` 关闭并清理临时构建。
- 可设 `VIBEMOBILE_DEMO_PORT`（0–65535，默认 0 自动分配端口）。
- 支持：打开“修复购物车总价” → 发任务 → 授权 → Diff → 源码 → 终端 → 设置页切换 Provider。
- 设置页展示 Codex、Claude Code、OpenCode 及 GPT-6.1-Sol；模型和连接配置可按项目调整。

## 数据边界

- 路径 `/demo/aurora-shop`、机器名、会话、时间、模型选择、测试结果均由本脚本固定；不读取真实工作区、用户目录、代理历史、配置或密钥。
- 独立浏览器上下文，无本机用户 Cookie / 存储；禁用 Service Worker；录制只允许访问本次演示服务，HTTP / WS 外部请求会使生成失败。
- 演示服务不连接代理 / PTY，不解释终端输入；源码内容与终端输出由流程文件提供；静态文件仅从本次临时前端构建读取。
- 构建戳使用固定演示版本；只截取网页内容，不录制桌面、地址栏、操作系统通知。
- 每个录制断点检查浏览器异常、未知 API、外部请求和可见文本中的常见本机路径 / 地址；生成后仍应目视检查图片再发布。
