// 管理后台：鉴权 / Key 管理 / 热加载 / 模型测试 / 用量
//
// 这些用例覆盖的是「后台能改运行时状态」这条链路 —— 它没有编译期检查兜底，
// 只能靠真实起进程 + 真实 HTTP 调用来验证。全部走 mock 上游，不需要真 Key。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, startProxy, allocPort, closeServer } from './helpers.mjs';
import http from 'node:http';

const PASSWORD = 'test-password-123';
const BASE_ENV = { ADMIN_PASSWORD: PASSWORD, CC_API_KEY: '' };
// 模型目录需要一个上游 Key 才能从（mock）上游拉取
const CATALOG_KEY = 'user_catalogkey0000000000000000';

/** 从响应里取 admin_session 的 Cookie 对（只取 name=value，丢弃属性） */
function sessionCookie(res) {
  const raw = res.headers.getSetCookie?.()[0] || res.headers.get('set-cookie') || '';
  if (!raw) return null;
  return raw.split(';')[0];
}

async function login(proxy, password, headers = {}) {
  const r = await proxy.post('/admin/api/login', { password }, headers);
  const json = await r.json();
  return { status: r.status, json, cookie: sessionCookie(r), setCookieRaw: r.headers.get('set-cookie') };
}

/** 已登录的后台客户端。注意 get 的第二个参数是 fetch 的 init，Cookie 必须放进 headers。 */
async function authed(proxy, headers = {}) {
  const { cookie } = await login(proxy, PASSWORD, headers);
  assert.ok(cookie, '登录应返回 admin_session Cookie');
  const h = { Cookie: cookie, ...headers };
  return {
    get: (path) => proxy.get(`/admin/api${path}`, { headers: h }),
    post: (path, body) => proxy.post(`/admin/api${path}`, body, h),
  };
}

// ── ① 未配置密码：后台整体拒绝 ────────────────────────

test('后台未配置密码时拒绝登录，且受保护接口一律 401', async () => {
  const s = await setup({ env: { CC_API_KEY: '', ADMIN_PASSWORD: '' } });
  try {
    const r = await s.proxy.post('/admin/api/login', { password: 'whatever' });
    assert.equal(r.status, 503, '未配置密码必须拒绝，而不是放行');
    assert.match((await r.json()).error, /未设置管理密码/);

    const keys = await s.proxy.get('/admin/api/keys');
    assert.equal(keys.status, 401);

    // session 接口是公开的：前端必须能先问出「有没有登录 / 有没有配密码」
    const sess = await s.proxy.get('/admin/api/session');
    assert.equal(sess.status, 200);
    const body = await sess.json();
    assert.equal(body.data.authenticated, false);
    assert.equal(body.data.passwordConfigured, false);
    assert.equal(body.data.passwordSource, 'none');
  } finally { await s.close(); }
});

// ── ② 登录 / 会话 / 登出 ─────────────────────────────

