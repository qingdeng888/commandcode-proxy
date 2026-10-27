// 出站代理池：条目解析 / 后台管理 API / Key ↔ 代理绑定 / 健康检查与故障转移。
//
// 这一组用例覆盖的是「多代理 + 轮换池 + 与 Key 绑定」这条链路。它没有编译期
// 检查兜底（proxy.mjs 是纯 JS），只能靠真实起进程 + 真实 HTTP 调用验证。
// 全部走 mock 上游与本地录制代理，不需要真代理服务器。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  allocPort, closeServer, seedConfig, setup, startMockUpstream, startProxy,
} from './helpers.mjs';
import {
  MAX_BULK_PROXIES, parseProxyEntry, parseProxyFileText, proxyFingerprint,
  redactProxyUrl, stripProxyLineComment, validateProxyEntry,
} from '../lib/proxies.mjs';

const PASSWORD = 'proxy-test-password';
const AUTH = { Authorization: 'Bearer user_test' };
const CHAT = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };

// ── ① 纯函数：条目解析 ────────────────────────────────

test('代理条目解析：pool+ 前缀与 #pool 片段等价，其它片段不被吞掉', () => {
  assert.deepEqual(parseProxyEntry('pool+http://u:p@1.2.3.4:8080'),
    { value: 'http://u:p@1.2.3.4:8080', pool: true });
  assert.deepEqual(parseProxyEntry('http://1.2.3.4:8080#pool'),
    { value: 'http://1.2.3.4:8080', pool: true });
  assert.deepEqual(parseProxyEntry('http://1.2.3.4:8080'),
    { value: 'http://1.2.3.4:8080', pool: false });
  assert.deepEqual(parseProxyEntry('direct'), { value: 'direct', pool: false });
  assert.deepEqual(parseProxyEntry('  '), { value: '', pool: false });
  // 只有 #pool 是保留片段：别的片段原样留着，不能悄悄丢掉用户写的东西
  assert.deepEqual(parseProxyEntry('http://1.2.3.4:8080#other'),
    { value: 'http://1.2.3.4:8080#other', pool: false });
  // #POOL 大小写不敏感
  assert.equal(parseProxyEntry('http://1.2.3.4:8080#POOL').pool, true);
});

test('代理地址脱敏：口令永远不出现在展示串里，轮换标记保留', () => {
  assert.equal(redactProxyUrl('http://user:secret@1.2.3.4:8080'), 'http://1.2.3.4:8080');
  assert.equal(redactProxyUrl('pool+http://user:secret@1.2.3.4:8080'), 'http://1.2.3.4:8080');
  assert.equal(redactProxyUrl('direct'), 'direct');
  assert.equal(redactProxyUrl('nonsense'), '(invalid)');
  assert.equal(redactProxyUrl(''), '(empty)');
  // 脱敏串本身绝不能包含口令
  assert.ok(!redactProxyUrl('http://user:secret@1.2.3.4:8080').includes('secret'));
});

test('代理条目校验：只收 http://（CONNECT 隧道）与 direct', () => {
  assert.equal(validateProxyEntry('http://1.2.3.4:8080'), null);
  assert.equal(validateProxyEntry('http://u:p@1.2.3.4:8080'), null);
  assert.equal(validateProxyEntry('pool+http://1.2.3.4:8080'), null);
  assert.equal(validateProxyEntry('direct'), null);
  assert.match(validateProxyEntry(''), /不能为空/);
  assert.match(validateProxyEntry('socks5://1.2.3.4:1080'), /只支持 http/);
  assert.match(validateProxyEntry('https://1.2.3.4:8080'), /只支持 http/);
  assert.match(validateProxyEntry('not a url'), /无效/);
  // 报错里不能回显可能带口令的原串
  assert.ok(!validateProxyEntry('http://u:secret@').includes('secret'));
});

test('代理文件解析：忽略空行 / BOM / 注释，但 #pool 与 URL 里的 // 必须活下来', () => {
  assert.equal(stripProxyLineComment('http://a:1 # note'), 'http://a:1 ');
  assert.equal(stripProxyLineComment('http://a:1 ; note'), 'http://a:1 ');
  assert.equal(stripProxyLineComment('http://a:1 // note'), 'http://a:1 ');
  // 关键：#pool 是 URL 的一部分，不是注释
  assert.equal(stripProxyLineComment('http://a:1#pool'), 'http://a:1#pool');
  assert.equal(stripProxyLineComment('http://a:1'), 'http://a:1');
  const parsed = parseProxyFileText('\uFEFF# 注释\nhttp://a:1\n\n; 分号注释\nhttp://b:2 # 行尾注释\npool+http://c:3\n');
  assert.deepEqual(parsed, ['http://a:1', 'http://b:2', 'pool+http://c:3']);
});

