// dsh-cmdwatch 宿主半集成测试（模拟宿主，无需重启真实 DSH）
//
//   node test-hostsync.mjs
//
// 为什么需要它：0.5.1 的两个故障（裸后台任务读不到输出、状态卡运行中 + Tee 日志
// 不清理）都只在"多会话 + 定时轮询"的真实时序下出现，lib/rewrite.js 那种纯函数
// 单测覆盖不到。这里真加载 lib/index.js 的 apply()，用假的 ctx/webServer/jobs/timer
// 驱动同一条时序：
//
//   1. 我启动裸后台任务（无收集管道 → 不包装，输出只能走 jobs.read）
//   2. 另一个会话的活动触发 onJobsChanged（实测就是把 owner 顶掉的那条路径）
//   3. 定时轮询——修复前这里会以 "belongs to another session" 被拒（面板零输出）
//
// 唯一改动：把宿主提供的 `@deepseek-ai/dsh-tools` 静态 import 换成本地桩
// （工作区没有 node_modules），其余代码逐字节原样执行。
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

let pass = 0, fail = 0;
const assert = (name, cond) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name);
  cond ? pass++ : fail++;
};

const here = dirname(fileURLToPath(import.meta.url));
const libDir = join(here, 'lib');
const ORIGINAL_IMPORT = 'import { defineTool } from "@deepseek-ai/dsh-tools";';
const source = readFileSync(join(libDir, 'index.js'), 'utf8');
if (!source.includes(ORIGINAL_IMPORT)) {
  console.error('FAIL - lib/index.js 里找不到预期的 dsh-tools import，测试需要同步更新');
  process.exit(1);
}
const tmpEntry = join(libDir, '.index.under-test.mjs');
writeFileSync(tmpEntry, source.replace(ORIGINAL_IMPORT, 'const defineTool = (d) => d;'), 'utf8');

const workDir = mkdtempSync(join(tmpdir(), 'cmdmon-host-'));
let plugin;
try {
  plugin = await import(pathToFileURL(tmpEntry).href);
} finally {
  rmSync(tmpEntry, { force: true });
}

// ---- 假宿主 ----
// exec.agent 是 Agent 对象（hooks 传的就是它），而 jobs 的 caller 语义是**会话 id 字符串**
// （dsh-jobs-local：`job.owner.id !== caller`）。假实现照这个真实契约来，传 Agent 对象必被拒。
const ME = { id: 'session-me' };
const OTHER = { id: 'session-other' };
const THIRD = { id: 'session-third' };

function snapshotOf(j) {
  // 真实 jobs 视图暴露的是 owner（会话 id 字符串），旧字段名 ownerSession 不再存在
  return {
    id: j.id, kind: j.kind, label: j.label, status: j.status, detail: j.detail,
    startedAt: j.startedAt, finishedAt: j.finishedAt, owner: j.owner
  };
}

const store = new Map();
const readCalls = [];
const endpoints = new Map();
const handlers = new Map();
let pollFn = null;
let changedCb = null;
let doneCb = null;

const jobs = {
  read(id, caller) {
    readCalls.push({ op: 'read', id, caller });
    const j = store.get(id);
    if (!j) throw new Error(`unknown job ${id}`);
    if (j.owner !== undefined && j.owner !== caller) throw new Error(`job ${id} belongs to another session`);
    const text = j.pending; j.pending = '';
    // 真实形状：{ chunks, lossy, result?, job }（0.1.5+；旧版才是 { text, snapshot }）
    return { chunks: text ? [{ text, channel: 'stdout' }] : [], lossy: false, job: snapshotOf(j) };
  },
  get(id, caller) {
    readCalls.push({ op: 'get', id, caller });
    const j = store.get(id);
    if (!j) throw new Error(`unknown job ${id}`);
    if (j.owner !== undefined && j.owner !== caller) throw new Error(`job ${id} belongs to another session`);
    return snapshotOf(j);
  },
  list(caller) {
    return [...store.values()].filter((j) => j.owner === undefined || j.owner === caller).map(snapshotOf);
  },
  onJobsChanged(fn) { changedCb = fn; return () => {}; },
  onJobDone(fn) { doneCb = fn; return () => {}; }
};

