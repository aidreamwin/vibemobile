# CLAUDE.md

## 这个文件是什么

**改这个仓库时的操作手册**，每次会话整份载入上下文。只写两样：**怎么做/怎么验**，以及**跨多个文件才看得出来的约束、写错了不会报错只会静默出错的接缝**。

判断标准只有一条：**删掉之后，改这个仓库的人会写出错的代码，它才留在这里。** 不写在这里的：原理叙事、部署步骤、已知限制的完整版 —— 都在下面这些文档里；以及代码里读得出来的实现。

**文档地图（改架构前先读）**：

- 对外入口：[README.md](README.md)
- 架构与数据流：[docs/architecture.md](docs/architecture.md)
- 部署与环境变量：[docs/deployment.md](docs/deployment.md)
- 已知限制：[docs/limitations.md](docs/limitations.md)
- 版本与发布：[docs/releasing.md](docs/releasing.md)
- 安全模型：[SECURITY.md](SECURITY.md)
- 贡献流程：[CONTRIBUTING.md](CONTRIBUTING.md)

**不要和这些文档重复叙事**：CLAUDE.md 只保留“写错了不会报错”的约束。文档里的内容变了，先改文档，再回来删掉这里重复的段落。

## 这是什么

手机浏览器远程驱动本机的编码代理，接了 **Codex** 和 **Claude Code** 两个后端。单用户、无权限体系。

**后端存在的唯一理由**：app-server 拒绝任何带 `Origin` 头的 WS 升级请求，而浏览器的 WS 一定带，所以浏览器**不能**直连，必须由 Node 后端充当 WS 客户端。这是约束，不是取舍（架构图见 README）。

## 命令

```bash
npm run dev              # 后端 5800 · 前端 5802 · app-server 6800（端口被占会报错退出）
npm run dev:server       # 只起后端
npm run dev:web          # 只起前端
node scripts/dev.mjs --server-port=5900 --codex-port=6801 --web-port=5902   # 整段换端口

npm run build                                  # ⚠️ 只构建前端
npm run build:all                              # 前后端都构建（后端 postbuild 写 dist/version.json）
npm start                                      # 跑 apps/server/dist（部署段 3000）

npm run lint                                   # Biome：格式 + lint（warn 不阻断）
npm run lint:fix                               # 自动修复安全项
npm run format                                 # 只格式化
npm run format:check                           # 只检查格式
npm run typecheck                              # 前后端 tsc；server 的 scripts/ 也在这里检查
npm test                                       # 全部单测（vitest）
npm test --workspace=@vibemobile/server -- src/codex/mapEvents.test.ts   # 单个测试文件
npm run test:coverage                          # 覆盖率（两个 workspace 各自输出 coverage/）
```

服务端有两份 tsconfig：`tsconfig.json` 是**类型检查**（包含 `src/`、`scripts/`、
`vitest.config.ts`），`tsconfig.build.json` 是**构建**（只含 `src/`，排除
`*.test.ts`）。`npm run build --workspace=@vibemobile/server` 用后者，所以
`dist/` 里不应再出现 `*.test.js`；`prebuild` 会先清空 `dist/`。

验证脚本（**自己 spawn CLI，不需要先起服务**）：

```bash
npm run test:approval                          # Codex 审批往返 + 中断
npm run smoke                                  # apps/server/scripts/smoke-codex.ts
npx tsx apps/server/scripts/smoke-image.ts     # 发一张图，断言它活着回到转写里
npx tsx apps/server/scripts/smoke-claude.ts    # Claude SDK 层 go/no-go（流式 · 审批 · 中断）
npx tsx apps/server/scripts/test-claude.ts     # ClaudeProvider 全链路
```

需要服务在跑（`<PIN>` 是登录 PIN）：

```bash
npm run test:hub -- <PIN>        npm run test:terminal -- <PIN>
npm run smoke:browser -- <PIN>   # 无头 Edge 按 390×844 走完整 UI（需先 npm run build）
node apps/web/scripts/smoke-claude-browser.mjs <PIN>
```

`smoke:browser` 覆盖面最广 —— 服务器健康但前端渲染崩溃这类问题只有它能发现。

### 改完源码必须重新构建再测

服务端跑的是 `dist/`（无 watch 模式），浏览器冒烟读的是 `apps/web/dist`；改了源码不构建，测试跑的还是旧代码。

**而且两半在部署时会不同步**：部署中的服务**从磁盘实时读** `apps/web/dist`（重建前端立刻生效、**不用重启**），而它的后端跑的是进程启动时载入的旧 `dist/`。所以**动了 `/api` 契约就必须重建后端并重启服务**。

**本机有 3000 部署时不要原地构建前端**：`vite build` 会直接改写那个服务正在
从磁盘读的 `apps/web/dist`，用户刷新就会看到半成品。验证前端构建请用
`npx vite build --outDir <临时目录>`；验证后端用
`npx tsc -p apps/server/tsconfig.build.json --outDir <临时目录>`。不要在开发/
测试过程中停止或重启 3000 服务，除非用户明确要求。

### 改完代码要抬版本号

前端改了就抬 `apps/web/package.json` 的 `version`，后端改了就抬 `apps/server/package.json`，两边都改（比如动了 `packages/protocol`）就两个都抬，只动最后一位。**这是这条链路上唯一靠人的一步** —— 提交号和构建时间都是构建自己填的，不抬就分不出新构建和上一版。两半故意各用各的号。只改文档、注释不算改代码。

### 工程化约定

- **Biome** 负责格式和 lint，配置在 `biome.json`。`noExplicitAny`、a11y 和
  hooks 依赖规则目前是 **warn**（不阻断 CI），但新代码不要主动增加这些警告。
  不要用 `@ts-ignore` / `eslint-disable`；确需抑制时用
  `// biome-ignore lint/<rule>: 理由`。
- **CI** 在 `.github/workflows/ci.yml`：`npm ci` → lint → typecheck →
  test:coverage → build:all。单测本身很快，失败先看 lint/typecheck。
- **`apps/server/scripts/` 现在参与类型检查**，改 provider 接口后这些脚本
  也会报错；这是有意的，别把它们排除回 tsconfig。
- **测试文件不进入 `dist/`**：构建用 `tsconfig.build.json`，类型检查用
  `tsconfig.json`。加新的构建排除规则时两边都要想一遍。
- **Vitest 4 不再默认排除 `dist/`**：`apps/server/vitest.config.ts` 和
  `apps/web/vite.config.ts` 都显式用 `configDefaults.exclude` 加上了
  `dist/` / `coverage/`。删掉这行会让旧的 `dist/*.test.js` 被当成测试再跑
  一遍（数量翻倍，fixtures 路径还会错）。