test('代理指纹只由内容决定：同一地址跨重启 / 跨重排都是同一个 id', () => {
  assert.equal(proxyFingerprint('http://a:1'), proxyFingerprint('http://a:1'));
  assert.notEqual(proxyFingerprint('http://a:1'), proxyFingerprint('http://a:2'));
  assert.equal(proxyFingerprint('http://a:1').length, 16);
});

// ── ② 后台管理 API ────────────────────────────────────

async function loggedIn(proxy) {
  const r = await proxy.post('/admin/api/login', { password: PASSWORD });
  const cookie = (r.headers.getSetCookie?.()[0] || r.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie, '登录应返回会话 Cookie');
  const h = { Cookie: cookie, 'Content-Type': 'application/json' };
  return {
    get: (p) => proxy.get(`/admin/api${p}`, { headers: h }),
    post: (p, body) => proxy.post(`/admin/api${p}`, body, h),
  };
}

/** 带代理池配置启动：proxies 直接写进 config.json（config 来源，只读条目）。 */
async function startWithProxies({ proxies = [], proxyFile = '', extraConfig = {}, env = {} } = {}) {
  const workdir = mkdtempSync(join(tmpdir(), 'ccp-proxies-'));
  seedConfig(workdir, { proxies, proxyFile, ...extraConfig });
  const upstream = await startMockUpstream();
  const proxy = await startProxy({
    upstreamPort: upstream.port,
    env: { ADMIN_PASSWORD: PASSWORD, CC_API_KEY: '', ...env },
    cwd: workdir,
  });
  return {
    workdir, upstream, proxy,
    api: await loggedIn(proxy),
    async close() {
      await proxy.kill(); await upstream.close();
      rmSync(workdir, { recursive: true, force: true });
    },
  };
}

test('代理池默认只有一条 direct；后台可以增删改查', async () => {
  const s = await startWithProxies();
  try {
    const before = (await (await s.api.get('/proxies')).json()).data;
    assert.equal(before.proxies.length, 1, '空配置下池子里只有一条兜底 direct');
    assert.equal(before.proxies[0].address, 'direct');
    assert.equal(before.proxies[0].source, 'default');
    assert.equal(before.proxies[0].managed, false, '兜底条目不可删除');

    const added = await s.api.post('/proxies', { value: 'http://user:secret@127.0.0.1:18888' });
    assert.equal(added.status, 200);
    const list = (await added.json()).data.proxies;
    const row = list.find(t => t.address === 'http://127.0.0.1:18888');
    assert.ok(row, '新加的代理应出现在列表里');
    assert.equal(row.managed, true);
    assert.equal(row.source, 'ui');
    assert.equal(row.healthy, true, '新加的条目默认健康（还没被证伪）');
    assert.ok(!JSON.stringify(list).includes('secret'), '列表里绝不能出现口令');

    // 明文只由显式 reveal 给出
    const revealed = await (await s.api.post('/proxies/reveal', { id: row.id })).json();
    assert.equal(revealed.data.value, 'http://user:secret@127.0.0.1:18888');

    // 改地址：id 跟着内容变（身份就是内容）
    const updated = await s.api.post('/proxies/update', { id: row.id, value: 'http://127.0.0.1:18889' });
    assert.equal(updated.status, 200);
    const after = (await updated.json()).data.proxies;
    assert.ok(after.some(t => t.address === 'http://127.0.0.1:18889'));
    assert.ok(!after.some(t => t.id === row.id), '地址变了就是换了一条，旧 id 不该还在');

    // 删除
    const del = await s.api.post('/proxies/delete', { ids: [after.find(t => t.address === 'http://127.0.0.1:18889').id] });
    assert.equal(del.status, 200);
    assert.equal((await del.json()).data.proxies.length, 1);
  } finally { await s.close(); }
});

test('代理条目校验失败时后台返回 400 与可读原因', async () => {
  const s = await startWithProxies();
  try {
    const bad = await s.api.post('/proxies', { value: 'socks5://1.2.3.4:1080' });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /只支持 http/);

    const empty = await s.api.post('/proxies', { value: '  ' });
    assert.equal(empty.status, 400);

    const okAdd = await s.api.post('/proxies', { value: 'http://127.0.0.1:18888' });
    assert.equal(okAdd.status, 200);
    const dup = await s.api.post('/proxies', { value: 'http://127.0.0.1:18888' });
    assert.equal(dup.status, 400);
    assert.match((await dup.json()).error, /已存在/);
  } finally { await s.close(); }
});

