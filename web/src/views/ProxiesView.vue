<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { api } from '../api'
import { loadKeys, keysState } from '../store'
import { toast } from '../toast'
import { fmtDateTime, fmtLatency, fmtNum } from '../utils'

/*
 * 出站代理池 = 本代理访问 Command Code 时走的**出口**。
 *
 * 三条路由形态：
 *   direct        直连（不经过任何代理）
 *   http://…      普通 HTTP 代理（CONNECT 隧道）
 *   #pool / pool+ 轮换型代理池（Resin 之类）：每条新连接换一个出口 IP
 *
 * 上游 Key 与代理有三种绑定模式：
 *   auto    静态 i%N 绑定，代理故障时自动转移到最空闲的健康代理（默认）
 *   bind    固定在这条代理上，故障也不自动迁移（「这个号就走这个 IP」）
 *   rotate  每次尝试都重新挑一条健康代理（要的就是每次换 IP）
 */

const state = reactive({
  list: [],
  bindings: [],
  proxyFile: '',
  proxyFileError: '',
  dataFile: '',
  loading: false,
  loaded: false,
})

const addForm = reactive({ value: '' })
const bulkText = ref('')
const bulkOpen = ref(false)
const busy = reactive({ add: false, bulk: false, rowId: '', testingId: '', savingId: '', batch: false })
const batchProgress = ref('')
const editing = reactive({ id: '', value: '' })
const revealed = reactive({})
const testResults = reactive({})
const selected = ref([])

// 绑定行自带 keyId（服务端给的），用它去 Key 池里取展示信息 ——
// 不要按下标对齐：Key 池里被禁用的 Key 不参与绑定，下标一旦错位就会把
// 「A 的绑定」画在「B 的行」上。
const keysById = computed(() => {
  const map = {}
  for (const k of (keysState.list || [])) map[k.id] = k
  return map
})

function keyOf(binding) {
  return binding && binding.keyId ? (keysById.value[binding.keyId] || null) : null
}

const healthyCount = computed(() => state.list.filter((t) => t.healthy).length)
const poolCount = computed(() => state.list.filter((t) => t.pool).length)
const allSelected = computed(() => state.list.length > 0 && selected.value.length === state.list.length)
// 部分选中：表头复选框画成「不确定」态。没有它，勾了一半时表头看起来是未勾选，
// 用户会以为自己没选任何东西（参考实现也是这么处理的）。
const someSelected = computed(() => selected.value.length > 0 && !allSelected.value)

async function load() {
  state.loading = true
  try {
    const { data } = await api('GET', '/proxies')
    state.list = (data && data.proxies) || []
    state.bindings = (data && data.bindings) || []
    state.proxyFile = (data && data.proxyFile) || ''
    state.proxyFileError = (data && data.proxyFileError) || ''
    state.dataFile = (data && data.dataFile) || ''
    state.loaded = true
  } catch (e) {
    toast.error('加载代理池失败：' + e.message)
  } finally {
    state.loading = false
  }
}

function applyPayload(data) {
  if (!data) return
  if (data.proxies) state.list = data.proxies
  if (data.bindings) state.bindings = data.bindings
  if (data.proxyFile !== undefined) state.proxyFile = data.proxyFile || ''
  if (data.proxyFileError !== undefined) state.proxyFileError = data.proxyFileError || ''
}

async function add() {
  const value = addForm.value.trim()
  if (!value) return
  busy.add = true
  try {
    const { data, message } = await api('POST', '/proxies', { value })
    applyPayload(data)
    addForm.value = ''
    toast.success(message || '已添加')
  } catch (e) {
    toast.error('添加失败：' + e.message)
  } finally {
    busy.add = false
  }
}

async function addBulk() {
  if (!bulkText.value.trim()) return
  busy.bulk = true
  try {
    const { data, message } = await api('POST', '/proxies/bulk', { text: bulkText.value })
    applyPayload(data)
    bulkText.value = ''
    toast.success(message || '已批量添加')
  } catch (e) {
    toast.error('批量添加失败：' + e.message)
  } finally {
    busy.bulk = false
  }
}

function startEdit(t) {
  editing.id = t.id
  editing.value = revealed[t.id] || t.address
}

async function saveEdit() {
  busy.savingId = editing.id
  try {
    const { data, message } = await api('POST', '/proxies/update', { id: editing.id, value: editing.value })
    applyPayload(data)
    delete revealed[editing.id]
    editing.id = ''
    toast.success(message || '已保存')
  } catch (e) {
    toast.error('保存失败：' + e.message)
  } finally {
    busy.savingId = ''
  }
}