- **版本号与发布流程**见 [docs/releasing.md](docs/releasing.md)；Codex CLI
  的精确 pin 和升级步骤也在那里，不要顺手升级。

## 架构

### provider 接缝

`apps/server/src/providers/types.ts` 的 `AgentProvider` 是唯一接缝。`routes/` 与 `ws/hub.ts` 完全 provider-agnostic；前端只消费 `packages/protocol/src/events.ts` 里的归一化 `AgentEvent`，不感知任何一个代理的私有协议。**加一个 provider = 实现 `AgentProvider` + 在 `index.ts` 里 `registry.register()`。**

两个后端的会话模型不同，这是最容易写错的地方：

| | Codex | Claude Code |
|---|---|---|
| 传输 | 后端 spawn 的常驻 app-server，JSON-RPC over WS | SDK `query()` |
| 进程 | 一个长驻进程，服务全程复用 | **每回合一个子进程**，回合结束即退出 |
| 续接 | 订阅同一个 thread | 首回合传 `sessionId`，之后传 `resume` |
| 回合中插话 | 原生 `turn/steer`，折进当前回合 | **保持 stdin 打开**，消息折进当前回合（不打断已在跑的工具） |
| 会话元数据 | app-server 的 thread 记录给 `model`/`reasoningEffort` | **没有对应物**，全得自己存 |
| 端口 | 占一个 | 不占 |

Claude 的 session id 是本地 `randomUUID()` 铸的，第一回合才通过 `options.sessionId` 交给 CLI —— 这就是"每回合一个子进程"还能有稳定路由 id 的原因。

### 会话路由

会话 id 是裸的，多数请求不带 provider。`providers/registry.ts` 维护 `sessionId → providerId` 反查表：每个学到 id 的路径都会 `bind()`，`forSession()` 未命中时才挨个问 provider，最后兜底 `default`。

- **`registry.default` 是"第一个注册的 provider"，也就是 Codex** —— `index.ts` 的注册顺序是有意的，任何依赖它的地方都等于假设只有一个后端。
- **`/api/sessions` 不带 `provider` 就是"只有 Codex"**（故意保留的旧契约）。要看全部时**主动**发 `?provider=all`（`routes/sessions.ts` 的 `ALL_PROVIDERS`）：逐个 provider 拉、按 `updatedAt` 合并排序，单个抛错只记 warn 并当空列表。未知的 `provider` 值兜底成 `default`（200，不是 404）。
- 这个 `all` **故意没放进 `packages/protocol`**：那个包是纯类型的（服务端一行它的 runtime JS 都不引，这是 `rootDir: src` 能构建的原因）。
- **`Transcript.hasMore` 只在为真时出现**（`...(cond ? { hasMore: true } : {})`），所以「键不存在」就是「没有更多」。它和 `nextCursor` **不是同一件事**：`hasMore` 回答「还有更早的吗」，`nextCursor` 回答「怎么取」；provider 可能只说前者（前端退回静态的「以上还有更早的记录（未加载）」），**不能拿 `hasMore` 去假装有游标**。客户端把 `nextCursor` 原样回传成 `?cursor=`，路由不做任何解释 —— Codex 的是 app-server 自己的游标，Claude 的是自铸的 `c:<跳过的轮数>`（**从最新端数**，翻页期间有新回合就开始漂移，靠前端按 item id 去重兜底）。
- **`?items=` 是「大约多少个渲染条目」，`?limit=` 是轮数；两者共用一个游标。** 一轮可以从 1 个条目到几百个，固定轮数让页面大小差两个数量级，所以前端两个入口（首屏、上翻）都只发 `items: 60`。三种约束不能改：**切只切在整轮边界**（页面可以超出预算，一个巨型轮就单独返回）；**只要还有更旧的轮就绝不返回空页**（否则前端「内容不足一屏就自动补一页」会停摆）；**游标仍按轮计数**（Claude 的 `c:<跳过的轮数>` 不变，Codex 的仍是 app-server 的），两个入口混着翻不会错位。路由在带 `items` 时**仍发 `limit`**（默认 60），这样不认识新选项的 provider 也有一份 sane 的轮数。
  - Codex 的 RPC 只收轮数：`#transcriptByItems` 从 1 轮开始倍增探测，够了再发一次**精确 `limit=kept`** 的请求。这一步不是优化 —— `nextCursor` 指的是「该次请求最后一轮之后」，直接花探测那次的游标会把多取到的轮**静默跳过**。
  - Claude 的同一条读法按 prompt 数倍增（`skip + prompts + liveExtra`），每轮一个子进程无关、但每次都要重新解析窗口：总和约是最终窗口的 2 倍，`targetItems` 个 prompt 是上界（每轮至少一个条目）。**没有 `items` 时完全走旧路径**，`limit` 缺省仍然是「全部」。
- **`/api/sessions` 的 `search`、`archived`、`pinned` 是三个不同的东西**：`search` 对 Codex 走 app-server 原生的 `searchTerm`（**只匹配标题**，不匹配正文），对 Claude 是在已拿到的那批 `SDKSessionInfo` 上做子串匹配；`archived` 是过滤；`pinned` 只在 `PATCH` 上有，`GET` 不带。排序（置顶在前）在**前端**做，服务端不排。
- 审批走另一条路：`answerApproval` 只带审批自己的 id、不带 thread id，所以 `ws/hub.ts` 另建 `requestId → providerId` 的 owner 表来转发；`approval.requested` / `approval.resolved` 是**全局广播**的，两半必须一起送，否则客户端会卡在一个永远关不掉的弹窗上。

### 多 runner 名单（Hub）

- 名单文件默认 `<stateDir>/runners.json`（Docker 下落在 `hub-data` 卷）；`VIBEMOBILE_RUNNERS_FILE` 可覆盖，但**必须可写**，否则设置页的创建/刷新/删除返回 `runner_store_unwritable`。**Hub 是唯一写入者**：外部改文件要重启才可见，且下一次页面操作会按内存重写它。
- **明文 token 只在创建/刷新的响应里出现一次**，磁盘只有 SHA-256；「找不回 token」是设计，恢复手段只有刷新。刷新必须**先落盘再改内存、再 terminate 现有隧道**，否则旧 token 还能继续执行。
- `hubApp.ts` 导入了 `RunnerStore` 的**类型**，`runnerStore.ts` 在运行时反向导入 `tokenHash`/`validateRunners` —— 这个方向不能反过来变成值导入，否则出现模块环。
- 只有 `remoteIds` 里的 runner 可管理；默认 `local`（或 `VIBEMOBILE_DEFAULT_RUNNER=off` 时的首个条目）不能删除，否则 `specs` 会变空。

