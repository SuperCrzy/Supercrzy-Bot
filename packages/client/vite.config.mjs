import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'
import { resolve } from 'path'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
const __dirname = fileURLToPath(new URL('.', import.meta.url))
/** Client package version — kept in sync across all workspaces by scripts/version.mjs. */
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
export default defineConfig({
  // 相对路径 base：Electron file:// 加载需要（绝对路径 /assets 在 file:// 下解析到磁盘根 → 黑屏）；
  // 网页部署到子路径也兼容
  base: './',
  // 版本号的唯一来源：这里的 package.json（由 scripts/version.mjs 与其余 workspace 同步）。
  // 取代原先硬编码在 src/data/changelog.ts 里的 ENGINE_VERSION —— 那个常量写在注释里说
  // "必须与 package.json 一致"，但没有任何检查盯着它，于是停更四个月（0.4.0 vs 1.2.3）。
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  // 依赖缓存用项目内默认（node_modules/.vite）——曾配 /tmp/vite-cache 导致 deps 并发加载挂起（@fs 对 /tmp 的边界问题）
  plugins: [vue(), VitePWA({ registerType: 'autoUpdate', workbox: { maximumFileSizeToCacheInBytes: 10485760, globPatterns: ['**/*.{js,css,html,svg,png,woff2}'] }, manifest: { name:'SUPERCRZY BOT',short_name:'SUPERCRZY BOT',theme_color:'#1a1a2e',background_color:'#1a1a2e',display:'standalone',icons:[{src:'/logo-192.png',sizes:'192x192',type:'image/png'},{src:'/logo.png',sizes:'512x512',type:'image/png',purpose:'any maskable'}] } })],resolve:{alias:{'@':resolve(__dirname,'src')}},server:{port:5173,proxy:{
    '/api': {
      target: 'http://localhost:3000',
      changeOrigin: true,
      // 关键：禁用响应缓冲，否则开发环境下"流"会被攒成"一次性到达"。
      //   · text/event-stream → SSE（正文流式转发）
      //   · audio/*          → TTS 朗读音频（2026-09-28 起 /api/tts/stream 边合成边下发）。
      //     **漏掉这一条会让"边收边播"在 dev 下完全失效**，而生产（不经过 vite）却是好的 ——
      //     典型的"只有开发环境有问题"，所以两个一起列在这里。
      configure: (proxy) => {
        proxy.on('proxyRes', (proxyRes) => {
          const ct = proxyRes.headers['content-type'] || ''
          if (ct.includes('text/event-stream') || ct.startsWith('audio/')) {
            delete proxyRes.headers['content-length']
            proxyRes.headers['cache-control'] = 'no-cache, no-transform'
            proxyRes.headers['x-accel-buffering'] = 'no'
            proxyRes.headers['connection'] = 'keep-alive'
          }
        })
      }
    },
    '/ws': { target: 'ws://localhost:3000', ws: true }
  }},
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          echarts: ['echarts'],
          monaco: ['monaco-editor'],
        }
      }
    }
  }
})