async function toggleEnabled(t, enabled) {
  busy.rowId = t.id
  try {
    const { data, message } = await api('POST', '/proxies/enabled', { ids: [t.id], enabled })
    applyPayload(data)
    toast.success(message || (enabled ? '已启用' : '已停用'))
  } catch (e) {
    toast.error('操作失败：' + e.message)
  } finally {
    busy.rowId = ''
  }
}

async function setEnabledForSelection(enabled) {
  const ids = [...selected.value]
  if (!ids.length) return
  const label = enabled ? '启用' : '停用'
  if (!window.confirm(`确定${label}所选 ${ids.length} 条代理吗？`)) return
  busy.rowId = 'bulk'
  try {
    const { data, message } = await api('POST', '/proxies/enabled', { ids, enabled })
    applyPayload(data)
    selected.value = []
    toast.success(message || `已${label} ${ids.length} 条`)
  } catch (e) {
    toast.error('操作失败：' + e.message)
  } finally {
    busy.rowId = ''
  }
}

async function removeMany(ids) {
  if (!ids.length) return
  if (!window.confirm(`确定删除所选 ${ids.length} 条代理吗？\n\n来自 config.json 或代理文件的条目无法删除，只能停用。`)) return
  busy.rowId = 'bulk'
  try {
    const { data, message } = await api('POST', '/proxies/delete', { ids })
    applyPayload(data)
    selected.value = []
    toast.success(message || '已删除')
  } catch (e) {
    toast.error('删除失败：' + e.message)
  } finally {
    busy.rowId = ''
  }
}

async function test(t) {
  busy.testingId = t.id
  delete testResults[t.id]
  try {
    const { data, message } = await api('POST', '/proxies/test', { id: t.id })
    applyPayload(data)
    testResults[t.id] = { ok: data.ok, latencyMs: data.latencyMs, error: data.error, at: Date.now() }
    if (data.ok) toast.success(message || '连通正常')
    else toast.error('不可达：' + (data.error || '未知原因'))
  } catch (e) {
    toast.error('测试失败：' + e.message)
  } finally {
    busy.testingId = ''
  }
}

/**
 * 批量测试选中的代理。走服务端的 /proxies/test-batch 而不是前端 for 循环逐条调：
 * 并发由服务端统一控制（默认 4），结果一次返回完整一张表 ——
 * 前端循环会在中途遇到限流/超时后留下半张表，用户不知道剩下的是「没测」还是「测失败了」。
 */
async function testSelected() {
  const ids = [...selected.value]
  if (!ids.length) {
    toast.error('请先勾选要测试的代理')
    return
  }
  busy.batch = true
  // 不画「1/N」的假进度：服务端一次调用跑完再返回，前端并不知道当前走到第几条。
  // 与其显示一个永远停在 0/N 的计数器，不如如实说「正在测 N 条」。
  batchProgress.value = `正在测试 ${ids.length} 条…`
  try {
    const { data, message } = await api('POST', '/proxies/test-batch', { ids })
    applyPayload(data)
    for (const r of (data.results || [])) {
      testResults[r.id] = { ok: r.ok, latencyMs: r.latencyMs, error: r.error, status: r.status, at: Date.now() }
    }
    const s = data.summary || {}
    if (s.failed) toast.error(message || `测试完成：${s.ok}/${s.total} 条连通`)
    else toast.success(message || `测试完成：${s.ok}/${s.total} 条连通`)
  } catch (e) {
    toast.error('批量测试失败：' + e.message)
  } finally {
    busy.batch = false
    batchProgress.value = ''
  }
}

async function reveal(t) {
  busy.rowId = t.id
  try {
    const { data } = await api('POST', '/proxies/reveal', { id: t.id })
    revealed[t.id] = data.value
    setTimeout(() => { delete revealed[t.id] }, 15000)
  } catch (e) {
    toast.error('获取明文失败：' + e.message)
  } finally {
    busy.rowId = ''
  }
}

async function copy(text, label = '已复制') {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(label)
  } catch {
    toast.error('复制失败，请手动选择复制')
  }
}

function toggleSelect(id, checked) {
  const set = new Set(selected.value)
  if (checked) set.add(id)
  else set.delete(id)
  selected.value = [...set]
}

function toggleSelectAll(checked) {
  selected.value = checked ? state.list.map((t) => t.id) : []
}

/** 表头复选框在「部分选中」时点击应当变成全选，而不是依赖浏览器的默认行为。 */
function onSelectAllClick(event) {
  toggleSelectAll(event.target.checked)
}

