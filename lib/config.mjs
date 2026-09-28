// ── 配置：加载 / 热更新 / 原子持久化 ──────────────────────
// 与旧版 proxy.mjs 内联 loadConfig 的行为保持兼容（默认值 → config.json → 环境变量），
// 但做了三件旧版做不到的事：
//   1) CFG 是**同一个对象**，热更新靠 Object.assign 原地改 —— 数据面里几百处
//      `CFG.xxx` 读取无需改动，也不会有「新旧两份配置」并存的窗口；
//   2) 支持把 UI 的修改原子写回 config.json（不丢用户自定义字段）；
//   3) 记录哪些字段被环境变量锁住 —— 否则用户在后台改了却没生效，只会一脸问号。
//
// 优先级：环境变量 > config.json > 内置默认值。
import { resolve } from 'path';
import { readJSON, writeJSONAtomic, fileMtimeMs, ROOT, DATA_DIR } from './store.mjs';

export const CONFIG_PATH = process.env.CC_CONFIG_FILE
  ? resolve(process.env.CC_CONFIG_FILE)
  : resolve(ROOT, 'config.json');

function baseDefaults() {
  return {
    port: 3000,
    host: '0.0.0.0',
    proxyKey: '',   // 数据面本地访问口令：非空时启用严格鉴权
    apiKey: '',     // 上游 CC API Key：单个字符串或字符串数组（历史字段，见 keys.json）
    apiBase: 'https://api.commandcode.ai',
    projectSlug: 'cc-proxy',
    logFile: '',
    logLevel: 'info',
    useProviderModels: true,
    modelRefreshIntervalMs: 5 * 60 * 1000,
    zdr: false,
    cliMode: 'agent',
    cliSessionMode: 'interactive',
    fingerprintSalt: '',
    deviceProjectDir: '',
    emptySystemPlaceholder: true,
    upstreamProxy: '',
    strategy: 'round_robin',   // Key 轮询策略：round_robin | random | fill
    defaultModel: '',          // 模型测试与默认路由使用的模型；空则由目录首项兜底
  };
}

/** config.json 里允许被 UI 改写并回写的字段白名单（其余字段原样保留但不主动写） */
const PERSISTABLE = new Set([
  'port', 'host', 'proxyKey', 'apiKey', 'apiBase', 'projectSlug', 'logFile', 'logLevel',
  'useProviderModels', 'modelRefreshIntervalMs', 'zdr', 'cliMode', 'cliSessionMode',
  'fingerprintSalt', 'deviceProjectDir', 'emptySystemPlaceholder', 'upstreamProxy',
  'strategy', 'defaultModel',
]);

/** 环境变量 → 配置字段。顺序即应用顺序，全部为「环境变量优先」。 */
const ENV_MAP = [
  ['PORT', 'port', v => parseInt(v, 10)],
  ['HOST', 'host', v => v],
  ['PROXY_KEY', 'proxyKey', v => v],
  ['CC_API_KEY', 'apiKey', v => v.split(',')],
  ['CC_API_BASE', 'apiBase', v => v],
  ['PROJECT_SLUG', 'projectSlug', v => v],
  ['LOG_FILE', 'logFile', v => v],
  ['CC_LOG_LEVEL', 'logLevel', v => v],
  ['CC_USE_PROVIDER_MODELS', 'useProviderModels', v => v !== 'false'],
  ['CMD_ZDR', 'zdr', v => v === '1'],
  ['CC_FINGERPRINT_SALT', 'fingerprintSalt', v => v],
  ['CC_DEVICE_PROJECT_DIR', 'deviceProjectDir', v => v],
  ['CC_CLI_MODE', 'cliMode', v => v],
  ['CC_CLI_SESSION_MODE', 'cliSessionMode', v => v],
  ['CC_EMPTY_SYSTEM_PLACEHOLDER', 'emptySystemPlaceholder', v => v !== 'false'],
  ['CC_UPSTREAM_PROXY', 'upstreamProxy', v => v],
];

