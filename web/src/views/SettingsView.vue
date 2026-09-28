<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { api } from '../api'
import { loadModels, models, stats, loadStats } from '../store'
import { toast } from '../toast'
import { LEVEL_OPTIONS, STRATEGY_OPTIONS, fmtNum } from '../utils'

const config = ref(null)
const loading = ref(false)
const saving = ref(false)
const error = ref('')

const form = reactive({
  strategy: 'round_robin',
  defaultModel: '',
  zdr: false,
  upstreamProxy: '',
  logLevel: 'info',
  logFile: '',
  apiBase: '',
  projectSlug: '',
  proxyKey: '',
})

const pw = reactive({ current: '', next: '', confirm: '' })
const pwBusy = ref(false)
const pwResult = ref('')
const pwOk = ref(false)

const modelOptions = computed(() => {
  const list = (models.list || []).map((m) => m.id)
  if (form.defaultModel && !list.includes(form.defaultModel)) list.unshift(form.defaultModel)
  return list
})

const version = computed(() => (config.value && config.value.version) || (stats.data && stats.data.version) || '-')

function applyConfig(cfg) {
  if (!cfg) return
  form.strategy = cfg.strategy || 'round_robin'
  form.defaultModel = cfg.defaultModel || ''
  form.zdr = !!cfg.zdr
  form.upstreamProxy = cfg.upstreamProxy || ''
  form.logLevel = cfg.logLevel || 'info'
  form.logFile = cfg.logFile || ''
  form.apiBase = cfg.apiBase || ''
  form.projectSlug = cfg.projectSlug || ''
  form.proxyKey = ''
}

async function loadConfig() {
  loading.value = true
  try {
    const { data } = await api('GET', '/config')
    config.value = data || null
    applyConfig(config.value)
    error.value = ''
  } catch (e) {
    error.value = e.message
    toast.error('加载配置失败：' + e.message)
  } finally {
    loading.value = false
  }
}

async function saveConfig() {
  saving.value = true
  try {
    const payload = {
      strategy: form.strategy,
      defaultModel: form.defaultModel,
      zdr: !!form.zdr,
      upstreamProxy: form.upstreamProxy,
      logLevel: form.logLevel,
      logFile: form.logFile,
      apiBase: form.apiBase,
      projectSlug: form.projectSlug,
    }
    // proxyKey 为写入型字段：留空表示不修改
    if (form.proxyKey) payload.proxyKey = form.proxyKey
    const res = await api('POST', '/config/update', payload)
    if (res.data) {
      config.value = res.data
      applyConfig(res.data)
    }
    toast.success(res.message || '配置已保存')
  } catch (e) {
    toast.error('保存失败：' + e.message)
  } finally {
    saving.value = false
  }
}

async function changePassword() {
  const current = pw.current
  const next = pw.next
  pwResult.value = ''
  pwOk.value = false
  if (!current || !next) {
    pwResult.value = '请填写当前密码和新密码'
    return
  }
  if (next !== pw.confirm) {
    pwResult.value = '两次输入的新密码不一致'
    return
  }
  if (next.length < 8) {
    pwResult.value = '新密码至少 8 位'
    return
  }
  pwBusy.value = true
  try {
    // 该接口用 401 表示「当前密码错误」，不能触发全局跳登录
    const res = await api('POST', '/password', { current, new: next }, { skipAuthRedirect: true })
    pwOk.value = true
    pwResult.value = '✅ ' + (res.message || '密码已更新')
    pw.current = ''
    pw.next = ''
    pw.confirm = ''
    toast.success(res.message || '密码已更新')
  } catch (e) {
    pwResult.value = '❌ ' + e.message
    toast.error(e.message)
  } finally {
    pwBusy.value = false
  }
}

onMounted(() => {
  loadConfig()
  loadModels()
  if (!stats.loaded) loadStats()
})
</script>