### 前端

`apps/web/src/lib/store.ts` 把 delta 攒在模块级可变结构里、**每帧（rAF）最多 flush 一次**（后台标签页 rAF 会停，退回 50ms 定时器）。`item.completed` 是权威的、会丢弃对应 buffer —— 但**只在 item 自身为空时才**把 buffer 折进去（Codex 出现过 `exitCode: 0` 且 `aggregatedOutput` 为空的完成帧）。

`lib/ws.ts` 自带重连 + 订阅重放。`Query` 活在 Node 进程里，所以刷新不影响后端执行；用户可见的那一半靠 `resumeSession` 重放 live 状态（进行中的回合、待审批、停止按钮）+ `getTranscript` 追加进行中的回合。

**页面逻辑留在 `pages/`，展示组件在 `components/`**：`ChatHeader` / `ChatItemList` /
`StreamingBlock` / `ChatLoadError` / `ChatOverlays`，以及 `SessionRow` /
`SessionList` / `SessionListEmpty`。拆分时**不要把页面级状态搬进展示组件** ——
滚动锚点、`loadingOlder`、分页 ref、`showFile` 的稳定性都属于页面；组件只拿
props，否则下面这些“加载中把 scrollTop 夹到 0”的约束会重新散开。

**新增页面必须用 `React.lazy` 注册路由**（`App.tsx`），首页 `Sessions` 除外。
`vite.config.ts` 的 `manualChunks` 把 React / Radix / Markdown / xterm 分到
vendor chunk，`chunkSizeWarningLimit` 是 500 kB。把 xterm 或 `react-markdown`
重新静态 import 到首屏页面，会让初始包和构建警告一起回来；不要用提高
`chunkSizeWarningLimit` 来消警告。

- **上翻分页（`Chat.tsx`）的 `loadingOlder` 绝不能复用页面级 `loading`** —— 和下面列表页那条是同一个形状（`加载中…` 会把 `scrollTop` 夹到 0）。锚点是**「距底距离」且在响应落地那一刻才测**（请求发出时测的话，等待期间用户滚过的距离会被一起还原掉），在 `useLayoutEffect` 里 `scrollTop = scrollHeight - anchor.height + anchor.top`。
- **`prependTranscriptItems` 按 item id 去重，`resyncTranscript` 必须是按位置合并**：一旦加载过更早的页，`[...snapshot, ...剩下的]` 会把它们搬到会话末尾。**同一 cursor 且这一页一个 item 都没加进去时必须丢掉 cursor** —— 否则「内容不足一屏就自动补一页」会无限循环。**Claude 的 turn id 是「窗口相对」的**（`claude:turn:N` 按这一页尾读到的窗口重新编号），翻页后同一个 id 可能指不同回合 —— 去重只能看 item id，别拿 turn id 当身份。

**「回到这个页面要回到离开时的位置」有两份实现**：`pages/Sessions.tsx`（会话列表）和 `pages/Files.tsx`（文件浏览，记整个视图 —— 在哪个目录、开着哪个文件、滚到哪）。两条共同接缝：

- **状态放模块作用域，不能放组件 state** —— 切底部导航会卸载这一页，而浏览器的滚动恢复只认 window，认不出这些内部滚动容器。用 `useLayoutEffect` 在 `!loading` 时恢复，否则会先闪一帧顶部。
- **加载中那一帧绝不能把偏移写回去**：`加载中…` 是个很矮的块，会立刻把 `scrollTop` 夹到 0 并触发一次 scroll 事件 —— 监听里不判 `loading`，每次打开/刷新都会把记住的位置覆盖成 0。**这行代码长得完全正常。**文件页有**第二个**同样的抽屉：编辑态把整篇文档换成一个 `h-full` 的 textarea，外层容器内容变矮、被夹住、又触发一次 scroll 事件。所以那两处条件都是 `loading || editing`，`useLayoutEffect` 的依赖里也有 `editing` —— 少一个「退出编辑后回到原处」就没了。

锚点不同是故意的：会话列表按「最近动过」排序，刚看过的那条会跳到顶部，所以它锚**行 id + 像素偏移**；文件列表顺序稳定，锚 `scrollTop` 就够。

- **列表页的搜索框绝不能 `setLoading(true)`**：`加载中…` 那个矮块会立刻把 `scrollTop` 夹到 0 并触发一次 scroll 事件，把记住的位置覆盖掉 —— 和上面那条是同一个形状。搜索只换数据，不换那个 loading 态。
- **`App.tsx` 的启动第一枪是 `api.authMode()`，不是 `me()`**：`authDisabled` 的部署里 `requireAuth` 直接放行，`/api/auth/me` **永远不会 401**，所以只有这个部署自己的开关能回答「这里到底要不要 PIN」。按 401 分流的写法会把没有 PIN 的部署永远展示成 PIN 登录页。`me()` 的 401 才去 PIN 页，网络/5xx 是「连不上服务器 + 重试」，**别把两者都写成 `'anonymous'`**。
- **连接状态要一个 `socket.started` 而不只是 `state`**：子组件的 effect 先于 `App` 的 `connect()` 跑，只看 `state` 会让每次加载都闪一次「已断开」——那是从没发生过的断线。

### 配置

`apps/server/src/config.ts` 的 `repoRoot()` 从**模块位置**往上找带 `workspaces` 的 package.json，不是从 cwd —— npm 跑 workspace 脚本时 cwd 是 `apps/server`，用 cwd 会解析出第二个 `.vibemobile/`（另一个签名密钥、另一个 PIN）。配置里所有路径都是仓库相对。

`packages/protocol` 不发构建产物：直接以 TS 源码被引用，而且**只被 `import type` 引用**，改它不需要构建它自己。

## 改代码要守的规则

### 权限档位