function applyEnv(cfg) {
  const locked = new Set();
  for (const [env, field, cast] of ENV_MAP) {
    const raw = process.env[env];
    // CMD_ZDR 旧行为：只有显式给了值才覆盖（未设置时保持 config.json 的值）
    if (raw === undefined) continue;
    cfg[field] = cast(raw);
    locked.add(field);
  }
  return locked;
}

/** 归一化 apiKeyList：兼容单个字符串 / 字符串数组，剔除空白项，去重 */
export function normalizeApiKeyList(apiKey) {
  const list = (Array.isArray(apiKey) ? apiKey : [apiKey])
    .filter(k => typeof k === 'string' && k.trim())
    .map(k => k.trim());
  return [...new Set(list)];
}

function derive(cfg) {
  cfg.apiKeyList = normalizeApiKeyList(cfg.apiKey);
  return cfg;
}

/** 从磁盘 + 环境变量算出一份完整配置（不触碰全局 CFG） */
function compute({ onError } = {}) {
  const cfg = baseDefaults();
  const fileCfg = readJSON(CONFIG_PATH, null, (file, err) => {
    if (onError) onError(`[config] 解析 ${file} 失败，已回退内置默认值: ${err.message}`);
  });
  if (fileCfg && typeof fileCfg === 'object' && !Array.isArray(fileCfg)) {
    // 只吸收已知字段，避免把用户的自定义注释字段混进来干扰判断
    for (const k of Object.keys(cfg)) {
      if (k in fileCfg) cfg[k] = fileCfg[k];
    }
  }
  const envLocked = applyEnv(cfg);
  derive(cfg);
  return { cfg, envLocked };
}

const boot = compute({ onError: (m) => console.error(m) });

/** 全局配置对象。热更新原地改它，引用身份不变。 */
export const CFG = boot.cfg;

/** 被环境变量锁定的字段名集合（UI 需据此提示「此字段由环境变量控制」） */
export const ENV_LOCKED = boot.envLocked;

let configMtime = fileMtimeMs(CONFIG_PATH);

/**
 * 重新从磁盘加载（保留环境变量优先级）。
 * 返回是否发生了实际变化 —— 调用方据此决定要不要重建派生状态（如上游代理）。
 */
export function reloadConfig({ onError } = {}) {
  const { cfg, envLocked } = compute({ onError });
  let changed = false;
  for (const k of Object.keys(cfg)) {
    if (CFG[k] !== cfg[k]) changed = true;
    CFG[k] = cfg[k];
  }
  ENV_LOCKED.clear();
  for (const k of envLocked) ENV_LOCKED.add(k);
  configMtime = fileMtimeMs(CONFIG_PATH);
  return { changed, config: CFG };
}

export function hasExternalChange() {
  return fileMtimeMs(CONFIG_PATH) !== configMtime;
}