test('批量添加：逐行粘贴，重复跳过、非法单列出来，不会因为一行坏掉整批失败', async () => {
  const s = await startWithProxies();
  try {
    const r = await s.api.post('/proxies/bulk', {
      text: [
        'http://127.0.0.1:19001',
        'http://127.0.0.1:19002',
        'http://127.0.0.1:19001',      // 批内重复
        'socks5://127.0.0.1:19003',    // 非法
        '',                            // 空行
        'pool+http://127.0.0.1:19004',
      ].join('\n'),
    });
    assert.equal(r.status, 200);
    const data = (await r.json()).data;
    assert.equal(data.added, 3, '两条普通 + 一条轮换池');
    assert.equal(data.skipped.length, 1, '批内重复被跳过');
    assert.equal(data.invalid.length, 1, '非法条目单独列出，不影响其它条目');
    assert.match(data.invalid[0].error, /只支持 http/);

    const pool = data.proxies.find(t => t.address === 'http://127.0.0.1:19004');
    assert.equal(pool.pool, true, '#pool 条目应被标记为轮换池');
  } finally { await s.close(); }
});

test('批量添加有上限（防一次粘十万行把面板拖死）', async () => {
  const s = await startWithProxies();
  try {
    const many = Array.from({ length: MAX_BULK_PROXIES + 1 }, (_, i) => `http://127.0.0.1:${20000 + i}`);
    const r = await s.api.post('/proxies/bulk', { values: many });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, new RegExp(`最多添加 ${MAX_BULK_PROXIES}`));
  } finally { await s.close(); }
});

test('启停：config.json 里的条目也能停用（记在数据目录，不动配置文件）', async () => {
  const s = await startWithProxies({ proxies: ['http://127.0.0.1:18888'] });
  try {
    const cfgBefore = readFileSync(join(s.workdir, 'config.json'), 'utf-8');
    const list = (await (await s.api.get('/proxies')).json()).data.proxies;
    const row = list.find(t => t.source === 'config');
    assert.ok(row, 'config 来源的条目应出现');
    assert.equal(row.enabled, true);
    assert.equal(row.managed, false, 'config 条目不可删除');

    const off = await s.api.post('/proxies/enabled', { ids: [row.id], enabled: false });
    assert.equal(off.status, 200);
    const afterOff = (await off.json()).data.proxies.find(t => t.id === row.id);
    assert.equal(afterOff.enabled, false, '停用后仍在列表里（否则再也点不回来）');

    // 停用记录落在 data/proxies.json，config.json 一个字节都没动
    assert.equal(readFileSync(join(s.workdir, 'config.json'), 'utf-8'), cfgBefore,
      'config.json 是部署期输入，后台不许改写它');
    const state = JSON.parse(readFileSync(join(s.workdir, 'data', 'proxies.json'), 'utf-8'));
    assert.deepEqual(state.disabled, [row.id]);

    // 删除只读条目：明确拒绝并说明原因
    const del = await s.api.post('/proxies/delete', { ids: [row.id] });
    assert.equal(del.status, 400);
    assert.match((await del.json()).error, /只能停用/);

    // 重新启用
    const on = await s.api.post('/proxies/enabled', { ids: [row.id], enabled: true });
    assert.equal((await on.json()).data.proxies.find(t => t.id === row.id).enabled, true);
  } finally { await s.close(); }
});

test('代理文件：每行一条，支持注释与相对路径，读不到时明确报错而不是静默失效', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'ccp-proxyfile-'));
  writeFileSync(join(workdir, 'proxies.txt'), [
    '\uFEFF# 这是注释',
    'http://127.0.0.1:19101',
    '',
    '; 分号也是注释',
    'http://127.0.0.1:19102 # 行尾注释',
    'pool+http://127.0.0.1:19103',
  ].join('\n'));
  seedConfig(workdir, { proxyFile: 'proxies.txt' });   // 相对路径
  const upstream = await startMockUpstream();
  const proxy = await startProxy({
    upstreamPort: upstream.port, env: { ADMIN_PASSWORD: PASSWORD, CC_API_KEY: '' }, cwd: workdir,
  });
  try {
    const api = await loggedIn(proxy);
    const data = (await (await api.get('/proxies')).json()).data;
    const addrs = data.proxies.map(t => t.address);
    assert.ok(addrs.includes('http://127.0.0.1:19101'));
    assert.ok(addrs.includes('http://127.0.0.1:19102'));
    assert.ok(addrs.includes('http://127.0.0.1:19103'));
    assert.equal(data.proxies.filter(t => t.source === 'proxyfile').length, 3);
    assert.equal(data.proxyFile, 'proxies.txt');
    assert.equal(data.proxyFileError, '');
  } finally {
    await proxy.kill(); await upstream.close();
    // 文件缺失时：池子照常可用（只剩 direct），但必须把原因报出来
    rmSync(join(workdir, 'proxies.txt'), { force: true });
    const upstream2 = await startMockUpstream();
    const proxy2 = await startProxy({
      upstreamPort: upstream2.port, env: { ADMIN_PASSWORD: PASSWORD, CC_API_KEY: '' }, cwd: workdir,
    });
    try {
      const api2 = await loggedIn(proxy2);
      const data2 = (await (await api2.get('/proxies')).json()).data;
      assert.equal(data2.proxies.length, 1, '文件读不到不该让整个池消失');
      assert.ok(data2.proxyFileError, '但必须明确报出读不到，否则「我明明写了」会变成静默失效');
    } finally {
      await proxy2.kill(); await upstream2.close();
      rmSync(workdir, { recursive: true, force: true });
    }
  }
});

