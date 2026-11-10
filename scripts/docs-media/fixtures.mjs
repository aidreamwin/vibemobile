export const NOW = Date.parse('2026-01-15T02:00:00Z')
export const ROOT = '/demo/aurora-shop'
export const THREAD = 'demo-checkout'
export const TURN = 'demo-turn'
export const PROMPT = '修复购物车空列表时的总价显示，补上测试。'
export const INTRO = '问题已定位：空购物车没有初始金额。接下来修复计算逻辑，再运行测试。'
export const RESULT =
  '已修复空购物车总价。\n\n- 空列表返回 `0`，正常订单保持原有计算。\n- 新增空购物车用例，**3 项测试通过**。\n\n可以查看本轮改动，或打开 [cart.ts](src/cart.ts:1) 检查源码。'
export const SOURCE = [
  'export type CartItem = {',
  '  price: number',
  '  quantity: number',
  '}',
  '',
  'export function total(items: CartItem[]) {',
  '  return items.reduce(',
  '    (sum, item) =>',
  '      sum + item.price * item.quantity,',
  '    0,',
  '  )',
  '}',
  '',
].join('\n')
export const DIFF = [
  'diff --git a/src/cart.ts b/src/cart.ts',
  '--- a/src/cart.ts',
  '+++ b/src/cart.ts',
  '@@ -4,8 +4,9 @@',
  ' }',
  ' ',
  ' export function total(items: CartItem[]) {',
  '   return items.reduce(',
  '     (sum, item) =>',
  '-      sum + item.price * item.quantity',
  '+      sum + item.price * item.quantity,',
  '+    0,',
  '   )',
  ' }',
  'diff --git a/src/cart.test.ts b/src/cart.test.ts',
  '--- a/src/cart.test.ts',
  '+++ b/src/cart.test.ts',
  '@@ -1,4 +1,8 @@',
  " import { expect, it } from 'vitest'",
  " import { total } from './cart'",
  ' ',
  "+it('empty cart returns zero', () => {",
  '+  expect(total([])).toBe(0)',
  '+})',
  '+',
  " it('adds item totals', () => {",
].join('\n')
export const providers = [
  { id: 'codex', displayName: 'Codex', model: 'GPT-6.1-Sol' },
  { id: 'claude', displayName: 'Claude Code', model: 'claude-sonnet-4-5' },
  { id: 'opencode', displayName: 'OpenCode', model: 'GPT-6.1-Sol' },
].map((p) => ({ ...p, available: true, authenticated: true }))
export const sessions = [
  { id: THREAD, provider: 'codex', title: '修复购物车总价', preview: '空列表显示异常，补上边界测试。', pinned: true },
  {
    id: 'demo-layout',
    provider: 'claude',
    title: '优化商品页移动端布局',
    preview: '正在检查小屏幕下的按钮与间距。',
    status: 'working',
  },
  { id: 'demo-search', provider: 'opencode', title: '为商品搜索补充测试', preview: '搜索与分页用例已整理。' },
].map((s, index) => ({
  cwd: ROOT,
  projectId: 'aurora-shop',
  model: providers.find((p) => p.id === s.provider).model,
  createdAt: NOW - 3_600_000,
  updatedAt: NOW - index * 300_000,
  status: 'idle',
  needsAttention: false,
  sandbox: 'workspace-write',
  approvalPolicy: 'on-request',
  reasoningEffort: 'medium',
  ...s,
}))
export const approval = {
  requestId: 'demo-approval',
  threadId: THREAD,
  turnId: TURN,
  itemId: 'demo-test',
  type: 'command',
  title: '运行购物车测试',
  detail: 'npm test -- src/cart.test.ts',
  cwd: ROOT,
  reason: '修复已完成，运行测试确认空购物车与正常订单的行为。',
  availableDecisions: ['accept', 'decline', 'cancel'],
}
export const steps = ['定位空购物车问题', '修复计算并补充用例', '运行测试并检查改动']
export const command = {
  kind: 'command',
  id: 'demo-test',
  command: approval.detail,
  cwd: ROOT,
  status: 'done',
  exitCode: 0,
  durationMs: 840,
  output:
    'PASS src/cart.test.ts\n  ✓ empty cart returns zero\n  ✓ adds item totals\n  ✓ supports multiple quantities\n\nTests  3 passed (3)',
}
export const chapters = [
  {
    tag: '01 / AI 移动入口',
    title: '让 AI 执行，\n你掌控方向。',
    text: '提出需求、查看进度、处理授权。\n随时决定下一步怎么走。',
  },
  {
    tag: '02 / 实时跟进',
    title: '发出指令，\n看见执行进展。',
    text: '消息逐步出现，计划同步更新。\n随时了解代理正在做什么。',
  },
  {
    tag: '03 / 手机授权',
    title: '需要确认时，\n直接在手机决策。',
    text: '先看清命令、目录和原因，\n再决定允许、拒绝或中断。',
  },
  {
    tag: '04 / 检查结果',
    title: '改了什么，\n在手机上看清。',
    text: '检查文件 Diff 与测试结果，\n点击文件引用继续查看源码。',
  },
  {
    tag: '05 / 查看源码',
    title: '从回答，\n直接走到代码。',
    text: '文件引用在当前界面打开，\n带着上下文检查具体实现。',
  },
  { tag: '06 / 持续执行', title: '终端也能\n随身接续。', text: '手机直连持久终端。\n查看测试结果，接着处理下一步。' },
  {
    tag: '07 / 多 Provider',
    title: '切换供应商，\n保持工作流连续。',
    text: '在设置中管理 Codex、Claude Code、OpenCode。\n按项目选择合适的模型与连接。',
  },
]

export const agentProfiles = {
  data: {
    codex: [
      {
        id: 'openai-main',
        name: 'OpenAI 主账号',
        baseUrl: 'https://api.openai.com/v1',
        model: 'GPT-6.1-Sol',
        models: ['GPT-6.1-Sol', 'GPT-6.1-Sol-mini'],
        modelContextWindows: { 'GPT-6.1-Sol': 256000 },
        hasApiKey: true,
        active: true,
        updatedAt: NOW,
      },
    ],
    claude: [
      {
        id: 'anthropic-main',
        name: 'Anthropic 工作账号',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-sonnet-4-5',
        models: ['claude-sonnet-4-5'],
        hasApiKey: true,
        active: true,
        updatedAt: NOW,
      },
    ],
    opencode: [
      {
        id: 'team-gateway',
        name: '团队网关',
        baseUrl: 'https://gateway.example.com/v1',
        model: 'GPT-6.1-Sol',
        models: ['GPT-6.1-Sol'],
        hasApiKey: true,
        active: false,
        updatedAt: NOW,
      },
    ],
  },
  active: { codex: 'openai-main', claude: 'anthropic-main', opencode: null },
}