test('登录成功下发 HttpOnly + SameSite=Lax 会话 Cookie，未登录访问受保护接口 401', async () => {
  const s = await setup({ env: BASE_ENV });
  try {
    const anon = await s.proxy.get('/admin/api/keys');
    assert.equal(anon.status, 401);
    const errBody = await anon.json();
    assert.equal(errBody.error.type, 'auth_error', '未登录必须是 auth_error 形状');

    const bad = await login(s.proxy, 'wrong-password');
    assert.equal(bad.status, 401);
    assert.equal(bad.json.error, '密码错误');

    const good = await login(s.proxy, PASSWORD);
    assert.equal(good.status, 200);
    assert.equal(good.json.success, true);
    assert.match(good.setCookieRaw, /admin_session=/);
    assert.match(good.setCookieRaw, /HttpOnly/);
    assert.match(good.setCookieRaw, /SameSite=Lax/);
    assert.match(good.setCookieRaw, /Path=\//);

    const list = await s.proxy.get('/admin/api/keys', { headers: { Cookie: good.cookie } });
    assert.equal(list.status, 200);
    assert.equal((await list.json()).success, true);
  } finally { await s.close(); }
});

test('登出后会话失效，且重复登出是幂等的', async () => {
  const s = await setup({ env: BASE_ENV });
  try {
    const { cookie } = await login(s.proxy, PASSWORD);
    assert.equal((await s.proxy.post('/admin/api/logout', {}, { Cookie: cookie })).status, 200);
    assert.equal((await s.proxy.get('/admin/api/keys', { headers: { Cookie: cookie } })).status, 401);
    assert.equal((await s.proxy.post('/admin/api/logout', {}, { Cookie: cookie })).status, 200);
  } finally { await s.close(); }
});

// ── ③ 登录限速 ───────────────────────────────────────

test('同一来源连续失败 5 次后锁定，返回 429 与 retry_after', async () => {
  const s = await setup({ env: BASE_ENV });
  try {
    const ip = { 'X-Forwarded-For': '203.0.113.9' };
    for (let i = 0; i < 5; i++) {
      const r = await login(s.proxy, 'nope', ip);
      assert.equal(r.status, 401, `第 ${i + 1} 次失败应是 401`);
    }
    const locked = await login(s.proxy, 'nope', ip);
    assert.equal(locked.status, 429, '第 6 次必须被限速');
    assert.ok(locked.json.retry_after > 0, '限速响应要给出 retry_after');

    // 即使密码正确也被锁（否则限速形同虚设）
    const evenCorrect = await login(s.proxy, PASSWORD, ip);
    assert.equal(evenCorrect.status, 429);

    // 换一个来源不受影响：限速是按来源隔离的
    const other = await login(s.proxy, PASSWORD, { 'X-Forwarded-For': '203.0.113.10' });
    assert.equal(other.status, 200);
  } finally { await s.close(); }
});

// ── ④ 修改后台密码 ───────────────────────────────────

test('修改密码：长度校验 → 当前密码校验 → 成功且其它会话失效', async () => {
  const s = await setup({ env: BASE_ENV });
  try {
    // 会话 A（用来改密码），会话 B（应被踢掉）
    const a = (await login(s.proxy, PASSWORD)).cookie;
    const b = (await login(s.proxy, PASSWORD)).cookie;

    const tooShort = await s.proxy.post('/admin/api/password',
      { current: PASSWORD, new: 'short' }, { Cookie: a });
    assert.equal(tooShort.status, 400);
    assert.match((await tooShort.json()).error, /至少 8 位/);

    const wrongCurrent = await s.proxy.post('/admin/api/password',
      { current: 'not-the-password', new: 'a-good-new-password' }, { Cookie: a });
    assert.equal(wrongCurrent.status, 401);
    assert.equal((await wrongCurrent.json()).error, '当前密码错误');

    const ok = await s.proxy.post('/admin/api/password',
      { current: PASSWORD, new: 'a-good-new-password' }, { Cookie: a });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).message, '密码已更新');

    // 改密后旧密码立即失效、新密码可用，且**无需重启**
    assert.equal((await login(s.proxy, PASSWORD)).status, 401);
    assert.equal((await login(s.proxy, 'a-good-new-password')).status, 200);

    // 其它会话被踢掉，当前会话保留
    assert.equal((await s.proxy.get('/admin/api/keys', { headers: { Cookie: b } })).status, 401,
      '改密后其它已登录会话必须失效');
    assert.equal((await s.proxy.get('/admin/api/keys', { headers: { Cookie: a } })).status, 200,
      '发起改密的会话应保留');
  } finally { await s.close(); }
});

// ── ⑤ Key 增删改查 ───────────────────────────────────