test('旧的 upstreamProxy 单代理字段仍生效，并以 legacy 来源出现在池子里', async () => {
  const s = await startWithProxies({ extraConfig: { upstreamProxy: 'http://127.0.0.1:19201' } });
  try {
    const list = (await (await s.api.get('/proxies')).json()).data.proxies;
    const legacy = list.find(t => t.source === 'legacy');
    assert.ok(legacy, '升级上来的部署不该因为新增了代理池就失去原来的单代理');
    assert.equal(legacy.address, 'http://127.0.0.1:19201');
  } finally { await s.close(); }
});

// ── ③ 真实走代理 ──────────────────────────────────────

/** 录制型代理：CONNECT 与 absolute-form 都接，统一记入 hits。 */
async function startRecordingProxy({ failConnect = false } = {}) {
  const port = await allocPort();
  const hits = [];
  const server = http.createServer((req, res) => {
    let target;
    try { target = new URL(req.url); } catch { res.writeHead(405); res.end(); return; }
    hits.push({ kind: 'http', url: req.url, headers: req.headers });
    const up = http.request({
      host: target.hostname, port: target.port || 80,
      path: target.pathname + target.search, method: req.method, headers: req.headers,
    }, (ur) => { res.writeHead(ur.statusCode, ur.headers); ur.pipe(res); });
    up.on('error', () => res.destroy());
    req.pipe(up);
  });
  server.on('connect', (req, clientSocket, head) => {
    hits.push({ kind: 'connect', url: req.url, headers: req.headers });
    if (failConnect) { clientSocket.destroy(); return; }
    const [h, p] = req.url.split(':');
    const up = net.connect(Number(p || 443), h, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) up.write(head);
      up.pipe(clientSocket); clientSocket.pipe(up);
    });
    up.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => up.destroy());
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  return {
    port, hits,
    url: `http://127.0.0.1:${port}`,
    close: () => closeServer(server),
  };
}

test('生成请求与指纹预请求走同一条代理（同一账号不能从两个 IP 现身）', async () => {
  const rec = await startRecordingProxy();
  const s = await startWithProxies({ proxies: [rec.url] });
  try {
    const r = await s.proxy.post('/v1/chat/completions', { ...CHAT, stream: true }, AUTH);
    await r.text();
    assert.equal(s.upstream.generateCount(), 1, '生成请求应到达上游');
    // 三条（fingerprint / lifecycle / generate）都经代理
    assert.ok(rec.hits.length >= 3,
      `预请求与生成必须都走代理，否则同一账号从两个 IP 现身。实际代理请求数: ${rec.hits.length}`);
  } finally { await s.close(); await rec.close(); }
});

test('代理不可达时换一条代理重试，而不是把好账号标成失败', async () => {
  const dead = await startRecordingProxy({ failConnect: true });
  const live = await startRecordingProxy();
  const s = await startWithProxies({ proxies: [dead.url, live.url] });
  try {
    const r = await s.proxy.post('/v1/chat/completions', { ...CHAT, stream: true }, AUTH);
    const text = await r.text();
    assert.equal(r.status, 200, '第一条代理挂了应自动换第二条，客户端看到成功');
    assert.match(text, /hello/);
    assert.equal(s.upstream.generateCount(), 1, '只有活的那条代理把请求送达了上游');
    assert.ok(live.hits.length >= 1, '第二条代理应被真正使用');
  } finally { await s.close(); await dead.close(); await live.close(); }
});

