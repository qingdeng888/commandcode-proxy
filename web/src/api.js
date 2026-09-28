// 唯一的 API 访问路径：统一前缀 /admin/api、同源 Cookie、JSON 收发、
// 拆解 {success,data,error,message} 信封。
const API_PREFIX = '/admin/api'

export class ApiError extends Error {
  constructor(message, status = 0, payload = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.payload = payload
  }
}

let unauthorizedHandler = null

/** 注册 401 处理（清空登录态 + 跳回登录视图）。 */
export function setUnauthorizedHandler(fn) {
  unauthorizedHandler = fn
}

function extractError(json) {
  if (!json || typeof json !== 'object') return ''
  const e = json.error
  if (typeof e === 'string' && e) return e
  if (e && typeof e === 'object' && typeof e.message === 'string' && e.message) return e.message
  if (typeof json.message === 'string' && json.message) return json.message
  return ''
}

function extractMessage(json) {
  if (!json || typeof json !== 'object') return ''
  return typeof json.message === 'string' ? json.message : ''
}

/**
 * @param {'GET'|'POST'} method
 * @param {string} path  形如 '/keys'（自动加 /admin/api 前缀）
 * @param {object} [body]
 * @param {{skipAuthRedirect?:boolean}} [opts]
 * @returns {Promise<{data:any,message:string,raw:any}>} 已拆信封的结果
 */
export async function api(method, path, body, opts = {}) {
  const init = {
    method,
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  }
  if (body !== undefined && body !== null) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }

  let res
  try {
    res = await fetch(API_PREFIX + path, init)
  } catch (e) {
    throw new ApiError('网络错误：' + (e && e.message ? e.message : '请求失败'), 0)
  }

  const text = await res.text()
  let json = null
  if (text) {
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
  }

  const serverError = extractError(json)

  if (res.status === 401) {
    const message = serverError || '未登录或登录已过期，请先登录'
    // 401 意味着会话失效：清空登录态并跳回登录视图。
    // 例外：修改密码接口用 401 表示「当前密码错误」，由调用方就地展示，不跳转。
    if (!opts.skipAuthRedirect) {
      if (unauthorizedHandler) unauthorizedHandler()
    }
    throw new ApiError(message, 401, json)
  }

  if (!json || json.success !== true) {
    let message = serverError || `请求失败（HTTP ${res.status}）`
    if (json && json.retry_after) message += `（${json.retry_after} 秒后可重试）`
    throw new ApiError(message, res.status, json)
  }

  return {
    data: json.data === undefined ? null : json.data,
    message: extractMessage(json),
    raw: json,
  }
}

export const http = {
  get: (path, opts) => api('GET', path, undefined, opts),
  post: (path, body, opts) => api('POST', path, body === undefined ? {} : body, opts),
}
