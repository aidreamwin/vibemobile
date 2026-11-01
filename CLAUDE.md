# CLAUDE.md

- 改仓库的操作手册，整份载入上下文；只写「怎么做/怎么验」和「删掉就会静默写错」的约束。
- 文档地图：[README](README.md) · [架构](docs/architecture.md) · [部署](docs/deployment.md) · [限制](docs/limitations.md) · [发布](docs/releasing.md) · [安全](SECURITY.md) · [贡献](CONTRIBUTING.md)
## 文档与代码治理（严格执行）

#### 文档
- 覆写不追加：删过时描述，不留历史/Changelog（Git 负责历史）。
- 电报体：无过渡句、客套、背景；只用列表、表格、代码块、Mermaid。
- 单文档 ≤150 行；超了先删再写；不复述代码逻辑，只写环境/平台限制、非直觉 Hack 的原因、命令。

#### 代码
- 禁止补丁堆叠：直接改原逻辑，不建 `func_v2()` / `*_new.py` / `test_fix.py` 副本。
- 禁止硬编码：路径、硬件参数、超参、量化阈值、IP、端口 → `configs/` 或环境变量。
- 临时调试脚本、print、一次性验证 → `.ai/scratch/`；解决后删除或转成单测，禁止污染主目录。
- 跑通复杂流程（转换/量化/交叉编译/板端推理）必须封装成带参数校验的脚本或 Makefile 靶点。
- 职责单一；跨层不访问实现细节；接口先行（先定接口再填实现）。
## 是什么
- 手机浏览器远程驱动本机编码代理，接 Codex 与 Claude Code；单用户、无权限体系。
- 后端唯一理由：app-server 拒绝带 `Origin` 头的 WS 升级，浏览器 WS 必带 → 浏览器不能直连，Node 后端充当 WS 客户端。
## 命令

```bash
npm run dev / dev:server / dev:web      # 5800 / 5802 / app-server 6800；端口被占直接退出
node scripts/dev.mjs --server-port=5900 --codex-port=6801 --web-port=5902
npm run build                           # ⚠️ 只构建前端
npm run build:all                       # 前后端；后端 postbuild 写 dist/version.json
npm start                               # 跑 apps/server/dist（部署段 3000）
npm run lint / lint:fix / format / format:check
npm run typecheck                       # 前后端 tsc；server 的 scripts/ 也检查
npm test / test:coverage
npm test --workspace=@vibemobile/server -- src/codex/mapEvents.test.ts
# 自 spawn CLI，无需服务：
npm run test:approval / smoke
npx tsx apps/server/scripts/smoke-image.ts / smoke-claude.ts / test-claude.ts
# 需服务在跑（<PIN>）；smoke:browser 需先 build，覆盖面最广：
npm run test:hub / test:terminal / smoke:browser -- <PIN>
node apps/web/scripts/smoke-claude-browser.mjs <PIN>
```
### 构建与版本
- 服务端跑 `dist/`（无 watch），冒烟读 `apps/web/dist`；改源码必须重建再测。
- 部署中服务实时读 `apps/web/dist`（改前端不重启），后端 dist 在进程启动时载入；**动 `/api` 契约必须重建后端并重启**。
- 本机有 3000 部署时不要原地 build 前端；验证用 `npx vite build --outDir <tmp>` / `npx tsc -p apps/server/tsconfig.build.json --outDir <tmp>`；不要擅自停/重启 3000。
- 抬版本：改前端抬 `apps/web/package.json`，改后端抬 `apps/server/package.json`，动 `packages/protocol` 两处都抬，末位 +1；只改文档/注释不抬；两半故意不同号。
- tsconfig：`tsconfig.json` 类型检查（含 `scripts/`，有意，别排除回 tsconfig），`tsconfig.build.json` 构建（只 `src/`、排除 `*.test.ts`），`dist/` 不应有测试；Vitest 4 不默认排除 `dist/`，两个 config 都显式排除 `dist/`/`coverage/`。
- Biome：`noExplicitAny`/a11y/hooks 为 warn，新代码不要增加；禁用 `@ts-ignore`/`eslint-disable`，用 `// biome-ignore lint/<rule>: 理由`；CI 顺序 `npm ci → lint → typecheck → test:coverage → build:all`。
## 架构
### provider 接缝
- `providers/types.ts` 的 `AgentProvider` 是唯一接缝；`routes/`、`ws/hub.ts` provider-agnostic；前端只消费 `packages/protocol/src/events.ts` 的 `AgentEvent`；加 provider = 实现接口 + `index.ts` 里 `registry.register()`。

