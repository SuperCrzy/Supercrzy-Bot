/**
 * AI 浏览器「起始页」（2026-09-23）
 *
 * 为什么需要它 —— 不是为了好看，是为了让 attach 模式**有页可接管**：
 *
 * desktop 侧的原生视图（`WebContentsView`）建出来时必须先 loadURL 一个地址，
 * 而 `ai-browser.ts` 的接管判定有四条硬规则：
 *   · 空 URL → 会卡住 `connectOverCDP` 30s，必须排除
 *   · `about:blank` / `data:` / `file:` → 非 http(s)，排除
 *   · App 自己的 SPA 入口（`/`、`/index.html`）→ 是宿主 UI，排除
 *   · 于是视图落在 `about:blank` 时**一个可接管页面都找不到**，attach 直接报废。
 *
 * 所以这里提供一个真实 http(s)、同源但**非 SPA 入口路径**的起始页：
 *   - 是 http 页面 → 满足接管条件
 *   - path 是 `/browser-start.html` 而不是 `/` → 不撞「宿主 UI」排除
 *
 * ⚠️ 路径是契约的一部分：改动这里必须同步
 * `ai-browser.ts` 的 `HOST_UI_PATHS`（若把它改成 `/` 就会把自己排掉）。
 */
export const BROWSER_START_PAGE_PATH = '/browser-start.html'

export function browserStartPageHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI 浏览器</title>
<style>
  :root { color-scheme: light dark; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; align-items: center; justify-content: center;
    background: #f7f8fa; color: #1f2328;
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  }
  main { max-width: 30rem; padding: 2rem; }
  .k { font-size: 0.8125rem; letter-spacing: 0.08em; text-transform: uppercase; color: #8a93a6; margin: 0 0 0.75rem; }
  .d { font-size: 1rem; line-height: 1.75; margin: 0 0 1rem; }
  .h { font-size: 0.875rem; line-height: 1.7; color: #6b7280; border-left: 2px solid #d7dbe1; padding-left: 0.875rem; margin: 0; }
  @media (prefers-color-scheme: dark) {
    body { background: #141414; color: #e6e8ec; }
    .h { color: #9aa1ac; border-left-color: #333a45; }
    .k { color: #7c8593; }
  }
</style>
</head>
<body>
<main id="sc-start" data-sc-start="1">
  <p class="k">AI 浏览器</p>
  <p class="d">这里就是 AI 正在操作的那个网页内核。在地址栏输入网址即可打开；AI 打开网页时，这里会同步显示同一个页面。</p>
  <p class="h">人和 AI 共用同一个页面：你在这里打字，AI 看得见；AI 点过的位置，你也看得到。</p>
</main>
</body>
</html>`
}