- **每回合生效的是输入框上那个权限项**，它每回合覆盖建会话时的预设（`startTurn()` 拿 `opts.sandbox/approvalPolicy` 重算 `permissionMode`）。但输入框**必须从"会话现在跑在哪一档"开始，不能自己挑一档**：`SessionSummary` 的 `sandbox`/`approvalPolicy`（`#summaryFromLive`/`#summaryFromInfo` 用 `permissionOptionsFor()` 反推）就是为这个存在的；读的是**内存 `LiveSession` 优先、磁盘存档兜底**。输入框自己挑一档的症状是"新建会话选了完全访问 → 第一条消息发的是按需确认 → 授权弹窗不断弹"。
- **读不到时一律兜底成「按需确认」**，**绝不拿"用户上次在这个 App 里选过的档"去填**。存的是「这个会话上次用的档位」，不是「下一次用哪个」。
- **建会话 sheet 能造出 9 种 `(sandbox, approvalPolicy)` 组合，输入框只有几张固定的卡**（Claude 4 张、Codex 3 张），那 6 种会显示成「按需确认」，用户一发消息机器就按那一对走。**别写成「方向是变安全」**（错的说法）：6 种里有 2 种在维度上是放宽的。成立的不变量只有两条：**认不出的组合绝不会点亮完全访问**；**屏幕上的那一档就是下一回合发出去的那一对**。
- **只有两个字段都在协议枚举里才报**：`codex/permission.ts` 的 `SANDBOXES`/`APPROVAL_POLICIES` 是 Codex 侧唯一的运行期闸门（`ws/hub.ts` 对这两个字段零校验）。
- 四档梯子写在两处、枚举值散在三处，**改档位要一起改**：`apps/web/src/lib/permission.ts`（前端唯一一份，`PERMISSIONS` + `permissionCardFor()` + `permissionCardsFor()`）和 `claude/permission.ts` 的 `permissionModeFor()`/`permissionOptionsFor()`（纯模块、单独单测）。
- **第四档「自动判断」是 Claude 专属，也是唯一一处「协议比后端宽」**：它走同一条信道（`approvalPolicy: 'auto'` + `sandbox: 'workspace-write'`，没有新字段），于是 `packages/protocol` 的 `ApprovalPolicy` 宽于两个后端的运行期词汇。闸门钉在两边：`codex/permission.ts` 的 `isApprovalPolicy`（给 Codex 传 `auto` 是**静默无效**）和按 provider 出菜单的 `permissionCardsFor()`（未知 provider 给窄的那份）。**它下 `canUseTool` 0 次** —— 不是「有风险会暂停问你」，手机上不会有弹窗、也看不出它放过了什么。
- `permissionCardFor()` 的 `cards` 参数**必需、不给默认值**：Radix 在 `value` 没有对应 item 时渲染**空触发器**，所以「选中的卡 ∈ 被提供的卡」必须是结构保证 —— `Chat.tsx` 的种子和 `<Composer>` 两处都得传同一个列表。
- `needsDangerousAck('auto')` **永远是 `false`，有单测钉着**：一旦变真就会设 `allowDangerouslySkipPermissions`，而那正是 root 容器下 CLI 直接 `exit(1)` 的那条路。
- **「完全访问」在两个后端都等同于无人值守** —— 本应用里唯一能让一部手机拿到无限制机器权限的入口。
- **`AskUserQuestion` 不是权限请求**，但它和权限请求**共用同一扇门**（从 `canUseTool` 进来）。**答案只能走 `updatedInput.answers`**（`{[问题原文]: label}`，多选是 `', '` 连接的 label），所以这类请求标成 `type:'userInput'`、问题结构化放进 `ApprovalRequest.questions`，`availableDecisions` 里**没有** `acceptForSession`，前端 `ApprovalSheet.tsx` 见到 `questions` 就换成一整套表单。三条不许动的纪律：**给不出答案时一律拒绝，绝不退回 allow**；**只接受形状对得上的答案**（`claude/askUser.ts` 的 `answersFor` 返回 `null` 就拒绝）；**问题读不出来就退回普通审批卡**（`questionsFrom` 返回 `undefined`，显示原始 JSON，而不是渲染一个永远提交不了的表单）。**`canUseTool` 在 `bypassPermissions` 下照样会被调用**，所以完全访问会话里照样弹、照样能答。
  - Codex 侧（`item/tool/requestUserInput`）用同一套形状：`questionsFor` 造 `questions`、`answersForQuestions` 编响应，`CodexProvider` 把原始 `params.questions` 的 id 按位置存进 `PendingApproval.questionIds`（协议的 `ApprovalQuestion` 没有 id，而响应按 id 索引）。**这条链路没有实测过。**

### 会话与吊销

- JWT 里带 `ver`，`verifySession` 要求它等于 `config.sessionVersion`。**登录不递增版本**（多设备同时在线是明确需求）；吊销只发生在 `VIBEMOBILE_PIN` **真的变了**（用 `verifyPin` 判断，不能每次启动都递增）和 `POST /api/auth/logout-all`。
- `sessionVersion` 存在 `state.json`，由 `bumpSessionVersion(config)` 先写盘再更新内存。新增任何吊销入口都要走它，否则旧 token 不会失效。
- 默认 TTL 是 7 天；`POST /api/auth/logout` 只清 Cookie，不吊销 token。Hub 和单机服务各用各的 `state.json`，所以吊销只影响各自的部署。

### 会话存档（`providers/sessionPrefs.ts`）

两个后端各存各的词汇、**不做归一化**：Claude 写 `claude-sessions.json`（键 `permissionMode`），Codex 写 `codex-sessions.json`（键 `sandbox`/`approvalPolicy`）。归一化是错的 —— Claude 的 `permissionModeFor` 把 `approvalPolicy: 'never'` 折叠成 `bypassPermissions`，走一遍前端卡表再回来会把 Codex 的 `(read-only, never)` 也报成完全访问。

- **磁盘文件名 `claude-sessions.json` 和键名 `permissionMode` 一个字都不能改**（线上存档里有真实记录）。
- **`startTurn` 记录的必须是 merge 的结果而不是 `opts`**（一回合可以只带一半，另一半 app-server 沿用上次的），而且写在 `await` **之前**。
- `deleteSession` 的 `forget` 在 RPC **成功之后**（Claude 相反：先 forget 再删磁盘）；`archiveSession` **不** forget（归档保留记录，不是漏了）。
- **`archived` 只对 Claude 存在这里，`pinned` 两边都存** —— 不对称是刻意的：Codex 的归档走 app-server 自己的 `thread/archive`，Claude 没有对应物才落到 prefs。`pinned` 纯属本 UI 的状态，两个后端都没有。
- **`MAX_ENTRIES = 500` 的淘汰会静默取消归档/取消置顶**：被挤出存档的老会话会重新出现在列表里、图钉消失。接受（不修），但这就是「置顶了一个很久没动的会话，过一阵它自己松开」的原因。
- 恢复的告警只发一次（`#noticed` 这个 `Set`）：`resumeSession` 一次打开会被调两次（`/open` + WS `subscribe`），重连时 `resubscribeAll()` 每个线程还会再来一次。它走 **`onNotice` 而不是 `onLog`**（`onLog` 接到 `debug`，默认 `info` 下看不见）。
- **刻意不读 `Thread{Start,Resume,Fork}Response` 里那两个字段**（生成类型标着 Legacy），也**不把记住的值塞进 `thread/resume` 的参数** —— 后者会在"刚打开还没发消息"时就把线程设成完全访问。承重的不变量只有一条：**界面显示的那一档 == 下一回合发出去的那一对**。
- **Claude 的 `model`/`effort`/权限档位都是我们自己存的**（`getSessionInfo()` 只给标题/cwd/时间戳）。改 `LiveSession` 这两个字段时注意**三处**读它：`#summaryFromLive`、`#summaryFromInfo`（回落到 prefs）、`#spawnTurn` —— `session.effort` 必须真的传进 `Options.effort`，否则输入框上的强度只是装饰。fork 会继承（`copy()`）。