| | Codex | Claude Code |
|---|---|---|
| 传输 | 后端 spawn 的常驻 app-server，JSON-RPC over WS | SDK `query()` |
| 进程 | 长驻，服务全程复用 | 每回合一个子进程 |
| 续接 | 订阅同一 thread | 首回合 `sessionId`，之后 `resume` |
| 回合中插话 | `turn/steer` 折进当前回合 | 保持 stdin 打开，折进当前回合（不打断在跑的工具） |
| 会话元数据 | app-server thread 记录给 `model`/`reasoningEffort` | 没有，自己存 |
| 端口 | 占一个 | 不占 |

- Claude session id 本地 `randomUUID()`，首回合经 `options.sessionId` 交给 CLI。
- `config.ts` 的 `repoRoot()` 从模块位置往上找含 `workspaces` 的 package.json，不从 cwd（workspace 脚本 cwd 是 `apps/server`，会解析出第二个 `.vibemobile/`）；`packages/protocol` 不发产物、只被 `import type`，改它不用构建。
### 会话路由
- `providers/registry.ts` 维护 `sessionId → providerId`：每个学到 id 的路径 `bind()`，未命中才挨个问 provider，兜底 `default`；`registry.default` = 第一个注册的 provider（Codex）—— `index.ts` 注册顺序有意义。
- `/api/sessions` 不带 `provider` = 只有 Codex（旧契约）；全部要显式 `?provider=all`（逐 provider 拉、按 `updatedAt` 合并，单个抛错记 warn 当空）；未知 provider 兜底 `default`（200）；`all` 故意不进 `packages/protocol`（纯类型，服务端不引 runtime）。
- `Transcript.hasMore` 只在真时出现；`hasMore`=「还有更早的」，`nextCursor`=「怎么取」，不能互相替代；客户端原样回传 `?cursor=`；Claude 游标是 `c:<跳过的轮数>`（从最新端数，会漂移，靠 item id 去重）。
- `?items=`≈渲染条目数，`?limit=`=轮数，共用一个游标；前端两个入口都发 `items: 60`；三条不变：切在整轮边界、有更旧轮就绝不返回空页、游标按轮计；带 `items` 时仍发 `limit`（默认 60）。Codex 只收轮数：倍增探测后必须再发一次精确 `limit=kept` 请求，否则探测游标会静默跳过轮；Claude 按 prompt 数倍增（`skip + prompts + liveExtra`），无 `items` 走旧路径，`limit` 缺省=全部。
- `search`/`archived`/`pinned` 不同：Codex `search` 走 `searchTerm`（仅标题），Claude 在已取页子串匹配；`archived` 过滤；`pinned` 仅 `PATCH`；置顶排序在前端。
- 审批：`answerApproval` 只带审批 id → `ws/hub.ts` 另建 `requestId → providerId` owner 表；`approval.requested`/`resolved` 全局广播，两半必须一起发。
### Hub 多 runner
- 名单 `<stateDir>/runners.json`（Docker: `hub-data` 卷），`VIBEMOBILE_RUNNERS_FILE` 可覆盖但必须可写，否则 `runner_store_unwritable`；Hub 唯一写入者，外部改文件要重启、且下次操作按内存重写。
- 明文 token 只在创建/刷新响应出现一次，磁盘只有 SHA-256；刷新顺序：先落盘 → 改内存 → terminate 旧隧道。
- `hubApp.ts` 只 `import type` `RunnerStore`；`runnerStore.ts` 运行时反向导入 `tokenHash`/`validateRunners`，不能变成值导入（模块环）；只有 `remoteIds` 可管理，默认 `local`（`VIBEMOBILE_DEFAULT_RUNNER=off` 时首个）不可删，否则 `specs` 为空。
### 前端
- `lib/store.ts`：delta 攒在模块级可变结构，rAF 每帧最多 flush 一次（后台退 50ms 定时器）；`item.completed` 权威并丢弃 buffer，但只在 item 自身为空时才折入（Codex 有空 `aggregatedOutput` 的完成帧）。
- `lib/ws.ts` 自带重连 + 订阅重放；`Query` 在 Node 进程，刷新不影响执行；`resumeSession` 重放 live 状态 + `getTranscript` 追加进行中回合。
- 页面逻辑在 `pages/`，展示组件在 `components/`，不要把页面状态（滚动锚点、`loadingOlder`、分页 ref、`showFile`）搬进组件；新页面用 `React.lazy`（首页 `Sessions` 除外）；`manualChunks` 分 React/Radix/Markdown/xterm，不要静态 import xterm/react-markdown 到首屏，也不要提高 `chunkSizeWarningLimit`。
- `loadingOlder` 绝不复用页面 `loading`（矮块会把 `scrollTop` 夹到 0）；锚点用「距底距离」、在响应落地时测，`useLayoutEffect` 里 `scrollTop = scrollHeight - anchor.height + anchor.top`。
- `prependTranscriptItems` 按 item id 去重；`resyncTranscript` 按位置合并（否则旧页被搬到末尾）；同一 cursor 且没加任何 item 时必须丢 cursor（否则自动补页死循环）；Claude `claude:turn:N` 是窗口相对编号，只能拿 item id 当身份。
- 回到原位置（`pages/Sessions.tsx`、`pages/Files.tsx`）：状态放模块作用域（切导航会卸载）；`useLayoutEffect` 在 `!loading` 时恢复；监听里 `loading || editing` 时绝不写偏移（矮块/textarea 会夹到 0）；会话列表锚行 id + 像素，文件页锚 `scrollTop`；列表搜索框禁止 `setLoading(true)`（同上）。
- `App.tsx` 第一枪是 `api.authMode()` 不是 `me()`：`authDisabled` 下 `/me` 永不 401；`me()` 的 401 才去 PIN 页，网络/5xx 是「连不上 + 重试」；连接状态要 `socket.started`，只看 `state` 会让每次加载闪一次假断线。
## 规则
### 权限档位
- 每回合生效的是输入框权限项，覆盖建会话预设（`startTurn()` 用 `opts.sandbox/approvalPolicy` 重算）；输入框必须从会话当前档开始（`SessionSummary.sandbox/approvalPolicy`，内存 `LiveSession` 优先、磁盘兜底）。
- 读不到一律兜底「按需确认」，绝不用「上次在这个 App 选的档」；建会话 9 种组合，输入框只有固定卡（Claude 4 / Codex 3），6 种显示为「按需确认」；不变量：认不出的组合不点亮完全访问，屏幕上的档 == 下一回合发出去的那对。
- `codex/permission.ts` 的 `SANDBOXES`/`APPROVAL_POLICIES` 是唯一运行期闸门（两字段都在枚举里才报）；档位改三处：`apps/web/src/lib/permission.ts`（`PERMISSIONS`/`permissionCardFor()`/`permissionCardsFor()`）与 `claude/permission.ts`（`permissionModeFor()`/`permissionOptionsFor()`）。
- 「自动判断」Claude 专属：同信道 `approvalPolicy:'auto'` + `sandbox:'workspace-write'`；`isApprovalPolicy` 拦 Codex（静默无效）；`permissionCardsFor()` 未知 provider 给窄表；它下 `canUseTool` 0 次。
- `permissionCardFor()` 的 `cards` 必需无默认（Radix 缺 item 会渲染空触发器），`Chat.tsx` 种子和 `<Composer>` 传同一列表。
- `needsDangerousAck('auto')` 永远 false（单测钉着）：变真会设 `allowDangerouslySkipPermissions`，root 容器下 CLI `exit(1)`；「完全访问」= 无人值守，唯一能拿到无限制机器权限的入口。
- `AskUserQuestion` 与权限共用 `canUseTool`；答案只走 `updatedInput.answers`（`{[问题原文]: label}`，多选 `', '` 连接）→ `type:'userInput'` + `ApprovalRequest.questions`，无 `acceptForSession`，`ApprovalSheet.tsx` 见到 `questions` 换表单；给不出答案一律拒绝，只接受形状对的（`answersFor` 返回 `null` 即拒），问题读不出退回普通审批卡，`bypassPermissions` 下照样调用。
- Codex 侧同一形状：`questionsFor`/`answersForQuestions`，`questionIds` 按位置存（响应按 id 索引）。**未实测。**
### 会话与吊销
- JWT 带 `ver`，`verifySession` 要求等于 `config.sessionVersion`；登录不递增（多设备在线），只在 `VIBEMOBILE_PIN` 真变（`verifyPin`）和 `POST /api/auth/logout-all` 吊销；`sessionVersion` 在 `state.json`，`bumpSessionVersion(config)` 先写盘再改内存；TTL 7 天，`POST /api/auth/logout` 只清 Cookie。
### 会话存档（`providers/sessionPrefs.ts`）
- 各存各的词汇、不归一化：Claude `claude-sessions.json`（`permissionMode`），Codex `codex-sessions.json`（`sandbox`/`approvalPolicy`）；文件名与键名不可改（线上有记录）；归一化会把 Codex `(read-only, never)` 报成完全访问。
- `startTurn` 记录 merge 结果而非 `opts`，且在 `await` 之前；`deleteSession` 的 `forget` 在 RPC 成功后（Claude 相反：先 forget 再删盘）；`archiveSession` 不 forget。
- `archived` 只 Claude 存这里，`pinned` 两边都存（Codex 归档走 `thread/archive`）；`MAX_ENTRIES = 500` 淘汰会静默取消归档/置顶（接受，不修）。
- 恢复告警 `#noticed` 只发一次，走 `onNotice`（`onLog` 是 debug）；不读 Thread{Start,Resume,Fork}Response 的 Legacy 字段，不把记住的值塞进 `thread/resume`（会在刚打开时就设成完全访问）；不变量：界面档位 == 下一回合发出去的对。
- Claude 的 `model`/`effort`/档位自己存：`#summaryFromLive`、`#summaryFromInfo`、`#spawnTurn` 三处；`session.effort` 必须进 `Options.effort`；fork 继承。
### Claude 后端
- 分工：`ClaudeProvider.ts`（生命周期/回合/审批/live）、`transcript.ts`（JSONL/排序/`buildTurns`）、`mapClaudeEvents.ts`（实时状态机）、`mapUtils.ts`（纯映射）、`turnInput.ts`（streaming input）、`runtime.ts`（探针/模型/超时/config 目录）；改签名六个一起看。
- `#spawnTurn` 每回合传 `settings.autoCompactEnabled: true`，`autoCompactWindow` = `contextWindow` 的 80%，首回合用 `[1m]` 兜底 1,048,576；删掉会跑到 API 硬上限才 400。
- 插话走输入流：首条后保持 `TurnInput` 打开，`steer` push，CLI 在下一个模型边界折入（一个 `result`、一个 `turn.completed`，`mapper.interject` 不发 `turn.started`）；不取消在跑工具，不用 `priority:'now'`（会中止回合）；`result` 一到先 `run.accepting=false` 再 close 输入流（否则进程不退、`#pump` 卡住）；插话 uuid 不进 `#byCommand`；JSONL 重放会显示成另一 turn。
- `query()` 绝不传 `env`（会丢 `ANTHROPIC_BASE_URL`）；凭据由 config 目录决定（CLI 读 `~/.claude/settings.json` 的 `env`），不是进程环境；没凭据不报错、换官方模型目录（症状：列表变官方 + 不回消息）。
- `/api/providers`：`available` 要真起 CLI 拿 init 帧；`authenticated` 看 `account.tokenSource`（`'none'` 是字符串，`Boolean` 会误报）；`/api/health` 的 Claude `ready` 恒 `null`；`probe()` 重（Claude ~230 MB CLI / Codex 最多 30 s）→ 一律走 `probeCache.ts`（30 s TTL + single-flight），启动预热，别在请求路径直接调。
- effort 只能看 CLI JSONL（`init.effort` 恒 `undefined`；用户消息行有 `effort`/`perTurnEffort`，缺省记 `high`）。
- 斜杠命令来自 `system:init`，必须减掉 `terminal_slash_commands`（本地终端绑定）；走 `commands.updated`（每个 init 帧都发），`resumeSession` 重放；Codex 为空表；不用 `supportedCommands()`（每回合子进程，等于多起一次 CLI）。
- 压缩 `compact_boundary` 是可见 item（与 Codex `contextCompaction` 同形），id `claude:compaction:<uuid>`（无 uuid 才随机），实时与回放都产出；边界不起 turn（无 turn 时缓存挂到下一个 prompt）。
- `getTranscript` 读全部历史：从文件尾 512 KB 反向倍增，凑够 `limit + skip` 个 prompt；无 `limit` 传 `Infinity`；四处不能错：按 boundary 分段、每段独立 `orderTranscript`（boundary 不进段）、顺序按 parent 链（复刻 SDK `yBe + bBe`）、任意字节开窗要丢残行并按 Buffer 解码且 cut 推到第一个 prompt；游标按轮。SDK `getSessionMessages` 只是兜底、仍只给压缩后段。
- `listSessions` 把 `limit` 当页大小：过滤在分页后跑，页大小按差多少增长；不设 limit 要读每个会话头尾（3,000 个实测 327 ms vs 26 ms）。
### Codex 后端
- `@openai/codex` 精确 pin（根 devDependencies，无 `^`）；升版需同意，流程：改 pin → `npm ci` → `npm run gen:codex-types` → diff → 核对措辞 → 跑 smoke/approval/image；Dockerfile 从 `package.json` 读。
- 模型列表是二进制内置目录（支持新模型只能升级行，`listModels()` 纯转发）；`supervisor.ts` 用 `require.resolve`，不看 PATH/`CODEX_CLI_PATH`。
- 「没有这个线程」只有措辞（`thread not loaded`/`no rollout found`/`is not materialized yet`），全 `-32600`，集中在 `CodexProvider` 顶部谓词；措辞不在类型里且换过；未知 id → `SessionNotFoundError`（`#threadRpc`），路由 404；别把「没有历史」和「没有这个线程」混用（会把新建会话变 404）；`DELETE` 404 前端当成功。
- `packages/protocol/src/generated/` 已 gitignore、无人 import，仅协议参考。
### 图片
- 图片落 `.vibemobile/images/`（`<sha256[:32]>.<ext>`），转写只放 `/api/images/<token>`；代理会话文件只读：不写 `~/.codex/sessions/**`、`~/.claude/projects/**`，`*-sessions.json` 不记图。
- `ImageStore` 无内存态，可多实例同 `stateDir`；`SessionPrefsStore` 相反只能一个实例；无 `stateDir` = 无 store（不写 `images`，data URL 不上 item）。
- 落盘走 `normalizeItem(item, { onImage })`，不能先放进 item 再改写；Claude 侧要在 `beginTurn` 前完成；token 带扩展名（定 Content-Type），拒 `svg`（同源 XSS）。
- `GET /api/images/:id` 是唯一非 JSON 路由：未命中必须 `Cache-Control: no-store`，命中 `immutable`；图片目录纯缓存，故意无清理。
- item 两种拼法都要读：WS `{"type":"image","url"}`，rollout `{"type":"image","image_url"}`（靠 `smoke-image.ts` 抓）；出站张数在 provider 入口 `capImages(rawInput)`；`MAX_PER_MESSAGE` 与 `apps/web/src/lib/image.ts` 的 `MAX_IMAGES` 是同一数两份，必须同步。
### 终端持久化（`ws/terminal.ts`）
- shell 属于终端：socket close 只是 detach，不杀 pty；回收看无连接 + `config.terminal.idleTimeoutMs`（60 s 扫一轮）；身份在 `sessionStorage`，未知 id 给新壳并回传（不是 404）。
- 快照先于 output：`mirror.write()` 回调里 `serialize()`；`ready=false` 期间分片进 `conn.pending`，快照后补发；少了它分片静默丢失。
- pty 与 mirror 的 cols/rows 必须一起改（attach/resize/构造），错位不报错；`excludeAltBuffer` = 尺寸没变（没变则 alt buffer 就是当前屏幕，必须还原；变了让重绘赢）。
- `@xterm/headless` 只能动态 import：Node CJS 在 `default`，tsx 直接给 `Terminal`（`loadMirror()` 两种都认）；`@xterm/addon-serialize` 是正常命名导出；`attached` 只由服务端给，false 才画 `shell · cwd` banner、接回不画；`exit` 必须先于 `kill()`，`restart` 先 dispose 旧 onData/onExit 再 kill。
### 构建戳与重启
- `buildInfo.ts` 的 `build` 是模块级常量（进程启动时）；只有 `buildOnDisk()` 请求时重读；`/api/health` 返回两者；不要改成每次现读。
- 开发模式现场问 git，`builtAt` 为 null；`commit` 可为 null（Docker 无 `.git`），比较前两边都要有值；前端走 `virtual:build-info`（`buildInfoPlugin`），不要用 `define`（dev 下不替换）。
- `scripts/build-info.mjs` 不能加 shebang（vite 注入代码后 `#!` 不在第 0 字节 → 构建/vite dev 都挂）；Dockerfile 只 COPY 它。
- 重启：`Stop-Service -Force` → 轮询 `Stopped` → `Start-Service` → `/api/health` 的 `build == buildOnDisk`；`Restart-Service -Force` 会报错；卡住时 `sc queryex` 看 nssm PID，应用已退但 nssm 在 → `Stop-Process -Id <nssm> -Force`；Git Bash 的 `taskkill /F` 会被改写成路径。
### 文件引用 · 查看器 · 写入（前端）
- 代理写的是路径，浏览器当页面地址；`lib/fileLink.ts` 的 `parseFileRef()`：相对路径按会话 `cwd`，`/D:/x`、`D:/x`、`file:///D:/x` 归一 `D:/x`，`:10`/`#L10` 取行；其余（`http(s)`/`mailto`/`app:`/`#`/省略协议）交给浏览器。
- 认出的交给 `components/FileViewer.tsx` 浮层（不是路由），走 `/api/files/content`，受 `workspaceRoots` 约束；`Chat.tsx` 必须把 `showFile` 作为 `onOpenFile` 传下去，否则链接退化成新标签页。
- 必须覆写 react-markdown `urlTransform`：默认转换会把 `D:/x.md` 清成 `href=""`（`/D:/x` 靠斜杠躲过）；只放行文件引用，其余仍走默认。
- 看文件唯一实现 `components/FileBody.tsx`（行号 + 预览）；`FileViewer` 只管抓取/头/状态；预览链接按文档所在目录（`folder`），不是会话 cwd；模式跨文件保留：`preview && isRenderable(path)`，不写重置 effect。
- 正文逐行一个 div（行号/换行只能元素自知）；`MAX_ROWS = 5000` 是渲染上限（服务端读 512 KB）；行号列 `select-none`，空行输出空格；`smoke:browser` 审批依赖 radix select 的 `pointerTypeRef` 初值 `"touch"`，升 radix 时重验。
- 写入唯一路径 `files/workspace.ts` 的 `writeFileText()`，走 `resolveInside()`，只能改不能新建（404）。
- 信道 LF，服务端 `applyEol(toLf(text), detectEol(bytes))` 还原行尾；`toLf` 承重，`applyEol` 不幂等（CRLF 输入会出 `\r\r\n`）；手工验：CRLF 文件改一行，`git diff --stat` 应 ~1 行。
- `FileContent.rev` = 读到字节的短 sha256，带且不匹配 `409 file_changed`；前端 409 必须保留草稿、只重读换 `rev`；路由 `bodyLimit` 必须 2 MiB（默认 1 MiB 在 handler 前 413）；`WorkspaceError.code` 可选，不给时响应体与旧版逐字节相同。
- `FileEditor` 是 `FileBody` 的兄弟（textarea 自滚，不能逐行渲染）；草稿只能由 `content.text` 初始化，不能取 rows（5000 行以上会丢尾）；`content.truncated` 不可编辑；`MAX_EDIT_LINES` 守卫；编辑态整个头部替换为 取消/保存；脏草稿卸载时存模块作用域；`saveError` 与页面 `error` 分开（否则弹回目录丢草稿）。
### 平台
- 端口分段：3xxx/5xxx HTTP，68xx codex app-server；开发/部署必须分开（supervisor 只探 `/readyz` 端口，撞上会静默接错）；`npm run dev` 预检。
- Windows：`.ps1` 带 BOM、`.bat` 纯 ASCII；二进制走 npm（`nssm-bin`）；端口占用用 `connect` 判断（`SO_REUSEADDR` 允许多绑定）。
