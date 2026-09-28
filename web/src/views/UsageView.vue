<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { api } from '../api'
import { loadStats } from '../store'
import { toast } from '../toast'
import { SOURCE_LABELS, fmtDateTime, fmtNum, fmtTokens } from '../utils'
import StatCard from '../components/StatCard.vue'

const data = ref(null)
const loading = ref(false)
const error = ref('')
const busy = reactive({})

const items = computed(() => (data.value && data.value.items) || [])
const summary = computed(() => (data.value && data.value.summary) || {})

async function loadUsage(silent = false) {
  if (!silent) loading.value = true
  try {
    const res = await api('GET', '/usage')
    data.value = res.data || null
    error.value = ''
  } catch (e) {
    error.value = e.message
    if (!silent) toast.error('加载用量失败：' + e.message)
  } finally {
    loading.value = false
  }
}

function failPercent(it) {
  const total = Number(it.requestsToday) || 0
  const failed = Number(it.failedToday) || 0
  if (!total || !failed) return 0
  return Math.round((failed / total) * 100)
}

async function resetUsage(it, scope) {
  const message =
    scope === 'all'
      ? '确定重置用量吗？\n将重置该 Key 的【全部】用量，累计数据也会被清空，不可恢复。'
      : '确定重置用量吗？\n将重置该 Key 的【今日】用量，累计数据不受影响。'
  if (!window.confirm(message)) return
  const id = it.keyId
  const flag = `${id}:${scope}`
  busy[flag] = true
  try {
    const res = await api('POST', '/usage/reset', { keyId: id, scope })
    toast.success(res.message || (scope === 'all' ? '全部用量已重置' : '今日用量已重置'))
    await loadUsage(true)
    loadStats(true)
  } catch (e) {
    toast.error('重置失败：' + e.message)
  } finally {
    busy[flag] = false
  }
}

onMounted(() => {
  loadUsage()
})
</script>

<template>
  <div>
    <h2>
      📈 用量
      <span class="probe-pill">统计来自本代理本地计数</span>
      <button class="btn btn-sm" style="margin-left: auto" type="button" :disabled="loading" @click="loadUsage()">
        <span v-if="loading" class="loading"></span>
        {{ loading ? '加载中…' : '🔄 刷新' }}
      </button>
    </h2>

    <div v-if="error" class="result-box" style="border-color: rgba(248,113,113,.4)">
      <div class="title text-danger">❌ 用量加载失败</div>
      <div class="hint">{{ error }}</div>
    </div>

    <div class="cards">
      <StatCard :value="fmtNum(summary.requestsToday)" label="今日请求" tone="blue" :sub="`累计 ${fmtNum(summary.requestsTotal)}`" />
      <StatCard :value="fmtNum(summary.failedToday)" label="今日失败" tone="red" :sub="`累计失败 ${fmtNum(summary.failedTotal)}`" />
      <StatCard
        :value="`${fmtTokens(summary.inToday)} / ${fmtTokens(summary.outToday)}`"
        label="今日 Tokens（输入 / 输出）"
        tone="yellow"
        :sub="`累计 ${fmtTokens(summary.inTotal)} / ${fmtTokens(summary.outTotal)}`"
      />
      <StatCard :value="fmtNum(items.length)" label="统计中的 Key" tone="green" sub="按 Key 维度统计" />
    </div>

    <div class="section">
      <div class="section-title">
        📈 每 Key 用量
        <span class="probe-pill">请求 = 成功 + 失败；重置只作用于所选范围</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Key</th>
              <th>标签</th>
              <th>来源</th>
              <th>今日请求</th>
              <th>今日成功</th>
              <th>今日失败</th>
              <th>累计请求</th>
              <th>累计失败</th>
              <th>今日 Tokens（入/出）</th>
              <th>累计 Tokens（入/出）</th>
              <th>最后使用</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!items.length">
              <td colspan="12" class="empty">{{ loading ? '加载中…' : '暂无用量数据' }}</td>
            </tr>
            <tr v-for="it in items" :key="it.keyId">
              <td>
                <span class="key-display">{{ it.keyMasked || '-' }}</span>
                <div class="text-dim" style="font-size: 11px" :title="it.keyId">{{ it.keyId }}</div>
              </td>
              <td>{{ it.label || '-' }}</td>
              <td><span class="model-tag" :class="it.source">{{ SOURCE_LABELS[it.source] || it.source || '-' }}</span></td>
              <td class="mono">{{ fmtNum(it.requestsToday) }}</td>
              <td class="mono text-green">{{ fmtNum(it.successToday) }}</td>
              <td class="mono" :class="it.failedToday ? 'text-danger' : ''">
                {{ fmtNum(it.failedToday) }}
                <span v-if="failPercent(it)" class="text-dim" style="font-size: 10px">({{ failPercent(it) }}%)</span>
              </td>
              <td class="mono">{{ fmtNum(it.requestsTotal) }}</td>
              <td class="mono" :class="it.failedTotal ? 'text-danger' : ''">{{ fmtNum(it.failedTotal) }}</td>
              <td class="mono">{{ fmtTokens(it.tokensInToday) }} / {{ fmtTokens(it.tokensOutToday) }}</td>
              <td class="mono">{{ fmtTokens(it.tokensInTotal) }} / {{ fmtTokens(it.tokensOutTotal) }}</td>
              <td class="mono">{{ fmtDateTime(it.lastUsedAt) }}</td>
              <td style="white-space: nowrap">
                <button
                  class="btn btn-sm"
                  type="button"
                  title="重置该 Key 今日用量（累计数据不受影响）"
                  :disabled="!!busy[`${it.keyId}:today`]"
                  @click="resetUsage(it, 'today')"
                >
                  <span v-if="busy[`${it.keyId}:today`]" class="loading"></span>
                  <span v-else>↻ 今日</span>
                </button>
                <button
                  class="btn btn-sm btn-danger"
                  style="margin-left: 6px"
                  type="button"
                  title="重置该 Key 全部用量（不可恢复）"
                  :disabled="!!busy[`${it.keyId}:all`]"
                  @click="resetUsage(it, 'all')"
                >
                  <span v-if="busy[`${it.keyId}:all`]" class="loading"></span>
                  <span v-else>🗑 全部</span>
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="section-body" style="padding-top: 12px">
        <div class="hint">
          重置仅影响本代理的本地计数，不会改变上游真实额度；「全部」会同时清空累计数据。
        </div>
      </div>
    </div>
  </div>
</template>
