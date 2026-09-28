<script setup>
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { api } from '../api'
import {
  keysState,
  loadKeys,
  loadStats,
  loadTestPrompt,
  now,
  resetTestPrompt,
  testMessagePayload,
  testPrompt,
  updateStrategy,
} from '../store'
import { toast } from '../toast'
import {
  SOURCE_LABELS,
  STRATEGY_LABELS,
  STRATEGY_OPTIONS,
  categoryLabel,
  fmtDateTime,
  fmtLatency,
  fmtNum,
  fmtRemaining,
  fmtTokens,
  remainingSeconds,
  truncate,
} from '../utils'
import CategoryBadge from '../components/CategoryBadge.vue'
import TestResultBox from '../components/TestResultBox.vue'

const busy = reactive({ add: false, strategy: false, rowId: '', revealingId: '', testingId: '', importingId: '' })
const addForm = reactive({ key: '', label: '' })
const editing = reactive({ id: '', label: '', enabled: true })
const revealed = reactive({})
const revealTimers = {}
const rowTests = reactive({})
const lastTest = ref(null)

const rows = computed(() => keysState.list || [])

const strategy = computed({
  get: () => keysState.strategy || 'round_robin',
  set: (v) => {
    doSetStrategy(v)
  },
})

function onMountedLoad() {
  if (!keysState.loaded) loadKeys()
}

async function doSetStrategy(v) {
  if (!v || v === keysState.strategy) return
  busy.strategy = true
  try {
    await updateStrategy(v)
    toast.success(`策略已更新为：${STRATEGY_LABELS[v] || v}`)
  } catch (e) {
    toast.error('策略更新失败：' + e.message)
    await loadKeys(true)
  } finally {
    busy.strategy = false
  }
}

async function addKey() {
  const key = addForm.key.trim()
  const label = addForm.label.trim()
  if (!key) {
    toast.error('请填写 Key')
    return
  }
  if (/\s/.test(key) || !key.startsWith('user_')) {
    toast.error('Key 格式不正确')
    return
  }
  busy.add = true
  try {
    const body = { key }
    if (label) body.label = label
    const res = await api('POST', '/keys', body)
    toast.success(res.message || 'Key 已添加')
    addForm.key = ''
    addForm.label = ''
    await loadKeys(true)
    loadStats(true)
  } catch (e) {
    toast.error('添加失败：' + e.message)
  } finally {
    busy.add = false
  }
}

function startEdit(k) {
  editing.id = k.id
  editing.label = k.label || ''
  editing.enabled = !!k.enabled
}

function cancelEdit() {
  editing.id = ''
}

async function saveEdit(k) {
  busy.rowId = k.id
  try {
    await api('POST', '/keys/update', { id: k.id, label: editing.label, enabled: editing.enabled })
    toast.success('已保存修改')
    editing.id = ''
    await loadKeys(true)
  } catch (e) {
    toast.error('保存失败：' + e.message)
  } finally {
    busy.rowId = ''
  }
}

async function onToggle(k, checked) {
  busy.rowId = k.id
  try {
    await api('POST', '/keys/update', { id: k.id, enabled: checked })
    toast.success(checked ? '已启用该 Key' : '已禁用该 Key')
  } catch (e) {
    toast.error('操作失败：' + e.message)
  } finally {
    busy.rowId = ''
    await loadKeys(true)
    loadStats(true)
  }
}

async function removeKey(k) {
  if (!window.confirm('确定删除该 Key 吗？')) return
  busy.rowId = k.id
  try {
    await api('POST', '/keys/delete', { id: k.id })
    toast.success('Key 已删除')
    await loadKeys(true)
    loadStats(true)
  } catch (e) {
    toast.error('删除失败：' + e.message)
  } finally {
    busy.rowId = ''
  }
}

async function importKey(k) {
  busy.importingId = k.id
  try {
    const res = await api('POST', '/keys/import', { id: k.id })
    toast.success(res.message || '已导入为后台 Key')
    await loadKeys(true)
  } catch (e) {
    toast.error('导入失败：' + e.message)
  } finally {
    busy.importingId = ''
  }
}