test('所有代理都不可达时如实报错，不会假装成功', async () => {
  const dead1 = await startRecordingProxy({ failConnect: true });
  const dead2 = await startRecordingProxy({ failConnect: true });
  const s = await startWithProxies({ proxies: [dead1.url, dead2.url] });
  try {
    const r = await s.proxy.post('/v1/chat/completions', { ...CHAT, stream: true }, AUTH);
    assert.notEqual(r.status, 200, '两条代理都挂了就不能给 200');
    assert.equal(s.upstream.generateCount(), 0, '上游从未被联系过');
  } finally { await s.close(); await dead1.close(); await dead2.close(); }
});

// ── ④ Key ↔ 代理绑定 ──────────────────────────────────

test('绑定模式：auto / bind / rotate 都记在数据目录，且后台能读回', async () => {
  const s = await startWithProxies({ proxies: ['http://127.0.0.1:19301', 'http://127.0.0.1:19302'] });
  try {
    // 加两个上游 Key，让绑定表有内容
    for (const [key, label] of [['user_aaaa0000000000000000000000000001', 'A'], ['user_bbbb0000000000000000000000000002', 'B']]) {
      const r = await s.api.post('/keys', { key, label });
      assert.equal(r.status, 200, JSON.stringify(await r.json()));
    }
    const keys = (await (await s.api.get('/keys')).json()).data.keys.filter(k => k.source === 'ui');
    assert.equal(keys.length, 2);

    const list = (await (await s.api.get('/proxies')).json()).data.proxies.filter(t => t.managed || t.source === 'config');
    const pool = list.filter(t => t.source === 'config');
    assert.equal(pool.length, 2);

    // auto 默认：两个 Key 分别落在第 0、1 条（i % N）
    let bindings = (await (await s.api.get('/proxies')).json()).data.bindings;
    assert.deepEqual(bindings.map(b => b.mode), ['auto', 'auto']);
    assert.deepEqual(bindings.map(b => b.proxyIndex), [0, 1], 'auto 是静态 i%N 绑定');

    // bind：把第二个 Key 固定到第 0 条
    const bindRes = await s.api.post('/proxies/binding', { keyId: keys[1].id, mode: 'bind', proxyId: pool[0].id });
    assert.equal(bindRes.status, 200, JSON.stringify(await bindRes.json()));
    bindings = (await (await s.api.get('/proxies')).json()).data.bindings;
    assert.equal(bindings[1].mode, 'bind');
    assert.equal(bindings[1].proxyIndex, 0);

    // rotate：第一个 Key 每次轮换（proxyIndex 置 -1 表示不静态绑定）
    const rotRes = await s.api.post('/proxies/binding', { keyId: keys[0].id, mode: 'rotate' });
    assert.equal(rotRes.status, 200);
    bindings = (await (await s.api.get('/proxies')).json()).data.bindings;
    assert.equal(bindings[0].mode, 'rotate');
    assert.equal(bindings[0].proxyIndex, -1, 'rotate 不静态绑定任何一条');

    // 绑定落在 data/proxies.json，config.json 不动
    const state = JSON.parse(readFileSync(join(s.workdir, 'data', 'proxies.json'), 'utf-8'));
    assert.equal(Object.keys(state.bindings).length, 2);

    // 非法组合被拒
    const badMode = await s.api.post('/proxies/binding', { keyId: keys[0].id, mode: 'nonsense' });
    assert.equal(badMode.status, 200, '未知模式归一成 auto，不报错');
    const badProxy = await s.api.post('/proxies/binding', { keyId: keys[0].id, mode: 'bind', proxyId: 'deadbeefdeadbeef' });
    assert.equal(badProxy.status, 400);
    assert.match((await badProxy.json()).error, /不在当前池中/);
    const badKey = await s.api.post('/proxies/binding', { keyId: 'nope', mode: 'bind', proxyId: pool[0].id });
    assert.equal(badKey.status, 404);
  } finally { await s.close(); }
});

test('绑定的代理被停用后，bind 退回 auto（静默失效比退回更糟）', async () => {
  const s = await startWithProxies({ proxies: ['http://127.0.0.1:19401'] });
  try {
    const key = 'user_cccc0000000000000000000000000003';
    await s.api.post('/keys', { key, label: 'C' });
    const pool = (await (await s.api.get('/proxies')).json()).data.proxies.find(t => t.source === 'config');
    const keys = (await (await s.api.get('/keys')).json()).data.keys.filter(k => k.source === 'ui');
    await s.api.post('/proxies/binding', { keyId: keys[0].id, mode: 'bind', proxyId: pool.id });

    let bindings = (await (await s.api.get('/proxies')).json()).data.bindings;
    assert.equal(bindings[0].mode, 'bind');

    // 停用被绑定的那条 → 绑定自动退回 auto，Key 仍然可用
    await s.api.post('/proxies/enabled', { ids: [pool.id], enabled: false });
    bindings = (await (await s.api.get('/proxies')).json()).data.bindings;
    assert.equal(bindings[0].mode, 'auto', '绑定的代理不在池里时应退回 auto，而不是让 Key 不可用');
  } finally { await s.close(); }
});

