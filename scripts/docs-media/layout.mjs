import { chapters } from './fixtures.mjs'

const escapeHtml = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;')
const lines = (value) => escapeHtml(value).replaceAll('\n', '<br>')
const base = `*{box-sizing:border-box}body{margin:0;color:#f2f5f4;background:#101918;font-family:"Segoe UI","Microsoft YaHei",sans-serif}img{display:block} .mint{color:#9ae8c1}.muted{color:#a3b4b0}.brand{font-weight:650;letter-spacing:-1px}.mark{display:inline-block;width:12px;height:12px;background:#9ae8c1;border-radius:4px;margin-right:12px}.eyebrow{font-size:14px;letter-spacing:2px}.phone{border:1px solid #4a5b55;border-radius:25px;padding:7px;background:#202a27;box-shadow:0 24px 60px #0005;overflow:hidden}.phone img{width:100%;border-radius:18px}.badge{border:1px solid #4a5b55;border-radius:20px;padding:7px 14px;font-size:13px;color:#bdcec7} .foot{position:absolute;bottom:28px;left:44px;right:44px;display:flex;justify-content:space-between;font-size:12px;color:#9bafa7}`
const document = (style, body) =>
  `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>${base}${style}</style><body>${body}</body></html>`

export function chapterLayout(png, index) {
  const chapter = chapters[index]
  return document(
    `body{width:1000px;height:820px;background:radial-gradient(ellipse at 85% 12%,#223e32,transparent 60%),#101918}.brand{position:absolute;top:44px;left:44px;font-size:22px}.badge{position:absolute;right:44px;top:42px}.copy{position:absolute;top:245px;left:44px;width:465px}h1{font-size:51px;line-height:1.25;letter-spacing:-2px;font-weight:650;margin:22px 0}p{font-size:19px;line-height:1.9;color:#a3b4b0}.phone{position:absolute;top:88px;left:572px;width:364px}.progress{display:flex;gap:8px;margin-top:42px}.progress i{width:34px;height:3px;background:#34463e;border-radius:3px}.progress i.active{background:#9ae8c1}`,
    `
    <div class="brand"><span class="mark"></span>VibeMobile</div><span class="badge">真实界面 · 工作场景</span>
    <div class="copy"><span class="eyebrow mint">${chapter.tag}</span><h1>${lines(chapter.title)}</h1><p>${lines(chapter.text)}</p>
    <div class="progress">${chapters.map((_, i) => `<i class="${i === index ? 'active' : ''}"></i>`).join('')}</div></div>
    <div class="phone"><img alt="${escapeHtml(chapter.tag)}" src="${png}"></div>
    <div class="foot"><span>手机远程驱动自己的编码代理</span><span>Aurora Shop · 购物车修复</span></div>`,
  )
}

export function overviewLayout(images) {
  return document(
    `body{width:1600px;height:1000px;background:radial-gradient(ellipse at 80% 20%,#243f33,transparent 65%),#101918}.brand{position:absolute;top:58px;left:64px;font-size:28px}.badge{position:absolute;right:64px;top:58px}.copy{position:absolute;left:64px;top:263px;width:410px}h1{font-size:72px;line-height:1.17;letter-spacing:-4px;margin:22px 0 28px;font-weight:650}.copy p{font-size:22px;line-height:1.8;color:#a3b4b0}.agents{margin-top:42px;line-height:2;font-size:15px;color:#c7dbd0}.screens{position:absolute;left:560px;right:72px;top:130px;display:flex;gap:34px;align-items:flex-start}.screen{width:420px}.caption{margin:18px 0 0 8px;font-size:17px;font-weight:600}.number{color:#9ae8c1;margin-right:7px;font-size:12px}.foot{left:64px;right:64px;bottom:40px;font-size:14px}`,
    `
    <div class="brand"><span class="mark"></span>VibeMobile</div><span class="badge">真实界面 · 工作场景</span>
    <div class="copy"><span class="eyebrow mint">AI 原生 · 移动优先</span><h1>随时指挥 AI，<br>持续构建。</h1><p>你提出意图，<br>AI 负责执行。<br>开发入口随身携带。</p><div class="agents">Codex &nbsp; / &nbsp; Claude Code &nbsp; / &nbsp; OpenCode</div></div>
    <div class="screens">${images.map((png, i) => `<div class="screen"><div class="phone"><img src="${png}" alt="${['统一查看会话', '切换多 Provider'][i]}"></div><div class="caption"><span class="number">0${i + 1}</span>${['统一查看会话', '切换多 Provider'][i]}</div></div>`).join('')}</div>
    <div class="foot"><span>手机负责控制与反馈，电脑或服务器负责代码与执行。</span><span>演示场景：Aurora Shop · 购物车修复</span></div>`,
  )
}

export function galleryLayout() {
  const names = ['sessions', 'streaming', 'approval', 'diff', 'source', 'terminal', 'settings']
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VibeMobile · 功能演示</title>
    <style>${base}body{max-width:1400px;padding:36px 24px;margin:auto}h1{font-size:28px}p{color:#a3b4b0;line-height:1.8}a{color:#9ae8c1}img{max-width:100%;height:auto;border-radius:14px}#motion{max-width:1000px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:28px}.grid img{max-width:390px;width:100%}h2{margin-top:40px}button{color:#101918;background:#9ae8c1;border:0;border-radius:8px;padding:10px 16px;cursor:pointer;margin:8px 0 16px}</style>
    <h1>VibeMobile · AI 原生，移动优先</h1><p>手机负责提出需求、审批与验收，AI Coding Agent 负责执行。</p>
    <img src="webp/overview.webp" alt="VibeMobile 核心功能：会话、授权、代码改动和 Provider 设置"><h2>完整流程</h2><p>查看会话 → 发送任务 → 实时输出 → 允许测试 → 查看 Diff → 打开源码 → 终端 → Provider 设置。GIF 按需播放，可切回静态图。</p>
    <button type="button" id="toggle">播放演示 GIF</button><img id="motion" src="webp/workflow-poster.webp" alt="购物车修复的操作流程">
    <h2>逐屏查看</h2><div class="grid">${chapters.map((chapter, i) => `<article><h3>${chapter.tag}</h3><p>${lines(chapter.text)}</p><a href="webp/${names[i]}.webp"><img src="webp/${names[i]}.webp" alt="${escapeHtml(chapter.tag)}"></a></article>`).join('')}</div>
    <p><a href="../demo.md">复现与迭代说明</a> · <a href="manifest.json">素材清单</a></p>
    <script>document.querySelector('#toggle').onclick = function () { const image = document.querySelector('#motion'); const play = this.textContent.includes('播放'); image.src = play ? 'workflow.gif' : 'webp/workflow-poster.webp'; this.textContent = play ? '停止动画' : '播放演示 GIF' }</script></html>`
}
