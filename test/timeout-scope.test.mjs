// 连续超时提示的**作用域**：同一会话连续 3 次超时才劝用户压缩上下文。
//
// 原实现是全进程一个计数器（`let consecutiveTimeouts = 0`），于是毫不相干的会话
// 会互相误伤：A 会话卡住两次之后，B 会话第一次超时就收到「请压缩上下文」，
// 而 B 的请求根本没变大。参考实现（dsh-commandcode-provider 的 gradeHeaderTimeout）
// 按 session 建 streak 并对条目数做上限淘汰，本文件锁定同样的口径。
//
// 断言方式：不同 x-session-id 轮流超时，任何一条都不该提前升级成「压缩上下文」提示；
// 同一 session id 连续超时三次才升级。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';

const AUTH = { Authorization: 'Bearer user_test' };
const CHAT = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
const SOFT = 'Response timeout - request timed out';
const HARD = 'try reducing context length';

/** 上游接了请求就挂住：不写任何字节，直到代理的空闲看门狗触发。 */
const hang = (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.flushHeaders();
  return true;
};

async function timeoutOnce(proxy, sessionId) {
  const r = await proxy.post('/v1/chat/completions', { ...CHAT, stream: true },
    { ...AUTH, ...(sessionId ? { 'x-session-id': sessionId } : {}) });
  const text = await r.text();
  assert.ok(text.includes('rate_limit_error'), '应收到超时错误事件，实际：' + text.slice(0, 200));
  return text;
}

test('超时提示按会话隔离：A 会话卡住不会让 B 会话提前收到「压缩上下文」', async () => {
  const s = await setup({ env: { CC_STREAM_IDLE_MS: '250' }, onRequest: hang });
  try {
    // A 会话连续超时两次 —— 还没到阈值，仍应是软提示
    for (let i = 0; i < 2; i++) {
      const text = await timeoutOnce(s.proxy, 'session-A-0001');
      assert.ok(text.includes(SOFT), `A 第 ${i + 1} 次应为软提示`);
      assert.ok(!text.includes(HARD), `A 第 ${i + 1} 次不该升级`);
    }
    // B 会话第一次超时：若计数器是全局的，这里会是「第 3 次」→ 错误地升级
    const b = await timeoutOnce(s.proxy, 'session-B-0002');
    assert.ok(b.includes(SOFT), 'B 的第一次超时必须仍是软提示（全局计数器会把它误判成第 3 次）');
    assert.ok(!b.includes(HARD), 'B 的请求没变大，不该劝它压缩上下文');
  } finally { await s.close(); }
});

test('同一会话连续 3 次超时才升级成「压缩上下文」提示', async () => {
  const s = await setup({ env: { CC_STREAM_IDLE_MS: '250' }, onRequest: hang });
  try {
    const id = 'session-same-0003';
    const first = await timeoutOnce(s.proxy, id);
    assert.ok(first.includes(SOFT), '第 1 次：软提示');
    const second = await timeoutOnce(s.proxy, id);
    assert.ok(second.includes(SOFT), '第 2 次：仍是软提示');
    const third = await timeoutOnce(s.proxy, id);
    assert.ok(third.includes(HARD), '第 3 次：同一会话连续超时，才提示压缩上下文');
  } finally { await s.close(); }
});

test('成功请求会清掉该会话的 streak（不是把它压回 0 再算）', async () => {
  // 第一次请求挂住（超时），第二次正常返回，第三次再挂住 —— 应回到软提示。
  // 只对 /alpha/generate 计数：指纹 / lifecycle 预请求也会走 onRequest，
  // 用全局 call 计数会把它们算进去（第二次不一定是那次生成）。
  let generateCalls = 0;
  const s = await setup({
    env: { CC_STREAM_IDLE_MS: '250' },
    onRequest: (req, res) => {
      if (req.url !== '/alpha/generate') return false;
      generateCalls++;
      if (generateCalls === 2) return false;   // 第二次生成交给默认 NDJSON（正常完成）
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.flushHeaders();
      return true;
    },
  });
  try {
    const id = 'session-reset-0004';
    await timeoutOnce(s.proxy, id);            // 超时 #1
    const ok = await s.proxy.post('/v1/chat/completions', { ...CHAT, stream: true },
      { ...AUTH, 'x-session-id': id });
    const okText = await ok.text();
    assert.ok(!okText.includes('rate_limit_error'), '第二次应正常完成，实际：' + okText.slice(0, 200));
    assert.equal(generateCalls, 2, '应恰好发生两次生成');

    const after = await timeoutOnce(s.proxy, id);   // 应是新的 streak 第 1 次
    assert.ok(after.includes(SOFT), '成功之后重新计数，不该继承之前的 1 次');
    assert.ok(!after.includes(HARD), '不该升级');
  } finally { await s.close(); }
});

test('没有会话标识的请求仍会累积（落到同一个全局槽位）', async () => {
  // 若把「无 session」的请求各自当成独立作用域，阈值就永远不会触发 —— 提示等于消失。
  const s = await setup({ env: { CC_STREAM_IDLE_MS: '250' }, onRequest: hang });
  try {
    for (let i = 0; i < 2; i++) {
      const t = await timeoutOnce(s.proxy, null);
      assert.ok(t.includes(SOFT), `无 session 第 ${i + 1} 次应为软提示`);
    }
    const third = await timeoutOnce(s.proxy, null);
    assert.ok(third.includes(HARD),
      '无会话标识的请求共用全局槽位，第 3 次仍要能升级出压缩提示');
  } finally { await s.close(); }
});