const ctx = {
  get(name) { return name === 'jobs' ? jobs : name === 'timer' ? timer : undefined; },
  on(event, fn) { handlers.set(event, fn); },
  effect(fn) { const off = fn(); if (typeof off === 'function') offs.push(off); },
  webServer: { register(r) { endpoints.set(r.path, r.handler); return () => {}; } },
  shell: {}
};
const timer = { interval(fn) { pollFn = fn; return () => {}; } };
const offs = [];

plugin.apply(ctx, {});

const tick = () => { if (pollFn) pollFn(); };
const fireChanged = (agent) => { if (changedCb) changedCb(agent); };
const payloadFor = (query) => {
  const res = { writeHead() {}, end(body) { this.body = body; } };
  endpoints.get('/cmdmon/snapshot')({ url: '/cmdmon/snapshot?' + query }, res);
  return JSON.parse(res.body);
};
// 记录级断言用全量视图（all=1，排查口）；会话隔离断言另用 payloadFor 指定 session
const payload = () => payloadFor('since=0&all=1');
const recOf = (key) => payload().records.find((r) => r.key === key);
const diagMsgs = () => payload().diagEvents.map((e) => e.msg);
const call = (event, ...a) => handlers.get(event)(...a);

// ---- 场景 1：我的裸后台任务 + 跨会话事件 + 轮询（0.5.1 的核心故障）----
const bgArgs = { command: '1..3 | ForEach-Object { "A-$_" }', run_in_background: true, workdir: workDir };
call('tools/execute', { name: 'pwsh', callId: 'call_me_1', agent: ME, arguments: bgArgs }, () => {});
store.set('pwsh-99', {
  id: 'pwsh-99', kind: 'pwsh', label: bgArgs.command, status: 'running',
  owner: ME.id, startedAt: Date.now(), pending: ''
});
call('tools/result', { name: 'pwsh', callId: 'call_me_1', agent: ME, arguments: bgArgs },
  { value: { kind: 'background', jobId: 'pwsh-99' } });

// 另一个会话的活动：事件携带别的 agent（修复前会把 pwsh-99 的 owner 顶成 OTHER）
fireChanged(OTHER);
// 该会话自己的任务也进入记录（owner 正确，属兜底登记）
store.set('pwsh-2', {
  id: 'pwsh-2', kind: 'pwsh', label: 'other session job', status: 'running',
  owner: OTHER.id, startedAt: Date.now(), pending: 'other-1\n'
});

// 运行中分批产生输出，轮询三次
store.get('pwsh-99').pending = 'A-1\n';
tick();
store.get('pwsh-99').pending = 'A-2\n';
tick();
store.get('pwsh-99').pending = 'A-3\n';
tick();

const myCalls = readCalls.filter((c) => c.id === 'pwsh-99');
let rec = recOf('job:pwsh-99');
assert('传给 jobs 的 caller 是会话 id 字符串（不是 Agent 对象）',
  myCalls.length > 0 && myCalls.every((c) => typeof c.caller === 'string' && c.caller === ME.id));
assert('跨会话事件后仍以权威 owner 读取（caller 未被顶掉）',
  myCalls.length > 0 && myCalls.every((c) => c.caller === ME.id));
assert('裸后台任务输出实时进入记录（修复前恒为 0）',
  rec && rec.output.includes('A-1') && rec.output.includes('A-3'));
assert('该任务未被标记 readDenied', rec && rec.readDenied === false);
assert('该任务无读取错误', rec && (rec.readError === null || rec.readError === undefined));

// ---- 场景 2：归属信息自相矛盾（异常输入）——被拒一次后不再重试、不刷屏 ----
// 该任务真实属于 OTHER，却以 ME 的调用登记（模拟宿主给出的归属信息矛盾）
store.set('pwsh-7', {
  id: 'pwsh-7', kind: 'pwsh', label: 'mismatched job', status: 'running',
  owner: OTHER.id, startedAt: Date.now(), pending: 'x\n'
});
call('tools/result', { name: 'pwsh', callId: 'call_me_7', agent: ME, arguments: {} },
  { value: { kind: 'background', jobId: 'pwsh-7' } });