async function reveal(k) {
  if (revealed[k.id]) {
    maskNow(k.id)
    return
  }
  busy.revealingId = k.id
  try {
    const { data } = await api('POST', '/keys/reveal', { id: k.id })
    const full = data && data.key
    if (!full) {
      toast.error('服务端未返回完整 Key')
      return
    }
    revealed[k.id] = full
    if (revealTimers[k.id]) clearTimeout(revealTimers[k.id])
    revealTimers[k.id] = setTimeout(() => maskNow(k.id), 5000)
    toast.info('已显示完整 Key，5 秒后自动重新脱敏')
  } catch (e) {
    toast.error('获取完整 Key 失败：' + e.message)
  } finally {
    busy.revealingId = ''
  }
}

function maskNow(id) {
  if (revealTimers[id]) {
    clearTimeout(revealTimers[id])
    delete revealTimers[id]
  }
  delete revealed[id]
}

async function copyText(text) {
  const value = String(text ?? '')
  if (!value) return
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(value)
    } else {
      const ta = document.createElement('textarea')
      ta.value = value
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    toast.success('已复制到剪贴板')
  } catch {
    toast.error('复制失败，请手动选择复制')
  }
}

async function testKey(k) {
  busy.testingId = k.id
  try {
    const { data } = await api('POST', '/keys/test', { id: k.id, ...testMessagePayload() })
    if (!data) {
      toast.info('测试完成，但服务端未返回结果')
      return
    }
    rowTests[k.id] = data
    lastTest.value = { label: k.label || k.keyMasked, result: data }
    if (data.ok) {
      toast.success(`Key 测试通过（${fmtLatency(data.latencyMs)}）`)
    } else if (data.category === 'not_in_plan') {
      toast.warning('Key 有效，但该模型不在套餐内')
    } else {
      toast.error(`Key 测试失败：${data.message || categoryLabel(data.category)}`)
    }
  } catch (e) {
    toast.error('Key 测试失败：' + e.message)
  } finally {
    busy.testingId = ''
  }
}

function shownKey(k) {
  return revealed[k.id] || k.keyMasked || '-'
}

function isReadonly(k) {
  return k.source === 'config' || k.source === 'env'
}

function healthCategory(k) {
  const t = rowTests[k.id]
  if (t) return t.category
  return (k.health && k.health.status) || 'unknown'
}

function healthLatency(k) {
  const t = rowTests[k.id]
  if (t) return t.latencyMs
  return k.health ? k.health.latencyMs : null
}

function healthMessage(k) {
  const t = rowTests[k.id]
  if (t) return t.message
  return (k.health && k.health.message) || ''
}

function healthCheckedAt(k) {
  const t = rowTests[k.id]
  if (t) return t.checkedAt
  return k.health ? k.health.checkedAt : null
}

function cooldownLeft(k) {
  return remainingSeconds(k.cooldownUntil, now.value)
}

onMounted(() => {
  loadTestPrompt()
  onMountedLoad()
  loadStats()
})

onUnmounted(() => {
  Object.keys(revealTimers).forEach((id) => clearTimeout(revealTimers[id]))
})
</script>

