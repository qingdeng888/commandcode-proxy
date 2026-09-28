import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import { setUnauthorizedHandler } from './api'
import { auth, startClock } from './store'
import './styles.css'

// 统一 401 处理：清空登录态 + 跳回登录视图（会话已失效时）。
setUnauthorizedHandler(() => {
  const wasAuthenticated = auth.authenticated
  auth.authenticated = false
  if (wasAuthenticated && router.currentRoute.value.name !== 'login') {
    router.replace({ name: 'login' })
  }
})

startClock()

const app = createApp(App)
app.use(router)
app.mount('#app')
