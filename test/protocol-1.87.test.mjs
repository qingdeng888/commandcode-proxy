// 对齐 command-code@1.87.1 后新增/变化的协议行为。
//
// 依据（dist/cli.mjs，未混淆）：
//   · isRefusalFinishReason：refusal / content_filter / content-filter 三种写法都算「被拦截」，
//     normalizeStopReason2 / consumedStopReason 先判它，再判 tool-calls / length；
//   · 事件集新增 cache-write-tokens（写缓存用量单发一条）与 tool-result /
//     server_tool_result（providerExecuted 的服务端工具结果）—— 代理不执行工具，
//     但也绝不该把它们打成 Unknown；
//   · 没有 finish 事件时仍抛 "no finish event" 的可重试 502（与 1.53.1 一致）。
//
// 另加两条与版本无关、但属于「上游请求必须干净」的不变量：
//   · 出网 body 里不得出现孤立代理项（lone surrogate）；
//   · 输出上限被上游拒绝时，按它写明的上限降档重发一次，之后同模型不再重复踩。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { allocPort, closeServer, setup, startProxy } from './helpers.mjs';

const AUTH = { Authorization: 'Bearer user_test' };
const CHAT = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };

const withFinish = (reason) => [
  '{"type":"text-start"}',
  '{"type":"text-delta","text":"partial"}',
  '{"type":"text-end"}',
  `{"type":"finish","finishReason":"${reason}","totalUsage":{"inputTokens":9,"outputTokens":3}}`,
];

async function openaiNonStream(s, body = CHAT) {
  const r = await s.proxy.post('/v1/chat/completions', body, AUTH);
  return { status: r.status, json: await r.json() };
}
async function anthropicNonStream(s) {
  const r = await s.proxy.post('/v1/messages',
    { model: 'm', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] },
    { 'x-api-key': 'user_test' });
  return { status: r.status, json: await r.json() };
}
async function responsesNonStream(s) {
  const r = await s.proxy.post('/v1/responses', { model: 'm', input: 'hi' }, AUTH);
  return { status: r.status, json: await r.json() };
}

// ── ① refusal 一族必须被识别，不能谎报完成 ──────────────────

test('1.87.1 chat：finishReason=refusal → finish_reason=content_filter（不折成 stop）', async () => {
  const s = await setup({ ndjson: withFinish('refusal') });
  try {
    const { status, json } = await openaiNonStream(s);
    assert.equal(status, 200);
    assert.equal(json.choices[0].finish_reason, 'content_filter',
      'refusal 是 OpenAI 侧合法的「被拦截」枚举，折成 stop 等于说模型自己说完了');
    assert.equal(json.choices[0].message.content, 'partial');
  } finally { await s.close(); }
});

test('1.87.1 chat：content-filter（连字符写法）同样归到 content_filter', async () => {
  const s = await setup({ ndjson: withFinish('content-filter') });
  try {
    const { json } = await openaiNonStream(s);
    assert.equal(json.choices[0].finish_reason, 'content_filter');
  } finally { await s.close(); }
});

test('1.87.1 messages：refusal 以原生 stop_reason=refusal 透出', async () => {
  const s = await setup({ ndjson: withFinish('refusal') });
  try {
    const { json } = await anthropicNonStream(s);
    assert.equal(json.stop_reason, 'refusal', 'Anthropic 有 refusal 枚举，必须原样透出');
  } finally { await s.close(); }
});

test('1.87.1 responses：refusal → status=incomplete + content_filter', async () => {
  const s = await setup({ ndjson: withFinish('refusal') });
  try {
    const { json } = await responsesNonStream(s);
    assert.equal(json.status, 'incomplete', '被拦截不等于答完了');
    assert.deepEqual(json.incomplete_details, { reason: 'content_filter' },
      'incomplete_details.reason 只有 max_output_tokens / content_filter 两个合法值');
  } finally { await s.close(); }
});

// ── ② 新增事件不能被当成 Unknown ─────────────────────────────

test('1.87.1 cache-write-tokens / server_tool_result 不再刷 Unknown CC event type', async () => {
  const ndjson = [
    '{"type":"text-start"}',
    '{"type":"text-delta","text":"hello"}',
    '{"type":"cache-write-tokens","cacheWriteTokens":42}',
    '{"type":"server_tool_result","toolCallId":"s1","toolName":"web_search","output":{"type":"text","value":"ok"}}',
    '{"type":"tool-result","toolCallId":"s1","toolName":"web_search","output":{"type":"text","value":"ok"}}',
    '{"type":"text-end"}',
    '{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":9,"outputTokens":3}}',
  ];
  const s = await setup({ ndjson });
  try {
    // 流式与非流式各跑一遍：两条路径各有一份静默事件表
    await (await s.proxy.post('/v1/chat/completions', { ...CHAT, stream: true }, AUTH)).text();
    await (await s.proxy.post('/v1/chat/completions', CHAT, AUTH)).text();
    await (await s.proxy.post('/v1/messages',
      { model: 'm', max_tokens: 50, stream: true, messages: [{ role: 'user', content: 'hi' }] },
      { 'x-api-key': 'user_test' })).text();
    const logs = s.proxy.logs();
    assert.ok(!logs.includes('Unknown CC event type'),
      '不应把 1.87.1 的新事件打成 Unknown：\n' + logs.split('\n').filter(l => l.includes('Unknown CC')).join('\n'));
  } finally { await s.close(); }
});