test('Key 增删改查：格式校验、重复校验、脱敏展示、按需揭示', async () => {
  const s = await setup({ env: BASE_ENV });
  try {
    const api = await authed(s.proxy);
    const KEY = 'user_abcdefghijklmnopqrstuvwxyz';

    const badFormat = await api.post('/keys', { key: 'not-a-user-key' });
    assert.equal(badFormat.status, 400);
    assert.match((await badFormat.json()).error, /格式不正确/);

    const added = await api.post('/keys', { key: KEY, label: '主号' });
    assert.equal(added.status, 200);
    const id = (await added.json()).data.key.id;
    assert.ok(id, '新增应返回 Key 条目');

    const dup = await api.post('/keys', { key: KEY, label: '重复' });
    assert.equal(dup.status, 400);
    assert.match((await dup.json()).error, /已存在/);

    const list = await api.get('/keys');
    const item = (await list.json()).data.keys.find(k => k.id === id);
    assert.equal(item.label, '主号');
    assert.equal(item.source, 'ui');
    assert.equal(item.readOnly, false);
    assert.ok(!item.key, '列表项不应携带完整 Key 字段');
    assert.ok(!JSON.stringify(item).includes('abcdefghijklmnop'), '列表序列化后也不能出现完整 Key');
    assert.match(item.keyMasked, /^user_abc/);
    assert.match(item.keyMasked, /…/);

    const revealed = await api.post('/keys/reveal', { id });
    assert.equal((await revealed.json()).data.key, KEY, '揭示接口返回完整值');

    const renamed = await api.post('/keys/update', { id, label: '改名后', enabled: false });
    assert.equal(renamed.status, 200);
    const after = (await (await api.get('/keys')).json()).data.keys.find(k => k.id === id);
    assert.equal(after.label, '改名后');
    assert.equal(after.enabled, false, '禁用状态要持久化到列表');

    assert.equal((await api.post('/keys/delete', { id })).status, 200);
    const remaining = (await (await api.get('/keys')).json()).data.keys;
    assert.equal(remaining.find(k => k.id === id), undefined, '删除后不应再出现在列表');

    assert.equal((await api.post('/keys/delete', { id })).status, 400, '删除不存在的 Key 应报错');
  } finally { await s.close(); }
});

// ── ⑥ 热加载：后台加 Key，数据面立即可用 ──────────────

test('后台新增 Key 后无需重启即可作为上游凭证使用（热加载）', async () => {
  // 严格模式：客户端只认 proxyKey，上游凭证来自 Key 池
  const s = await setup({ env: { ...BASE_ENV, PROXY_KEY: 'client-secret' } });
  try {
    const api = await authed(s.proxy);
    const KEY = 'user_hotloadkey0000000000000000';

    // 加之前：池里没有任何 Key，上游凭证无从取得
    const before = await s.proxy.post('/v1/chat/completions',
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      { Authorization: 'Bearer client-secret' });
    assert.equal(before.status, 500, '没有上游 Key 时应明确报 500');

    const added = await api.post('/keys', { key: KEY, label: '热加载测试' });
    assert.equal(added.status, 200);

    // 加之后：同一个进程、不重启，立刻能用于上游调用
    const after = await s.proxy.post('/v1/chat/completions',
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      { Authorization: 'Bearer client-secret' });
    assert.equal(after.status, 200);
    assert.equal(s.mock.lastGenerate().headers.authorization, `Bearer ${KEY}`,
      '上游收到的必须来自刚在后台添加的 Key');

    // 禁用后立即失效：数据面不再拿它当上游凭证
    const id = (await added.json()).data.key.id;
    await api.post('/keys/update', { id, enabled: false });
    const disabled = await s.proxy.post('/v1/chat/completions',
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      { Authorization: 'Bearer client-secret' });
    assert.equal(disabled.status, 500, '禁用后应立刻回到「无可用上游 Key」');
  } finally { await s.close(); }
});

// ── ⑦ 只读来源（config / env） ───────────────────────

