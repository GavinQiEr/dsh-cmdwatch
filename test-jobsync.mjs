// dsh-cmdwatch 任务 owner 登记单测：node test-jobsync.mjs
import { classifyJobError, createOwnerRegistry, isTerminalJobStatus, jobViewOf, renderJobRead } from './lib/jobsync.js';

let pass = 0, fail = 0;
const assert = (name, cond) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name);
  cond ? pass++ : fail++;
};

// ---- 回归：跨会话事件不得顶掉权威 owner（0.5.1 实测事故）----
// caller 的真实语义是**会话 id 字符串**（dsh-jobs-local：`job.owner.id !== caller`），
// 登记表里存的也必须是 id 字符串——传 Agent 对象会被一律拒绝（0.5.2 前的真根因）。
const foreign = 'session-other';
const mine = 'session-me';

// 场景：onJobsChanged 先到（兜底登记了别的会话的 agent），随后 tools/result 权威注册
const r1 = createOwnerRegistry();
assert('兜底登记可填补空缺', r1.register('pwsh-37', foreign, false) === true);
assert('兜底值已写入', r1.get('pwsh-37') === foreign);
assert('权威登记可覆盖兜底值', r1.register('pwsh-37', mine, true) === true);
assert('权威值生效', r1.get('pwsh-37') === mine);

// 又一个跨会话事件到来：绝不能把权威 owner 顶掉
assert('重复兜底登记被忽略', r1.register('pwsh-37', foreign, false) === false);
assert('跨会话事件不再顶掉权威 owner', r1.get('pwsh-37') === mine);

// 端到端：权限判定按 caller 的会话执行，任务只认它自己的会话
const read = (registry, id, caller, ownerSession) => {
  if (registry.get(id) !== caller) throw new Error(`job ${id} belongs to another session`);
  return `${ownerSession}:output`;
};
assert('修复后本会话读取成功', read(r1, 'pwsh-37', mine, 'session-me') === 'session-me:output');

// 对照：只有兜底登记（错误 owner）时读取被拒——就是修复前的现象
const r2 = createOwnerRegistry();
r2.register('pwsh-44', foreign, false);
let denied = '';
try { read(r2, 'pwsh-44', mine, 'session-me'); } catch (e) { denied = e.message; }
assert('错误 owner 下读取被拒（复现原故障）', denied === 'job pwsh-44 belongs to another session');

// ---- 其它登记语义 ----
const r3 = createOwnerRegistry();
assert('缺 jobId 不登记', r3.register(undefined, mine, true) === false);
assert('缺 agent 不登记', r3.register('pwsh-1', null, true) === false);
assert('未登记时 has=false', r3.has('pwsh-1') === false);
r3.register('pwsh-1', mine, true);
assert('登记后 has=true / size=1', r3.has('pwsh-1') && r3.size === 1);
assert('clear 单条', r3.clear('pwsh-1') === true && r3.has('pwsh-1') === false);
r3.register('pwsh-2', mine, true);
r3.register('pwsh-3', mine, true);
r3.clearAll();
assert('clearAll 清空', r3.size === 0);

// ---- 错误归类 ----
assert('another session → denied', classifyJobError('job pwsh-37 belongs to another session') === 'denied');
assert('permission denied → denied', classifyJobError('permission denied') === 'denied');
assert('中文无权限 → denied', classifyJobError('无权限读取该任务') === 'denied');
assert('not found → gone', classifyJobError('job pwsh-9 not found') === 'gone');
assert('unknown job → gone', classifyJobError('unknown job pwsh-9') === 'gone');
assert('超时 → other', classifyJobError('read timeout') === 'other');
assert('空错误 → other', classifyJobError(undefined) === 'other' && classifyJobError(null) === 'other');

// ---- jobs.read 结果渲染（真实形状 chunks / 旧形状 text）----
assert('新形状：stdout 块按序拼接',
  renderJobRead({ chunks: [{ text: 'a\n', channel: 'stdout' }, { text: 'b\n' }] }) === 'a\nb\n');
assert('新形状：stderr 归并到 [stderr] 段',
  renderJobRead({ chunks: [{ text: 'out\n', channel: 'stdout' }, { text: 'boom\n', channel: 'stderr' }] }) === 'out\n[stderr]\nboom\n');
assert('新形状：log 旁白不进正文',
  renderJobRead({ chunks: [{ text: 'x\n', channel: 'stdout' }, { text: 'narration', channel: 'log' }] }) === 'x\n');
assert('新形状：stderr 前补换行',
  renderJobRead({ chunks: [{ text: 'out', channel: 'stdout' }, { text: 'e', channel: 'stderr' }] }) === 'out\n[stderr]\ne');
assert('旧形状：直接取 text', renderJobRead({ text: 'legacy\n' }) === 'legacy\n');
assert('空/非法输入 → 空串',
  renderJobRead(undefined) === '' && renderJobRead(null) === '' && renderJobRead({ chunks: [] }) === '');

// ---- 读结果里的任务视图 ----
assert('新形状取 read.job', jobViewOf({ chunks: [], job: { status: 'completed' } }).status === 'completed');
assert('旧形状取 read.snapshot', jobViewOf({ text: '', snapshot: { status: 'failed' } }).status === 'failed');
assert('两者都无 → undefined', jobViewOf({ chunks: [] }) === undefined && jobViewOf(undefined) === undefined);

// ---- 终止状态词汇表（dsh-jobs-local 的 isTerminal）----
assert('completed/failed/killed 为终止',
  isTerminalJobStatus('completed') && isTerminalJobStatus('failed') && isTerminalJobStatus('killed'));
assert('running/stopping 未终止',
  !isTerminalJobStatus('running') && !isTerminalJobStatus('stopping') && !isTerminalJobStatus(undefined));

console.log('\n结果: ' + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
