// ── 后台 REST API ─────────────────────────────────────
// 契约见 docs/admin-api.md —— 前后端唯一接口，改字段必须同步那边。
//
// 依赖全部通过构造参数注入（auth / pool / catalog / runner / probe），
// 模块之间没有循环 import：proxy.mjs 在最上层负责把实现接进来。
import { CFG, describeConfig, validatePatch, applyPatch, LOG_LEVELS } from './config.mjs';
import { CATEGORY_LABELS } from './models.mjs';
import { serveAdminAsset } from './admin-ui.mjs';

const API_PREFIX = '/admin/api';
const MAX_ADMIN_BODY = 1024 * 1024;   // 后台请求体上限 1MB，防误传大文件

const VERSION = '1.1.0';

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function ok(res, data, message) {
  const payload = { success: true };
  if (data !== undefined) payload.data = data;
  if (message !== undefined) payload.message = message;
  sendJSON(res, 200, payload);
}

function fail(res, status, error, extra = null) {
  sendJSON(res, status, { success: false, error, ...(extra || {}) });
}

function unauthorized(res) {
  sendJSON(res, 401, { error: { message: '未登录或登录已过期，请先登录', type: 'auth_error' } });
}

/** 后台请求体：小上限 + 容错解析。返回 { ok, body } 或 { ok:false }。 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c) => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_ADMIN_BODY) {
        aborted = true;
        resolve({ ok: false, error: '请求体过大' });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks).toString('utf-8').trim();
      if (!raw) return resolve({ ok: true, body: {} });
      try {
        const body = JSON.parse(raw);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return resolve({ ok: false, error: 'invalid request' });
        }
        resolve({ ok: true, body });
      } catch {
        resolve({ ok: false, error: 'invalid request' });
      }
    });
    req.on('error', () => { if (!aborted) { aborted = true; resolve({ ok: false, error: '读取请求体失败' }); } });
  });
}

function clientIp(req) {
  // 信任反代传来的 X-Forwarded-For 首段；没有则退回 socket 地址。
  // 注意：XFF 可伪造，因此限速只是「抬高暴力破解成本」，不是访问控制。
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function normalizeSupported(ep) {
  return Array.isArray(ep) && ep.length ? ep : ['/chat/completions'];
}

export function createAdminApi(deps) {
  const {
    auth, pool, catalog, runner, logBus, log,
    probe,                     // ({model,key}) => 探测结果
    startedAt = Date.now(),
    reloadUpstreamProxy = null,
  } = deps;

  // ── 路由表 ────────────────────────────────────────
  // public: 不需要登录。session 也放在这里 —— 前端启动时必须先问出
  // 「有没有登录 / 有没有配置密码」，否则连登录页该显示什么都决定不了。
  const routes = {
    'POST /login': { public: true, handler: loginHandler },
    'POST /logout': { public: true, handler: logoutHandler },
    'GET /session': { public: true, handler: sessionHandler },
    'POST /password': { handler: passwordHandler },

    'GET /stats': { handler: statsHandler },

    'GET /keys': { handler: keysListHandler },
    'POST /keys': { handler: keysAddHandler },
    'POST /keys/update': { handler: keysUpdateHandler },
    'POST /keys/delete': { handler: keysDeleteHandler },
    'POST /keys/reveal': { handler: keysRevealHandler },
    'POST /keys/test': { handler: keysTestHandler },
    'POST /keys/import': { handler: keysImportHandler },

    'GET /models': { handler: modelsListHandler },
    'POST /models/refresh': { handler: modelsRefreshHandler },
    'POST /models/test': { handler: modelTestHandler },
    'POST /models/test-batch': { handler: modelBatchHandler },
    'GET /models/test-status': { handler: modelTestStatusHandler },
    'POST /models/test-cancel': { handler: modelTestCancelHandler },

    'GET /usage': { handler: usageHandler },
    'POST /usage/reset': { handler: usageResetHandler },

    'GET /config': { handler: configGetHandler },
    'POST /config/update': { handler: configUpdateHandler },

    'GET /logs': { handler: logsHandler },
    'GET /logs/stream': { handler: logsStreamHandler },
  };

  // ── 各处理器 ──────────────────────────────────────

  /**
   * 新 Key 到位后立刻预热模型目录。
   * 启动时若没有 Key，目录会先落到静态回退列表上；用户加完 Key 不该再看到那份列表，
   * 所以这里主动补一次同步（失败也无所谓，models 接口还会再试）。
   */
  function warmCatalog(key) {
    if (!key || catalog.fromUpstream) return;
    catalog.sync({ apiKey: key }).catch(() => {});
  }

  async function loginHandler(req, res, body) {
    const password = typeof body.password === 'string' ? body.password : '';
    const result = await auth.login(password, clientIp(req));
    if (!result.ok) {
      return fail(res, result.status, result.error,
        result.retryAfter ? { retry_after: result.retryAfter } : null);
    }
    auth.setSessionCookie(res, result.token);
    return ok(res);
  }

  async function logoutHandler(req, res) {
    const s = auth.sessionFrom(req);
    auth.destroySession(s?.token);
    auth.clearSessionCookie(res);
    return ok(res);
  }

  async function sessionHandler(req, res) {
    const s = auth.sessionFrom(req);
    return ok(res, {
      authenticated: !!s,
      passwordConfigured: auth.isConfigured(),
      passwordSource: auth.source(),
    });
  }

  async function passwordHandler(req, res, body, ctx) {
    const result = await auth.changePassword(
      typeof body.current === 'string' ? body.current : '',
      typeof body.new === 'string' ? body.new : '',
      ctx.session?.token,
    );
    if (!result.ok) return fail(res, result.status, result.error);
    return ok(res, undefined, '密码已更新');
  }

  async function statsHandler(req, res) {
    const usage = pool.usageReport();
    const cat = catalog.describe();
    return ok(res, {
      version: VERSION,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      strategy: CFG.strategy,
      keys: pool.countByState(),
      models: {
        total: cat.models.length,
        lastSyncAt: cat.lastSyncAt,
        syncing: cat.syncing,
        lastError: cat.lastError,
      },
      requests: {
        today: usage.summary.requestsToday,
        total: usage.summary.requestsTotal,
        failedToday: usage.summary.failedToday,
        inflight: deps.getInflight ? deps.getInflight() : 0,
      },
      tokens: {
        inToday: usage.summary.inToday, inTotal: usage.summary.inTotal,
        outToday: usage.summary.outToday, outTotal: usage.summary.outTotal,
      },
      admin: { address: deps.address || '', dataDir: describeConfig().dataDir },
    });
  }

  // ── Key ──────────────────────────────────────────
  async function keysListHandler(req, res) {
    return ok(res, { strategy: CFG.strategy, keys: pool.list() });
  }

  async function keysAddHandler(req, res, body) {
    const result = pool.add({ key: body.key, label: body.label });
    if (!result.ok) return fail(res, 400, result.error);
    const item = pool.list().find(k => k.id === result.entry.id);
    warmCatalog(result.entry.key);
    return ok(res, { key: item }, 'Key 已添加');
  }

  async function keysUpdateHandler(req, res, body) {
    if (typeof body.id !== 'string' || !body.id) return fail(res, 400, 'id 不能为空');
    const result = pool.update({ id: body.id, label: body.label, enabled: body.enabled });
    if (!result.ok) return fail(res, 400, result.error);
    const item = pool.list().find(k => k.id === body.id);
    return ok(res, { key: item }, '已保存');
  }

  async function keysDeleteHandler(req, res, body) {
    if (typeof body.id !== 'string' || !body.id) return fail(res, 400, 'id 不能为空');
    const result = pool.remove(body.id);
    if (!result.ok) return fail(res, 400, result.error);
    return ok(res, undefined, 'Key 已删除');
  }

  async function keysRevealHandler(req, res, body) {
    if (typeof body.id !== 'string' || !body.id) return fail(res, 400, 'id 不能为空');
    const result = pool.reveal(body.id);
    if (!result.ok) return fail(res, 404, result.error);
    log('warn', '后台查看了 Key 明文', { id: body.id, ip: clientIp(req) });
    return ok(res, { key: result.key });
  }

  async function keysTestHandler(req, res, body) {
    // 支持 { id } 测已有 Key，或 { key } 测尚未保存的 Key（新增前试一下）
    let key = null;
    let keyId = null;
    if (typeof body.id === 'string' && body.id) {
      const entry = pool.findById(body.id);
      if (!entry) return fail(res, 404, 'Key 不存在');
      key = entry.key; keyId = entry.id;
    } else if (typeof body.key === 'string' && body.key.trim()) {
      key = body.key.trim();
      keyId = null;
    } else {
      return fail(res, 400, '需要提供 id 或 key');
    }

    const model = typeof body.model === 'string' && body.model ? body.model : catalog.defaultModel();
    if (!model) return fail(res, 503, '模型目录为空，无法测试（请先刷新模型列表）');

    const result = await probe({ key, model });
    pool.setHealth(key, {
      category: result.category,
      latencyMs: result.latencyMs,
      message: result.message,
    });
    if (result.category === 'ok') pool.clearCooldown(key);

    return ok(res, {
      ok: result.category === 'ok',
      category: result.category,
      categoryLabel: CATEGORY_LABELS[result.category] || result.category,
      latencyMs: result.latencyMs,
      message: result.message,
      model: result.model || model,
      httpStatus: result.httpStatus ?? null,
      keyId,
      checkedAt: new Date().toISOString(),
    });
  }

  async function keysImportHandler(req, res, body) {
    // 支持两种语义：不传 body 导入全部只读 Key；传 { id } 只导入指定的那一个
    // （前端是按行点「导入」，只导一个更符合直觉）。
    if (typeof body.id === 'string' && body.id) {
      const ext = pool.all().find(e => e.id === body.id);
      if (!ext) return fail(res, 404, 'Key 不存在');
      if (!ext.readOnly) return fail(res, 400, '该 Key 已经是可管理状态，无需导入');
      const result = pool.add({ key: ext.key, label: ext.label });
      if (!result.ok) return fail(res, 400, result.error);
      const item = pool.list().find(k => k.id === result.entry.id);
      return ok(res, { imported: 1, key: item }, '已导入');
    }

    const result = pool.importExternal();
    if (!result.ok) return fail(res, 400, result.error || '导入失败');
    return ok(res, { imported: result.imported },
      result.imported > 0 ? `已导入 ${result.imported} 个 Key` : '没有可导入的 Key');
  }

  // ── 模型 ─────────────────────────────────────────
  async function modelsListHandler(req, res) {
    // 首次读取时缓存是空的（没人触发过同步）—— 此时必须同步拉一次，
    // 否则后台「模型」页首次打开会是一片空白，用户只能以为功能坏了。
    // 缓存不是「成功同步过且在有效期内」时也要拉：静态回退列表不算成功同步，
    // 否则用户在后台补上 Key 之后，页面还会继续显示那份回退列表。
    // 没有可用 Key 时同样会走一次（内部有 30s 失败退避，不会打爆上游）。
    const key = pool.pick()?.key || null;
    if (!catalog.isFresh()) await catalog.sync({ apiKey: key });
    else if (key) catalog.ensureFresh(key);
    const cat = catalog.describe();
    return ok(res, {
      models: cat.models.map(m => ({
        id: m.id, name: m.name,
        contextLength: m.contextLength,
        supportedEndpoints: normalizeSupported(m.supportedEndpoints),
        source: m.source,
      })),
      lastSyncAt: cat.lastSyncAt,
      nextSyncInSec: cat.nextSyncInSec,
      syncing: cat.syncing,
      lastError: cat.lastError,
      fromUpstream: cat.fromUpstream,
      defaultModel: catalog.defaultModel(),
    });
  }

  async function modelsRefreshHandler(req, res) {
    const key = pool.pick()?.key || CFG.apiKeyList[0] || null;
    if (!key) return fail(res, 503, '没有可用的 Key，无法拉取模型目录');
    const models = await catalog.sync({ apiKey: key, force: true });
    return ok(res, { count: models.length }, `已刷新，共 ${models.length} 个模型`);
  }

  async function modelTestHandler(req, res, body) {
    const model = typeof body.model === 'string' ? body.model.trim() : '';
    if (!model) return fail(res, 400, 'model 不能为空');
    if (!catalog.get(model)) return fail(res, 400, `未知模型: ${model}`);

    let key = null; let keyId = null;
    if (typeof body.keyId === 'string' && body.keyId) {
      const entry = pool.findById(body.keyId);
      if (!entry) return fail(res, 404, 'Key 不存在');
      key = entry.key; keyId = entry.id;
    } else {
      const picked = pool.pick();
      if (!picked) return fail(res, 503, '没有可用的 Key');
      key = picked.key; keyId = picked.id;
    }

    const result = await probe({ key, model });
    if (keyId) {
      pool.setHealth(key, { category: result.category, latencyMs: result.latencyMs, message: result.message });
      if (result.category === 'ok') pool.clearCooldown(key);
    }
    return ok(res, {
      model: result.model || model,
      ok: result.category === 'ok',
      category: result.category,
      categoryLabel: CATEGORY_LABELS[result.category] || result.category,
      latencyMs: result.latencyMs,
      httpStatus: result.httpStatus ?? null,
      message: result.message,
      keyId,
      checkedAt: new Date().toISOString(),
      outputPreview: result.outputPreview || '',
    });
  }

  async function modelBatchHandler(req, res, body) {
    if (runner.busy) return fail(res, 409, '已有批量测试在运行中');

    let models = Array.isArray(body.models) && body.models.length
      ? body.models.filter(m => typeof m === 'string' && catalog.get(m))
      : catalog.list().map(m => m.id);
    if (models.length === 0) return fail(res, 400, '没有可测试的模型');

    const keyId = typeof body.keyId === 'string' && body.keyId ? body.keyId : null;
    if (keyId && !pool.findById(keyId)) return fail(res, 404, 'Key 不存在');

    const limit = Number.isFinite(Number(body.concurrency)) ? Number(body.concurrency) : 3;

    // 后台跑，立刻返回 jobId；前端轮询 test-status
    runner.run({ models, keyId, limit }).catch(e => {
      log('error', '批量模型测试异常终止', { error: e.message });
    });

    return ok(res, { jobId: runner.status().jobId, total: models.length },
      `已开始测试 ${models.length} 个模型`);
  }

  async function modelTestStatusHandler(req, res) {
    const st = runner.status();
    return ok(res, {
      running: st.running,
      jobId: st.jobId,
      startedAt: st.startedAt,
      finishedAt: st.finishedAt,
      total: st.total,
      done: st.done,
      results: st.results,
      summary: st.summary,
    });
  }

  async function modelTestCancelHandler(req, res) {
    const r = runner.cancel();
    if (!r.ok) return fail(res, 400, r.error);
    return ok(res, undefined, '已请求取消');
  }

  // ── 用量 ─────────────────────────────────────────
  async function usageHandler(req, res) {
    const report = pool.usageReport();
    return ok(res, {
      items: report.items.map(i => ({ ...i, lastUsedAt: i.lastUsedAt })),
      summary: report.summary,
    });
  }

  async function usageResetHandler(req, res, body) {
    const keyId = typeof body.keyId === 'string' ? body.keyId : '';
    const scope = body.scope === 'all' ? 'all' : 'today';
    if (!keyId) return fail(res, 400, 'keyId 不能为空');
    if (!pool.findById(keyId)) return fail(res, 404, 'Key 不存在');
    pool.resetUsage(keyId, scope);
    return ok(res, undefined, scope === 'all' ? '全部用量已重置' : '今日用量已重置');
  }

  // ── 设置 ─────────────────────────────────────────
  async function configGetHandler(req, res) {
    return ok(res, { ...describeConfig(), version: VERSION });
  }

  async function configUpdateHandler(req, res, body) {
    const needRestart = ['port', 'host'].filter(k => k in body);

    const check = validatePatch(body, (patch) => {
      if ('defaultModel' in patch && patch.defaultModel) {
        if (!catalog.get(patch.defaultModel)) return `未知模型: ${patch.defaultModel}`;
      }
      return null;
    });
    if (!check.ok) return fail(res, 400, check.error);

    const applied = applyPatch(check.patch);

    // 上游代理是少数需要重建派生状态（连接隧道）的字段
    if ('upstreamProxy' in check.patch && reloadUpstreamProxy) {
      try { reloadUpstreamProxy(); } catch (e) {
        log('error', '重建上游代理失败', { error: e.message });
      }
    }
    if ('useProviderModels' in check.patch && check.patch.useProviderModels) {
      const key = pool.pick()?.key || CFG.apiKeyList[0] || null;
      if (key) catalog.sync({ apiKey: key, force: true }).catch(() => {});
    }

    const messages = [];
    if (!applied.persisted) {
      messages.push(`配置已生效但写盘失败：${applied.error}`);
    } else if (!applied.nothingToPersist) {
      messages.push('已保存到 data/settings.json');
    }
    if (applied.shadowed?.length) {
      messages.push(`以下字段在 config.json 中也有配置，后台设置（data/settings.json）优先：${applied.shadowed.join(', ')}`);
    }
    if (applied.ignoredByEnv?.length) {
      messages.push(`以下字段由环境变量锁定，后台修改不会生效：${applied.ignoredByEnv.join(', ')}`);
    }
    if (needRestart.length) messages.push('端口/监听地址改动需重启进程后生效');

    return ok(res, { ...describeConfig(), version: VERSION }, messages.join('；') || '没有需要保存的改动');
  }

  // ── 日志 ─────────────────────────────────────────
  async function logsHandler(req, res, _body, ctx) {
    const limit = Math.min(500, Math.max(1, Number.parseInt(ctx.url.searchParams.get('limit') || '200', 10) || 200));
    const level = ctx.url.searchParams.get('level') || null;
    return ok(res, { logs: logBus.recent(limit, level && LOG_LEVELS.includes(level) ? level : null) });
  }

  function logsStreamHandler(req, res, _body, ctx) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',   // nginx 下必须，否则 SSE 会被缓冲住
    });
    res.write(': connected\n\n');

    const level = ctx?.url?.searchParams?.get('level') || null;
    const minLevel = level && LOG_LEVELS.includes(level) ? level : null;
    const LEVEL_ORDER = { debug: 10, info: 20, warn: 30, error: 40 };
    const pass = (entry) => !minLevel || (LEVEL_ORDER[entry.level] ?? 0) >= (LEVEL_ORDER[minLevel] ?? 0);

    const send = (entry) => {
      if (!pass(entry)) return;   // 支持 ?level=，避免把不需要的级别推给前端
      try { res.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`); } catch {}
    };
    // 先补发最近 50 条，避免前端刚打开时一片空白
    for (const e of logBus.recent(50).reverse()) send(e);

    const unsubscribe = logBus.subscribe(send);
    // 心跳：中间层（nginx/cloudflare）会掐断长时间无数据的连接
    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch {}
    }, 20000);

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    res.on('close', cleanup);
    res.on('error', cleanup);
    return true;
  }

  // ── 分发 ─────────────────────────────────────────
  /**
   * 处理 /admin/api/*。返回 true 表示已处理（调用方无需再管）。
   */
  async function handle(req, res, url) {
    // 后台接口不对外开放 CORS：跨站页面拿不到响应，降低被恶意页面驱动操作的面。
    res.removeHeader('Access-Control-Allow-Origin');
    res.removeHeader('Access-Control-Allow-Methods');
    res.removeHeader('Access-Control-Allow-Headers');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return true;
    }

    const path = url.pathname.slice(API_PREFIX.length) || '/';
    const route = routes[`${req.method} ${path}`];

    if (!route) {
      const known = Object.keys(routes).some(k => k.endsWith(' ' + path));
      if (known) {
        fail(res, 405, `方法不允许：${req.method} ${path}`);
      } else {
        fail(res, 404, `接口不存在：${path}`);
      }
      return true;
    }

    const session = auth.sessionFrom(req);
    if (!route.public && !session) {
      unauthorized(res);
      return true;
    }

    // GET/DELETE 无请求体；其余解析 JSON
    let body = {};
    if (req.method === 'POST') {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) {
        fail(res, parsed.error === '请求体过大' ? 413 : 400, parsed.error);
        return true;
      }
      body = parsed.body;
    }

    try {
      const handled = await route.handler(req, res, body, { url, session });
      if (handled === undefined) return true;   // 处理器已响应
      return true;
    } catch (e) {
      log('error', '后台接口异常', { path, error: e.message, stack: e.stack?.split('\n')[1]?.trim() });
      if (!res.headersSent) fail(res, 500, `服务端异常: ${e.message}`);
      return true;
    }
  }

  return {
    handle,
    prefix: API_PREFIX,
    isAdminPath: (pathname) => pathname === '/admin' || pathname.startsWith('/admin/'),
    isApiPath: (pathname) => pathname === API_PREFIX || pathname.startsWith(API_PREFIX + '/'),
    serveAsset: serveAdminAsset,
    VERSION,
  };
}