// ── ③ 孤立代理项不得出网 ─────────────────────────────────────

test('出网 body 的孤立代理项被清掉，成对代理项（emoji）原样保留', async () => {
  const s = await setup();
  try {
    // '\uD83D' 是半个 emoji（高频截断产物）；'👍' 是合法的一对
    const lone = '\uD83D';
    const r = await s.proxy.post('/v1/chat/completions', {
      model: 'm', stream: true,
      messages: [{ role: 'user', content: `before ${lone} after 👍` }],
    }, AUTH);
    await r.text();
    const raw = s.mock.lastGenerate().raw;
    assert.ok(!raw.includes('\\ud83d'), '孤立代理项的转义不得出现在出网 body 里');
    assert.ok(raw.includes('👍'), '成对代理项（emoji）必须原样保留');
    assert.match(raw, /before\s+after 👍/, '清洗只删坏字符，不吞正文');
  } finally { await s.close(); }
});

// ── ④ 输出上限拒绝 → 按上游写明的上限降档重发一次 ────────────

/** 上游第一次用 400 + 上限比较句拒绝，之后正常吐流。 */
async function startCeilingUpstream({ refusalBody, secondOk = true } = {}) {
  const port = await allocPort();
  const state = { generateCalls: 0, bodies: [] };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      if (req.url !== '/alpha/generate') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }
      state.generateCalls++;
      state.bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (state.generateCalls === 1 || !secondOk) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(refusalBody);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      for (const line of [
        '{"type":"text-delta","text":"fits"}',
        '{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":5,"outputTokens":2}}',
      ]) res.write(line + '\n');
      res.end();
    });
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  return { port, state, close: () => closeServer(server) };
}

test('输出上限被拒 → 用上游写明的上限重发一次，下游只看到 200', async () => {
  const upstream = await startCeilingUpstream({
    refusalBody: JSON.stringify({
      error: { message: 'max_tokens: 200000 > 128000, which is the maximum allowed number of output tokens for claude-sonnet-5-5' },
    }),
  });
  const proxy = await startProxy({ upstreamPort: upstream.port, env: { CC_UPSTREAM_RETRY_BASE_MS: '20' } });
  try {
    const r = await proxy.post('/v1/chat/completions', {
      model: 'claude-sonnet-5-5', stream: true, max_tokens: 200000,
      messages: [{ role: 'user', content: 'hi' }],
    }, AUTH);
    const text = await r.text();
    assert.equal(r.status, 200, '降档重发应消化掉这次 400，下游不该看到它');
    assert.match(text, /fits/);
    assert.equal(upstream.state.generateCalls, 2, '应恰好重发一次');
    assert.equal(upstream.state.bodies[0].params.max_tokens, 200000, '第一次按客户端给的预算发送');
    assert.equal(upstream.state.bodies[1].params.max_tokens, 128000, '第二次夹到上游亲口报出的上限');

    // 学到的上限对后续请求同样生效，不必再吃一次 400
    const before = upstream.state.generateCalls;
    const second = await proxy.post('/v1/chat/completions', {
      model: 'claude-sonnet-5-5', stream: true, max_tokens: 200000,
      messages: [{ role: 'user', content: 'again' }],
    }, AUTH);
    await second.text();
    assert.equal(second.status, 200);
    assert.equal(upstream.state.generateCalls, before + 1, '第二次请求不该再被 400 拒一次');
    assert.equal(upstream.state.bodies.at(-1).params.max_tokens, 128000, '学到的上限要预先夹住');
  } finally { await proxy.kill(); await upstream.close(); }
});

test('只报「invalid max_tokens」而不给数字时不猜上限、只重试一次', async () => {
  const upstream = await startCeilingUpstream({
    refusalBody: JSON.stringify({ error: { message: 'Invalid input: expected number, received undefined at max_tokens' } }),
    secondOk: false,
  });
  const proxy = await startProxy({ upstreamPort: upstream.port, env: { CC_UPSTREAM_RETRY_BASE_MS: '20' } });
  try {
    const r = await proxy.post('/v1/chat/completions', {
      model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }],
    }, AUTH);
    assert.equal(r.status, 400, '上游 400 应原样映射（422→400、400 原样）');
    assert.equal(upstream.state.generateCalls, 1,
      '没有可解析的上限时不能瞎猜一个值重发 —— 猜出来的数字与真实上限在后续请求里无从区分');
  } finally { await proxy.kill(); await upstream.close(); }
});