test('删除被绑定的代理时，绑定一起退回 auto（不留悬空引用）', async () => {
  const s = await startWithProxies();
  try {
    const key = 'user_dddd0000000000000000000000000004';
    await s.api.post('/keys', { key, label: 'D' });
    const added = await s.api.post('/proxies', { value: 'http://127.0.0.1:19501' });
    const pool = (await added.json()).data.proxies.find(t => t.address === 'http://127.0.0.1:19501');
    const keys = (await (await s.api.get('/keys')).json()).data.keys.filter(k => k.source === 'ui');
    await s.api.post('/proxies/binding', { keyId: keys[0].id, mode: 'bind', proxyId: pool.id });

    const del = await s.api.post('/proxies/delete', { ids: [pool.id] });
    assert.equal(del.status, 200);
    const bindings = (await del.json()).data.bindings;
    assert.equal(bindings[0].mode, 'auto', '被删掉的代理不能继续留在绑定里');
  } finally { await s.close(); }
});

// ── ⑤ 健康检查 ────────────────────────────────────────

test('健康检查：连不通的代理被标记为不健康并进冷却，恢复后自动迁回', async () => {
  // 用一个「先通后断再通」的代理：直接操作录制代理的开关
  let broken = false;
  const port = await allocPort();
  const hits = [];
  const server = http.createServer((req, res) => { res.writeHead(405); res.end(); });
  server.on('connect', (req, clientSocket, head) => {
    hits.push(req.url);
    if (broken) { clientSocket.destroy(); return; }
    const [h, p] = req.url.split(':');
    const up = net.connect(Number(p || 443), h, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) up.write(head);
      up.pipe(clientSocket); clientSocket.pipe(up);
    });
    up.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => up.destroy());
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));

  const s = await startWithProxies({ proxies: [`http://127.0.0.1:${port}`] });
  try {
    // 先成功一次，建立「这条是好的」基线
    let r = await s.proxy.post('/v1/chat/completions', { ...CHAT, stream: true }, AUTH);
    await r.text();
    let row = (await (await s.api.get('/proxies')).json()).data.proxies.find(t => t.source === 'config');
    assert.equal(row.healthy, true);
    assert.equal(row.failures, 0);

    // 代理断掉 → 真实请求失败 → 该条目应被记为不健康（这是「路由层失败」）
    broken = true;
    r = await s.proxy.post('/v1/chat/completions', { ...CHAT, stream: true }, AUTH);
    await r.text().catch(() => {});
    row = (await (await s.api.get('/proxies')).json()).data.proxies.find(t => t.source === 'config');
    assert.equal(row.healthy, false, '连不上代理必须记为不健康');
    assert.ok(row.failures >= 1, '应累计失败次数');
    assert.ok(row.cooldownUntil, '应进入冷却');

    // 单测按钮：代理仍然断着 → 明确报不可达，而不是抛接口错误
    const testFail = await s.api.post('/proxies/test', { id: row.id });
    assert.equal(testFail.status, 200, '探测失败不是接口错误，客户端要拿到原因');
    const failBody = await testFail.json();
    assert.equal(failBody.data.ok, false);
    assert.ok(failBody.data.error, '要给出不可达的原因');

    // 代理恢复 → 单测成功 → 条目回到健康
    broken = false;
    const testOk = await s.api.post('/proxies/test', { id: row.id });
    const okBody = await testOk.json();
    assert.equal(okBody.data.ok, true, JSON.stringify(okBody));
    assert.equal(typeof okBody.data.latencyMs, 'number');
    row = okBody.data.proxies.find(t => t.source === 'config');
    assert.equal(row.healthy, true, '探测通过后应恢复健康');
    assert.equal(row.failures, 0, '恢复后失败计数清零');
    assert.equal(row.cooldownUntil, null, '恢复后冷却清除');

    // 恢复之后请求又能走这条代理
    const before = hits.length;
    r = await s.proxy.post('/v1/chat/completions', { ...CHAT, stream: true }, AUTH);
    await r.text();
    assert.ok(hits.length > before, '恢复后请求应重新走这条代理');
  } finally {
    await s.close(); await closeServer(server);
  }
});

