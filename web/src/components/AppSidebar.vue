<script setup>
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { logout } from '../store'
import { toast } from '../toast'

const router = useRouter()

const NAV = [
  { name: 'dashboard', icon: '📊', title: '仪表盘' },
  { name: 'keys', icon: '🔑', title: 'Key 管理' },
  { name: 'models', icon: '🧠', title: '模型' },
  { name: 'usage', icon: '📈', title: '用量' },
  { name: 'logs', icon: '📜', title: '请求日志' },
  { name: 'settings', icon: '⚙️', title: '设置' },
]

const apiAddress = computed(() => {
  if (typeof window === 'undefined' || !window.location || !window.location.host) return '-'
  return window.location.origin
})

const theme = ref(readTheme())
const themeIcon = computed(() => (theme.value === 'dark' ? '🌙' : '☀️'))

function readTheme() {
  try {
    return localStorage.getItem('theme') === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t)
  try {
    localStorage.setItem('theme', t)
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

function toggleTheme() {
  theme.value = theme.value === 'dark' ? 'light' : 'dark'
  applyTheme(theme.value)
}

async function doLogout() {
  if (!window.confirm('确定退出登录吗？')) return
  await logout()
  toast.success('已退出登录')
  router.replace({ name: 'login' })
}
</script>

<template>
  <aside class="sidebar">
    <h1>
      <span class="logo">⚡</span>
      <span class="brand-name">Command Code 代理</span>
      <button class="theme-toggle" type="button" title="切换主题" @click="toggleTheme">
        <span class="icon">{{ themeIcon }}</span>
        <span class="light-label">浅色</span>
        <span class="dark-label">深色</span>
      </button>
    </h1>

    <router-link
      v-for="item in NAV"
      :key="item.name"
      class="nav-item"
      active-class="active"
      :to="{ name: item.name }"
    >
      <span class="nav-ico">{{ item.icon }}</span>
      <span>{{ item.title }}</span>
    </router-link>

    <div class="sidebar-footer">
      <div style="margin-bottom: 8px">
        <button class="btn btn-sm btn-danger" type="button" @click="doLogout">⏻ 退出登录</button>
      </div>
      <div class="footer-addr">API 地址: <span>{{ apiAddress }}</span></div>
    </div>
  </aside>
</template>