// ── ⑤ 额度类错误要换 Key（不是「与 Key 无关」）──────────────

/**
 * 两个 Key 的池：**第一次** generate 回 402 额度不足（无论打到哪个 Key），之后正常。
 * 断言点因此与「启动预热消耗了一次轮询游标」解耦：无论第一个被选中的是谁，
 * 只要额度类错误被当成「该换 Key」，就一定会出现第二次调用且换了 Key；
 * 若被当成「与 Key 无关」，则一次就结束。
 */
async function startQuotaUpstream() {
  const port = await allocPort();
  const state = { calls: [], generateCalls: 0 };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      if (req.url !== '/alpha/generate') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }
      state.generateCalls++;
      const auth = req.headers.authorization || '';
      state.calls.push(auth);
      if (state.generateCalls === 1) {
        res.writeHead(402, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'INSUFFICIENT_CREDITS', message: 'insufficient credits' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      for (const line of [
        '{"type":"text-delta","text":"served by another key"}',
        '{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":5,"outputTokens":2}}',
      ]) res.write(line + '\n');
      res.end();
    });
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  return { port, state, close: () => closeServer(server) };
}

test('额度不足（402 INSUFFICIENT_CREDITS）触发换 Key，而不是当成模型维度直接失败', async () => {
  const upstream = await startQuotaUpstream();
  // 严格模式（PROXY_KEY）才会由代理从池里挑上游 Key；透传模式下客户端自带 Key，没有池可换。
  const proxy = await startProxy({
    upstreamPort: upstream.port,
    env: { CC_API_KEY: 'user_a,user_b', PROXY_KEY: 'client-secret', CC_UPSTREAM_RETRY_BASE_MS: '20' },
  });
  try {
    const r = await proxy.post('/v1/chat/completions', { ...CHAT, stream: true },
      { Authorization: 'Bearer client-secret' });
    const text = await r.text();
    assert.equal(r.status, 200, '池里还有可用 Key 时不该把额度不足透给下游');
    assert.match(text, /served by another key/);
    assert.equal(upstream.state.generateCalls, 2, '额度不足必须再试下一个 Key');
    assert.notEqual(upstream.state.calls[0], upstream.state.calls[1],
      '第二次必须是**另一个** Key —— 换了个相同的等于没换');
  } finally { await proxy.kill(); await upstream.close(); }
});

// ── ⑥ 请求头集合：不得出现只有非普通会话才会发的头 ───────────

test('1.87.1 头部：不发 x-cli-surface / x-oss-primary-provider / x-cmd-provider-deepseek-internal', async () => {
  const s = await setup();
  try {
    const r = await s.proxy.post('/v1/chat/completions', { ...CHAT, stream: true }, AUTH);
    await r.text();
    const headers = s.mock.lastGenerate().headers;
    // 这三个在 1.87.1 里分别是 acp/rpc 入口、BYOK、内部账号专用；
    // 普通 CLI 会话一个都不发，代理自称普通会话就不能发
    for (const h of ['x-cli-surface', 'x-oss-primary-provider', 'x-cmd-provider-deepseek-internal']) {
      assert.ok(!(h in headers), `${h} 只有非普通会话才会发，代理不得发送`);
    }
    assert.equal(headers['x-command-code-version'], '1.88.0', '版本号应与实现对齐');
  } finally { await s.close(); }
});

// ── ⑦ 网关 JSON 节点数上限：必须单列诊断，不能被当成上下文溢出 ──────

test('JSON node count 上限 → 明确说是结构限制、给出网关写明的数字', async () => {
  const s = await setup({
    status: 400,
    errorBody: JSON.stringify({ error: { message: 'JSON node count cannot exceed 32768' } }),
  });
  try {
    const r = await s.proxy.post('/v1/chat/completions', { ...CHAT, stream: true }, AUTH);
    assert.equal(r.status, 400, '上游 400 原样映射');
    const j = await r.json();
    assert.match(j.error.message, /32768/, '必须引用网关自己写明的上限数字');
    assert.match(j.error.message, /structure/i, '要说明限制的是请求结构，不是 token 长度');
    assert.match(j.error.message, /compacting|compress/i, '要提示压缩上下文通常不够');
    assert.equal(j.error.node_limit, 32768, '机器可读字段，便于客户端自行判断');
  } finally { await s.close(); }
});

test('普通 400 不被 JSON 节点诊断误伤', async () => {
  const s = await setup({
    status: 400,
    errorBody: JSON.stringify({ error: { message: 'messages: field required' } }),
  });
  try {
    const r = await s.proxy.post('/v1/chat/completions', { ...CHAT, stream: true }, AUTH);
    const j = await r.json();
    assert.ok(!('node_limit' in j.error), '无关的 400 不该带 node_limit');
    assert.equal(j.error.message, 'messages: field required', '错误正文原样透出');
  } finally { await s.close(); }
});