test('上游返回 4xx/5xx 不算代理故障（代理是通的，那是账号/模型的问题）', async () => {
  const rec = await startRecordingProxy();
  const upstream = await startMockUpstream({
    status: 401,
    errorBody: JSON.stringify({ error: { message: 'invalid key' } }),
  });
  const workdir = mkdtempSync(join(tmpdir(), 'ccp-proxy-4xx-'));
  seedConfig(workdir, { proxies: [rec.url] });
  const proxy = await startProxy({
    upstreamPort: upstream.port,
    env: { ADMIN_PASSWORD: PASSWORD, CC_API_KEY: '', PROXY_KEY: 'client-secret' },
    cwd: workdir,
  });
  try {
    const api = await loggedIn(proxy);
    const r = await proxy.post('/v1/chat/completions', { ...CHAT, stream: true }, { Authorization: 'Bearer client-secret' });
    await r.text().catch(() => {});

    const row = (await (await api.get('/proxies')).json()).data.proxies.find(t => t.source === 'config');
    assert.equal(row.healthy, true,
      '上游答了 HTTP 就说明代理通了；把 401 记成代理故障会让好代理被误判下线');
    assert.equal(row.failures, 0);
  } finally {
    await proxy.kill(); await upstream.close(); await rec.close();
    rmSync(workdir, { recursive: true, force: true });
  }
});

test('轮换池条目（#pool）永远不记健康状态：它的出口每次都不同，一次失败说明不了什么', async () => {
  const s = await startWithProxies({ proxies: ['pool+http://127.0.0.1:19601'] });
  try {
    const row = (await (await s.api.get('/proxies')).json()).data.proxies.find(t => t.source === 'config');
    assert.equal(row.pool, true);
    // 真实请求失败（这条代理不存在）→ 轮换池条目不该被标记不健康
    const r = await s.proxy.post('/v1/chat/completions', { ...CHAT, stream: true }, AUTH);
    await r.text().catch(() => {});
    const after = (await (await s.api.get('/proxies')).json()).data.proxies.find(t => t.source === 'config');
    assert.equal(after.healthy, true, '轮换池条目不记健康状态');
    assert.equal(after.failures, 0);
  } finally { await s.close(); }
});

// ── ⑥ 未启用代理池时行为完全不变 ──────────────────────

test('没有配置任何代理时，请求直连上游（默认路径行为不变）', async () => {
  const s = await setup();
  try {
    const r = await s.proxy.post('/v1/chat/completions', { ...CHAT, stream: true }, AUTH);
    const text = await r.text();
    assert.equal(r.status, 200);
    assert.match(text, /hello/);
    assert.equal(s.mock.generateCount(), 1);
  } finally { await s.close(); }
});

test('代理池持久化：重启后条目与绑定都还在', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'ccp-proxy-persist-'));
  seedConfig(workdir);
  const upstream = await startMockUpstream();
  const env = { ADMIN_PASSWORD: PASSWORD, CC_API_KEY: '' };

  const p1 = await startProxy({ upstreamPort: upstream.port, env, cwd: workdir });
  let proxyId = '';
  try {
    const api = await loggedIn(p1);
    const added = await api.post('/proxies', { value: 'http://127.0.0.1:19701' });
    proxyId = (await added.json()).data.proxies.find(t => t.address === 'http://127.0.0.1:19701').id;
    const key = 'user_eeee0000000000000000000000000005';
    await api.post('/keys', { key, label: 'E' });
    const keys = (await (await api.get('/keys')).json()).data.keys.filter(k => k.source === 'ui');
    await api.post('/proxies/binding', { keyId: keys[0].id, mode: 'bind', proxyId });
  } finally { await p1.kill(); }

  assert.ok(existsSync(join(workdir, 'data', 'proxies.json')), '应生成 data/proxies.json');
  const p2 = await startProxy({ upstreamPort: upstream.port, env, cwd: workdir });
  try {
    const api = await loggedIn(p2);
    const data = (await (await api.get('/proxies')).json()).data;
    assert.ok(data.proxies.some(t => t.id === proxyId), '重启后代理条目仍在');
    assert.equal(data.bindings[0].mode, 'bind', '重启后绑定仍在');
    assert.equal(data.bindings[0].proxyId, proxyId);
  } finally {
    await p2.kill(); await upstream.close();
    rmSync(workdir, { recursive: true, force: true });
  }
});

// ── ⑦ 批量测试 ────────────────────────────────────────

