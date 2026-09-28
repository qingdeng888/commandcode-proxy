// 展示层格式化与枚举映射（全部中文）。

export const STRATEGY_OPTIONS = [
  { value: 'round_robin', label: '轮询 (round_robin)' },
  { value: 'random', label: '随机 (random)' },
  { value: 'fill', label: '填满 (fill)' },
]

export const STRATEGY_LABELS = {
  round_robin: '轮询',
  random: '随机',
  fill: '填满',
}

export const LEVEL_OPTIONS = [
  { value: 'debug', label: 'debug' },
  { value: 'info', label: 'info' },
  { value: 'warn', label: 'warn' },
  { value: 'error', label: 'error' },
]

export const SOURCE_LABELS = {
  ui: '后台添加',
  config: '配置文件',
  env: '环境变量',
}

// category 枚举同时用于 health.status 与测试结果
export const CATEGORY_LABELS = {
  ok: '正常',
  unauthorized: 'Key 无效',
  quota: '额度用尽',
  not_in_plan: '不在套餐内',
  network: '网络异常',
  error: '上游错误',
  unknown: '未检测',
}

export const CATEGORY_TONES = {
  ok: 'ok',
  unauthorized: 'danger',
  quota: 'warn',
  not_in_plan: 'warn',
  network: 'danger',
  error: 'danger',
  unknown: 'muted',
}

export const CATEGORY_ORDER = ['ok', 'unauthorized', 'quota', 'not_in_plan', 'network', 'error']

export function categoryLabel(category) {
  if (!category) return CATEGORY_LABELS.unknown
  return CATEGORY_LABELS[category] || String(category)
}

export function categoryTone(category) {
  if (!category) return 'muted'
  return CATEGORY_TONES[category] || 'muted'
}

/** not_in_plan 是模型维度的结论，不代表 Key 失效。 */
export function categoryDetail(category, fallback) {
  if (category === 'not_in_plan') return 'Key 有效，但该模型不在套餐内'
  return fallback || categoryLabel(category)
}

const MISSING = '-'

function isMissing(v) {
  return v === null || v === undefined || v === '' || (typeof v === 'number' && Number.isNaN(v))
}

export function fmtNum(n) {
  if (isMissing(n)) return MISSING
  const num = Number(n)
  if (!Number.isFinite(num)) return MISSING
  return num.toLocaleString('zh-CN')
}

/** 大数字缩写：1000000 → 1M，200000 → 200K。 */
export function fmtTokens(n) {
  if (isMissing(n)) return MISSING
  const num = Number(n)
  if (!Number.isFinite(num)) return MISSING
  if (Math.abs(num) >= 1000000) return trimZero((num / 1000000).toFixed(2)) + 'M'
  if (Math.abs(num) >= 1000) return trimZero((num / 1000).toFixed(1)) + 'K'
  return String(num)
}

function trimZero(s) {
  return s.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')
}

/** 模型上下文长度：1000000 → 1M，200000 → 200K。 */
export function fmtContext(n) {
  if (isMissing(n)) return MISSING
  const num = Number(n)
  if (!Number.isFinite(num) || num <= 0) return MISSING
  return fmtTokens(num)
}

export function fmtDateTime(v) {
  if (isMissing(v)) return MISSING
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return String(v)
  return d.toLocaleString('zh-CN', { hour12: false })
}

export function fmtTime(v) {
  if (isMissing(v)) return MISSING
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return String(v)
  return d.toLocaleTimeString('zh-CN', { hour12: false })
}

export function fmtLatency(ms) {
  if (isMissing(ms)) return MISSING
  const num = Number(ms)
  if (!Number.isFinite(num)) return MISSING
  return num >= 1000 ? `${(num / 1000).toFixed(2)} s` : `${num} ms`
}

/** 运行时长：1234 → 20分 34秒。 */
export function fmtUptime(sec) {
  if (isMissing(sec)) return MISSING
  let s = Math.max(0, Math.floor(Number(sec) || 0))
  const d = Math.floor(s / 86400)
  s -= d * 86400
  const h = Math.floor(s / 3600)
  s -= h * 3600
  const m = Math.floor(s / 60)
  s -= m * 60
  const parts = []
  if (d) parts.push(`${d}天`)
  if (h) parts.push(`${h}小时`)
  if (m) parts.push(`${m}分`)
  if (!d) parts.push(`${s}秒`)
  return parts.join(' ')
}

/** 冷却剩余秒数；无常驻冷却返回 0。 */
export function remainingSeconds(cooldownUntil, nowMs) {
  if (isMissing(cooldownUntil)) return 0
  const until = new Date(cooldownUntil).getTime()
  if (Number.isNaN(until)) return 0
  const left = Math.ceil((until - nowMs) / 1000)
  return left > 0 ? left : 0
}

export function fmtRemaining(left) {
  const s = Math.max(0, Math.floor(left))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}

export function fmtDurationMs(ms) {
  if (isMissing(ms)) return MISSING
  const num = Number(ms)
  if (!Number.isFinite(num)) return MISSING
  if (num >= 1000) return `${(num / 1000).toFixed(2)}s`
  return `${num}ms`
}

export function fmtBytes(n) {
  if (isMissing(n)) return MISSING
  const num = Number(n)
  if (!Number.isFinite(num)) return MISSING
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = num
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`
}

/** 日志 data 字段格式化：对象 → 缩进 JSON。 */
export function fmtPayload(data) {
  if (data === null || data === undefined || data === '') return ''
  if (typeof data === 'string') return data
  try {
    return JSON.stringify(data, null, 2)
  } catch {
    return String(data)
  }
}

export function truncate(s, max = 40) {
  if (isMissing(s)) return MISSING
  const str = String(s)
  return str.length > max ? str.slice(0, max - 1) + '…' : str
}

export function sumBy(items, pick) {
  return (items || []).reduce((acc, it) => acc + (Number(pick(it)) || 0), 0)
}
