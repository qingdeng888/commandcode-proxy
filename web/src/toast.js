import { reactive } from 'vue'

// 右上角 toast：成功绿、失败红、默认 3.5s。单例 reactive store。
export const toastState = reactive({ items: [] })

let seq = 0

export function pushToast(message, type = 'info', duration = 3500) {
  const text = message === null || message === undefined || message === '' ? '操作完成' : String(message)
  const item = { id: ++seq, message: text, type, duration }
  toastState.items.push(item)
  if (toastState.items.length > 5) toastState.items.shift()
  if (duration > 0) {
    setTimeout(() => dismissToast(item.id), duration)
  }
  return item.id
}

export function dismissToast(id) {
  const i = toastState.items.findIndex((t) => t.id === id)
  if (i >= 0) toastState.items.splice(i, 1)
}

export const toast = {
  success: (m, d) => pushToast(m, 'success', d),
  error: (m, d) => pushToast(m, 'error', d ?? 4500),
  info: (m, d) => pushToast(m, 'info', d),
  warning: (m, d) => pushToast(m, 'warning', d),
}
