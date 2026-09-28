import { createRouter, createWebHashHistory } from 'vue-router'
import { auth, loadSession } from './store'
import AdminLayout from './components/AdminLayout.vue'
import LoginView from './views/LoginView.vue'
import DashboardView from './views/DashboardView.vue'
import KeysView from './views/KeysView.vue'
import ApiKeysView from './views/ApiKeysView.vue'
import ModelsView from './views/ModelsView.vue'
import UsageView from './views/UsageView.vue'
import LogsView from './views/LogsView.vue'
import SettingsView from './views/SettingsView.vue'

// 使用 hash 路由：静态托管在 /admin/ 下，无需服务端 SPA fallback。
const routes = [
  {
    path: '/login',
    name: 'login',
    component: LoginView,
    meta: { title: '登录', public: true },
  },
  {
    path: '/',
    component: AdminLayout,
    children: [
      { path: '', redirect: { name: 'dashboard' } },
      { path: 'dashboard', name: 'dashboard', component: DashboardView, meta: { title: '仪表盘' } },
      // 两套 Key 分成两个页面：上游 Key 是服务端凭证，2API Key 是签发给下游的凭证
      { path: 'api-keys', name: 'apiKeys', component: ApiKeysView, meta: { title: '2API Key' } },
      { path: 'keys', name: 'keys', component: KeysView, meta: { title: '上游 Key' } },
      { path: 'models', name: 'models', component: ModelsView, meta: { title: '模型' } },
      { path: 'usage', name: 'usage', component: UsageView, meta: { title: '用量' } },
      { path: 'logs', name: 'logs', component: LogsView, meta: { title: '请求日志' } },
      { path: 'settings', name: 'settings', component: SettingsView, meta: { title: '设置' } },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: { name: 'dashboard' } },
]

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
})

router.beforeEach(async (to) => {
  // 启动时用 GET /admin/api/session 决定登录态
  if (!auth.ready) await loadSession()

  if (to.meta && to.meta.public) {
    if (auth.authenticated) return { name: 'dashboard' }
    return true
  }
  if (!auth.authenticated) {
    return { name: 'login' }
  }
  return true
})

router.afterEach((to) => {
  const title = to.meta && to.meta.title
  document.title = title ? `${title} - Command Code 代理管理后台` : 'Command Code 代理管理后台'
})

export default router