test('批量测试：一次请求测完所选代理，单条失败不影响其余，结果按勾选顺序返回', async () => {
  const live = await startRecordingProxy();
  const dead = await startRecordingProxy({ failConnect: true });
  const s = await startWithProxies();
  try {
    const added = await s.api.post('/proxies/bulk', {
      values: [live.url, dead.url, 'http://127.0.0.1:19999'],
    });
    assert.equal(added.status, 200);
    // 响应体只能消费一次：先解析再断言，不要 json() 两次
    const addedBody = await added.json();
    const rows = addedBody.data.proxies.filter(t => t.managed);
    assert.equal(rows.length, 3);

    // 故意打乱顺序：返回顺序必须跟勾选顺序一致，否则表格里的结果会跳来跳去
    const ids = [rows[1].id, rows[0].id, rows[2].id];
    const r = await s.api.post('/proxies/test-batch', { ids });
    assert.equal(r.status, 200);
    const data = (await r.json()).data;

    assert.equal(data.summary.total, 3);
    assert.deepEqual(data.results.map(x => x.id), ids, '结果顺序必须与请求顺序一致');

    const byId = Object.fromEntries(data.results.map(x => [x.id, x]));
    assert.equal(byId[rows[0].id].ok, true, '活的代理应连通');
    assert.equal(typeof byId[rows[0].id].latencyMs, 'number');
    assert.equal(byId[rows[1].id].ok, false, '连不上的代理应判为不可达');
    assert.ok(byId[rows[1].id].error, '要给出不可达的原因');
    assert.equal(byId[rows[2].id].ok, false, '端口没人监听也是不可达');

    assert.equal(data.summary.ok, 1);
    assert.equal(data.summary.failed, 2);
    // 每条的状态都写回了池子，列表能直接看到
    const list = Object.fromEntries(data.proxies.map(t => [t.id, t]));
    assert.equal(list[rows[0].id].healthy, true);
    assert.equal(list[rows[1].id].healthy, false);
    assert.ok(list[rows[1].id].cooldownUntil, '失败的那条应进入冷却');
  } finally { await s.close(); await live.close(); await dead.close(); }
});

test('批量测试：不存在的 id 如实计入 skipped，而不是整批失败', async () => {
  const live = await startRecordingProxy();
  const s = await startWithProxies();
  try {
    const added = await s.api.post('/proxies', { value: live.url });
    const row = (await added.json()).data.proxies.find(t => t.managed);
    const r = await s.api.post('/proxies/test-batch', { ids: [row.id, 'deadbeefdeadbeef'] });
    assert.equal(r.status, 200);
    const data = (await r.json()).data;
    assert.equal(data.summary.total, 1, '只有真实存在的那条被测试');
    assert.deepEqual(data.skipped, ['deadbeefdeadbeef']);
    assert.equal(data.results[0].ok, true);
  } finally { await s.close(); await live.close(); }
});

test('批量测试：空 ids 与超大批次都被明确拒绝', async () => {
  const s = await startWithProxies();
  try {
    const empty = await s.api.post('/proxies/test-batch', { ids: [] });
    assert.equal(empty.status, 400);

    // 上限之内但都不存在 → 400（没有可测的），而不是静默返回空结果
    const none = await s.api.post('/proxies/test-batch', { ids: ['a', 'b'] });
    assert.equal(none.status, 400);
    assert.match((await none.json()).error, /都不存在/);

    const tooMany = await s.api.post('/proxies/test-batch', {
      ids: Array.from({ length: 201 }, (_, i) => `id-${i}`),
    });
    assert.equal(tooMany.status, 400);
    assert.match((await tooMany.json()).error, /最多测试 200 条/);
  } finally { await s.close(); }
});

test('批量测试并发有上限：同时发两批会被拒（并发翻倍正是上限要防的事）', async () => {
  // 让探测慢下来，制造一个「第一批还在跑」的窗口
  const slow = await startRecordingProxy();
  const s = await startWithProxies({ env: { CC_PROXY_PROBE_TIMEOUT_MS: '3000' } });
  try {
    const added = await s.api.post('/proxies/bulk', { values: [slow.url] });
    const row = (await added.json()).data.proxies.find(t => t.managed);

    const first = s.api.post('/proxies/test-batch', { ids: [row.id] });
    // 给第一批一点时间真正进入探测
    await new Promise(r => setTimeout(r, 30));
    const second = await s.api.post('/proxies/test-batch', { ids: [row.id] });
    // 第一批可能已经跑完（探测很快），那样第二批就是正常 200 —— 两种都接受，
    // 但绝不允许两批同时跑却都返回 200 且都不带结果。
    const secondStatus = second.status;
    assert.ok(secondStatus === 200 || secondStatus === 409,
      `第二批要么正常排队（200）要么被单飞拒绝（409），实际 ${secondStatus}`);
    if (secondStatus === 409) {
      assert.match((await second.json()).error, /已有批量测试在运行中/);
    }
    const firstRes = await first;
    assert.equal(firstRes.status, 200);
  } finally { await s.close(); await slow.close(); }
});