### Claude 后端

- **文件分工**（拆分后别把它们再塞回一个文件）：`ClaudeProvider.ts` 只负责
  provider 生命周期、回合、审批和 live 状态；`transcript.ts` 负责 JSONL 读取、
  分段排序和 `buildTurns`；`mapClaudeEvents.ts` 是实时帧状态机，纯映射工具在
  `mapUtils.ts`；`turnInput.ts` 是 streaming input；`runtime.ts` 是探针、模型
  标签、超时、config 目录等无状态辅助。`ClaudeProvider` 里的 `#summaryFrom*` /
  `#spawnTurn` / `#approval*` 仍依赖这些模块，改签名时四个文件一起看。
- **自动压缩必须显式开启，而且窗口要比模型硬上限小**：`#spawnTurn` 每回合传
  `settings.autoCompactEnabled: true`，并用 `session.contextWindow`（来自
  `usage.updated` 的 `modelUsage[*].contextWindow`）的 80% 作为
  `autoCompactWindow`。首回合没有观察值时，`listModels()` 缓存的
  `resolvedModel` 里的 `[1m]` 标记会兜底成 1,048,576。**不要删掉这个
  `settings`**：代理模型（实测 `deepseek-flash[1m]`）不被 CLI 目录完全识别时，
  默认策略可以一直跑到 API 的硬上限才报 400（实测 1,051,635 vs 1,048,576）。
  这个余量同时覆盖 32k completion 预算和 token 估算漂移。
- **回合中的插话走输入流，不是排下一回合**：`#spawnTurn` 用的 `TurnInput`
  （`claude/turnInput.ts`）在首条消息之后**保持打开**（SDK streaming input），`steer` 把消息 push 进去，CLI 在下一个模型边界把它折进当前回合 —— 实测 CLI 2.1.303：**一个 `result`、一个 `turn.completed`**，用户气泡挂在该回合上（`mapper.interject`，不发 `turn.started`）。三条约束：
  - **不会取消已在跑的工具**（实测 Bash 的 `sleep 25` 照常跑完，插话在工具返回后才交给模型）。Codex 的 `turn/steer` 同一语义；**不要用 `priority:'now'`** —— 那是另一种行为（中止当前回合并另起一回合，实测 `terminal_reason: aborted_tools`）。
  - **`result` 一到就必须 close 输入流**，否则 CLI 以为还会有人说话、进程永不退出，`#pump` 也就永远轮不到下一回合。关之前先把 `run.accepting = false`，让与结果帧赛跑的 `steer` 退回排队。
  - **插话的 uuid 绝不能进 `mapper.#byCommand`**：`result.user_message_uuid` 回显的是开启该回合的 prompt，不是折进来的那条。
  - 刷新后从 JSONL 重放会把它显示成**另一个 turn**（`transcript.ts` 的 `buildTurns` 按每条 prompt 切回合），内容不丢、顺序不乱；只有实时视图知道它们同属一回合。
- **`query()` 绝不传 `env`**：那个选项整体替换子进程环境，会丢掉 `ANTHROPIC_BASE_URL` 之类的代理配置，每一轮都会失败。
- **决定凭据的是 config 目录，不是进程环境** —— CLI 自己读 `~/.claude/settings.json` 的 `env` 段，所以「部署后说没凭据」时先问**谁能读到这份配置**（pm2/nssm 以别的用户启动、文件里根本没有 `env` 段、配置只存在于 VSCode 的 `claudeCode.environmentVariables`），**别再用「环境变量没传进去」解释这个症状**。
- **没有凭据的 CLI 不报错，它换一本模型目录**（列内置官方目录而不是代理的），「模型列表变成官方的 + 发消息不回复」是同一个原因。
- 判断 Claude 用 `/api/providers`：`available` 要真起一次 CLI 拿 init 帧，`authenticated` 看 `account.tokenSource` —— **没凭据时它是字符串 `'none'`，不是 `undefined`**，`Boolean(...)` 会把连不上的 CLI 报成已登录。（`/api/health` 的 `providers[].ready` 只是 Codex 的字段，Claude 恒为 `null`，不是故障。）
- **`probe()` 是按次计费的重活**：Claude 要 spawn 一个 ~230 MB 的原生 CLI，Codex 在 app-server 没起来时会等满 30 s。所以 `/api/providers` 一律走 `providers/probeCache.ts`（30 s TTL + single-flight），启动时预热一次。**别在别的路由里直接调，更别让任何请求路径去等它。**
- **强度有没有生效，只能看 CLI 自己写的东西**：`init.effort` 在 SDK 起的会话里恒为 `undefined`；可靠信道是 CLI 的 session JSONL（用户消息行上有 `"effort"` 和 `perTurnEffort`，不传时记 `high`，`DEFAULT_EFFORT` 就是这么定的）。`test-claude.ts` 第 7 阶段去 `~/.claude/projects/*/` 找那个文件来验。
- **斜杠命令表来自 CLI 的 `system:init` 帧，不是本仓库的硬编码**（和 `listModels()` 纯转发同一条原则），而且 **`terminal_slash_commands` 必须减掉** —— SDK 的原话是它们"bound to the local terminal，手机/远程 UI 应当从菜单里隐藏"。本机实测 46 条里减掉 3 条（`doctor`/`color`/`reload-plugins`）。
  - **它走 `commands.updated` 事件，不是新路由**：`#noteCommands()` 每个 init 帧都发一份（比较"变没变"没有意义：多数时候完全相同，而两回合之间连上来的客户端根本没有可比的前一份），`resumeSession` 从 provider 自己的 `session.commands` 重放。`CodexProvider` 没有对应物 → 空表，前端表现为「没有可选命令」而不是报错。
  - `supportedCommands()` 确实能主动取，但**只在活的 Query 上可用，而我们是每回合一个子进程** —— 用它等于为了一份菜单多付一次 ~230 MB CLI 启动。init 帧是白拿的。