/** 绑定改动：mode 变化后立即重读，因为 auto 的实际落点是服务端算的。 */
async function setBinding(keyId, mode, proxyId) {
  busy.rowId = keyId
  try {
    const { data, message } = await api('POST', '/proxies/binding', { keyId, mode, proxyId })
    applyPayload(data)
    toast.success(message || '已保存')
  } catch (e) {
    toast.error('绑定失败：' + e.message)
  } finally {
    busy.rowId = ''
  }
}

function keyIdOf(binding) {
  return binding && binding.keyId ? binding.keyId : ''
}

onMounted(async () => {
  if (!keysState.loaded) await loadKeys().catch(() => {})
  await load()
})
</script>

<template>
  <div>
    <h2>
      🌐 出站代理池
      <span class="probe-pill">
        共 {{ fmtNum(state.list.length) }} 条 · 健康 {{ fmtNum(healthyCount) }}
        <template v-if="poolCount"> · 轮换池 {{ fmtNum(poolCount) }}</template>
      </span>
      <button class="btn btn-sm" style="margin-left: auto" type="button" :disabled="state.loading" @click="load">
        <span v-if="state.loading" class="loading"></span>
        {{ state.loading ? '加载中…' : '🔄 刷新' }}
      </button>
    </h2>

    <div class="section">
      <div class="section-title">📖 这是什么</div>
      <div class="section-body">
        <div class="hint">
          代理池决定本代理**从哪里出去**访问 Command Code。条目可以是直连、普通 HTTP 代理，
          或轮换型代理池（<code>pool+http://…</code> 或 <code>http://…#pool</code>：每条新连接换一个出口 IP）。
          上游 Key 与代理的绑定有三种模式：<strong>自动</strong>（静态分配 + 故障转移）、
          <strong>固定</strong>（不自动迁移）、<strong>每次轮换</strong>（每次请求换一条健康代理）。
        </div>
        <div v-if="state.proxyFileError" class="hint text-danger" style="margin-top: 8px">
          <strong>代理文件读取失败</strong>：<code>{{ state.proxyFile }}</code> —— {{ state.proxyFileError }}
          <br />文件里的条目本轮不参与轮询，但 config.json 里的条目照常可用。
        </div>
        <div v-else-if="state.proxyFile" class="hint" style="margin-top: 8px">
          代理文件：<code>{{ state.proxyFile }}</code>（每行一条，<code>#</code> / <code>;</code> / <code>//</code> 起注释）
        </div>
        <div v-if="state.dataFile" class="hint" style="margin-top: 8px">
          后台管理的条目与绑定落在 <code>{{ state.dataFile }}</code>；
          <code>config.json</code> 是部署期输入，后台不会改写它。
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">➕ 添加代理</div>
      <div class="section-body">
        <div class="form-row">
          <div class="field" style="flex: 1 1 420px">
            <label>代理地址</label>
            <input
              v-model="addForm.value"
              type="text"
              class="mono"
              placeholder="http://user:pass@127.0.0.1:7890 或 pool+http://… 或 direct"
              @keyup.enter="add"
            />
          </div>
          <div class="field" style="flex: 0 0 auto">
            <button class="btn btn-primary" type="button" :disabled="busy.add || !addForm.value.trim()" @click="add">
              <span v-if="busy.add" class="loading" style="border-top-color: #04121a"></span>
              {{ busy.add ? '添加中…' : '➕ 添加' }}
            </button>
          </div>
          <div class="field" style="flex: 0 0 auto">
            <button class="btn btn-sm" type="button" @click="bulkOpen = !bulkOpen">
              {{ bulkOpen ? '收起批量' : '📋 批量添加' }}
            </button>
          </div>
        </div>
        <div v-if="bulkOpen" style="margin-top: 10px">
          <textarea
            v-model="bulkText"
            rows="6"
            class="mono"
            style="width: 100%"
            placeholder="每行一条：&#10;http://user:pass@1.2.3.4:8080&#10;pool+http://user:pass@5.6.7.8:8080&#10;# 井号开头是注释"
          ></textarea>
          <div class="flex" style="gap: 8px; margin-top: 8px; align-items: center">
            <button class="btn btn-primary btn-sm" type="button" :disabled="busy.bulk || !bulkText.trim()" @click="addBulk">
              <span v-if="busy.bulk" class="loading" style="border-top-color: #04121a"></span>
              {{ busy.bulk ? '添加中…' : '➕ 批量添加' }}
            </button>
            <span class="hint">重复的会跳过，格式不对的会单独列出，不会因为一行坏掉整批失败。</span>
          </div>
        </div>
        <div class="hint" style="margin-top: 8px">
          <strong>口令只用于连接</strong>：列表一律显示脱敏地址（<code>http://host:port</code>），
          需要完整地址时点行内的 👁（会记一条后台日志）。
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">
        📋 代理列表
        <span v-if="selected.length" class="probe-pill">已选 {{ fmtNum(selected.length) }}</span>
      </div>
      <div v-if="selected.length" class="section-body" style="padding-bottom: 0">
        <div class="flex" style="gap: 8px; align-items: center; flex-wrap: wrap">
          <button class="btn btn-sm btn-primary" type="button" :disabled="busy.batch" @click="testSelected">
            <span v-if="busy.batch" class="loading" style="border-top-color: #04121a"></span>
            {{ busy.batch ? '测试中…' : '🔍 测试所选' }}
          </button>
          <button class="btn btn-sm" type="button" :disabled="busy.rowId === 'bulk'" @click="setEnabledForSelection(true)">✅ 启用所选</button>
          <button class="btn btn-sm" type="button" :disabled="busy.rowId === 'bulk'" @click="setEnabledForSelection(false)">⏸ 停用所选</button>
          <button class="btn btn-sm btn-danger" type="button" :disabled="busy.rowId === 'bulk'" @click="removeMany([...selected])">🗑 删除所选</button>
          <button class="btn btn-sm" type="button" @click="selected = []">取消选择</button>
          <span v-if="batchProgress" class="hint" role="status">{{ batchProgress }}</span>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th style="width: 34px">
                <input
                  type="checkbox"
                  :checked="allSelected"
                  :indeterminate.prop="someSelected"
                  @change="onSelectAllClick"
                />
              </th>
              <th>地址</th>
              <th>来源</th>
              <th>状态</th>
              <th>绑定的 Key</th>
              <th>最近检测</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!state.list.length">
              <td colspan="7" class="empty">{{ state.loading ? '加载中…' : '池子为空' }}</td>
            </tr>
            <tr v-for="t in state.list" :key="t.id" :class="{ 'row-disabled': !t.enabled }">
              <td>
                <input type="checkbox" :checked="selected.includes(t.id)" @change="toggleSelect(t.id, $event.target.checked)" />
              </td>
              <td class="mono">
                <template v-if="editing.id === t.id">
                  <input v-model="editing.value" type="text" class="mono" style="width: 100%" @keyup.enter="saveEdit" />
                </template>
                <template v-else-if="revealed[t.id]">
                  {{ revealed[t.id] }}
                  <button class="btn btn-sm" style="margin-left: 6px" type="button" @click="copy(revealed[t.id], '已复制代理地址')">📋</button>
                </template>
                <template v-else>
                  {{ t.address }}
                  <span v-if="t.pool" class="badge" title="轮换型代理池：每条新连接换一个出口 IP">轮换池</span>
                </template>
              </td>
              <td>
                <span class="badge muted">{{ t.source }}</span>
                <span v-if="!t.managed" class="hint" style="margin-left: 4px" title="来自 config.json / 代理文件 / 内置兜底：只能停用，不能删除">只读</span>
              </td>
              <td>
                <span class="badge" :class="t.enabled ? (t.healthy ? 'ok' : 'danger') : 'muted'">
                  {{ !t.enabled ? '已停用' : (t.healthy ? '健康' : '不健康') }}
                </span>
                <div v-if="t.failures" class="hint">连续失败 {{ fmtNum(t.failures) }} 次</div>
                <div v-if="t.cooldownUntil" class="hint">冷却至 {{ fmtDateTime(t.cooldownUntil) }}</div>
                <div v-if="t.lastError" class="hint text-danger" :title="t.lastError">{{ t.lastError }}</div>
              </td>
              <td>
                <span v-if="t.keys" class="badge ok">{{ fmtNum(t.keys) }} 个</span>
                <span v-else class="hint">—</span>
              </td>
              <td class="hint">
                <template v-if="testResults[t.id]">
                  <span :class="testResults[t.id].ok ? 'text-green' : 'text-danger'">
                    {{ testResults[t.id].ok ? '连通' : '不可达' }}
                    <template v-if="testResults[t.id].latencyMs != null"> · {{ fmtLatency(testResults[t.id].latencyMs) }}</template>
                  </span>
                  <div v-if="testResults[t.id].error" class="text-danger">{{ testResults[t.id].error }}</div>
                </template>
                <template v-else-if="t.lastCheckedAt">
                  {{ fmtDateTime(t.lastCheckedAt) }}
                  <template v-if="t.lastLatencyMs != null"> · {{ fmtLatency(t.lastLatencyMs) }}</template>
                </template>
                <template v-else>未检测</template>
              </td>
              <td>
                <div class="flex" style="gap: 6px; flex-wrap: wrap">
                  <button
                    class="btn btn-sm"
                    type="button"
                    :disabled="busy.testingId === t.id || busy.batch || !t.enabled"
                    :title="!t.enabled ? '已停用的代理不参与路由，无需测试' : ''"
                    @click="test(t)"
                  >
                    <span v-if="busy.testingId === t.id" class="loading"></span>
                    {{ busy.testingId === t.id ? '检测中…' : '🔍 测试' }}
                  </button>
                  <button
                    class="btn btn-sm"
                    type="button"
                    :disabled="busy.rowId === t.id || busy.batch || !t.enabled"
                    @click="toggleEnabled(t, false)"
                  >⏸ 停用</button>
                  <button
                    v-if="!t.enabled"
                    class="btn btn-sm"
                    type="button"
                    :disabled="busy.rowId === t.id"
                    @click="toggleEnabled(t, true)"
                  >✅ 启用</button>
                  <button v-if="t.managed" class="btn btn-sm" type="button" :disabled="busy.rowId === t.id" @click="startEdit(t)">✏️ 编辑</button>
                  <button v-if="t.managed" class="btn btn-sm btn-danger" type="button" :disabled="busy.rowId === t.id" @click="removeMany([t.id])">🗑 删除</button>
                  <button v-if="!revealed[t.id]" class="btn btn-sm" type="button" :disabled="busy.rowId === t.id" @click="reveal(t)">👁</button>
                  <template v-if="editing.id === t.id">
                    <button class="btn btn-sm btn-primary" type="button" :disabled="busy.savingId === t.id" @click="saveEdit">保存</button>
                    <button class="btn btn-sm" type="button" @click="editing.id = ''">取消</button>
                  </template>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="section">
      <div class="section-title">
        🔗 Key ↔ 代理绑定
        <span class="probe-pill">共 {{ fmtNum(state.bindings.length) }} 个上游 Key</span>
      </div>
      <div class="section-body">
        <div class="hint">
          <strong>自动</strong>：按 <code>i % N</code> 静态分配，代理故障时转移到最空闲的健康代理，恢复后自动迁回。<br />
          <strong>固定</strong>：始终走指定的那一条，故障也不迁移（要保证「这个号只从这个 IP 出去」时用它）。<br />
          <strong>每次轮换</strong>：每次尝试都重新挑一条健康代理 —— 要的就是每次换 IP。
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>上游 Key</th>
              <th>绑定模式</th>
              <th>指定代理</th>
              <th>当前出口</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!state.bindings.length">
              <td colspan="5" class="empty">还没有上游 Key。先在「上游 Key」页添加。</td>
            </tr>
            <tr v-for="b in state.bindings" :key="b.fp">
              <td class="mono">
                <template v-if="keyOf(b)">
                  {{ keyOf(b).keyMasked }}
                  <span v-if="keyOf(b).label" class="hint"> · {{ keyOf(b).label }}</span>
                </template>
                <template v-else>{{ b.fp }}</template>
              </td>
              <td>
                <select
                  :value="b.mode"
                  :disabled="!keyIdOf(b) || busy.rowId === keyIdOf(b)"
                  @change="setBinding(keyIdOf(b), $event.target.value, b.proxyId)"
                >
                  <option value="auto">自动（静态分配 + 故障转移）</option>
                  <option value="bind">固定到指定代理</option>
                  <option value="rotate">每次轮换</option>
                </select>
              </td>
              <td>
                <select
                  v-if="b.mode === 'bind'"
                  :value="b.proxyId"
                  :disabled="busy.rowId === keyIdOf(b)"
                  @change="setBinding(keyIdOf(b), 'bind', $event.target.value)"
                >
                  <option v-for="t in state.list.filter((x) => x.enabled)" :key="t.id" :value="t.id">{{ t.address }}</option>
                </select>
                <span v-else class="hint">—</span>
              </td>
              <td class="hint">
                <template v-if="b.proxyAddress">
                  {{ b.proxyAddress }}
                  <span v-if="b.proxyHealthy === false" class="text-danger">（不健康）</span>
                </template>
                <template v-else>每次轮换（不固定）</template>
              </td>
              <td>
                <button
                  v-if="b.mode !== 'auto'"
                  class="btn btn-sm"
                  type="button"
                  :disabled="busy.rowId === keyIdOf(b)"
                  @click="setBinding(keyIdOf(b), 'auto')"
                >↺ 恢复自动</button>
                <span v-else class="hint">默认</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
