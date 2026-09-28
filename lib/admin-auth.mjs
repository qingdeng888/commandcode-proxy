// ── 后台鉴权 ──────────────────────────────────────────
// 密码来源优先级：data/.admin-auth.json 的哈希 > ADMIN_PASSWORD 环境变量 > 未配置（后台整体拒绝访问）。
// 后台密码与数据面的 proxyKey 是**两套独立凭证**：
//   proxyKey   给调用 /v1/* 的客户端用
//   ADMIN_PASSWORD 给打开 /admin/ 的人用
// 混用会让「面板登录」与「API 调用」互相牵制，也会让改密码这件事影响线上调用方。
//
// 哈希用 Node 内置 scrypt（N=16384,r=8,p=1,64 字节），比参考项目的 bcrypt 更抗 GPU 且免依赖。
// 校验用异步 scrypt —— 同步版会阻塞事件循环几十毫秒，而这个进程同时在转发流式响应。
//
// 会话在内存（重启即需重新登录，与参考项目一致），默认 24h 且不滑动续期。
// 额外补了参考项目没有的两件事：登录失败限速、可选 Secure Cookie。
import { scrypt as _scrypt, randomBytes, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
import { dataPath, readJSON, writeJSONAtomic, DATA_DIR, ensureDir } from './store.mjs';

const scrypt = promisify(_scrypt);

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;

export const AUTH_PATH = dataPath('.admin-auth.json');
export const COOKIE_NAME = 'admin_session';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

// 登录限速：同一 IP 在窗口内失败达到阈值即锁定。
// 参考项目完全没有这一层，而后台监听 0.0.0.0 时它就是公网上的一个口令框。
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX_FAILURES = 5;
const RATE_BLOCK_MS = 15 * 60 * 1000;

export const MIN_PASSWORD_LEN = 8;

async function hashPassword(password) {
  const salt = randomBytes(SALT_LEN);
  const derived = await scrypt(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

async function verifyHash(password, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, n, r, p, saltB64, hashB64] = parts;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const derived = await scrypt(password, salt, expected.length, {
      N: Number(n), r: Number(r), p: Number(p),
    });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** 明文比对（环境变量来源）：定长比较，避免逐字节泄露时序 */
function verifyPlain(password, plain) {
  const a = Buffer.from(String(password), 'utf8');
  const b = Buffer.from(String(plain), 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ── Cookie ──────────────────────────────────────────
export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function buildCookie(value, { maxAge = null, expires = null } = {}) {
  const parts = [`${COOKIE_NAME}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (process.env.ADMIN_COOKIE_SECURE === '1') parts.push('Secure');
  if (expires) parts.push(`Expires=${expires.toUTCString()}`);
  if (maxAge !== null) parts.push(`Max-Age=${maxAge}`);
  return parts.join('; ');
}

export function createAdminAuth({ log = () => {} } = {}) {
  ensureDir(DATA_DIR);

  let fileHash = null;
  let fileUpdatedAt = null;
  let loaded = false;

  const envPassword = () => (process.env.ADMIN_PASSWORD || '').trim();

  function load() {
    if (loaded) return;
    loaded = true;
    const data = readJSON(AUTH_PATH, null, (file, err) => {
      log('warn', '后台密码文件解析失败，将退回环境变量', { file, error: err.message });
    });
    if (data && typeof data.passwordHash === 'string' && data.passwordHash) {
      fileHash = data.passwordHash;
      fileUpdatedAt = data.updatedAt || null;
    }
  }

  /** 每次判定都重新读一次文件：后台改密后无需重启，也让外部删除文件立即生效 */
  function refresh() {
    loaded = false;
    fileHash = null;
    fileUpdatedAt = null;
    load();
  }

  function source() {
    load();
    if (fileHash) return 'file';
    if (envPassword()) return 'env';
    return 'none';
  }

  function isConfigured() {
    return source() !== 'none';
  }

  async function verify(password) {
    load();
    if (fileHash) return verifyHash(password, fileHash);
    const env = envPassword();
    if (env) return verifyPlain(password, env);
    return false;
  }

  // ── 会话 ────────────────────────────────────────
  const sessions = new Map();   // token → { expiry, createdAt }

  function createSession() {
    const token = randomBytes(32).toString('hex');
    sessions.set(token, { expiry: Date.now() + SESSION_TTL_MS, createdAt: Date.now() });
    return token;
  }

  function destroySession(token) {
    if (token) sessions.delete(token);
  }

  function destroyOtherSessions(keepToken) {
    let n = 0;
    for (const t of [...sessions.keys()]) {
      if (t === keepToken) continue;
      sessions.delete(t);
      n++;
    }
    return n;
  }

  function sessionFrom(req) {
    const token = parseCookies(req.headers?.cookie)[COOKIE_NAME];
    if (!token) return null;
    const s = sessions.get(token);
    if (!s) return null;
    if (Date.now() >= s.expiry) { sessions.delete(token); return null; }
    return { token, ...s };
  }

  // ── 登录限速 ────────────────────────────────────
  const attempts = new Map();   // ip → { failures: [ts], blockedUntil }

  function rateState(ip) {
    const rec = attempts.get(ip);
    if (!rec) return { blocked: false, remaining: RATE_MAX_FAILURES };
    if (rec.blockedUntil && Date.now() < rec.blockedUntil) {
      return { blocked: true, retryAfter: Math.ceil((rec.blockedUntil - Date.now()) / 1000), remaining: 0 };
    }
    const cutoff = Date.now() - RATE_WINDOW_MS;
    rec.failures = rec.failures.filter(t => t > cutoff);
    if (rec.blockedUntil && Date.now() >= rec.blockedUntil) rec.blockedUntil = null;
    return { blocked: false, remaining: Math.max(0, RATE_MAX_FAILURES - rec.failures.length) };
  }

  function noteFailure(ip) {
    const rec = attempts.get(ip) || { failures: [], blockedUntil: null };
    const cutoff = Date.now() - RATE_WINDOW_MS;
    rec.failures = rec.failures.filter(t => t > cutoff);
    rec.failures.push(Date.now());
    if (rec.failures.length >= RATE_MAX_FAILURES) {
      rec.blockedUntil = Date.now() + RATE_BLOCK_MS;
      log('warn', '后台登录失败次数过多，已临时锁定该来源', { ip, blockMin: Math.round(RATE_BLOCK_MS / 60000) });
    }
    attempts.set(ip, rec);
  }

  function noteSuccess(ip) {
    attempts.delete(ip);
  }

  // 清理过期会话/限速记录，避免长时间运行后 Map 无限增长
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [t, s] of sessions) if (now >= s.expiry) sessions.delete(t);
    const cutoff = now - RATE_WINDOW_MS;
    for (const [ip, rec] of attempts) {
      rec.failures = rec.failures.filter(x => x > cutoff);
      if (rec.failures.length === 0 && (!rec.blockedUntil || now >= rec.blockedUntil)) attempts.delete(ip);
    }
  }, 10 * 60 * 1000);
  cleanup.unref?.();

  async function login(password, ip) {
    const rs = rateState(ip);
    if (rs.blocked) {
      return { ok: false, status: 429, error: '尝试过于频繁，请稍后再试', retryAfter: rs.retryAfter };
    }
    if (!isConfigured()) {
      return { ok: false, status: 503, error: '后台未设置管理密码，请设置 ADMIN_PASSWORD 环境变量后重启，或在 data/.admin-auth.json 中配置' };
    }
    const ok = await verify(password);
    if (!ok) {
      noteFailure(ip);
      const after = rateState(ip);
      return { ok: false, status: 401, error: '密码错误', remaining: after.remaining };
    }
    noteSuccess(ip);
    return { ok: true, token: createSession() };
  }

  async function changePassword(current, next, keepToken) {
    // 校验顺序与参考项目一致：先查新密码长度（省一次昂贵的哈希），再验当前密码
    if (typeof next !== 'string' || Buffer.byteLength(next, 'utf8') < MIN_PASSWORD_LEN) {
      return { ok: false, status: 400, error: `新密码至少 ${MIN_PASSWORD_LEN} 位` };
    }
    if (!isConfigured()) {
      return { ok: false, status: 503, error: '后台未设置管理密码，无法修改' };
    }
    if (!(await verify(current))) {
      return { ok: false, status: 401, error: '当前密码错误' };
    }
    const hash = await hashPassword(next);
    const payload = { passwordHash: hash, updatedAt: new Date().toISOString() };
    try {
      writeJSONAtomic(AUTH_PATH, payload, 0o600);
    } catch (e) {
      return { ok: false, status: 500, error: `保存密码失败: ${e.message}` };
    }
    fileHash = hash;
    fileUpdatedAt = payload.updatedAt;
    loaded = true;
    const killed = destroyOtherSessions(keepToken);
    log('info', '后台密码已更新', { path: AUTH_PATH, otherSessionsInvalidated: killed });
    return { ok: true, invalidatedOthers: killed };
  }

  return {
    source, isConfigured, verify, login, changePassword,
    setSessionCookie: (res, token) => {
      res.setHeader('Set-Cookie', buildCookie(token, { expires: new Date(Date.now() + SESSION_TTL_MS) }));
    },
    clearSessionCookie: (res) => {
      res.setHeader('Set-Cookie', buildCookie('', { maxAge: 0 }));
    },
    createSession, destroySession, sessionFrom, refresh,
    get sessionCount() { return sessions.size; },
    get path() { return AUTH_PATH; },
    get updatedAt() { return fileUpdatedAt; },
  };
}