- **压缩（`compact_boundary`）是个可见 item**，和 Codex 的 `contextCompaction` 共用一个形状。以前两边都掉进 `default`（Codex 还变成 `kind:'unknown'`，而 `ItemCard` 的 default 返回 `null`）——**用户完全看不出上下文被压缩过**。实时（`mapClaudeEvents.ts` 的 `#noteCompaction`）和回放（`transcript.ts` 的 `buildTurns`）都会产出它，id 是 `claude:compaction:<boundary uuid>`（帧上真没有 uuid 才随机），这样同一条 boundary 同时出现在两路时客户端按 id 去重。boundary **绝不自己起一个 turn**：没有打开的 turn 时先缓存，挂到下一个 prompt 上。
- **`getTranscript` 只要找到会话 JSONL 就整份读，作用域是全部历史**（`transcript.ts` 的 `readTranscriptMessages`，不再有 5 MB 阈值）。旧读取器（以及 SDK 的每一条路径）都在最后一个 boundary 处把作用域切断，压缩前的记录看起来"没了"——用户要能回溯，所以改成每 512 KB 从文件尾反向窗口倍增，凑够 `limit + skip` 个 prompt 即停。实测 22 MB / 14 次压缩 / 33 轮约 107 ms；翻到最老一页时窗口覆盖整个文件。四处不能改错：
  - **必须按 boundary 分段、每段独立 `orderTranscript`**。把整份历史一起交给它，它只从全文件最新的叶子回溯一条链，旧段会被整段丢掉（实测 55 条 prompt 只剩 4 条）。boundary 本身**不放进任何一段**，只作为标记插在两段之间——放进去会触发 `preservedMessages` / `preservedSegment` 的拼接，而被保留的条目物理上就在上一段，结果是重复显示。分段读取天然让它们只出现一次，留在压缩前的位置（和 SDK 的"摘要之后重新显示"不同，这是有意的）。
  - **顺序不是文件顺序**：JSONL 是追加写，并行工具调用按完成顺序落盘，同一 `message.id` 的 assistant 片段会和 tool_result 交错，只有 parent 链能说明哪个分支继续。`orderTranscript` 复刻 SDK 的 `yBe + bBe`（从最新叶子回溯，再把链外同 id 片段按 timestamp 补到该组最后一个链内 assistant 之后）；少了它，大会话的并行工具卡顺序会和之前不一致（实测 7 个大会话里 2 个不同）。
  - **窗口从任意字节开始**：首行是残片必须丢，而且要先按 Buffer 解码 —— 被切断的多字节字符落在丢掉的那一行里。窗口落在一轮中间时，返回前把 cut 推到第一个 prompt，否则 `buildTurns` 会造出一个没有 prompt 的伪 turn，`c:<skip>` 的轮数就对不上。
  - **没有 `limit` 时传 `Infinity`**：读取器直接把初始窗口设成整个文件，别从 512 KB 一路倍增（会把同一个文件重复解析 9 次）。
- **SDK 的 `getSessionMessages` 只是兜底**（文件找不到/读不了），它**仍然只给压缩后的段** —— 这是降级，不是等价路径，别在注释或 UI 里写成两者一样。
- **Claude 的 `listSessions` 把 `limit` 当分页大小下推**：cwd/search/archived 三个过滤器在拿到的一页上跑，凑不够再翻倍，凑够即停（无搜索的常见情况只读一页）。不设 limit 时 SDK 要读每个会话文件的头尾，3,000 个会话实测 327 ms vs 26 ms。筛选条件在分页之后跑是有意的 —— 但页大小必须按「过滤后还差多少」增长，不能只请求 `limit` 就停。

### Codex 后端

- **版本精确 pin 在 `0.162.1`（根 devDependencies，不带 `^`），升版本必须先得到用户同意** —— 协议没有版本协商，跨版本字段会静默漂移，升级必然伴随一次适配（重跑 `npm run gen:codex-types`、diff 产物、逐条核对措辞）。Dockerfile 从 `package.json` 读它，不要另写一份。
- **模型列表就是这个 CLI 二进制的内置目录 —— 「支持新模型」在这份代码里没有可改的地方，只能升上面那一行。** `listModels()` 是纯转发。`supervisor.ts` 用 `require.resolve` 定位二进制，不看 PATH、也不看 `CODEX_CLI_PATH` —— 本机并存的 Codex 桌面 app / VSCode 扩展与本服务无关。`model/list` 默认过滤 `hidden: true`，`listModels()` 传 `{}`，想显示得显式开。
- **「没有这个线程」只有措辞、没有错误码，所以这条判断必须集中在一处。** 三种措辞（`thread not loaded: <id>` / `no rollout found for thread id <id>` / `is not materialized yet`）全是泛化的 `-32600`，只能匹配文案（`CodexProvider` 顶部那三个谓词）；**措辞不在生成的类型里**，而且**换过**。
- **不认识的 id 一律翻译成 `providers/types.ts` 的 `SessionNotFoundError`**（`#threadRpc` 统一包一层），路由用 `notFoundOr` 回答 404；`getSession` 按接口约定返回 `null`，404 由路由既有的分支给出。**别让「没有历史」和「没有这个线程」共用一个谓词** —— 混在一起会把「刚建好、还没发消息的会话」（它就真的存在）变成 404。`DELETE` 拿到 404 时前端当成功。
- **`packages/protocol/src/generated/`（890 个文件）已被 gitignore、没有任何模块 import 它**，只是协议参考（该协议没有官方文档，网上文章有错）。重生成：`npm run gen:codex-types`。

### 图片

用户发出的图片落盘在 `.vibemobile/images/`（内容寻址 `<sha256[:32]>.<ext>`），转写里只放 `/api/images/<token>`。**代理的会话文件只读**：绝不去写 `~/.codex/sessions/**` 或 `~/.claude/projects/**`，`*-sessions.json` 也不记图片。

