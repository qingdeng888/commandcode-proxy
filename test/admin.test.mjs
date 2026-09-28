// 管理后台：鉴权 / Key 管理 / 热加载 / 模型测试 / 用量
//
// 这些用例覆盖的是「后台能改运行时状态」这条链路 —— 它没有编译期检查兜底，
// 只能靠真实起进程 + 真实 HTTP 调用来验证。全部走 mock 上游，不需要真 Key。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, startProxy, allocPort, closeServer, seedConfig, REPO } from './helpers.mjs';
import http from 'node:http';
import { mkdtempSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { maskKey } from '../lib/keys.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
async function startCatalogUpstream({ generateStatus = 200, generateBody = null, models = null, ndjson = null } = {}) {
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
      for (const line of (ndjson ?? [
        '{"type":"text-start"}',
        '{"type":"text-delta","text":"hi"}',
        '{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":3,"outputTokens":1}}',
      ])) res.write(line + '\n');
      res.end();
    });
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  return {
    port, seen,
    close: () => closeServer(server),
    lastGenerate: () => seen.filter(s => s.url === '/alpha/generate').pop() || null,
    generateCount: () => seen.filter(s => s.url === '/alpha/generate').length,
    /** 上游实际收到的提示词（探测请求的信封 params.messages[0]） */
    lastPrompt: () => {
      const g = seen.filter(s => s.url === '/alpha/generate').pop();
      if (!g) return null;
      try {
        const body = JSON.parse(g.raw);
        const part = body?.params?.messages?.[0]?.content?.[0];
        return part?.text ?? null;
      } catch { return null; }
    },
    /** 上游实际收到的完整信封（验证 system / max_tokens / reasoning_effort 等） */
    lastWireBody: () => {
      const g = seen.filter(s => s.url === '/alpha/generate').pop();
      if (!g) return null;
      try { return JSON.parse(g.raw); } catch { return null; }
    },
    /** 上游实际收到的信封里用的 model（验证「省略 model 时的兜底」） */
    lastWireModel: () => {
      const g = seen.filter(s => s.url === '/alpha/generate').pop();
      if (!g) return null;
      try { return JSON.parse(g.raw)?.params?.model ?? null; } catch { return null; }
    },
    /** 所有探测请求收到的提示词，按顺序 */
    allPrompts: () => seen
      .filter(s => s.url === '/alpha/generate')
      .map(s => { try { return JSON.parse(s.raw)?.params?.messages?.[0]?.content?.[0]?.text ?? null; } catch { return null; } }),
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

test('单次模型测试返回模型的完整回答；批量结果保持紧凑不带正文', async () => {
  const longReply = '这是一段用于验证完整返回的较长回答。'.repeat(60);   // 约 1000+ 字符
  const upstream = await startCatalogUpstream({ ndjson: [
    '{"type":"text-start"}',
    `{"type":"text-delta","text":"${longReply}"}`,
    '{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":7,"outputTokens":321}}',
  ] });
  const proxy = await startProxy({
    upstreamPort: upstream.port,
    env: { ...BASE_ENV, CC_API_KEY: CATALOG_KEY, CC_USE_PROVIDER_MODELS: 'true' },
  });
  try {
    const api = await authed(proxy);
    const list = (await (await api.get('/models')).json()).data;
    const model = list.models[0].id;

    // 单次测试：要给到模型的实际回答（仪表盘要展示）
    const single = (await (await api.post('/models/test', { model })).json()).data;
    assert.ok(single.output && single.output.length > 900,
      `单次测试应返回完整回答，实际 ${single.output ? single.output.length : 0} 字符`);
    assert.ok(single.output.startsWith('这是一段用于验证完整返回'), '回答内容要原样返回');
    assert.ok(single.outputPreview.length < single.output.length,
      'outputPreview 应是明显短于正文的压缩版本');
    assert.equal(single.finishReason, 'stop', '应带出结束原因');
    assert.deepEqual(single.usage, { inputTokens: 7, outputTokens: 321 }, '应带出 token 用量');
    assert.equal(single.truncated, false);

    // Key 测试同样返回回答
    const kid = (await (await api.post('/keys', { key: 'user_outputcheck0000000000000', label: 'O' })).json()).data.key.id;
    const viaKey = (await (await api.post('/keys/test', { id: kid })).json()).data;
    assert.ok(viaKey.output && viaKey.output.length > 900, 'Key 测试也应返回完整回答');

    // 批量：只为分类，不带正文（否则结果列表与 model-tests.json 会被撑大）
    const started = await api.post('/models/test-batch', { models: [model], concurrency: 1 });
    assert.equal(started.status, 200);
    for (let i = 0; i < 40; i++) {
      const st = (await (await api.get('/models/test-status')).json()).data;
      if (!st.running && st.done >= 1) break;
      await new Promise(r => setTimeout(r, 150));
    }
    const st = (await (await api.get('/models/test-status')).json()).data;
    assert.equal(st.results.length, 1);
    assert.ok(!st.results[0].output, '批量结果不应携带回答正文');
    assert.ok(st.results[0].outputPreview, '但应保留短预览');
  } finally { await proxy.kill(); await upstream.close(); }
});

test('结束原因为 max_tokens 时明确标出回答被截断', async () => {
  const upstream = await startCatalogUpstream({ ndjson: [
    '{"type":"text-start"}',
    '{"type":"text-delta","text":"写到这里就被上限截断了"}',
    '{"type":"finish","finishReason":"max_tokens","totalUsage":{"inputTokens":3,"outputTokens":1024}}',
  ] });
  const proxy = await startProxy({
    upstreamPort: upstream.port,
    env: { ...BASE_ENV, CC_API_KEY: CATALOG_KEY, CC_USE_PROVIDER_MODELS: 'true' },
  });
  try {
    const api = await authed(proxy);
    const list = (await (await api.get('/models')).json()).data;
    const d = (await (await api.post('/models/test', { model: list.models[0].id })).json()).data;
    assert.equal(d.ok, true, '被 token 上限截断仍算链路正常');
    assert.equal(d.truncated, true);
    assert.equal(d.finishReason, 'max_tokens');
    assert.match(d.message, /token 上限/, '说明里要讲清是被上限截断，而不是让用户以为模型坏了');
  } finally { await proxy.kill(); await upstream.close(); }
});

test('返回上游实际服务的模型与厂商，用于核实路由命中（模型自述不可信）', async () => {
  // 情况一：上游回报的 modelId 与请求一致
  const upstream = await startCatalogUpstream({ ndjson: [
    '{"type":"text-start"}',
    '{"type":"text-delta","text":"我是 Claude"}',
    '{"type":"finish-step","finishReason":"stop","providerMetadata":{"novita":{}},"response":{"modelId":"deepseek/deepseek-v4.1-flash"}}',
    '{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":40,"outputTokens":20}}',
  ] });
  const proxy = await startProxy({
    upstreamPort: upstream.port,
    env: { ...BASE_ENV, CC_API_KEY: CATALOG_KEY, CC_USE_PROVIDER_MODELS: 'true' },
  });
  try {
    const api = await authed(proxy);
    const ids = (await (await api.get('/models')).json()).data.models.map(m => m.id);
    // 目录里没有 deepseek/deepseek-v4.1-flash，用 mock 的第一个模型，但让上游回报成它
    const requested = ids[1];
    const d = (await (await api.post('/models/test', { model: requested })).json()).data;

    assert.equal(d.upstreamModel, 'deepseek/deepseek-v4.1-flash', '应回报上游实际服务的模型');
    assert.equal(d.upstreamProvider, 'novita', '应回报上游实际使用的厂商');
    assert.equal(d.modelMatched, false, '与请求不一致时 modelMatched 必须为 false');
    assert.match(d.message, /上游实际服务的是 deepseek\/deepseek-v4\.1-flash/, '不一致要在 message 里明说');
    // 模型自述说自己是 Claude，但结论以元数据为准 —— 这正是要防的乌龙
    assert.equal(d.output, '我是 Claude');
  } finally { await proxy.kill(); await upstream.close(); }
});

test('一致时标记为命中，且不产生误导性警告', async () => {
  const upstream = await startCatalogUpstream({ ndjson: [
    '{"type":"text-start"}',
    '{"type":"text-delta","text":"pong"}',
    '{"type":"finish-step","finishReason":"stop","providerMetadata":{"deepinfra":{}},"response":{"modelId":"claude-sonnet-5"}}',
    '{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":40,"outputTokens":3}}',
  ] });
  const proxy = await startProxy({
    upstreamPort: upstream.port,
    env: { ...BASE_ENV, CC_API_KEY: CATALOG_KEY, CC_USE_PROVIDER_MODELS: 'true' },
  });
  try {
    const api = await authed(proxy);
    await api.get('/models');
    const d = (await (await api.post('/models/test', { model: 'claude-sonnet-5' })).json()).data;
    assert.equal(d.upstreamModel, 'claude-sonnet-5');
    assert.equal(d.upstreamProvider, 'deepinfra');
    assert.equal(d.modelMatched, true);
    assert.ok(!/不一致/.test(d.message), '一致时不应出现不一致警告');
  } finally { await proxy.kill(); await upstream.close(); }
});

test('探测信封：model 就是所选的模型，且单次给足 token 上限', async () => {
  const upstream = await startCatalogUpstream();
  const proxy = await startProxy({
    upstreamPort: upstream.port,
    env: { ...BASE_ENV, CC_API_KEY: CATALOG_KEY, CC_USE_PROVIDER_MODELS: 'true' },
  });
  try {
    const api = await authed(proxy);
    const list = (await (await api.get('/models')).json()).data;
    const requested = list.models[1].id;

    // 单次测试
    await api.post('/models/test', { model: requested });
    const body = upstream.lastWireBody();
    assert.ok(body, '应捕获到探测请求');

    // 最关键的一条：发出去的 model 必须就是选的那个（用户明确要求核实这点）
    assert.equal(body.params.model, requested, '探测请求的 model 必须等于所选模型');
    assert.ok(body.params.messages.length > 0, '应带上测试消息');

    // 单次要有足够预算：推理也计入上限，4096 才留得下正文
    assert.equal(body.params.max_tokens, 4096, '单次测试的 token 上限应为 4096');
    // 发空 system 占位是刻意的：能省掉 CC 注入的约 7.5K 默认提示词
    // （实测输入 42 vs 7602 token），而预算给足后正文同样稳定出现
    assert.deepEqual(body.params.system, [{ type: 'text', text: ' ' }],
      '探测应发送空 system 占位以省下约 7.5K 输入 token');

    // 批量：预算收紧、model 同样要正确
    await api.post('/models/test-batch', { models: [requested], concurrency: 1 });
    await new Promise(r => setTimeout(r, 600));
    const batchBody = upstream.lastWireBody();
    assert.equal(batchBody.params.model, requested, '批量探测的 model 也必须正确');
    assert.equal(batchBody.params.max_tokens, 256, '批量探测的 token 上限应为 256');
  } finally { await proxy.kill(); await upstream.close(); }
});

test('模型只思考不产出正文时：如实说明，并把思考内容返回', async () => {
  const upstream = await startCatalogUpstream({ ndjson: [
    '{"type":"reasoning-start"}',
    '{"type":"reasoning-delta","text":"让我想想这个问题该怎么回答……"}',
    '{"type":"reasoning-end"}',
    // 刻意不发任何 text-delta
    '{"type":"finish","finishReason":"max_tokens","totalUsage":{"inputTokens":40,"outputTokens":4096,"reasoningTokens":4096}}',
  ] });
  const proxy = await startProxy({
    upstreamPort: upstream.port,
    env: { ...BASE_ENV, CC_API_KEY: CATALOG_KEY, CC_USE_PROVIDER_MODELS: 'true' },
  });
  try {
    const api = await authed(proxy);
    const list = (await (await api.get('/models')).json()).data;
    const d = (await (await api.post('/models/test', { model: list.models[0].id })).json()).data;

    assert.equal(d.ok, true, '链路是通的（收到了响应与 finish），不应判成故障');
    assert.equal(d.textChars, 0);
    assert.ok(d.reasoningChars > 0, '应把思考内容收下来');
    assert.match(d.reasoning, /让我想想/);
    assert.match(d.message, /思考/, '说明里要点出「上限被思考占满」，而不是笼统说没有输出');
    assert.equal(d.truncated, true);
    assert.equal(d.finishReason, 'max_tokens');
  } finally { await proxy.kill(); await upstream.close(); }
});

test('只允许测试启用中的模型（服务端强制，不只是下拉过滤）', async () => {
  const upstream = await startCatalogUpstream();
  const proxy = await startProxy({
    upstreamPort: upstream.port,
    env: { ...BASE_ENV, CC_API_KEY: CATALOG_KEY, CC_USE_PROVIDER_MODELS: 'true' },
  });
  try {
    const api = await authed(proxy);
    const list = (await (await api.get('/models')).json()).data;
    const [m1, m2] = list.models.map(m => m.id);
    await api.post('/models/disable', { ids: [m2] });

    // 单模型测试：直接构造请求也不行
    const single = await api.post('/models/test', { model: m2 });
    assert.equal(single.status, 400);
    assert.match((await single.json()).error, /已被禁用/);

    const keyTest = await api.post('/keys/test', { key: CATALOG_KEY, model: m2 });
    assert.equal(keyTest.status, 400);
    assert.match((await keyTest.json()).error, /已被禁用/);

    // 未指定模型时自动挑的是启用中的那个，不受影响
    const auto = await api.post('/keys/test', { key: CATALOG_KEY });
    assert.equal(auto.status, 200);
    assert.equal((await auto.json()).data.model, m1, '自动选择应落在启用中的模型上');

    // 批量：显式带上禁用模型会被剔除并如实回报，而不是静默少测
    const batch = await api.post('/models/test-batch', { models: [m1, m2], concurrency: 1 });
    assert.equal(batch.status, 200);
    const batchBody = await batch.json();
    assert.equal(batchBody.data.total, 1);
    assert.deepEqual(batchBody.data.skipped, [m2]);
    assert.match(batchBody.message, /跳过 1 个被禁用的模型/);
    for (let i = 0; i < 40; i++) {
      const st = (await (await api.get('/models/test-status')).json()).data;
      if (!st.running && st.done >= 1) break;
      await new Promise(r => setTimeout(r, 150));
    }

    // 全部被禁用时批量测试直接报错，并说明原因
    await api.post('/models/disable', { all: true });
    const allDisabled = await api.post('/models/test-batch', { models: [m1, m2] });
    assert.equal(allDisabled.status, 400);
    assert.match((await allDisabled.json()).error, /都已被禁用/);
  } finally { await proxy.kill(); await upstream.close(); }
});

test('省略 model 时按「默认测试模型 → 第一个启用模型」兜底，不再写死', async () => {
  const upstream = await startCatalogUpstream();
  const proxy = await startProxy({
    upstreamPort: upstream.port,
    env: { ...BASE_ENV, CC_API_KEY: CATALOG_KEY, CC_USE_PROVIDER_MODELS: 'true' },
  });
  const H = { Authorization: `Bearer ${CATALOG_KEY}` };
  try {
    const api = await authed(proxy);
    const list = (await (await api.get('/models')).json()).data;
    const [m1, m2] = list.models.map(m => m.id);

    // 设默认测试模型为 m2 → 不带 model 的请求应使用 m2
    await api.post('/config/update', { defaultModel: m2 });
    await proxy.post('/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] }, H);
    assert.equal(upstream.lastWireModel(), m2, '省略 model 时应使用默认测试模型');

    // 把 m2 禁用 → 兜底应退到第一个启用模型 m1，而不是写死的那个 id
    await api.post('/models/disable', { ids: [m2] });
    await proxy.post('/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] }, H);
    assert.equal(upstream.lastWireModel(), m1, '默认模型被禁用后应退到第一个启用模型');

    // 三条数据面路径都走同一套兜底
    await proxy.post('/v1/messages', { max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }, { 'x-api-key': CATALOG_KEY });
    assert.equal(upstream.lastWireModel(), m1, 'Anthropic 路径同样兜底');
    await proxy.post('/v1/responses', { input: 'hi' }, H);
    assert.equal(upstream.lastWireModel(), m1, 'Responses 路径同样兜底');
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

// 回归：测试消息的默认值与参考项目一致，且支持自定义
test('测试消息：默认「你是谁，出来干活了」，可自定义，越界被拒', async () => {
  const upstream = await startCatalogUpstream();
  const proxy = await startProxy({
    upstreamPort: upstream.port,
    env: { ...BASE_ENV, CC_API_KEY: CATALOG_KEY, CC_USE_PROVIDER_MODELS: 'true' },
  });
  try {
    const api = await authed(proxy);
    const models = (await (await api.get('/models')).json()).data;
    const model = models.models[0].id;

    // 1) 不传 message → 上游收到的应是参考项目那条默认提示词
    const d1 = (await (await api.post('/models/test', { model })).json()).data;
    assert.equal(upstream.lastPrompt(), '你是谁，出来干活了',
      '默认提示词必须与参考项目一致');
    assert.equal(d1.prompt, '你是谁，出来干活了', '响应里要回显实际发送的内容');

    // 2) 传自定义 message → 原样发到上游
    const d2 = (await (await api.post('/models/test', { model, message: '你好，做一次连通性检查' })).json()).data;
    assert.equal(upstream.lastPrompt(), '你好，做一次连通性检查');
    assert.equal(d2.prompt, '你好，做一次连通性检查');

    // 3) 空白 message → 回落默认值（而不是发一个空提示词）
    await api.post('/models/test', { model, message: '   ' });
    assert.equal(upstream.lastPrompt(), '你是谁，出来干活了');

    // 4) Key 测试走同一条提示词逻辑
    const kid = (await (await api.post('/keys', { key: 'user_promptcheck00000000000000', label: 'P' })).json()).data.key.id;
    const d4 = (await (await api.post('/keys/test', { id: kid, message: '来自 Key 测试的消息' })).json()).data;
    assert.equal(upstream.lastPrompt(), '来自 Key 测试的消息');
    assert.equal(d4.prompt, '来自 Key 测试的消息');
    assert.equal(d4.ok, true);

    // 5) 越界与类型校验
    const tooLong = await api.post('/models/test', { model, message: 'x'.repeat(4001) });
    assert.equal(tooLong.status, 400);
    assert.match((await tooLong.json()).error, /过长/);

    const wrongType = await api.post('/models/test', { model, message: 123 });
    assert.equal(wrongType.status, 400);
    assert.match((await wrongType.json()).error, /必须是字符串/);

    // 6) 后台要能拿到默认值（前端据此预填，默认值只在后端定义一处）
    const cfg = (await (await api.get('/config')).json()).data;
    assert.equal(cfg.defaultTestMessage, '你是谁，出来干活了');
    assert.equal(cfg.maxTestMessageLen, 4000);
  } finally { await proxy.kill(); await upstream.close(); }
});

test('批量测试同样接受自定义测试消息', async () => {
  const upstream = await startCatalogUpstream();
  const proxy = await startProxy({
    upstreamPort: upstream.port,
    env: { ...BASE_ENV, CC_API_KEY: CATALOG_KEY, CC_USE_PROVIDER_MODELS: 'true' },
  });
  try {
    const api = await authed(proxy);
    await api.get('/models');

    const started = await api.post('/models/test-batch', { models: ['claude-sonnet-5', 'deepseek/deepseek-v4-flash'], message: '批量探测消息', concurrency: 2 });
    assert.equal(started.status, 200);
    assert.equal((await started.json()).data.prompt, '批量探测消息');

    // 等批量跑完
    for (let i = 0; i < 40; i++) {
      const st = (await (await api.get('/models/test-status')).json()).data;
      if (!st.running && st.done >= 2) break;
      await new Promise(r => setTimeout(r, 150));
    }
    const prompts = upstream.allPrompts();
    assert.ok(prompts.length >= 2, '批量测试应至少发出两次请求');
    assert.ok(prompts.every(p => p === '批量探测消息'),
      `每个模型都应收到自定义消息，实际：${JSON.stringify(prompts)}`);
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

// ── ⑨b 上游 Key 的停用 / 启用 ──────────────────────────

test('上游 Key 停用后立即退出轮询池，重新启用后恢复（无需重启）', async () => {
  const upstream = await startCatalogUpstream();
  const proxy = await startProxy({
    upstreamPort: upstream.port,
    // 严格模式：客户端只给 proxyKey，上游凭证来自池子 —— 这样停用才会影响数据面
    env: { ...BASE_ENV, CC_API_KEY: CATALOG_KEY, PROXY_KEY: 'client-secret', CC_USE_PROVIDER_MODELS: 'true' },
  });
  const H = { Authorization: 'Bearer client-secret' };
  const CHAT = { model: 'deepseek/deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] };
  try {
    const api = await authed(proxy);
    // env/config 来源是只读的（服务端会拒绝修改并说明原因），先导入成可管理的
    const readonly = await api.post('/keys/update', { id: (await (await api.get('/keys')).json()).data.keys[0].id, enabled: false });
    assert.equal(readonly.status, 400, '只读来源不能直接停用');
    assert.match((await readonly.json()).error, /环境变量/);

    await api.post('/keys/import');
    const keyId = (await (await api.get('/keys')).json()).data.keys.find(k => k.source === 'ui').id;

    // 默认启用：请求走池子里的 Key
    assert.equal((await proxy.post('/v1/chat/completions', CHAT, H)).status, 200);
    assert.equal(upstream.lastGenerate().headers.authorization, `Bearer ${CATALOG_KEY}`);

    // 停用
    const off = await api.post('/keys/update', { id: keyId, enabled: false });
    assert.equal(off.status, 200);
    const afterOff = (await (await api.get('/keys')).json()).data.keys.find(k => k.id === keyId);
    assert.equal(afterOff.enabled, false, '列表要反映停用状态');
    assert.equal((await (await api.get('/stats')).json()).data.keys.enabled, 0, '统计里的启用数应归零');

    // 停用后：没有可用上游 Key → 明确报 500，而不是照样打上游
    const before = upstream.generateCount();
    const blocked = await proxy.post('/v1/chat/completions', CHAT, H);
    assert.equal(blocked.status, 500, '全部停用时必须是明确失败');
    assert.equal(upstream.generateCount(), before, '停用的 Key 不应再被拿去请求上游');

    // 重新启用 → 立即恢复
    assert.equal((await api.post('/keys/update', { id: keyId, enabled: true })).status, 200);
    assert.equal((await proxy.post('/v1/chat/completions', CHAT, H)).status, 200);
    assert.equal((await (await api.get('/stats')).json()).data.keys.enabled, 1);
  } finally { await proxy.kill(); await upstream.close(); }
});

test('多 Key 下停用其中一个：该 Key 彻底不再被选中，其余照常服务', async () => {
  const KEY_A = 'user_keyA000000000000000000000';
  const KEY_B = 'user_keyB000000000000000000000';
  const upstream = await startCatalogUpstream();
  // 用显式 cwd，便于最后检查落盘文件（startProxy 不传 cwd 时会自建临时目录）
  const workdir = mkdtempSync(join(tmpdir(), 'ccp-keytoggle-'));
  seedConfig(workdir);
  const proxy = await startProxy({
    upstreamPort: upstream.port,
    cwd: workdir,
    env: { ...BASE_ENV, CC_API_KEY: `${KEY_A},${KEY_B}`, PROXY_KEY: 'client-secret', CC_USE_PROVIDER_MODELS: 'true' },
  });
  const H = { Authorization: 'Bearer client-secret' };
  const CHAT = { model: 'deepseek/deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] };
  try {
    const api = await authed(proxy);
    assert.equal((await (await api.get('/keys')).json()).data.keys.length, 2);

    // config/env 来源只读，先导入成可管理的
    await api.post('/keys/import');
    const uiKeys = (await (await api.get('/keys')).json()).data.keys.filter(k => k.source === 'ui');
    assert.equal(uiKeys.length, 2);
    const idA = uiKeys.find(k => k.keyMasked === maskKey(KEY_A))?.id;
    const idB = uiKeys.find(k => k.keyMasked === maskKey(KEY_B))?.id;
    assert.ok(idA && idB, `两个 Key 都应可定位（${JSON.stringify(uiKeys.map(k => k.keyMasked))}）`);

    // 停用 A
    assert.equal((await api.post('/keys/update', { id: idA, enabled: false })).status, 200);

    // 连打多次，确保被停用的那个再也不出现
    const used = new Set();
    for (let i = 0; i < 12; i++) {
      assert.equal((await proxy.post('/v1/chat/completions', CHAT, H)).status, 200);
      used.add(upstream.lastGenerate().headers.authorization.replace('Bearer ', ''));
    }
    assert.deepEqual([...used], [KEY_B], `只应使用仍启用的那个 Key，实际：${[...used]}`);

    // 停用状态要落盘（重启后仍生效）
    const persisted = JSON.parse(readFileSync(join(workdir, 'data', 'keys.json'), 'utf-8'));
    assert.ok(persisted.keys.some(k => k.id === idA && k.enabled === false),
      '停用状态应写入 keys.json');
    assert.ok(persisted.keys.some(k => k.id === idB && k.enabled === true), '另一个应保持启用');

    // 重启同一工作目录 → 停用依然生效
  } finally { await proxy.kill(); }

  const proxy2 = await startProxy({
    upstreamPort: upstream.port,
    cwd: workdir,
    env: { ...BASE_ENV, CC_API_KEY: `${KEY_A},${KEY_B}`, PROXY_KEY: 'client-secret', CC_USE_PROVIDER_MODELS: 'true' },
  });
  try {
    const used = new Set();
    for (let i = 0; i < 8; i++) {
      assert.equal((await proxy2.post('/v1/chat/completions', CHAT, H)).status, 200);
      used.add(upstream.lastGenerate().headers.authorization.replace('Bearer ', ''));
    }
    assert.deepEqual([...used], [KEY_B], '重启后停用状态仍应生效');
  } finally {
    await proxy2.kill();
    await upstream.close();
    rmSync(workdir, { recursive: true, force: true });
  }
});

// ── ⑩ 用量统计（token 记账）──────────────────────────

test('数据面请求计入 token 用量，且一条请求只记一次（流式/非流式都不重复）', async () => {
  const upstream = await startCatalogUpstream();
  const proxy = await startProxy({
    upstreamPort: upstream.port,
    env: { ...BASE_ENV, CC_API_KEY: CATALOG_KEY, CC_USE_PROVIDER_MODELS: 'true' },
  });
  const H = { Authorization: `Bearer ${CATALOG_KEY}` };
  const CHAT = { model: 'deepseek/deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] };
  try {
    const api = await authed(proxy);
    const keyId = (await (await api.get('/usage')).json()).data.items[0].keyId;

    // 非流式一次
    assert.equal((await proxy.post('/v1/chat/completions', CHAT, H)).status, 200);
    let row = (await (await api.get('/usage')).json()).data.items.find(i => i.keyId === keyId);
    assert.equal(row.requestsToday, 1, '一条请求只应记 1 次（重复记账是最容易犯的错）');
    assert.equal(row.tokensInToday, 3, '应记下输入 token（mock 的 totalUsage.inputTokens）');
    assert.equal(row.tokensOutToday, 1, '应记下输出 token');

    // 流式一次 → 累加，同样只记一次
    const sres = await proxy.post('/v1/chat/completions', { ...CHAT, stream: true }, H);
    await sres.text();
    await new Promise(r => setTimeout(r, 300));   // 等 response 的 finish 钩子跑完
    row = (await (await api.get('/usage')).json()).data.items.find(i => i.keyId === keyId);
    assert.equal(row.requestsToday, 2, '流式请求也应恰好记 1 次');
    assert.equal(row.tokensInToday, 6, '两条请求的 token 应累加');
    assert.equal(row.tokensOutToday, 2);

    // 汇总口径与明细一致
    const sum = (await (await api.get('/usage')).json()).data.summary;
    assert.equal(sum.requestsToday, 2);
    assert.equal(sum.inToday, 6);
    assert.equal(sum.outToday, 2);

    // 仪表盘的 stats 也要能读到（否则卡片显示 0）
    const stats = (await (await api.get('/stats')).json()).data;
    assert.equal(stats.tokens.inToday, 6, 'stats 的 token 统计应与用量页一致');
    assert.equal(stats.tokens.outToday, 2);
  } finally { await proxy.kill(); await upstream.close(); }
});

test('后台的模型测试也计入该 Key 的用量（否则只点测试的用量永远显示 0）', async () => {
  const upstream = await startCatalogUpstream();
  const proxy = await startProxy({
    upstreamPort: upstream.port,
    env: { ...BASE_ENV, CC_API_KEY: CATALOG_KEY, CC_USE_PROVIDER_MODELS: 'true' },
  });
  try {
    const api = await authed(proxy);
    const list = (await (await api.get('/models')).json()).data;
    const keyId = (await (await api.get('/usage')).json()).data.items[0].keyId;

    const before = (await (await api.get('/usage')).json()).data.items.find(i => i.keyId === keyId);
    assert.equal(before.requestsToday, 0, '探测之前应为 0');

    await api.post('/models/test', { model: list.models[0].id });
    const after = (await (await api.get('/usage')).json()).data.items.find(i => i.keyId === keyId);
    assert.equal(after.requestsToday, 1, '模型测试应计入请求数');
    assert.equal(after.tokensInToday, 3, '模型测试应计入 token');
    assert.equal(after.tokensOutToday, 1);
    assert.ok(after.lastUsedAt, '应更新最后使用时间');
  } finally { await proxy.kill(); await upstream.close(); }
});

test('输入 token 拆成 命中/写缓存/未命中，且三桶之和恒等于输入总数', async () => {
  const upstream = await startCatalogUpstream({ ndjson: [
    '{"type":"text-start"}',
    '{"type":"text-delta","text":"ok"}',
    '{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":1000,'
      + '"inputTokenDetails":{"noCacheTokens":100,"cacheReadTokens":850,"cacheWriteTokens":50},'
      + '"cachedInputTokens":850,"outputTokens":20}}',
  ] });
  const proxy = await startProxy({
    upstreamPort: upstream.port,
    env: { ...BASE_ENV, CC_API_KEY: CATALOG_KEY, CC_USE_PROVIDER_MODELS: 'true' },
  });
  try {
    const api = await authed(proxy);
    await api.get('/models');   // 触发目录同步，确保 items 里已有该 Key
    await proxy.post('/v1/chat/completions',
      { model: 'deepseek/deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] },
      { Authorization: `Bearer ${CATALOG_KEY}` });

    const usage = (await (await api.get('/usage')).json()).data;
    const row = usage.items[0];
    assert.equal(row.tokensInToday, 1000, '输入总数');
    assert.equal(row.cacheReadToday, 850, '缓存命中');
    assert.equal(row.cacheWriteToday, 50, '写入缓存');
    assert.equal(row.cacheMissToday, 100, '未命中');
    assert.equal(row.cacheReadToday + row.cacheWriteToday + row.cacheMissToday, row.tokensInToday,
      '三桶之和必须等于输入总数（口径不能重叠也不能漏）');
    assert.equal(row.cacheHitRateToday, 0.85, '命中率 = 命中 / 输入总数');

    const sum = usage.summary;
    assert.equal(sum.inToday, 1000);
    assert.equal(sum.cacheReadToday, 850);
    assert.equal(sum.cacheMissToday, 100);
    assert.equal(sum.cacheHitRateToday, 0.85);

    const stats = (await (await api.get('/stats')).json()).data;
    assert.equal(stats.tokens.cacheReadToday, 850, '仪表盘 stats 也要带命中明细');
    assert.equal(stats.tokens.cacheHitRateToday, 0.85);
  } finally { await proxy.kill(); await upstream.close(); }
});

test('上游没给缓存明细时全部归入未命中（和仍等于输入总数）', async () => {
  const upstream = await startCatalogUpstream({ ndjson: [
    '{"type":"text-start"}',
    '{"type":"text-delta","text":"ok"}',
    '{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":500,"outputTokens":10}}',
  ] });
  const proxy = await startProxy({
    upstreamPort: upstream.port,
    env: { ...BASE_ENV, CC_API_KEY: CATALOG_KEY, CC_USE_PROVIDER_MODELS: 'true' },
  });
  try {
    const api = await authed(proxy);
    await proxy.post('/v1/chat/completions',
      { model: 'deepseek/deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] },
      { Authorization: `Bearer ${CATALOG_KEY}` });
    const row = (await (await api.get('/usage')).json()).data.items[0];
    assert.equal(row.tokensInToday, 500);
    assert.equal(row.cacheReadToday, 0, '没有明细就没有命中');
    assert.equal(row.cacheMissToday, 500, '缺明细时全部算未命中，不能凭空造出命中');
    assert.equal(row.cacheHitRateToday, 0);
  } finally { await proxy.kill(); await upstream.close(); }
});

test('后台模型测试的 token 也按缓存拆桶', async () => {
  const upstream = await startCatalogUpstream({ ndjson: [
    '{"type":"text-start"}',
    '{"type":"text-delta","text":"ok"}',
    '{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":200,'
      + '"inputTokenDetails":{"noCacheTokens":40,"cacheReadTokens":160},"cachedInputTokens":160,"outputTokens":5}}',
  ] });
  const proxy = await startProxy({
    upstreamPort: upstream.port,
    env: { ...BASE_ENV, CC_API_KEY: CATALOG_KEY, CC_USE_PROVIDER_MODELS: 'true' },
  });
  try {
    const api = await authed(proxy);
    const list = (await (await api.get('/models')).json()).data;
    await api.post('/models/test', { model: list.models[0].id });
    const row = (await (await api.get('/usage')).json()).data.items[0];
    assert.equal(row.tokensInToday, 200);
    assert.equal(row.cacheReadToday, 160, '探测也要拆出命中');
    assert.equal(row.cacheMissToday, 40);
    assert.equal(row.cacheHitRateToday, 0.8);
  } finally { await proxy.kill(); await upstream.close(); }
});

test('历史数据（没有缓存字段）也要满足 命中+写+未命中 === 输入总数', async () => {
  // 模拟本功能上线前的 keys.json：一个 Key + 只记了 tokensIn 的旧格式用法
  const workdir = mkdtempSync(join(tmpdir(), 'ccp-legacy-'));
  seedConfig(workdir);
  mkdirSync(join(workdir, 'data'), { recursive: true });
  const legacyKey = {
    id: 'k_legacy0001', key: 'user_legacy00000000000000000000', label: '旧数据',
    enabled: true, createdAt: new Date().toISOString(),
  };
  writeFileSync(join(workdir, 'data', 'keys.json'), JSON.stringify({
    version: 1,
    keys: [legacyKey],
    stats: {
      [legacyKey.id]: {
        usage: {
          date: new Date().toISOString().slice(0, 10),
          requestsToday: 3, requestsTotal: 3, failedToday: 0, failedTotal: 0,
          tokensInToday: 49667, tokensInTotal: 49667,   // 旧格式：没有 cache* 字段
          tokensOutToday: 120, tokensOutTotal: 120,
        },
        health: { status: 'unknown', checkedAt: null, latencyMs: null, message: '' },
        cooldownUntil: null, lastError: null, lastUsedAt: null,
      },
    },
  }, null, 2));

  const upstream = await startCatalogUpstream();
  const proxy = await startProxy({
    upstreamPort: upstream.port,
    cwd: workdir,
    env: { ...BASE_ENV, CC_API_KEY: CATALOG_KEY, CC_USE_PROVIDER_MODELS: 'true' },
  });
  try {
    const api = await authed(proxy);
    const item = (await (await api.get('/usage')).json()).data.items.find(i => i.keyId === legacyKey.id);
    assert.ok(item, '旧数据里的 Key 应被读出');
    assert.equal(item.tokensInToday, 49667, '旧数据的总数要原样保留');
    assert.equal(item.cacheReadToday, 0, '没有明细就没有命中');
    assert.equal(item.cacheMissToday, 49667, '没给明细就全部算未命中，不能凭空造出命中');
    assert.equal(item.cacheReadToday + item.cacheWriteToday + item.cacheMissToday, item.tokensInToday,
      '不变量对历史数据也必须成立');
    assert.equal(item.cacheHitRateToday, 0);
  } finally {
    await proxy.kill();
    await upstream.close();
    rmSync(workdir, { recursive: true, force: true });
  }
});

// ── ⑩a 2API Key（下游客户端凭证）与上游 Key 的边界 ──────

test('2API Key：签发后保护立即生效，且与上游 Key 各自独立', async () => {
  const upstream = await startCatalogUpstream();
  const proxy = await startProxy({
    upstreamPort: upstream.port,
    env: { ...BASE_ENV, CC_API_KEY: CATALOG_KEY, CC_USE_PROVIDER_MODELS: 'true' },
  });
  const CHAT = { model: 'deepseek/deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] };
  try {
    const api = await authed(proxy);

    // 未签发前：透传模式，客户端带自己的上游 Key
    const passthrough = await proxy.post('/v1/chat/completions', CHAT, { Authorization: `Bearer ${CATALOG_KEY}` });
    assert.equal(passthrough.status, 200, '未签发 2API Key 时应是透传模式');
    assert.equal(upstream.lastGenerate().headers.authorization, `Bearer ${CATALOG_KEY}`);

    // 签发一个 2API Key（留空即自动生成）
    const created = await api.post('/apikeys', { label: '测试客户端' });
    assert.equal(created.status, 200);
    const createdBody = await created.json();
    const plain = createdBody.data.plainKey;
    const id = createdBody.data.key.id;
    assert.match(plain, /^ccp_/, '2API Key 用 ccp_ 前缀，与上游 user_ 一眼可分');
    assert.equal(createdBody.data.generated, true);
    assert.match(createdBody.message, /复制/);

    // 保护立即生效（无需重启）
    assert.equal((await proxy.post('/v1/chat/completions', CHAT)).status, 401, '无凭证必须 401');

    // 用 2API Key 调用 → 通过；上游拿到的是池里的 user_ Key，绝不是这个 2API Key
    const viaApiKey = await proxy.post('/v1/chat/completions', CHAT, { Authorization: `Bearer ${plain}` });
    assert.equal(viaApiKey.status, 200);
    const sentAuth = upstream.lastGenerate().headers.authorization;
    assert.equal(sentAuth, `Bearer ${CATALOG_KEY}`, '上游凭证应来自上游 Key 池');
    assert.ok(!sentAuth.includes(plain), '2API Key 绝不能透传给上游');

    // x-api-key 路径同样接受（Anthropic SDK 风格）
    const viaXApiKey = await proxy.post('/v1/messages',
      { model: 'claude-sonnet-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
      { 'x-api-key': plain });
    assert.equal(viaXApiKey.status, 200);

    // 把上游 Key 当客户端凭证用 → 401，并明确告诉他该用哪个
    const wrongKind = await proxy.post('/v1/chat/completions', CHAT, { Authorization: `Bearer ${CATALOG_KEY}` });
    assert.equal(wrongKind.status, 401);
    assert.match((await wrongKind.json()).error.message, /2API key/,
      '误用上游 Key 时必须给出可操作的提示');

    // 列表脱敏 + reveal
    const listed = (await (await api.get('/apikeys')).json()).data;
    const item = listed.keys.find(k => k.id === id);
    assert.ok(!JSON.stringify(item).includes(plain), '列表里不能出现明文');
    assert.match(item.keyMasked, /^ccp_/);
    assert.equal(listed.counts.total, 1);
    assert.equal((await (await api.post('/apikeys/reveal', { id })).json()).data.key, plain);

    // 禁用 → 立即失效；且**不会**因此退回免鉴权（那是危险方向）
    await api.post('/apikeys/update', { id, enabled: false });
    assert.equal((await proxy.post('/v1/chat/completions', CHAT, { Authorization: `Bearer ${plain}` })).status, 401);
    assert.equal((await proxy.post('/v1/chat/completions', CHAT)).status, 401,
      '禁用最后一个 2API Key 不能变成免鉴权');

    // 重新启用 → 恢复
    await api.post('/apikeys/update', { id, enabled: true });
    assert.equal((await proxy.post('/v1/chat/completions', CHAT, { Authorization: `Bearer ${plain}` })).status, 200);

    // 删光 → 回到透传模式（这是"关掉访问保护"的正规做法）
    assert.equal((await api.post('/apikeys/delete', { id })).status, 200);
    const back = await proxy.post('/v1/chat/completions', CHAT, { Authorization: `Bearer ${CATALOG_KEY}` });
    assert.equal(back.status, 200, '删光 2API Key 后应回到透传模式');
  } finally { await proxy.kill(); await upstream.close(); }
});

test('2API Key：前缀校验、重复校验、请求计数、与 proxyKey 并存', async () => {
  const upstream = await startCatalogUpstream();
  const proxy = await startProxy({
    upstreamPort: upstream.port,
    env: { ...BASE_ENV, CC_API_KEY: CATALOG_KEY, CC_USE_PROVIDER_MODELS: 'true', PROXY_KEY: 'legacy-single-password' },
  });
  const CHAT = { model: 'deepseek/deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] };
  try {
    const api = await authed(proxy);

    // 自定义 Key 必须以 ccp_ 开头；把上游 Key 传进来要给出明确指引
    const badPrefix = await api.post('/apikeys', { key: CATALOG_KEY });
    assert.equal(badPrefix.status, 400);
    const badPrefixBody = await badPrefix.json();
    assert.match(badPrefixBody.error, /ccp_/);
    assert.match(badPrefixBody.error, /上游/);

    const tooShort = await api.post('/apikeys', { key: 'ccp_x' });
    assert.equal(tooShort.status, 400);

    // 正常自定义
    const custom = 'ccp_custom0000000000000000000000';
    const okCreate = await api.post('/apikeys', { key: custom, label: '自定义' });
    assert.equal(okCreate.status, 200);
    assert.equal((await okCreate.json()).data.generated, false);

    // 重复
    const dup = await api.post('/apikeys', { key: custom });
    assert.equal(dup.status, 400);
    assert.match((await dup.json()).error, /已存在/);

    // 旧 proxyKey 仍然可用（兼容已部署配置）
    assert.equal((await proxy.post('/v1/chat/completions', CHAT, { Authorization: 'Bearer legacy-single-password' })).status, 200);
    // 2API Key 也可以用
    assert.equal((await proxy.post('/v1/chat/completions', CHAT, { Authorization: `Bearer ${custom}` })).status, 200);

    // 请求计数与最后使用时间
    const listed = (await (await api.get('/apikeys')).json()).data;
    const item = listed.keys.find(k => k.label === '自定义');
    assert.ok(item.requests >= 1, `应记录请求数，实际 ${item.requests}`);
    assert.ok(item.lastUsedAt, '应记录最后使用时间');
    assert.equal(listed.proxyKeySet, true, '应告知前端还有 proxyKey 存在');
    assert.equal(listed.protectionEnabled, true);
  } finally { await proxy.kill(); await upstream.close(); }
});

test('2API Key 持久化：重启后仍然有效', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'ccp-apikeys-'));
  seedConfig(workdir);
  const upstream = await startCatalogUpstream();
  const env = { ...BASE_ENV, CC_API_KEY: CATALOG_KEY, CC_USE_PROVIDER_MODELS: 'true' };
  const CHAT = { model: 'deepseek/deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] };

  let plain;
  const proxy1 = await startProxy({ upstreamPort: upstream.port, env, cwd: workdir });
  try {
    const api = await authed(proxy1);
    const created = await api.post('/apikeys', { label: '长期客户端' });
    plain = (await created.json()).data.plainKey;
  } finally { await proxy1.kill(); }

  assert.ok(existsSync(join(workdir, 'data', 'api-keys.json')), '2API Key 应单独落盘 api-keys.json');

  const proxy2 = await startProxy({ upstreamPort: upstream.port, env, cwd: workdir });
  try {
    assert.equal((await proxy2.post('/v1/chat/completions', CHAT, { Authorization: `Bearer ${plain}` })).status, 200,
      '重启后该 2API Key 仍应可用');
    assert.equal((await proxy2.post('/v1/chat/completions', CHAT)).status, 401, '重启后保护仍在');
  } finally {
    await proxy2.kill();
    await upstream.close();
    rmSync(workdir, { recursive: true, force: true });
  }
});

// ── ⑩b 模型启用/禁用 ────────────────────────────────

test('模型启用/禁用：列表带状态、单条与批量切换、全选、参数校验', async () => {
  const upstream = await startCatalogUpstream();
  const proxy = await startProxy({
    upstreamPort: upstream.port,
    env: { ...BASE_ENV, CC_API_KEY: CATALOG_KEY, CC_USE_PROVIDER_MODELS: 'true' },
  });
  try {
    const api = await authed(proxy);
    const first = (await (await api.get('/models')).json()).data;
    assert.equal(first.models.length, 2);
    assert.ok(first.models.every(m => m.enabled === true), '默认应全部启用');
    assert.deepEqual(first.counts, { total: 2, enabled: 2, disabled: 0 });

    const [m1, m2] = first.models.map(m => m.id);

    // 单条禁用
    const dis = await api.post('/models/disable', { ids: [m1] });
    assert.equal(dis.status, 200);
    const disBody = await dis.json();
    assert.deepEqual(disBody.data.changed, [m1]);
    assert.deepEqual(disBody.data.counts, { total: 2, enabled: 1, disabled: 1 });

    const after = (await (await api.get('/models')).json()).data;
    assert.equal(after.models.find(m => m.id === m1).enabled, false);
    assert.equal(after.models.find(m => m.id === m2).enabled, true);

    // 重复禁用 → changed 为空，而不是报错
    const again = await api.post('/models/disable', { ids: [m1] });
    assert.deepEqual((await again.json()).data.changed, []);

    // 批量：全选禁用
    const all = await api.post('/models/disable', { all: true });
    assert.equal(all.status, 200);
    assert.deepEqual((await all.json()).data.counts, { total: 2, enabled: 0, disabled: 2 });

    // 全选启用
    const allOn = await api.post('/models/enable', { all: true });
    assert.deepEqual((await allOn.json()).data.counts, { total: 2, enabled: 2, disabled: 0 });

    // 参数校验
    assert.equal((await api.post('/models/disable', {})).status, 400, '既没 ids 也没 all 应报错');
    assert.equal((await api.post('/models/disable', { ids: [] })).status, 400);
    const unknown = await api.post('/models/disable', { ids: ['no/such-model'] });
    assert.equal(unknown.status, 400);
    assert.match((await unknown.json()).error, /不在目录中/);
  } finally { await proxy.kill(); await upstream.close(); }
});

test('禁用模型对数据面真的生效：/v1/models 不返回，指名调用被 400 拒绝', async () => {
  const upstream = await startCatalogUpstream();
  const proxy = await startProxy({
    upstreamPort: upstream.port,
    env: { ...BASE_ENV, CC_API_KEY: CATALOG_KEY, CC_USE_PROVIDER_MODELS: 'true' },
  });
  const H = { Authorization: `Bearer ${CATALOG_KEY}` };
  const CHAT = (model) => ({ model, messages: [{ role: 'user', content: 'hi' }] });
  try {
    const api = await authed(proxy);
    const first = (await (await api.get('/models')).json()).data;
    const [m1, m2] = first.models.map(m => m.id);

    // 先用一下，确认正常情况下数据面是通的
    const before = await proxy.post('/v1/chat/completions', CHAT(m1), H);
    assert.equal(before.status, 200, '正常情况下应能调用');

    // 禁用它
    await api.post('/models/disable', { ids: [m1] });

    // /v1/models 不再返回它
    const listed = await (await proxy.get('/v1/models')).json();
    const ids = listed.data.map(m => m.id);
    assert.ok(!ids.includes(m1), '被禁用的模型不应出现在 /v1/models');
    assert.ok(ids.includes(m2), '未禁用的模型应照常出现');

    // 直接指名调用 → 400 且说明原因（只在列表里隐藏是不够的）
    const blocked = await proxy.post('/v1/chat/completions', CHAT(m1), H);
    assert.equal(blocked.status, 400);
    const errBody = await blocked.json();
    assert.match(errBody.error.message, /被禁用/);
    assert.equal(errBody.error.type, 'invalid_request_error');
    assert.equal(upstream.generateCount(), 1, '被拒绝的请求不应打到上游');

    // Anthropic 与 Responses 两条路径同样拦截
    const anthropicBlocked = await proxy.post('/v1/messages', { model: m1, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }, { 'x-api-key': CATALOG_KEY });
    assert.equal(anthropicBlocked.status, 400);
    const responsesBlocked = await proxy.post('/v1/responses', { model: m1, input: 'hi' }, H);
    assert.equal(responsesBlocked.status, 400);

    // 重新启用 → 恢复
    await api.post('/models/enable', { ids: [m1] });
    assert.equal((await proxy.post('/v1/chat/completions', CHAT(m1), H)).status, 200);
    const relisted = await (await proxy.get('/v1/models')).json();
    assert.ok(relisted.data.map(m => m.id).includes(m1), '重新启用后应回到列表');

    // 未在目录中的模型仍照旧透传（目录可能过期，不能因此拦下来）
    assert.equal((await proxy.post('/v1/chat/completions', CHAT('some/unlisted-model'), H)).status, 200);
  } finally { await proxy.kill(); await upstream.close(); }
});

test('模型启用状态持久化：重启后仍然有效', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'ccp-mstate-'));
  seedConfig(workdir);
  const upstream = await startCatalogUpstream();
  const env = { ...BASE_ENV, CC_API_KEY: CATALOG_KEY, CC_USE_PROVIDER_MODELS: 'true' };

  const proxy1 = await startProxy({ upstreamPort: upstream.port, env, cwd: workdir });
  let disabledId;
  try {
    const api = await authed(proxy1);
    const first = (await (await api.get('/models')).json()).data;
    disabledId = first.models[0].id;
    await api.post('/models/disable', { ids: [disabledId] });
  } finally { await proxy1.kill(); }

  assert.ok(existsSync(join(workdir, 'data', 'models.json')), '禁用状态应落盘 data/models.json');

  const proxy2 = await startProxy({ upstreamPort: upstream.port, env, cwd: workdir });
  try {
    const api = await authed(proxy2);
    const after = (await (await api.get('/models')).json()).data;
    assert.equal(after.models.find(m => m.id === disabledId).enabled, false, '重启后仍应保持禁用');
    assert.equal(after.counts.disabled, 1);

    // 数据面同样生效
    const blocked = await proxy2.post('/v1/chat/completions',
      { model: disabledId, messages: [{ role: 'user', content: 'hi' }] },
      { Authorization: `Bearer ${CATALOG_KEY}` });
    assert.equal(blocked.status, 400);
  } finally {
    await proxy2.kill();
    await upstream.close();
    rmSync(workdir, { recursive: true, force: true });
  }
});

test('同步上游模型会报告新增与移除', async () => {
  const models = [
    { id: 'model-a', name: 'A', context_length: 1000, supported_endpoints: ['/chat/completions'] },
    { id: 'model-b', name: 'B', context_length: 2000, supported_endpoints: ['/chat/completions'] },
  ];
  const upstream = await startCatalogUpstream({ models });
  const proxy = await startProxy({
    upstreamPort: upstream.port,
    env: { ...BASE_ENV, CC_API_KEY: CATALOG_KEY, CC_USE_PROVIDER_MODELS: 'true' },
  });
  try {
    const api = await authed(proxy);
    await api.get('/models');

    // 上游目录变化：去掉 A，加入 C
    models.splice(0, 1);
    models.push({ id: 'model-c', name: 'C', context_length: 3000, supported_endpoints: ['/chat/completions'] });

    const res = await api.post('/models/refresh', {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.data.added, ['model-c']);
    assert.deepEqual(body.data.removed, ['model-a']);
    assert.equal(body.data.count, 2);
    assert.match(body.message, /新增 1/);
    assert.match(body.message, /移除 1/);
  } finally { await proxy.kill(); await upstream.close(); }
});

// ── ⑪ 配置持久化（Docker 单文件挂载下最容易坏的一环）──────────
//
// 背景：Docker 里 config.json 是**单文件 bind mount**，而原子写是「临时文件 + rename」。
// 单文件挂载点上 rename 会直接 EBUSY，改动只进内存、宿主文件纹丝不动，容器重建即丢失。
// 因此后台的修改写进 data/settings.json（目录挂载，rename 正常）。

test('设置改动写入 data/settings.json（而不是 config.json），且重启后仍在', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'ccp-persist-'));
  seedConfig(workdir);
  const cfgBefore = readFileSync(join(workdir, 'config.json'), 'utf-8');
  const upstream = await startCatalogUpstream();
  const env = { ...BASE_ENV, CC_API_KEY: CATALOG_KEY, CC_USE_PROVIDER_MODELS: 'true' };

  const proxy1 = await startProxy({ upstreamPort: upstream.port, env, cwd: workdir });
  try {
    const api = await authed(proxy1);
    await api.get('/models');
    const r = await api.post('/config/update', { strategy: 'random', projectSlug: 'from-panel' });
    assert.equal(r.status, 200);
    assert.match((await r.json()).message || '', /settings\.json/, '响应应说明落在了哪里');
  } finally { await proxy1.kill(); }

  // 落在 data/settings.json，且只写了改动的字段
  const settingsPath = join(workdir, 'data', 'settings.json');
  assert.ok(existsSync(settingsPath), '应生成 data/settings.json');
  const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  assert.equal(settings.strategy, 'random');
  assert.equal(settings.projectSlug, 'from-panel');
  assert.equal(settings.apiBase, undefined, '只写被改动的字段，不该整份复制');

  // config.json 必须原封不动（它是部署期输入，不该被后台改写）
  assert.equal(readFileSync(join(workdir, 'config.json'), 'utf-8'), cfgBefore,
    'config.json 不应被后台修改');

  // 重启（同一工作目录）后设置仍在
  const proxy2 = await startProxy({ upstreamPort: upstream.port, env, cwd: workdir });
  try {
    const api = await authed(proxy2);
    const cfg = (await (await api.get('/config')).json()).data;
    assert.equal(cfg.strategy, 'random', '重启后设置必须还在');
    assert.equal(cfg.projectSlug, 'from-panel');
    assert.equal(cfg.settingSources.strategy, 'settings', '应标明该值来自后台设置');
    assert.match(cfg.settingsPath, /settings\.json$/);
  } finally {
    await proxy2.kill();
    await upstream.close();
    rmSync(workdir, { recursive: true, force: true });
  }
});

test('配置分层优先级：环境变量 > data/settings.json > config.json', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'ccp-layer-'));
  const upstream = await startCatalogUpstream();
  // config.json 层：预置 logLevel 与 projectSlug，作为最底层输入
  seedConfig(workdir, { logLevel: 'warn', projectSlug: 'from-config' });

  const proxy = await startProxy({
    upstreamPort: upstream.port,
    env: { ...BASE_ENV, CC_API_KEY: CATALOG_KEY, CC_USE_PROVIDER_MODELS: 'true' },
    cwd: workdir,
  });
  try {
    const api = await authed(proxy);
    const c0 = (await (await api.get('/config')).json()).data;
    assert.equal(c0.logLevel, 'warn', 'config.json 的值应生效');
    assert.equal(c0.settingSources.logLevel, 'config');

    // 后台改 logLevel → settings 层应压过 config 层
    await api.post('/config/update', { logLevel: 'info' });
    const c1 = (await (await api.get('/config')).json()).data;
    assert.equal(c1.logLevel, 'info');
    assert.equal(c1.settingSources.logLevel, 'settings', '后台设置应压过 config.json');

    // 未被子层覆盖的字段仍听 config.json
    assert.equal(c1.projectSlug, 'from-config', '后台没碰过的字段仍来自 config.json');
  } finally { await proxy.kill(); }

  // 环境变量层最高：即便 settings.json 里写了，也被环境变量压住并明确告知
  const proxy2 = await startProxy({
    upstreamPort: upstream.port,
    env: { ...BASE_ENV, CC_API_KEY: CATALOG_KEY, CC_USE_PROVIDER_MODELS: 'true', CC_LOG_LEVEL: 'error' },
    cwd: workdir,
  });
  try {
    const api = await authed(proxy2);
    const c2 = (await (await api.get('/config')).json()).data;
    assert.equal(c2.logLevel, 'error', '环境变量必须压过 settings.json');
    assert.equal(c2.settingSources.logLevel, 'env');
    assert.ok(c2.envLocked.includes('logLevel'), '应把 logLevel 标为环境变量锁定');

    const r = await api.post('/config/update', { logLevel: 'debug' });
    const body = await r.json();
    assert.match(body.message || '', /环境变量锁定/, '后台改被锁字段时必须明确提示');
    assert.equal(body.data.logLevel, 'error', '被锁字段的值不应被改掉');
  } finally {
    await proxy2.kill();
    await upstream.close();
    rmSync(workdir, { recursive: true, force: true });
  }
});

test('设置提交整份表单时只落盘真正变化的字段（避免 settings.json 变成整份快照）', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'ccp-diff-'));
  seedConfig(workdir);
  const upstream = await startCatalogUpstream();
  const proxy = await startProxy({
    upstreamPort: upstream.port,
    env: { ...BASE_ENV, CC_API_KEY: CATALOG_KEY, CC_USE_PROVIDER_MODELS: 'true' },
    cwd: workdir,
  });
  try {
    const api = await authed(proxy);
    await api.get('/models');
    const cfg = (await (await api.get('/config')).json()).data;

    // 1) 原样回提交整份表单（字段都没变）→ 不应产生落盘
    const noop = await api.post('/config/update', {
      strategy: cfg.strategy,
      defaultModel: cfg.defaultModel,
      zdr: cfg.zdr,
      upstreamProxy: cfg.upstreamProxy,
      logLevel: cfg.logLevel,
      logFile: cfg.logFile,
      apiBase: cfg.apiBase,
      projectSlug: cfg.projectSlug,
    });
    assert.equal(noop.status, 200);
    assert.ok(!/已保存到 data\/settings\.json/.test((await noop.json()).message || ''),
      '没有任何字段变化时不应声称已保存');
    assert.ok(!existsSync(join(workdir, 'data', 'settings.json')),
      '没有任何字段变化时不该写出 settings.json');

    // 2) 只改一个字段 → settings.json 只应包含这一个
    await api.post('/config/update', {
      strategy: 'fill',
      defaultModel: cfg.defaultModel,
      zdr: cfg.zdr,
      logLevel: cfg.logLevel,
      apiBase: cfg.apiBase,
      projectSlug: cfg.projectSlug,
    });
    const settings = JSON.parse(readFileSync(join(workdir, 'data', 'settings.json'), 'utf-8'));
    assert.deepEqual(Object.keys(settings), ['strategy'], '只落盘真正变化的字段');
    assert.equal(settings.strategy, 'fill');
  } finally {
    await proxy.kill();
    await upstream.close();
    rmSync(workdir, { recursive: true, force: true });
  }
});

// ── ⑫ 日志 ───────────────────────────────────────────

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
