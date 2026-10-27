// 同一请求的多次上游尝试共用一份序列化结果（serializeCcBody）。
//
// 一次请求会多次走到序列化点：多 Key 轮换、传输层闪断重试、输出上限降档重发。
// 这些尝试之间 body **逐字节相同**（变化只在 header 里），而带图长会话的 body
// 可达几十 MB —— 实测 28.4MB 正文重新 stringify 一次约 150ms 的**同步**时间，
// 期间进程内所有在途请求都被卡住。
//
// 同时必须锁住反向不变量：降档重发会改 `params.max_tokens`，那是两次尝试之间
// **唯一**会变的 body 字段，缓存必须在它变化时失效 —— 否则第二次发出去的还是旧预算，
// 降档等于没做（会无限重复吃同一个 400）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { allocPort, closeServer, setup, startProxy } from './helpers.mjs';

const AUTH = { Authorization: 'Bearer user_test' };
const CHAT = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };

// ── ① 换 Key 轮换：两次尝试发出的 body 必须完全一致 ──────────

test('换 Key 重试时，第二个 Key 收到的正文与第一个逐字节相同', async () => {
  const port = await allocPort();
  const bodies = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      if (req.url !== '/alpha/generate') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }
      bodies.push({ auth: req.headers.authorization, raw: Buffer.concat(chunks).toString('utf8') });
      if (bodies.length === 1) {
        res.writeHead(402, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'INSUFFICIENT_CREDITS', message: 'insufficient credits' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write('{"type":"text-delta","text":"ok"}\n');
      res.write('{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":3,"outputTokens":1}}\n');
      res.end();
    });
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));

  const proxy = await startProxy({
    upstreamPort: port,
    env: { CC_API_KEY: 'user_a,user_b', PROXY_KEY: 'secret', CC_UPSTREAM_RETRY_BASE_MS: '20' },
  });
  try {
    const r = await proxy.post('/v1/chat/completions', {
      model: 'm', stream: true,
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'hi' },
      ],
      tools: [{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object', properties: {} } } }],
    }, { Authorization: 'Bearer secret' });
    await r.text();

    assert.equal(bodies.length, 2, '应发生一次换 Key 重试');
    assert.notEqual(bodies[0].auth, bodies[1].auth, '两次必须是不同的 Key');
    assert.equal(bodies[0].raw, bodies[1].raw,
      '换 Key 只该改 header；正文必须逐字节相同（否则两侧缓存命名空间/前缀缓存都对不上）');
  } finally { await proxy.kill(); await closeServer(server); }
});

// ── ② 输出上限降档：改动的字段必须让缓存失效 ─────────────────

test('输出上限降档后重发的是**新**预算（缓存不能在 max_tokens 变化时命中）', async () => {
  const port = await allocPort();
  const sent = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      if (req.url !== '/alpha/generate') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      sent.push(body.params.max_tokens);
      if (sent.length === 1) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: { message: 'max_tokens: 200000 > 128000, which is the maximum allowed number of output tokens for m' },
        }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write('{"type":"text-delta","text":"fits"}\n');
      res.write('{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":3,"outputTokens":1}}\n');
      res.end();
    });
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));

  const proxy = await startProxy({ upstreamPort: port, env: { CC_UPSTREAM_RETRY_BASE_MS: '20' } });
  try {
    const r = await proxy.post('/v1/chat/completions', {
      model: 'm', stream: true, max_tokens: 200000,
      messages: [{ role: 'user', content: 'hi' }],
    }, AUTH);
    const text = await r.text();

    assert.equal(r.status, 200, '降档重发应消化掉 400');
    assert.match(text, /fits/);
    assert.deepEqual(sent, [200000, 128000],
      '第二次必须带上游写明的 128000；若缓存没失效，发出去的仍是 200000，降档等于没做');
  } finally { await proxy.kill(); await closeServer(server); }
});

// ── ③ 复用缓存不能让孤立代理项清洗失效 ───────────────────────

test('复用序列化结果时，孤立代理项仍被清掉（replacer 不会因缓存被绕过）', async () => {
  const s = await setup();
  try {
    const lone = '\uD83D';
    const r = await s.proxy.post('/v1/chat/completions', {
      model: 'm', stream: true,
      messages: [{ role: 'user', content: `before ${lone} after 👍` }],
    }, AUTH);
    await r.text();
    const raw = s.mock.lastGenerate().raw;
    assert.ok(!raw.includes('\\ud83d'), '缓存路径同样必须经过 sanitizeReplacer');
    assert.ok(raw.includes('👍'), '成对代理项仍须原样保留');
  } finally { await s.close(); }
});

// ── ④ 不同请求之间不能串味 ───────────────────────────────────

test('两个并发请求各自的正文互不干扰（缓存键是各自的 params 对象）', async () => {
  const s = await setup();
  try {
    const [a, b] = await Promise.all([
      s.proxy.post('/v1/chat/completions', { model: 'model-A', stream: true, messages: [{ role: 'user', content: 'from A' }] }, AUTH),
      s.proxy.post('/v1/chat/completions', { model: 'model-B', stream: true, messages: [{ role: 'user', content: 'from B' }] }, AUTH),
    ]);
    await Promise.all([a.text(), b.text()]);

    const gens = s.mock.seen.filter(x => x.url === '/alpha/generate').map(x => JSON.parse(x.raw));
    assert.equal(gens.length, 2);
    const models = gens.map(g => g.params.model).sort();
    assert.deepEqual(models, ['model-A', 'model-B'], '两个模型不能互相覆盖');
    const textOf = (g) => g.params.messages[0].content[0].text;
    const byModel = Object.fromEntries(gens.map(g => [g.params.model, textOf(g)]));
    assert.equal(byModel['model-A'], 'from A');
    assert.equal(byModel['model-B'], 'from B');
  } finally { await s.close(); }
});