- **`ImageStore` 没有内存态**（文件系统就是全部状态），所以 provider 和路由各自 `new` 一个指向同一个 `stateDir` 是安全的 —— 和 `SessionPrefsStore` **相反**（它缓存解析后的文件，一个文件只能有一个实例）。`stateDir` 缺席（单测、一次性脚本）时视为「没有 store」：一个 `images` 键都不写，原始 data URL 也绝不会进到 item 上。
- **落盘走回调（`normalizeItem(item, { onImage })`）而不是「先放进 item、回头再改写」**：后者漏一处出口就是几十 KB base64 直接上 WS。Claude 侧同理，必须在 `beginTurn` **之前**落盘（mapper 的 `#items` 会把 item 留一整个会话）。
- **token 里带扩展名是有意的**（`get` 靠它定 Content-Type），顺带让「token 里没有路径分隔符」成为结构保证。`svg` 必须拒（同源，SVG 就是 XSS）。
- **`GET /api/images/:id` 是本仓库唯一的非 JSON 路由**：未命中**必须带 `Cache-Control: no-store`**（否则浏览器按「内容寻址=不可变」把 404 缓存下来，图片再也回不来），命中用 `immutable`。
- **`.vibemobile/images/` 是纯缓存，整个删掉永远安全**，所以**故意没有清理逻辑**（剪掉的东西会被下一次读转写自己恢复）。这条别当成漏了。
- **同一个 item 有两个拼法，两边都要读**：WS 上是 `{"type":"image","url":…}`，rollout 文件里是 `{"type":"image","image_url":…}`。**只读 `image_url` 是踩过的坑**，而所有单测都是绿的 —— 抓到它的是 `smoke-image.ts`。
- **出站张数的闸门在 provider 的入口，不在 UI**：两个 provider 的 `startTurn`/`steer` 拿到输入的第一件事是 `capImages(rawInput)`（`images/store.ts`），这样 CLI、转写回显和落盘的图片表看到的是同一份列表。没有它，`MAX_PER_MESSAGE` 只约束「存下来回放的缩略图」，手机能一次塞进任意多张。
- **`MAX_PER_MESSAGE`（服务端）和 `MAX_IMAGES`（`apps/web/src/lib/image.ts`）是同一个数的两份**，只能靠人同步：`packages/protocol` 是**纯类型**的（服务端一行它的 runtime JS 都不引），没有一个能放运行期常量的地方。改一个必须改另一个，症状是前端放进 8 张、服务端截到别的数。

### 终端持久化（`ws/terminal.ts`）

**shell 属于终端，不属于 socket**（和「执行活在 Node 进程里」同一条原则）。socket 关闭只是 detach：PTY 继续跑，重连的客户端拿到一份屏幕快照。所以**别在 socket 的 close 里杀 pty**，回收只看「没有任何连接 + 超过 `config.terminal.idleTimeoutMs`」（60 秒扫一轮）。身份是 `sessionStorage` 里的一个 id（每设备/每标签各一个，刷新保留、新标签另起）；服务端不认识这个 id 就给新壳并在 `ready` 里回传新 id，**不是 404**。

- **快照必须先于后续 output，靠 per-connection 的 `ready` 闸门兜住中间那段**：`mirror.write()` 是排队的异步解析，所以在它的回调里 `serialize()`；`ready === false` 期间到达的分片存进 `conn.pending`，在快照之后补发。**少了这个闸门不报错，只是 attach 与快照之间那几个分片永久丢失**。
- **pty 和 mirror 的 cols/rows 必须一起改**（attach、`resize` 消息、以及构造 mirror 时）。mirror 只在快照里露面，错位不会报错 —— 表现是重连后换行位置和屏幕对不上。
- **`excludeAltBuffer` 必须等于「尺寸变没变」**：尺寸没变说明全屏程序不会收到 SIGWINCH、不会重绘，所以 alt buffer 就是当前屏幕，必须一起还原（否则 vim 重连后只剩背后的提示符）；尺寸变了才排除它，让重绘赢。
- **`@xterm/headless` 只能动态 import，而且两种运行时形状不同**：Node 下是 CJS、`Terminal` 只在 `default` 上；tsx（脚本用）下没有 `default`、直接给 `Terminal`。`loadMirror()` 两种都认。**`@xterm/addon-serialize` 旁边那个是正常的命名导出**，可以直接 import。
- **`attached` 标志（新建 vs 接回）只能由服务端给**：`false` 才画那行 `shell · cwd` banner。**接回时不画** —— 往恢复出来的屏幕上写一行服务端镜像里没有的字，两边从此就错开了。
- **发 `exit` 必须在 `kill()` 之前**：`kill` 会关掉这些 socket，关掉的 socket 送不出任何东西，客户端只能把「shell 退出了」显示成「连接断了」。同理 `restart` 要**先 dispose 旧的 onData/onExit 再 kill**，否则旧壳的 `onExit` 会把刚保住的那条 record 拆掉。

### 构建戳与重启

- **构建戳读的是「进程启动时」那一刻，这是刻意的，不要改成每次请求现读磁盘。** 后端 dist 是进程启动时载入的，重建了不重启、跑的还是旧代码 —— 这个区分一旦变成现读就消失了。所以 `apps/server/src/buildInfo.ts` 的 `build` 是**模块级常量**，只有 `buildOnDisk()` 在请求时重读，`/api/health` 同时返回两者。
- 开发模式（模块位置在 `src`）现场问 git 并让 `builtAt` 为 null；**`commit` 允许为 null（Docker 不复制 `.git`），null 不等于「不同」** —— 比较前必须先确认两边都有值，否则每次容器部署都会报假警告。
- 前端那一半**不要用 `define` 送**：`define` 只在 `vite build` 时替换，`vite dev` 下标识符原样留在模块里，于是显示一个假的 `unknown`。走 `apps/web/vite.config.ts` 的 `buildInfoPlugin`（虚拟模块 `virtual:build-info`），serve 和 build 同一条路。
- `scripts/build-info.mjs` **不能加 shebang** —— 它被 `vite.config.ts` import，而 vite 会为用到 `import.meta.url` 的模块在前面接一段注入代码，`#!` 不在第 0 字节就报 `Syntax error "!"`，指示的位置看着完全正常。**而且不止是构建失败**：`vite dev` 监听自己的配置文件，配置加载不了它就退出。Dockerfile 里只 `COPY` 这一个文件。
- **重启部署的服务比看起来慢，而且 `Restart-Service -Force` 会报错**：codex 的重连逻辑要等 nssm 的停止超时（15 s）走完。用 **`Stop-Service -Force` → 轮询到 `Stopped` → `Start-Service`**，再 `/api/health` 确认 `build` 和 `buildOnDisk` 相等。
- **`Stop-Service -Force` 自己也可能永不返回 —— 卡住的是 nssm，不是慢应用。** 判据是 `sc queryex VibeMobile` 报的 PID 是 nssm.exe 而应用进程已经没了（`Get-Process -Id <node pid>` 查不到）—— 那就 `Stop-Process -Id <nssm 的 PID> -Force`，SCM 立刻判成 `Stopped`。**Git Bash 里 `taskkill /F` 会被 MSYS 改写成路径**，要用 PowerShell 的 `Stop-Process`。停服务期间手机连不上 3000，两半的 `dist` 都重建好再动手。

### 文件引用与查看器（前端）

