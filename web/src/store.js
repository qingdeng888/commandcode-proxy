import { reactive, ref } from 'vue'
import { api } from './api'
import { toast } from './toast'

/* ---------------- 全局时钟（冷却倒计时 / 运行时长实时刷新） ---------------- */
export const now = ref(Date.now())
let clockTimer = null
export function startClock() {
  if (clockTimer) return
  now.value = Date.now()
  clockTimer = setInterval(() => {
    now.value = Date.now()
  }, 1000)
}
export function stopClock() {
  if (clockTimer) {
    clearInterval(clockTimer)
    clockTimer = null
  }
}

/* ---------------- 登录态 ---------------- */
export const auth = reactive({
  ready: false,
  loading: false,
  promise: null,
  authenticated: false,
  passwordConfigured: true,
  passwordSource: 'none',
  error: '',
})

/** 启动时调用 GET /admin/api/session 决定是否已登录。 */
export function loadSession(force = false) {
  if (auth.promise && !force) return auth.promise
  auth.loading = true
  auth.promise = (async () => {
    try {
      const { data } = await api('GET', '/session')
      auth.authenticated = !!(data && data.authenticated)
      auth.passwordConfigured = !data || data.passwordConfigured !== false
      auth.passwordSource = (data && data.passwordSource) || 'none'
      auth.error = ''
    } catch (e) {
      auth.authenticated = false
      if (e.status !== 401) auth.error = e.message
    } finally {
      auth.loading = false
      auth.ready = true
      auth.promise = null
    }
    return auth
  })()
  return auth.promise
}

export async function login(password) {
  const res = await api('POST', '/login', { password })
  auth.authenticated = true
  auth.error = ''
  auth.ready = true
  if (res.data && typeof res.data === 'object' && 'passwordConfigured' in res.data) {
    auth.passwordConfigured = res.data.passwordConfigured !== false
  }
  // 补齐 passwordSource 等信息（失败不影响登录结果）
  loadSession(true).catch(() => {})
  return res
}

export async function logout() {
  try {
    await api('POST', '/logout')
  } catch {
    /* 幂等：忽略退出接口错误 */
  }
  auth.authenticated = false
  auth.error = ''
  auth.ready = true
}

/* ---------------- 统计 ---------------- */
export const stats = reactive({ data: null, loaded: false, loading: false, error: '', promise: null })

export function loadStats(force = false) {
  if (stats.promise && !force) return stats.promise
  stats.loading = true
  stats.promise = (async () => {
    try {
      const { data } = await api('GET', '/stats')
      stats.data = data || null
      stats.loaded = true
      stats.error = ''
    } catch (e) {
      stats.error = e.message
    } finally {
      stats.loading = false
      stats.promise = null
    }
  })()
  return stats.promise
}

/* ---------------- 模型目录 ---------------- */
export const models = reactive({
  list: [],
  lastSyncAt: null,
  nextSyncInSec: 0,
  syncing: false,
  loaded: false,
  loading: false,
  error: '',
  promise: null,
})

export function loadModels(force = false) {
  if (models.promise && !force) return models.promise
  models.loading = true
  models.promise = (async () => {
    try {
      const { data } = await api('GET', '/models')
      models.list = (data && data.models) || []
      models.lastSyncAt = (data && data.lastSyncAt) || null
      models.nextSyncInSec = (data && data.nextSyncInSec) || 0
      models.syncing = !!(data && data.syncing)
      models.loaded = true
      models.error = ''
    } catch (e) {
      models.error = e.message
    } finally {
      models.loading = false
      models.promise = null
    }
  })()
  return models.promise
}

/** 立即重新拉取上游模型清单。 */
export async function refreshModels() {
  const res = await api('POST', '/models/refresh')
  await loadModels(true)
  return res
}

/* ---------------- Key 列表（多视图共享） ---------------- */
export const keysState = reactive({
  list: [],
  strategy: 'round_robin',
  loaded: false,
  loading: false,
  error: '',
  promise: null,
})

