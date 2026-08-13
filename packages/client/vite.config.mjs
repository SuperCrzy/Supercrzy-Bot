import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'
import { resolve } from 'path'
import { fileURLToPath } from 'url'
const __dirname = fileURLToPath(new URL('.', import.meta.url))
export default defineConfig({
  cacheDir: '/tmp/vite-cache',
  plugins: [vue(), VitePWA({ registerType: 'autoUpdate', workbox: { maximumFileSizeToCacheInBytes: 10485760, globPatterns: ['**/*.{js,css,html,svg,png,woff2}'] }, manifest: { name:'SUPERCRZY BOT',short_name:'SUPERCRZY BOT',theme_color:'#1a1a2e',background_color:'#1a1a2e',display:'standalone',icons:[{src:'/logo-192.png',sizes:'192x192',type:'image/png'},{src:'/logo.png',sizes:'512x512',type:'image/png',purpose:'any maskable'}] } })],resolve:{alias:{'@':resolve(__dirname,'src')}},server:{port:5173,proxy:{'/api':{target:'http://localhost:3000',changeOrigin:true},'/ws':{target:'ws://localhost:3000',ws:true}}},
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
