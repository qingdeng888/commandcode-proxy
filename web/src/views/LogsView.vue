<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { api } from '../api'
import { toast } from '../toast'
import { fmtDateTime, fmtNum, fmtPayload } from '../utils'

const MAX = 500
const LEVELS = [
  { value: 'all', label: '全部' },
  { value: 'debug', label: 'debug' },
  { value: 'info', label: 'info' },
  { value: 'warn', label: 'warn' },
  { value: 'error', label: 'error' },
]

const logs = ref([]) // 最新在前
const pending = ref([])
const paused = ref(false)
const autoScroll = ref(true)
const levelFilter = ref('all')
const connState = ref('connecting')
const reconnectCount = ref(0)
const loadingHistory = ref(false)
const boxRef = ref(null)

let es = null
let keySeq = 0

const filtered = computed(() =>
  levelFilter.value === 'all' ? logs.value : logs.value.filter((l) => (l.level || 'info') === levelFilter.value),
)

const counts = computed(() => {
  const c = { all: logs.value.length, debug: 0, info: 0, warn: 0, error: 0 }
  for (const l of logs.value) {
    const lv = l.level || 'info'
    c[lv] = (c[lv] || 0) + 1
  }
  return c
})

const connLabel = computed(() => {
  if (connState.value === 'open') return '已连接'
  if (connState.value === 'connecting') return '连接中…'
  if (connState.value === 'error') return '连接中断，正在自动重连…'
  return '已断开'
})

function hasData(l) {
  return l && l.data !== undefined && l.data !== null && l.data !== ''
}

function pushEntry(entry) {
  if (!entry || typeof entry !== 'object') return
  if (!entry.__k) entry.__k = ++keySeq
  if (paused.value) {
    pending.value.unshift(entry)
    if (pending.value.length > MAX) pending.value.length = MAX
    return
  }
  logs.value.unshift(entry)
  if (logs.value.length > MAX) logs.value.length = MAX
}

function onMessage(ev) {
  if (!ev || !ev.data) return
  try {
    pushEntry(JSON.parse(ev.data))
  } catch {
    /* 忽略非 JSON 的心跳/异常负载 */
  }
}

function disconnect() {
  if (es) {
    es.close()
    es = null
  }
}

function connect() {
  disconnect()
  connState.value = 'connecting'
  try {
    es = new EventSource('/admin/api/logs/stream')
  } catch {
    connState.value = 'error'
    return
  }
  es.onopen = () => {
    connState.value = 'open'
  }
  es.onerror = () => {
    // EventSource 会自动重连，这里只更新状态
    connState.value = 'error'
    reconnectCount.value += 1
  }
  es.addEventListener('log', onMessage)
  es.onmessage = onMessage
}

async function refresh() {
  loadingHistory.value = true
  try {
    const params = new URLSearchParams({ limit: '200' })
    if (levelFilter.value !== 'all') params.set('level', levelFilter.value)
    const { data } = await api('GET', `/logs?${params.toString()}`)
    const list = (data && data.logs) || []
    logs.value = list.map((l) => ({ ...l, __k: ++keySeq })).slice(0, MAX)
    pending.value = []
    toast.success(`已加载 ${logs.value.length} 条日志`)
  } catch (e) {
    toast.error('加载日志失败：' + e.message)
  } finally {
    loadingHistory.value = false
  }
}

function togglePause() {
  if (paused.value) {
    if (pending.value.length) {
      logs.value = pending.value.concat(logs.value).slice(0, MAX)
      pending.value = []
    }
    paused.value = false
    toast.info('已恢复实时日志')
  } else {
    paused.value = true
    toast.info('已暂停实时日志，新日志将暂存缓冲')
  }
}

function clearLogs() {
  logs.value = []
  pending.value = []
  toast.info('已清空当前日志视图')
}

function setLevel(v) {
  levelFilter.value = v
}

watch(
  () => filtered.value.length,
  async () => {
    if (!autoScroll.value) return
    await nextTick()
    if (boxRef.value) boxRef.value.scrollTop = 0
  },
)

onMounted(() => {
  refresh()
  connect()
})

onUnmounted(() => {
  disconnect()
})
</script>

<template>
  <div>
    <h2>
      📜 请求日志
      <span class="probe-pill">EventSource 实时流 · 最多保留 500 条 · 最新在前</span>
      <button class="btn btn-sm" style="margin-left: auto" type="button" :disabled="loadingHistory" @click="refresh">
        <span v-if="loadingHistory" class="loading"></span>
        {{ loadingHistory ? '加载中…' : '🔄 刷新' }}
      </button>
    </h2>

    <div class="section">
      <div class="section-title">
        📜 实时日志
        <span
          class="badge"
          :class="connState === 'open' ? 'ok' : connState === 'connecting' ? 'warn' : 'danger'"
        >{{ connLabel }}</span>
        <span v-if="reconnectCount" class="probe-pill">重连 {{ fmtNum(reconnectCount) }} 次</span>
        <span class="spacer"></span>
        <button class="btn btn-sm" type="button" @click="togglePause">
          {{ paused ? '▶ 继续' : '⏸ 暂停' }}
        </button>
        <button class="btn btn-sm" type="button" @click="clearLogs">🧹 清屏</button>
        <button class="btn btn-sm" type="button" title="重新建立 SSE 连接" @click="connect">🔌 重连</button>
      </div>

      <div class="section-body" style="padding-bottom: 0">
        <div class="justify-between">
          <div class="tabs" style="border-bottom: none; padding: 0">
            <button
              v-for="lv in LEVELS"
              :key="lv.value"
              class="tab"
              :class="{ active: levelFilter === lv.value }"
              type="button"
              @click="setLevel(lv.value)"
            >
              {{ lv.label }}
              <span class="probe-pill">{{ fmtNum(counts[lv.value] || 0) }}</span>
            </button>
          </div>
          <label class="inline-flex" style="cursor: pointer; font-size: 12px; color: var(--text2)">
            <span class="switch">
              <input v-model="autoScroll" type="checkbox" />
              <span class="slider"></span>
            </span>
            自动滚动
          </label>
        </div>

        <div v-if="paused" class="hint text-amber">
          ⏸ 已暂停：缓冲 {{ fmtNum(pending.length) }} 条新日志，点击「继续」后合并显示。
        </div>
      </div>

      <div class="section-body">
        <div ref="boxRef" class="log-box">
          <div v-if="!filtered.length" class="empty">
            {{ logs.length ? '当前级别下暂无日志' : '暂无日志' }}
          </div>
          <div v-for="l in filtered" :key="l.__k" class="log-row">
            <span class="log-time">{{ fmtDateTime(l.time) }}</span>
            <span class="log-level" :class="l.level || 'info'">{{ l.level || 'info' }}</span>
            <div class="log-body">
              <div class="log-msg">{{ l.msg || l.message || '' }}</div>
              <pre v-if="hasData(l)" class="log-data">{{ fmtPayload(l.data) }}</pre>
            </div>
          </div>
        </div>
        <div class="hint">
          连接由 <code>EventSource('/admin/api/logs/stream')</code> 提供，断线后浏览器会自动重连；服务端每 20 秒发送一次心跳注释行。
        </div>
      </div>
    </div>
  </div>
</template>
