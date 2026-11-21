/**
 * Why does the AI browser sometimes render a phone layout in a wide panel?
 * Loads three typical sites at the production viewport (1000x700) and reports
 * what each one decided to serve.
 */
import { chromium } from 'playwright-core'

const SITES = ['https://www.baidu.com', 'https://www.zhihu.com', 'https://www.taobao.com']

const b = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--no-sandbox', '--no-proxy-server'],
})
const ctx = await b.newContext({ viewport: { width: 1000, height: 700 } })
const p = await ctx.newPage()

for (const url of SITES) {
  try {
    await p.goto(url, { timeout: 30000, waitUntil: 'domcontentloaded' })
    await p.waitForTimeout(1500)
    const info = await p.evaluate(() => {
      const meta = document.querySelector('meta[name="viewport"]')?.getAttribute('content') || ''
      const ua = navigator.userAgent
      const isMobileUA = /Mobile|Android|iPhone/.test(ua)
      const bodyW = document.body?.scrollWidth || 0
      const hasM = /^https?:\/\/m\./.test(location.href)
      return {
        finalUrl: location.href,
        innerWidth: window.innerWidth,
        bodyScrollWidth: bodyW,
        viewportMeta: meta,
        uaIsMobile: isMobileUA,
        redirectedToM: hasM,
        title: document.title.slice(0, 30),
      }
    })
    console.log(`\n${url}`)
    console.log(`  -> ${info.finalUrl.slice(0, 60)}`)
    console.log(`  title=${info.title} inner=${info.innerWidth} bodyScrollW=${info.bodyScrollWidth}`)
    console.log(`  viewportMeta="${info.viewportMeta}" uaMobile=${info.uaIsMobile} mRedirect=${info.redirectedToM}`)
  } catch (e) {
    console.log(`\n${url}\n  ERROR ${e.message.split('\n')[0].slice(0, 80)}`)
  }
}
await b.close()