export function loadKeys(force = false) {
  if (keysState.promise && !force) return keysState.promise
  keysState.loading = true
  keysState.promise = (async () => {
    try {
      const { data } = await api('GET', '/keys')
      keysState.list = (data && data.keys) || []
      keysState.strategy = (data && data.strategy) || 'round_robin'
      keysState.loaded = true
      keysState.error = ''
    } catch (e) {
      keysState.error = e.message
    } finally {
      keysState.loading = false
      keysState.promise = null
    }
  })()
  return keysState.promise
}

export async function updateStrategy(strategy) {
  await api('POST', '/config/update', { strategy })
  keysState.strategy = strategy
  if (stats.data) stats.data.strategy = strategy
}

/* ---------------- 批量模型测试 ---------------- */
function emptySummary() {
  return { ok: 0, unauthorized: 0, quota: 0, not_in_plan: 0, network: 0, error: 0 }
}

export const batch = reactive({
  loaded: false,
  starting: false,
  running: false,
  polling: false,
  jobId: null,
  startedAt: null,
  finishedAt: null,
  total: 0,
  done: 0,
  results: [],
  summary: emptySummary(),
  error: '',
})

let batchTimer = null
let batchNoticePending = false

export function stopBatchPolling() {
  if (batchTimer) {
    clearTimeout(batchTimer)
    batchTimer = null
  }
}

function applyStatus(data) {
  if (!data || typeof data !== 'object') return
  batch.jobId = data.jobId ?? batch.jobId
  batch.startedAt = data.startedAt ?? batch.startedAt
  batch.finishedAt = data.finishedAt ?? null
  batch.total = Number(data.total) || 0
  batch.done = Number(data.done) || 0
  batch.results = Array.isArray(data.results) ? data.results : []
  batch.summary = Object.assign(emptySummary(), data.summary || {})
  const wasRunning = batch.running
  batch.running = !!data.running
  if (batch.jobId || batch.total > 0) batch.loaded = true
  if (wasRunning && !batch.running && batchNoticePending) {
    batchNoticePending = false
    const failed = batch.total - (batch.summary.ok || 0)
    toast.info(`批量测试完成：${batch.done}/${batch.total}，失败/异常 ${failed} 个`)
  }
}

export async function pollBatchOnce() {
  if (batch.polling) return
  batch.polling = true
  try {
    const { data } = await api('GET', '/models/test-status')
    batch.error = ''
    applyStatus(data)
  } catch (e) {
    batch.error = e.message
    batch.running = false
  } finally {
    batch.polling = false
  }
}

function scheduleBatchPoll(delay = 1000) {
  stopBatchPolling()
  batchTimer = setTimeout(async () => {
    await pollBatchOnce()
    if (batch.running) scheduleBatchPoll(1000)
  }, delay)
}

/** 视图挂载时调用：任务进行中则继续轮询。 */
export function ensureBatchPolling() {
  if (batch.running && !batchTimer) scheduleBatchPoll(400)
}

export async function startBatch(payload = {}) {
  batch.starting = true
  batch.error = ''
  try {
    const { data } = await api('POST', '/models/test-batch', payload)
    batch.jobId = (data && data.jobId) || null
    batch.loaded = true
    batch.running = true
    batch.startedAt = new Date().toISOString()
    batch.finishedAt = null
    batch.total = 0
    batch.done = 0
    batch.results = []
    batch.summary = emptySummary()
    batchNoticePending = true
    scheduleBatchPoll(500)
  } finally {
    batch.starting = false
  }
}

export async function cancelBatch() {
  const res = await api('POST', '/models/test-cancel')
  batch.running = false
  batchNoticePending = false
  stopBatchPolling()
  await pollBatchOnce()
  return res
}

export function resetBatchState() {
  batch.loaded = false
  batch.running = false
  batch.jobId = null
  batch.startedAt = null
  batch.finishedAt = null
  batch.total = 0
  batch.done = 0
  batch.results = []
  batch.summary = emptySummary()
  batch.error = ''
}

/** 便捷聚合导出，模板里可直接用 store.xxx。 */
export const store = {
  now,
  auth,
  stats,
  models,
  keysState,
  batch,
  loadSession,
  login,
  logout,
  loadStats,
  loadModels,
  refreshModels,
  loadKeys,
  updateStrategy,
  startBatch,
  cancelBatch,
  pollBatchOnce,
  ensureBatchPolling,
  stopBatchPolling,
  resetBatchState,
}
