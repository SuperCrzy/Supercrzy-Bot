import { createApp } from 'vue'
import { createPinia } from 'pinia'
import naive from 'naive-ui'
import App from './App.vue'
import createRouter from './router'
import createI18n from './i18n'
import './styles/tokens.css'
import './assets/styles/global.css'

const app = createApp(App)

const router = createRouter()
const i18n = createI18n()
const pinia = createPinia()

app.use(pinia)
app.use(router)
app.use(i18n)
app.use(naive)

app.mount('#app')
