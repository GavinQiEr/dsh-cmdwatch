// 用 mock ctx 驱动 lib/index.js，验证 /cmdmon/wait 长轮询端点
const mod = await import('./lib/index.js');

const noop = () => {};
const handlers = {};
const routes = {};

const ctx = new Proxy({}, {
  get(_t, prop) {
    switch (prop) {
      case 'get': return (n) => (n === 'timer' ? { interval: () => noop } : undefined);
      case 'on': return (ev, fn) => { handlers[ev] = fn; };
      case 'effect': return (fn) => { try { const d = fn(); return typeof d === 'function' ? d : noop; } catch (e) { return noop; } };
      case 'webServer': return { register: (s) => { routes[s.path] = s.handler; return noop; } };
      case 'tools': return { register: noop, get: () => undefined };
      case 'logger': return { warn: noop, info: noop, error: noop, debug: noop };
      default: return undefined;
    }
  },
});

mod.apply(ctx, {});
console.log('已注册路由:', Object.keys(routes).join(', '));

function mockReq(url) {
  return { url, on: noop };
}
function mockRes() {
  return {
    code: 0, body: '',
    writeHead(c) { this.code = c; },
    end(b) { this.body = b; },
  };
}
async function callWait(qs, timeoutHint) {
  const res = mockRes();
  const p = routes['/cmdmon/wait'](mockReq('/cmdmon/wait' + qs), res);
  await Promise.race([p, new Promise((r) => setTimeout(r, timeoutHint || 5000))]);
  return { code: res.code, body: res.body ? JSON.parse(res.body) : null };
}

let pass = 0, fail = 0;
const assert = (name, cond, extra) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (cond ? '' : '  → ' + JSON.stringify(extra)));
  cond ? pass++ : fail++;
};

// --- 场景 1：完成的记录 → 立即返回 ---
const execDone = { callId: 'call_done_1', name: 'pwsh', arguments: { command: 'echo hi' }, agent: { id: 'sess-A' } };
handlers['tools/execute'](execDone, noop);
handlers['tools/result'](execDone, { content: [{ type: 'text', text: 'hi\n' }], isError: false });

const t1 = Date.now();
const r1 = await callWait('?key=tool:call_done_1&session=sess-A&timeout_ms=5000');
assert('完成的记录：立即返回且 timedOut=false', r1.code === 200 && r1.body && r1.body.timedOut === false && r1.body.record && r1.body.record.status === 'completed', r1.body);
assert('完成的记录：等待耗时很短（<500ms）', Date.now() - t1 < 500, Date.now() - t1);

// --- 场景 2：不存在的 key → 超时返回 found:false ---
const t2 = Date.now();
const r2 = await callWait('?key=tool:nope&timeout_ms=400');
assert('不存在的 key：超时且 found=false', r2.body && r2.body.timedOut === true && r2.body.found === false, r2.body);
assert('不存在的 key：确实等了约 400ms', Date.now() - t2 >= 350, Date.now() - t2);

// --- 场景 3：运行中的记录 → 超时返回 record.status=running ---
const execRun = { callId: 'call_run_1', name: 'pwsh', arguments: { command: 'echo slow' }, agent: { id: 'sess-A' } };
handlers['tools/execute'](execRun, noop); // 只 execute，不 result → running
const r3 = await callWait('?key=tool:call_run_1&session=sess-A&timeout_ms=400');
assert('运行中的记录：超时返回 running', r3.body && r3.body.timedOut === true && r3.body.found === true && r3.body.record && r3.body.record.status === 'running', r3.body);

// --- 场景 4：不带 key（等待全部结束）→ 有 running 记录时不返回 ---
const r4 = await callWait('?session=sess-A&timeout_ms=400');
assert('无 key 且仍有 running：超时', r4.body && r4.body.timedOut === true, r4.body);

// 让它完成后再试
handlers['tools/result'](execRun, { content: [{ type: 'text', text: 'slow done\n' }], isError: false });
const r5 = await callWait('?session=sess-A&timeout_ms=2000');
assert('无 key 且全部结束：立即返回 pending=0', r5.body && r5.body.timedOut === false && r5.body.pending === 0, r5.body);

// --- 场景 5：会话隔离（别的会话看不到）---
const r6 = await callWait('?key=tool:call_done_1&session=sess-B&timeout_ms=400');
assert('会话隔离：跨会话 key 不可见 → found=false', r6.body && r6.body.found === false && r6.body.timedOut === true, r6.body);

// --- 场景 6：失败状态也算终止 ---
const execFail = { callId: 'call_fail_1', name: 'pwsh', arguments: { command: 'exit 1' }, agent: { id: 'sess-A' } };
handlers['tools/execute'](execFail, noop);
handlers['tools/result'](execFail, { content: [{ type: 'text', text: 'boom' }], isError: true });
const r7 = await callWait('?key=tool:call_fail_1&session=sess-A&timeout_ms=2000');
assert('failed 也算终止：立即返回', r7.body && r7.body.timedOut === false && r7.body.record.status === 'failed', r7.body);

console.log('\n结果: ' + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