test('环境变量来源的 Key 只读，可导入为可管理条目', async () => {
  const s = await setup({ env: { ADMIN_PASSWORD: PASSWORD, CC_API_KEY: 'user_fromenv000000000000000000' } });
  try {
    const api = await authed(s.proxy);

    const keys = (await (await api.get('/keys')).json()).data.keys;
    const ext = keys.find(k => k.source === 'env');
    assert.ok(ext, '应出现 env 来源的 Key');
    assert.equal(ext.readOnly, true);
    assert.ok(!ext.keyMasked.includes('fromenv0000000000000000'), '同样要脱敏');

    const del = await api.post('/keys/delete', { id: ext.id });
    assert.equal(del.status, 400);
    assert.match((await del.json()).error, /环境变量/);

    const imported = await api.post('/keys/import');
    assert.equal((await imported.json()).data.imported, 1);

    const keys2 = (await (await api.get('/keys')).json()).data.keys;
    const uiKey = keys2.find(k => k.source === 'ui');
    assert.ok(uiKey, '导入后应出现 ui 来源条目');
    assert.equal(keys2.filter(k => k.source === 'env').length, 0, '同一串不应在两种来源里重复出现');
    assert.equal((await api.post('/keys/delete', { id: uiKey.id })).status, 200, '导入后即可删除');
  } finally { await s.close(); }
});

// ── ⑧ 模型目录与模型测试 ─────────────────────────────