/** 轮询 config.json 的 mtime：手工编辑配置文件也能热生效（不依赖 fs.watch 的跨平台可靠性） */
export function startConfigWatcher({ intervalMs = 3000, onReload, onError } = {}) {
  const timer = setInterval(() => {
    if (!hasExternalChange()) return;
    try {
      const { changed } = reloadConfig({ onError });
      if (changed && onReload) onReload(CFG);
    } catch (e) {
      if (onError) onError(e);
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

// ── 校验 ────────────────────────────────────────────
export const STRATEGIES = ['round_robin', 'random', 'fill'];
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

function isValidProxyUrl(raw) {
  if (!raw) return true;
  try {
    const u = new URL(raw);
    return u.protocol === 'http:';
  } catch { return false; }
}

/**
 * 校验一个待更新的补丁。返回 { ok:true, patch } 或 { ok:false, error }。
 * 这里只做「不依赖运行时状态」的校验；像 defaultModel 是否存在这种需要模型目录的，
 * 由调用方（admin-api）用 validate 回调补充。
 */
export function validatePatch(patch, extraValidate = null) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, error: 'invalid request' };
  }
  const out = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!PERSISTABLE.has(k)) continue;   // 忽略未知字段而不是报错，兼容前端多传
    out[k] = v;
  }

  if ('strategy' in out && !STRATEGIES.includes(out.strategy)) {
    return { ok: false, error: '策略非法，必须是 round_robin / random / fill' };
  }
  if ('logLevel' in out && !LOG_LEVELS.includes(out.logLevel)) {
    return { ok: false, error: '日志级别非法，必须是 debug / info / warn / error' };
  }
  if ('port' in out) {
    const p = Number(out.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) return { ok: false, error: '端口必须是 1-65535 的整数' };
    out.port = p;
  }
  if ('apiBase' in out) {
    const s = String(out.apiBase || '').trim();
    if (!/^https?:\/\//.test(s)) return { ok: false, error: '上游地址必须以 http:// 或 https:// 开头' };
    out.apiBase = s.replace(/\/+$/, '');
  }
  if ('upstreamProxy' in out) {
    const s = String(out.upstreamProxy || '').trim();
    if (!isValidProxyUrl(s)) return { ok: false, error: '上游代理地址无效（仅支持 http://host:port）' };
    out.upstreamProxy = s;
  }
  if ('modelRefreshIntervalMs' in out) {
    const ms = Number(out.modelRefreshIntervalMs);
    if (!Number.isFinite(ms) || ms < 1000) return { ok: false, error: '模型刷新间隔必须 ≥ 1000 毫秒' };
    out.modelRefreshIntervalMs = ms;
  }
  for (const b of ['zdr', 'useProviderModels', 'emptySystemPlaceholder']) {
    if (b in out) out[b] = !!out[b];
  }
  for (const s of ['host', 'projectSlug', 'logFile', 'proxyKey', 'apiBase', 'deviceProjectDir', 'fingerprintSalt', 'cliMode', 'cliSessionMode', 'defaultModel']) {
    if (s in out && typeof out[s] !== 'string') out[s] = String(out[s] ?? '');
  }
  if ('proxyKey' in out) out.proxyKey = out.proxyKey.trim();

  if (extraValidate) {
    const err = extraValidate(out);
    if (err) return { ok: false, error: err };
  }

  // 环境变量锁定的字段：不报错，但告知调用方「写了也不会生效」
  const ignored = [...ENV_LOCKED].filter(k => k in out);
  return { ok: true, patch: out, ignoredByEnv: ignored };
}

/** 应用补丁到 CFG 并原子写回 config.json（保留文件里未知的自定义字段）。 */
export function applyPatch(patch) {
  Object.assign(CFG, patch);
  derive(CFG);

  const existing = readJSON(CONFIG_PATH, {}, null);
  const out = (existing && typeof existing === 'object' && !Array.isArray(existing)) ? { ...existing } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (PERSISTABLE.has(k)) out[k] = v;
  }
  try {
    writeJSONAtomic(CONFIG_PATH, out, 0o600);
    configMtime = fileMtimeMs(CONFIG_PATH);
  } catch (e) {
    // 写盘失败不应让运行中的配置回滚：内存里已经生效，只是重启后会丢
    return { persisted: false, error: e.message };
  }
  return { persisted: true };
}

/** 供后台展示（不含任何口令明文，只给「是否设置」） */
export function describeConfig() {
  return {
    port: CFG.port, host: CFG.host, apiBase: CFG.apiBase,
    projectSlug: CFG.projectSlug, proxyKeySet: !!CFG.proxyKey,
    zdr: !!CFG.zdr, logLevel: CFG.logLevel, logFile: CFG.logFile || '',
    useProviderModels: !!CFG.useProviderModels,
    modelRefreshIntervalMs: CFG.modelRefreshIntervalMs,
    upstreamProxy: CFG.upstreamProxy || '',
    strategy: CFG.strategy,
    defaultModel: CFG.defaultModel || '',
    cliMode: CFG.cliMode, cliSessionMode: CFG.cliSessionMode,
    emptySystemPlaceholder: !!CFG.emptySystemPlaceholder,
    dataDir: DATA_DIR,
    configPath: CONFIG_PATH,
    envLocked: [...ENV_LOCKED],
  };
}