**代理写出来的文件引用是「路径」，浏览器却一律把它当「页面地址」** —— Claude 写 `[testing.md](rules/testing.md)` / `[测试规范](/D:/code/…/testing.md:10)`，Codex 写 `[CSV](perf/runs.csv)`；这些全部以页面 origin 解析，手机上点一下就是向 VibeMobile 要一条不存在的路由。

- `apps/web/src/lib/fileLink.ts` 的 `parseFileRef()` 认这个形状：相对路径按**会话 cwd** 解析（`session.cwd` 由 `Chat.tsx` 传给 `ItemCard`/`Markdown`），`/D:/x`、`D:/x`、`file:///D:/x` 归一到 `D:/x`，`:10` 与 `#L10` 取行号；认不出来的（`http(s):`、`mailto:`、`app:`、`#锚点`、省略了协议的网址）原样交给浏览器。
- 认出来的交给 `components/FileViewer.tsx` 这个浮层（**不是新路由**：手机要保持聊天页的位置，而且文件可能属于别的 workspace root），内容走既有的 `/api/files/content`，**仍然受 `workspaceRoots` 约束**。
- **光有这个判断不够**：react-markdown 的 `defaultUrlTransform` 会把 `D:/x.md` 当成「有协议」清成 `href=""`（`/D:/x.md` 靠开头的斜杠躲过），所以必须覆写 `urlTransform`：只放行我们自己认得出的文件引用，其余仍走默认（`javascript:` 照样被清掉）。它**只作用于 Markdown 渲染的代理正文**，工具卡里的路径本来是纯文本。
- **看文件只有一份实现：`components/FileBody.tsx`**（源码行号 + Markdown 预览），文件页和浮层都用它。正文、截断提示、`MAX_ROWS`、模式切换都在 FileBody 里，`FileViewer` 只剩「抓取 + 头 + 加载/错误」。**预览里的链接必须按文档自己所在的目录解析，不是会话 cwd**（`FileBody` 里的 `folder`）—— 只有「转写里的链接」这两者才恰好相同。
- **模式是跨文件保留的**，所以「渲染还是不渲染」看 `preview && isRenderable(path)` 这个与，不要再写一个「换了文件就重置」的 effect。
- **浮层要把 `Chat.tsx` 的 `showFile` 当 `onOpenFile` 传下去**，否则预览里的链接会退化成一个新标签页（单测看不见）。
- **正文逐行渲染（一个逻辑行一个 div）**：行号和「自动换行」只有元素自己知道自己被折成了几行，所以「前后两片文本 + 中间一个 span」的写法满足不了它。`MAX_ROWS = 5000` 是**渲染**上限，服务端 512 KB 的**读取**上限在它之上，都不是阅读限制。行号那一列 `select-none`，空行渲染成一个空格（否则那一行会塌掉）。
- **`smoke:browser` 的审批环节依赖 radix 的 pointer-type 初值**：合成点击能驱动 `ui/select.tsx` 的 `Select`，是因为 `pointerTypeRef` 初值是 `"touch"`。**改那个 select 的 radix 版本时记得回来验这一段。**

### 文件写入（`PUT /api/files/content`）

写入只有一条路：`files/workspace.ts` 的 `writeFileText()`，路径仍走 `resolveInside()`，**只能改、绝不新建**（不存在就是 404）。浏览器那一侧是 `components/FileEditor.tsx` + `pages/Files.tsx` 的编辑态。

- **信道上一律 LF，由服务端还原文件自己的行尾**（`applyEol(toLf(text), detectEol(bytes))`，`files/eol.ts`）：`<textarea>.value` 会把 CRLF 规范成 LF，照原样写回去就是**整个文件一个 diff**，而保存是成功的、内容是"对"的 —— 这个失败方向最不好发现。`toLf` 那一步是承重的，`applyEol` 不幂等，对已经是 CRLF 的输入会产出 `\r\r\n`。手工验一次：拿真 CRLF 文件改一行保存，`git diff --stat` 必须显示 ~1 行。
- **`rev` 乐观并发保护是必需的**，不是加固：代理正在编同一个仓库，没有它手机上一次保存会无声吃掉代理刚写的代码。`FileContent.rev` 是读到字节的短 sha256，带上且不匹配就 `409 file_changed`；**前端拿到 409 必须保留草稿**（重新读文件只为了换 `rev`，不是把磁盘版本盖到用户头上）。
- **`bodyLimit` 必须在路由上覆盖（2 MiB）**：Fastify 默认 1 MiB 会在**进 handler 之前**以 413 挡掉，一个 512 KB 但换行密集的文件 JSON 序列化后就接近这个数，症状看着像客户端 bug。
- `WorkspaceError` 的 `code` **可选，不给时响应体和以前逐字节相同**（`{error}`）——加它不能改变 GET 的行为。
- **`FileEditor` 是 `FileBody` 的兄弟、渲染替代它**，不是它的一个模式：FileBody 是逐行一个 div 的**阅读器**，textarea 自己滚、没有逐行元素、也不能被重排。**草稿只能从 `content.text` 初始化，绝不能从 `FileBody` 的 rows 来** —— `MAX_ROWS = 5000` 是渲染上限，从那里取会让 5000 行以上的文件保存时静默丢尾巴。编辑入口另有 `MAX_EDIT_LINES` 守卫，被截断的文件（`content.truncated`）**不可编辑**：只能读到前 512 KB，存回去就是砍掉文件尾巴。
- **编辑态下整个头部按钮簇被替换成 取消 / 保存**（返回、上一级、查看改动、刷新、源码/预览开关全没了）—— 这是「别手滑丢草稿」最硬的保证，出去的路只剩知道草稿存在的那两条。脏草稿在卸载时存进模块作用域（切底部导航会卸载整页，拦不住），和这两页既有的「回到离开时的位置」同一条哲学。
- `saveError` 与页面级的 `error` **分开**：一次保存失败落到 `error` 会满足 `firstLoad` 的回退条件，把用户弹回目录列表 —— 正好丢掉那份刚保存失败的草稿。

### 平台

- **端口按用途分段**：3xxx/5xxx 是浏览器访问的 HTTP，68xx 是 codex app-server。开发和部署**必须**分开：supervisor 用轮询 `/readyz` 判断 app-server 就绪，这个探测**只认端口、不认进程** —— 撞上就静默接到别人身上，且是竞态。`npm run dev` 会预检。
- **Windows 脚本约束**：`.ps1` 必须带 BOM、`.bat` 必须纯 ASCII；取二进制走 npm（`nssm-bin`）而不是 GitHub Releases（本机不通）；判断端口占用必须 `connect` 而不是试绑定（`SO_REUSEADDR` 允许绑定已占用地址）。