const callsBefore = readCalls.filter((c) => c.id === 'pwsh-7').length;
tick();
tick();
tick();
const foreignCalls = readCalls.filter((c) => c.id === 'pwsh-7').length - callsBefore;
const foreignRec = recOf('job:pwsh-7');
assert('归属不一致的任务被标记 readDenied', foreignRec && foreignRec.readDenied === true);
assert('被拒后不再重试（最多 1 次读取尝试）', foreignCalls <= 1);
const deniedDiag = payload().diagEvents.filter((e) => e.msg === 'poll denied');
assert('被拒任务只诊断一次，不再每 500ms 刷屏',
  deniedDiag.filter((e) => e.jobId === 'pwsh-7').length === 1
  && diagMsgs().filter((m) => m === 'poll FAILED').length === 0);

// 归属纠正（任务确实属于 ME）：权威登记到达后解除拒读标记并恢复读取
store.get('pwsh-7').owner = ME.id;
store.get('pwsh-7').pending = 'recovered\n';
call('tools/result', { name: 'pwsh', callId: 'call_me_8', agent: ME, arguments: {} },
  { value: { kind: 'background', jobId: 'pwsh-7' } });
tick();
const recovered = recOf('job:pwsh-7');
assert('权威登记后解除 readDenied 并恢复读取',
  recovered && recovered.readDenied === false && recovered.output.includes('recovered'));

// 另一个会话的任务：对它自己的 caller 可见可读，但绝不进本会话的面板
fireChanged(OTHER);
tick();
const otherRec = recOf('job:pwsh-2');
assert('其它会话的任务归属其它会话、且能被它自己的 caller 读到',
  otherRec && otherRec.sessionId === OTHER.id && otherRec.output.includes('other-1'));

// ---- 场景 3：带收集管道的后台任务 → Tee 实时输出 + 终止收尾清理 ----
const pipeArgs = { command: '1..5 | ForEach-Object { "B-$_" } | Select-Object -Last 2', run_in_background: true, workdir: workDir };
call('tools/execute', { name: 'pwsh', callId: 'call_me_2', agent: ME, arguments: pipeArgs }, () => {});
const teeFile = join(workDir, '.cmdmon-call_me_2.log');
store.set('pwsh-100', {
  id: 'pwsh-100', kind: 'pwsh', label: pipeArgs.command, status: 'running',
  owner: ME.id, startedAt: Date.now(), pending: ''
});
call('tools/result', { name: 'pwsh', callId: 'call_me_2', agent: ME, arguments: pipeArgs },
  { value: { kind: 'background', jobId: 'pwsh-100' } });

writeFileSync(teeFile, 'B-1\nB-2\n', 'utf8');
tick();
let pipeRec = recOf('job:pwsh-100');
assert('后台收集管道任务改走 Tee（fgStream=true）', pipeRec && pipeRec.fgStream === true);
assert('Tee 日志增量实时进入记录', pipeRec && pipeRec.output.includes('B-2'));
assert('已包装记录不再挂 ⚠（例行说明改走 notes）',
  pipeRec && (pipeRec.warnings || []).length === 0 && (pipeRec.notes || []).length > 0);
assert('未包装的裸命令既无 ⚠ 也无例行说明',
  rec && (rec.warnings || []).length === 0 && (rec.notes || []).length === 0);

writeFileSync(teeFile, 'B-1\nB-2\nB-4\nB-5\n', 'utf8');
store.get('pwsh-100').status = 'completed';
store.get('pwsh-100').finishedAt = Date.now();
tick();
pipeRec = recOf('job:pwsh-100');
assert('任务终止后状态落为 completed', pipeRec && pipeRec.status === 'completed' && !!pipeRec.finishedAt);
assert('终止收尾读到剩余输出（B-4/B-5 未丢）',
  pipeRec && pipeRec.output.includes('B-4') && pipeRec.output.includes('B-5'));
assert('Tee 日志文件已清理（修复前残留）', !existsSync(teeFile));

