import { createApp, h, ref } from 'vue'
import { createPinia } from 'pinia'
import naive from 'naive-ui'
import i18n from './src/i18n'
import DetailPanel from './src/components/layout/DetailPanel.vue'
import { useAppStore } from './src/stores/app'
import './src/styles/tokens.css'
import './src/assets/styles/global.css'
const pinia=createPinia()
const app=createApp({setup(){const store=useAppStore(); store.addFileChange('/test/example.ts','const n = 1','const n = 2'); const tab=ref<any>('changes'); return ()=>h(DetailPanel,{visible:true,activeTab:tab.value,'onUpdate:tab':(x:string)=>tab.value=x})}})
app.use(pinia).use(i18n()).use(naive).mount('#app')
