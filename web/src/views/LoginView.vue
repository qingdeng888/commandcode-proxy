<script setup>
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { auth, login } from '../store'
import { toast } from '../toast'

const router = useRouter()
const route = useRoute()

const password = ref('')
const busy = ref(false)
const errorMsg = ref('')

const notConfigured = computed(
  () => auth.passwordConfigured === false || /未(设置|配置)管理密码|未设置管理密码/.test(errorMsg.value),
)

async function submit() {
  if (!password.value) {
    errorMsg.value = '请输入密码'
    return
  }
  busy.value = true
  errorMsg.value = ''
  try {
    await login(password.value)
    toast.success('登录成功')
    const redirect = route.query && route.query.redirect
    const target = typeof redirect === 'string' && redirect.startsWith('/') && !redirect.startsWith('/login') ? redirect : null
    await router.replace(target || { name: 'dashboard' })
  } catch (e) {
    errorMsg.value = e && e.message ? e.message : '登录失败'
    if (e && e.status === 503) auth.passwordConfigured = false
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="login-shell">
    <div class="login-card">
      <div class="logo">⚡</div>
      <div class="title">Command Code 代理管理后台</div>
      <div class="sub">请输入管理密码以继续</div>

      <div v-if="notConfigured" class="not-configured">
        <div>⚠️ <strong>后台尚未设置管理密码</strong></div>
        <div>出于安全考虑，未设置管理密码时后台拒绝访问。请在 config.json / 环境变量中设置后重启服务。</div>
        <code>ADMIN_PASSWORD=你的管理密码</code>
      </div>

      <form @submit.prevent="submit">
        <div class="field">
          <label for="password">密码</label>
          <input
            id="password"
            v-model="password"
            type="password"
            placeholder="请输入管理密码"
            autocomplete="current-password"
            autofocus
          />
        </div>
        <button class="btn" type="submit" :disabled="busy">
          <span v-if="busy" class="loading" style="border-top-color: #04121a"></span>
          {{ busy ? '登录中...' : '登 录' }}
        </button>
      </form>

      <div class="msg" :class="errorMsg ? 'error' : ''">{{ errorMsg }}</div>
      <div v-if="auth.error && !errorMsg" class="msg error">{{ auth.error }}</div>
      <div class="hint">此面板受到保护，请妥善保管密码</div>
    </div>
  </div>
</template>