// ---- 场景 4：前台"部分覆盖"（语句块没插 Tee）→ 完成时用完整工具结果补全 ----
// 命令：`foreach (...) { ... }\nWrite-Output done`——块内输出进不了 Tee 日志
const blockCmd = 'foreach ($i in 1..3) {\n  "i=$i"\n}\nWrite-Output done';
const blockArgs = { command: blockCmd, workdir: workDir };
call('tools/execute', { name: 'pwsh', callId: 'call_me_4', agent: ME, arguments: blockArgs }, () => {});
const blockRec = recOf('tool:call_me_4');
assert('部分覆盖的前台记录标记 partial', blockRec && blockRec.partial === true && blockRec.fgStream === true);
assert('部分覆盖写进例行说明',
  blockRec && (blockRec.notes || []).some((n) => n.includes('部分语句')));
call('tools/result', { name: 'pwsh', callId: 'call_me_4', agent: ME, arguments: blockArgs },
  { content: [{ type: 'text', text: 'i=1\ni=2\ni=3\ndone\n' }] });
const blockDone = recOf('tool:call_me_4');
assert('完成后用完整工具结果替换（块内输出不再丢失）',
  blockDone && blockDone.output.includes('i=2') && blockDone.output.includes('done'));

// 对照：全覆盖的前台记录不追加工具结果（避免与 Tee 内容重复）
const fullArgs = { command: 'Write-Output one; Write-Output two', workdir: workDir };
call('tools/execute', { name: 'pwsh', callId: 'call_me_5', agent: ME, arguments: fullArgs }, () => {});
const fullRec = recOf('tool:call_me_5');
assert('全覆盖记录 partial=false', fullRec && fullRec.partial === false);
writeFileSync(join(workDir, '.cmdmon-call_me_5.log'), 'one\ntwo\n', 'utf8');
tick();
call('tools/result', { name: 'pwsh', callId: 'call_me_5', agent: ME, arguments: fullArgs },
  { content: [{ type: 'text', text: 'one\ntwo\n' }] });
const fullDone = recOf('tool:call_me_5');
assert('全覆盖记录保持 Tee 内容、不重复追加',
  fullDone && fullDone.output.trim() === 'one\ntwo' && (fullDone.output.match(/one/g) || []).length === 1);

// ---- 会话隔离：不带会话标识的请求不得拿到任何有会话归属的记录 ----
const mineOnly = payloadFor('since=0&session=' + ME.id).records;
const foreignOnly = payloadFor('since=0&session=' + OTHER.id).records;
const noSession = payloadFor('since=0').records;
const allRecs = payloadFor('since=0&all=1').records;
assert('带本会话标识：只返回本会话记录',
  mineOnly.length > 0 && mineOnly.every((r) => r.sessionId === ME.id));
assert('带其它会话标识：只返回该会话记录（本会话记录不泄漏）',
  foreignOnly.length > 0 && foreignOnly.every((r) => r.sessionId === OTHER.id));
assert('不带会话标识：不返回任何有会话归属的记录（防串会话）',
  noSession.every((r) => r.sessionId === null || r.sessionId === undefined));
assert('all=1 才返回全部（仅排查用）',
  allRecs.length >= mineOnly.length + foreignOnly.length);

// ---- 会话隔离：clear 必须指定会话，不带参数不得清掉任何记录 ----
function callClear(bodyText) {
  const listeners = {};
  const req = { url: '/cmdmon/clear', on(ev, fn) { listeners[ev] = fn; return req; } };
  const res = { writeHead() {}, end(b) { res.body = b; } };
  const done = endpoints.get('/cmdmon/clear')(req, res);
  if (bodyText !== undefined && listeners.data) listeners.data(Buffer.from(bodyText));
  if (listeners.end) listeners.end();
  return Promise.resolve(done).then(() => JSON.parse(res.body));
}
const beforeClear = payload().records.length;
const noArg = await callClear();
assert('clear 不带参数：什么都不清（不再误清全量）',
  noArg.cleared === 'none' && payload().records.length === beforeClear);
await callClear(JSON.stringify({ session: OTHER.id }));
const afterClear = payload().records;
assert('clear 指定会话：只清该会话的记录',
  afterClear.length < beforeClear && afterClear.every((r) => r.sessionId === ME.id));

// 清理
for (const off of offs) { try { off(); } catch (e) { /* noop */ } }
rmSync(workDir, { recursive: true, force: true });

console.log('\n结果: ' + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