<template>
  <div>
    <h2>
      ⚙️ 设置
      <span class="probe-pill">写入 data/settings.json（后台设置层，原子替换）</span>
      <button class="btn btn-sm" style="margin-left: auto" type="button" :disabled="loading" @click="loadConfig">
        <span v-if="loading" class="loading"></span>
        {{ loading ? '加载中…' : '🔄 重新加载' }}
      </button>
    </h2>

    <div v-if="error" class="result-box" style="border-color: rgba(248,113,113,.4)">
      <div class="title text-danger">❌ 配置加载失败</div>
      <div class="hint">{{ error }}</div>
    </div>

    <div class="section">
      <div class="section-title">🔧 运行配置</div>
      <div class="section-body">
        <div class="form-row">
          <div class="field">
            <label>轮询策略</label>
            <select v-model="form.strategy">
              <option v-for="opt in STRATEGY_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
            </select>
          </div>
          <div class="field">
            <label>默认模型</label>
            <select v-model="form.defaultModel">
              <option value="">（未设置）</option>
              <option v-for="m in modelOptions" :key="m" :value="m">{{ m }}</option>
            </select>
          </div>
        </div>

        <div class="form-row">
          <div class="field">
            <label>上游地址 apiBase</label>
            <input v-model="form.apiBase" type="text" class="mono" placeholder="https://api.commandcode.ai" />
          </div>
          <div class="field">
            <label>项目标识 projectSlug</label>
            <input v-model="form.projectSlug" type="text" placeholder="cc-proxy" />
          </div>
        </div>

        <div class="form-row">
          <div class="field">
            <label>上游代理 upstreamProxy</label>
            <input v-model="form.upstreamProxy" type="text" class="mono" placeholder="http://127.0.0.1:7890（留空为直连）" />
          </div>
          <div class="field">
            <label>代理口令 proxyKey（留空表示不修改）</label>
            <input
              v-model="form.proxyKey"
              type="password"
              placeholder="设置后用于客户端访问代理"
              autocomplete="new-password"
            />
          </div>
        </div>

        <div class="form-row">
          <div class="field">
            <label>日志级别 logLevel</label>
            <select v-model="form.logLevel">
              <option v-for="opt in LEVEL_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
            </select>
          </div>
          <div class="field">
            <label>日志文件 logFile</label>
            <input v-model="form.logFile" type="text" class="mono" placeholder="留空表示仅输出到控制台" />
          </div>
        </div>

        <div class="form-row">
          <div class="field" style="flex: 0 0 auto">
            <label>零数据保留 zdr</label>
            <label class="inline-flex" style="cursor: pointer">
              <span class="switch">
                <input v-model="form.zdr" type="checkbox" />
                <span class="slider"></span>
              </span>
              <span style="font-size: 12.5px">{{ form.zdr ? '已开启' : '已关闭' }}</span>
            </label>
          </div>
        </div>

        <div class="form-actions">
          <button class="btn btn-primary" type="button" :disabled="saving || loading" @click="saveConfig">
            <span v-if="saving" class="loading" style="border-top-color: #04121a"></span>
            {{ saving ? '保存中…' : '💾 保存配置' }}
          </button>
        </div>
        <div class="hint">
          修改 <strong>port</strong> / <strong>host</strong> 需重启进程后生效（本页不修改这两项）。
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">ℹ️ 运行环境（只读）</div>
      <div class="section-body">
        <dl class="kv">
          <dt>监听地址</dt>
          <dd class="mono">{{ (config && config.host) || '-' }}:{{ (config && config.port) || '-' }}</dd>
          <dt>引擎版本</dt>
          <dd class="mono">{{ version }}</dd>
          <dt>数据目录</dt>
          <dd class="mono">{{ (config && config.dataDir) || '-' }}</dd>
          <dt>配置文件</dt>
          <dd class="mono">{{ (config && config.configPath) || '-' }}</dd>
          <dt>代理口令</dt>
          <dd>
            <span class="badge" :class="config && config.proxyKeySet ? 'ok' : 'muted'">
              {{ config && config.proxyKeySet ? '已设置' : '未设置' }}
            </span>
          </dd>
          <dt>使用上游模型清单</dt>
          <dd>{{ config ? (config.useProviderModels ? '是' : '否') : '-' }}</dd>
          <dt>模型刷新间隔</dt>
          <dd class="mono">
            {{ config && config.modelRefreshIntervalMs ? fmtNum(Math.round(config.modelRefreshIntervalMs / 1000)) + ' 秒' : '-' }}
          </dd>
        </dl>
      </div>
    </div>

    <div class="section">
      <div class="section-title">🔐 修改后台密码</div>
      <div class="section-body">
        <div class="form-row">
          <div class="field">
            <label>当前密码</label>
            <input v-model="pw.current" type="password" autocomplete="current-password" />
          </div>
          <div class="field">
            <label>新密码</label>
            <input v-model="pw.next" type="password" autocomplete="new-password" />
          </div>
          <div class="field">
            <label>确认新密码</label>
            <input v-model="pw.confirm" type="password" autocomplete="new-password" @keyup.enter="changePassword" />
          </div>
        </div>
        <div class="form-actions">
          <button class="btn btn-success" type="button" :disabled="pwBusy" @click="changePassword">
            <span v-if="pwBusy" class="loading" style="border-top-color: #04231a"></span>
            {{ pwBusy ? '提交中…' : '💾 修改密码' }}
          </button>
          <span v-if="pwResult" :class="pwOk ? 'text-green' : 'text-danger'" style="font-size: 12.5px">{{ pwResult }}</span>
        </div>
        <div class="hint">
          修改后密码会持久化保存，并立即使其它登录会话失效；新密码至少 8 位。
        </div>
      </div>
    </div>
  </div>
</template>