/** 一个会为 /provider/v1/models 返回真实目录、其余走 NDJSON 的 mock 上游 */
async function startCatalogUpstream({ generateStatus = 200, generateBody = null, models = null } = {}) {
  const port = await allocPort();
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, raw: Buffer.concat(chunks).toString('utf8') });
      if (req.url === '/provider/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: models ?? [
          { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', context_length: 1000000, supported_endpoints: ['/messages'] },
          { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', context_length: 200000, supported_endpoints: ['/chat/completions', '/responses'] },
        ] }));
        return;
      }
      if (req.url === '/alpha/fingerprint/record' || req.url === '/alpha/lifecycle-events') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }
      if (generateStatus !== 200) {
        res.writeHead(generateStatus, { 'Content-Type': 'application/json' });
        res.end(generateBody || JSON.stringify({ success: false, error: { code: 'UNAUTHORIZED', status: generateStatus, message: 'Invalid Authorization header or token.' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('{"type":"text-start"}\n');
      res.write('{"type":"text-delta","text":"hi"}\n');
      res.write('{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":3,"outputTokens":1}}\n');
      res.end();
    });
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  return {
    port, seen,
    close: () => closeServer(server),
    lastGenerate: () => seen.filter(s => s.url === '/alpha/generate').pop() || null,
    generateCount: () => seen.filter(s => s.url === '/alpha/generate').length,
  };
}

test('模型目录来自上游，并保留 contextLength 与 supportedEndpoints', async () => {
  const upstream = await startCatalogUpstream();
  const proxy = await startProxy({
    upstreamPort: upstream.port,
    env: { ...BASE_ENV, CC_API_KEY: CATALOG_KEY, CC_USE_PROVIDER_MODELS: 'true' },
  });
  try {
    const api = await authed(proxy);
    const data = (await (await api.get('/models')).json()).data;

    assert.equal(data.models.length, 2);
    const ds = data.models.find(m => m.id === 'deepseek/deepseek-v4-flash');
    assert.equal(ds.name, 'DeepSeek V4 Flash');
    assert.equal(ds.contextLength, 200000, '上游给的 context_length 必须保留');
    assert.deepEqual(ds.supportedEndpoints, ['/chat/completions', '/responses']);
    assert.equal(ds.source, 'upstream');
    assert.ok(data.lastSyncAt, '应记录同步时间');
  } finally { await proxy.kill(); await upstream.close(); }
});

test('模型测试按上游错误码分类：正常→ok，401→unauthorized，套餐外→not_in_plan', async () => {
  // 正常
  {
    const upstream = await startCatalogUpstream();
    const proxy = await startProxy({ upstreamPort: upstream.port, env: { ...BASE_ENV, CC_API_KEY: CATALOG_KEY, CC_USE_PROVIDER_MODELS: 'true' } });
    try {
      const api = await authed(proxy);
      const r = await api.post('/models/test', { model: 'deepseek/deepseek-v4-flash' });
      const data = (await r.json()).data;
      assert.equal(data.ok, true);
      assert.equal(data.category, 'ok');
      assert.equal(data.categoryLabel, '正常');
      assert.ok(data.latencyMs >= 0, '应记录延迟');
      assert.ok(data.httpStatus === 200);
    } finally { await proxy.kill(); await upstream.close(); }
  }

  // 401 → unauthorized
  {
    const upstream = await startCatalogUpstream({ generateStatus: 401 });
    const proxy = await startProxy({ upstreamPort: upstream.port, env: { ...BASE_ENV, CC_API_KEY: CATALOG_KEY, CC_USE_PROVIDER_MODELS: 'true' } });
    try {
      const api = await authed(proxy);
      const data = (await (await api.post('/models/test', { model: 'claude-sonnet-5' })).json()).data;
      assert.equal(data.ok, false);
      assert.equal(data.category, 'unauthorized');
      assert.equal(data.httpStatus, 401);
    } finally { await proxy.kill(); await upstream.close(); }
  }

  // 套餐外：必须以业务码判定，不能被 403 状态码覆盖成通用错误
  {
    const upstream = await startCatalogUpstream({
      generateStatus: 403,
      generateBody: JSON.stringify({ success: false, error: { code: 'MODEL_NOT_IN_PLAN', message: 'model not in your plan' } }),
    });
    const proxy = await startProxy({ upstreamPort: upstream.port, env: { ...BASE_ENV, CC_API_KEY: CATALOG_KEY, CC_USE_PROVIDER_MODELS: 'true' } });
    try {
      const api = await authed(proxy);
      const data = (await (await api.post('/models/test', { model: 'claude-sonnet-5' })).json()).data;
      assert.equal(data.category, 'not_in_plan', '业务码优先级必须高于 HTTP 状态码');
      assert.equal(data.ok, false);
      assert.ok(data.model === 'claude-sonnet-5');
    } finally { await proxy.kill(); await upstream.close(); }
  }
});

// 回归：静态回退曾被当成「同步成功」，导致补上 Key 后模型页仍显示旧列表（挡在 TTL 之外）
test('模型目录：无 Key 时回退静态列表，补上 Key 后立刻转为上游真实目录', async () => {
  const upstream = await startCatalogUpstream();
  const proxy = await startProxy({
    upstreamPort: upstream.port,
    env: { ...BASE_ENV, CC_USE_PROVIDER_MODELS: 'true' },   // CC_API_KEY='' → 启动时没有 Key
  });
  try {
    const api = await authed(proxy);

    const first = (await (await api.get('/models')).json()).data;
    assert.equal(first.fromUpstream, false, '没有 Key 时不应声称已同步上游');
    assert.equal(first.lastSyncAt, null, '未成功同步过就不能有同步时间');
    assert.ok(first.models.length > 0, '应回退到静态列表，而不是空白');
    assert.equal(first.models[0].source, 'static');

    // 在后台补一个 Key
    const added = await api.post('/keys', { key: CATALOG_KEY, label: '补 Key' });
    assert.equal(added.status, 200);

    const second = (await (await api.get('/models')).json()).data;
    assert.equal(second.fromUpstream, true, '补上 Key 后必须立刻拿到真实目录');
    assert.equal(second.models.length, 2, '应是 mock 上游给的两个模型，而不是静态列表');
    assert.equal(second.models[0].source, 'upstream');
    assert.ok(second.lastSyncAt, '应记录成功同步时间');
  } finally { await proxy.kill(); await upstream.close(); }
});

// ── ⑨ Key 测试与用量 ─────────────────────────────────
test('Key 测试写入健康状态，正常路径计入用量', async () => {
  const upstream = await startCatalogUpstream();
  const proxy = await startProxy({
    upstreamPort: upstream.port,
    env: { ...BASE_ENV, PROXY_KEY: 'client-secret', CC_USE_PROVIDER_MODELS: 'true' },
  });
  try {
    const api = await authed(proxy);
    const KEY = 'user_usageprobe0000000000000000';
    const id = (await (await api.post('/keys', { key: KEY, label: '用量' })).json()).data.key.id;

    // 先拉一次模型目录（Key 测试要挑一个默认模型）
    await api.get('/models');

    // 直接测 Key
    const tested = (await (await api.post('/keys/test', { id })).json()).data;
    assert.equal(tested.category, 'ok');
    assert.equal(tested.keyId, id);

    const listed = (await (await api.get('/keys')).json()).data.keys.find(k => k.id === id);
    assert.equal(listed.health.status, 'ok', '测试结论要写回 Key 健康状态');
    assert.ok(listed.health.checkedAt, '应记录检查时间');

    // 走一次真实数据面请求，用量应累加
    const r = await proxy.post('/v1/chat/completions',
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      { Authorization: 'Bearer client-secret' });
    assert.equal(r.status, 200);

    const usage = (await (await api.get('/usage')).json()).data;
    const row = usage.items.find(i => i.keyId === id);
    assert.ok(row.requestsToday >= 1, '数据面请求应计入该 Key 今日用量');
    assert.ok(usage.summary.requestsToday >= 1);

    // 重置今日用量
    const reset = await api.post('/usage/reset', { keyId: id, scope: 'today' });
    assert.equal(reset.status, 200);
    const after = (await (await api.get('/usage')).json()).data;
    assert.equal(after.items.find(i => i.keyId === id).requestsToday, 0);
  } finally { await proxy.kill(); await upstream.close(); }
});

// ── ⑩ 设置热更新 ─────────────────────────────────────

test('设置接口可热改策略与默认模型，非法值被拒', async () => {
  const upstream = await startCatalogUpstream();
  const proxy = await startProxy({
    upstreamPort: upstream.port,
    env: { ...BASE_ENV, CC_API_KEY: CATALOG_KEY, CC_USE_PROVIDER_MODELS: 'true' },
  });
  try {
    const api = await authed(proxy);

    // 先拉一次模型目录：defaultModel 必须存在于目录中才会被接受
    await api.get('/models');

    const bad = await api.post('/config/update', { strategy: 'nonsense' });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /策略非法/);

    const badModel = await api.post('/config/update', { defaultModel: 'no/such-model' });
    assert.equal(badModel.status, 400);
    assert.match((await badModel.json()).error, /未知模型/);

    const good = await api.post('/config/update', { strategy: 'random', defaultModel: 'claude-sonnet-5' });
    assert.equal(good.status, 200);
    const cfg = (await good.json()).data;
    assert.equal(cfg.strategy, 'random');
    assert.equal(cfg.defaultModel, 'claude-sonnet-5');

    // 立即生效（读回确认）
    const reread = (await (await api.get('/config')).json()).data;
    assert.equal(reread.strategy, 'random');

    const badProxy = await api.post('/config/update', { upstreamProxy: 'socks5://127.0.0.1:1080' });
    assert.equal(badProxy.status, 400, '不支持的代理协议必须被拒');
  } finally { await proxy.kill(); await upstream.close(); }
});

// ── ⑪ 日志 ───────────────────────────────────────────

test('日志接口返回运行日志，级别过滤生效', async () => {
  const s = await setup({ env: BASE_ENV });
  try {
    const api = await authed(s.proxy);
    const all = (await (await api.get('/logs')).json()).data.logs;
    assert.ok(all.length > 0, '应有启动日志');
    assert.ok(all.some(l => l.msg === 'CC Proxy started'));
    assert.ok(all[0].time && all[0].level && all[0].msg, '每条日志要有 time/level/msg');

    const onlyError = (await (await api.get('/logs?level=error')).json()).data.logs;
    assert.ok(onlyError.every(l => l.level === 'error'), 'level=error 只能返回 error 级');
  } finally { await s.close(); }
});