<template>
  <div>
    <h2>
      🔑 上游 Key
      <span class="probe-pill">Command Code 账号凭证（user_ 开头）· 这是服务端拿去调用上游用的</span>
      <button class="btn btn-sm" style="margin-left: auto" type="button" :disabled="keysState.loading" @click="loadKeys(true)">
        <span v-if="keysState.loading" class="loading"></span>
        {{ keysState.loading ? '加载中…' : '🔄 刷新' }}
      </button>
    </h2>

    <div class="result-box" style="border-color: rgba(34,211,238,.35)">
      <div class="title text-accent">🔑 这是「上游 Key」，不是给客户端用的 Key</div>
      <div class="hint">
        这里的 Key 是 <strong>Command Code 账号凭证</strong>（<code>user_</code> 开头），
        本代理拿它去调用上游。<strong>绝对不要发给下游客户端</strong> —— 那等于把账号送人。<br />
        给下游客户端用的凭证请到 <router-link to="/api-keys">🔐 2API Key</router-link> 页签发
        （<code>ccp_</code> 开头，可逐个吊销）。
      </div>
    </div>

    <div class="section">
      <div class="section-title">
        ⚙️ 轮询策略
        <span class="probe-pill">所有 Key 在多账号间的选择方式</span>
      </div>
      <div class="section-body">
        <div class="form-row">
          <div class="field">
            <label>策略</label>
            <select v-model="strategy" :disabled="busy.strategy">
              <option v-for="opt in STRATEGY_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="field" style="flex: 1 1 100%">
            <label>
              测试消息
              <button class="btn btn-sm" type="button" style="margin-left: 8px" @click="resetTestPrompt">
                ↺ 恢复默认
              </button>
            </label>
            <input
              v-model="testPrompt.message"
              type="text"
              :maxlength="testPrompt.maxLen"
              placeholder="留空则使用默认提示词"
            />
            <div class="hint" style="margin-top: 6px">
              点 ⚡ 测试 Key 时发送的内容；默认：<code>{{ testPrompt.defaultMessage }}</code>
            </div>
          </div>
        </div>
        <div class="hint">
          <strong>轮询</strong>按顺序依次使用；<strong>随机</strong>随机挑选；<strong>填满</strong>优先压满同一个 Key 再切换。
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">➕ 添加 Key</div>
      <div class="section-body">
        <div class="form-row">
          <div class="field">
            <label>Key *</label>
            <input v-model="addForm.key" type="text" class="mono" placeholder="user_…" autocomplete="off" />
          </div>
          <div class="field">
            <label>标签（可选）</label>
            <input v-model="addForm.label" type="text" placeholder="例如：主号" />
          </div>
          <div class="field" style="flex: 0 0 auto">
            <button class="btn btn-primary" type="button" :disabled="busy.add" @click="addKey">
              <span v-if="busy.add" class="loading" style="border-top-color: #04121a"></span>
              {{ busy.add ? '添加中…' : '➕ 添加' }}
            </button>
          </div>
        </div>
        <div class="hint">Key 必须以 <code>user_</code> 开头且不含空格；重复添加会提示「该 Key 已存在」。</div>
      </div>
    </div>

    <TestResultBox v-if="lastTest" :result="lastTest.result" :title="`最近一次 Key 测试：${lastTest.label}`" />

    <div class="section">
      <div class="section-title">
        🔑 Key 列表
        <span class="probe-pill">共 {{ fmtNum(rows.length) }} 个</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Key</th>
              <th>标签</th>
              <th>来源</th>
              <th>启用</th>
              <th>用量</th>
              <th>健康</th>
              <th>冷却</th>
              <th>最后错误</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!rows.length">
              <td colspan="9" class="empty">
                {{ keysState.loading ? '加载中…' : '暂无 Key，请在上方添加' }}
              </td>
            </tr>
            <tr v-for="k in rows" :key="k.id">
              <td>
                <span
                  class="key-display"
                  :class="{ revealed: !!revealed[k.id] }"
                  :title="revealed[k.id] ? '点击重新脱敏' : '点击 👁 显示完整 Key'"
                  @click="reveal(k)"
                >{{ shownKey(k) }}</span>
                <span v-if="revealed[k.id]" class="copy-icon" title="复制" @click="copyText(revealed[k.id])">📋</span>
              </td>
              <td>
                <input
                  v-if="editing.id === k.id"
                  v-model="editing.label"
                  type="text"
                  placeholder="标签"
                  style="width: 140px; padding: 4px 8px; font-size: 12px"
                />
                <template v-else>{{ k.label || '-' }}</template>
              </td>
              <td>
                <span class="model-tag" :class="k.source">{{ SOURCE_LABELS[k.source] || k.source || '-' }}</span>
                <div class="text-dim" style="font-size: 11px" :title="k.id">{{ truncate(k.id, 18) }}</div>
              </td>
              <td>
                <label class="switch" :title="isReadonly(k) ? 'config / env 来源只读，导入后可管理' : '启用 / 禁用'">
                  <input v-if="editing.id === k.id" v-model="editing.enabled" type="checkbox" />
                  <input
                    v-else
                    type="checkbox"
                    :checked="!!k.enabled"
                    :disabled="busy.rowId === k.id"
                    @change="onToggle(k, $event.target.checked)"
                  />
                  <span class="slider"></span>
                </label>
              </td>
              <td class="mono">
                今日 {{ fmtNum(k.usage && k.usage.requestsToday) }} / 累计 {{ fmtNum(k.usage && k.usage.requestsTotal) }}
                <div class="text-dim" style="font-size: 11px">
                  入 {{ fmtTokens(k.usage && k.usage.tokensInToday) }} / 出 {{ fmtTokens(k.usage && k.usage.tokensOutToday) }}
                </div>
              </td>
              <td>
                <CategoryBadge :category="healthCategory(k)" :message="healthMessage(k)" />
                <div class="text-dim" style="font-size: 11px">
                  <span v-if="rowTests[k.id]" class="text-accent">本次 · </span>
                  {{ fmtLatency(healthLatency(k)) }}
                  <span v-if="healthCheckedAt(k)"> · {{ fmtDateTime(healthCheckedAt(k)) }}</span>
                </div>
                <div v-if="healthMessage(k)" class="text-dim" style="font-size: 11px; max-width: 220px; white-space: normal">
                  {{ healthMessage(k) }}
                </div>
              </td>
              <td>
                <span v-if="cooldownLeft(k) > 0" class="badge warn" :title="`冷却至 ${fmtDateTime(k.cooldownUntil)}`">
                  剩余 {{ fmtRemaining(cooldownLeft(k)) }}
                </span>
                <span v-else>-</span>
              </td>
              <td>
                <span v-if="k.lastError" class="cell-error" :title="k.lastError">{{ truncate(k.lastError, 34) }}</span>
                <span v-else>-</span>
              </td>
              <td style="white-space: nowrap">
                <template v-if="editing.id === k.id">
                  <button class="btn btn-sm btn-primary" type="button" :disabled="busy.rowId === k.id" @click="saveEdit(k)">
                    保存
                  </button>
                  <button class="btn btn-sm" style="margin-left: 6px" type="button" @click="cancelEdit">取消</button>
                </template>
                <template v-else>
                  <button class="btn btn-sm btn-icon" type="button" title="显示 / 隐藏完整 Key" @click="reveal(k)">
                    {{ revealed[k.id] ? '🙈' : '👁' }}
                  </button>
                  <button
                    class="btn btn-sm btn-icon"
                    style="margin-left: 6px"
                    type="button"
                    title="测试该 Key 是否可用"
                    :disabled="busy.testingId === k.id"
                    @click="testKey(k)"
                  >
                    <span v-if="busy.testingId === k.id" class="loading"></span>
                    <span v-else>⚡</span>
                  </button>
                  <button
                    class="btn btn-sm btn-icon"
                    style="margin-left: 6px"
                    type="button"
                    title="编辑标签 / 启用状态"
                    @click="startEdit(k)"
                  >
                    ✏️
                  </button>
                  <button
                    v-if="isReadonly(k)"
                    class="btn btn-sm"
                    style="margin-left: 6px"
                    type="button"
                    title="导入为后台可管理的 Key"
                    :disabled="busy.importingId === k.id"
                    @click="importKey(k)"
                  >
                    导入
                  </button>
                  <button
                    class="btn btn-sm btn-danger btn-icon"
                    style="margin-left: 6px"
                    type="button"
                    title="删除"
                    :disabled="isReadonly(k) || busy.rowId === k.id"
                    @click="removeKey(k)"
                  >
                    ✕
                  </button>
                </template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="section-body" style="padding-top: 0">
        <div class="hint">
          列表中的 Key 默认脱敏，点击 👁 会调用 <code>keys/reveal</code> 获取完整值，5 秒后自动重新脱敏。
        </div>
      </div>
    </div>
  </div>
</template>
