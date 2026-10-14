// dsh-cmdwatch 面板排序单测：node test-order.mjs
import { isLiveRecord, sortRecords } from './client/order.js';

let pass = 0, fail = 0;
const assert = (name, cond) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name);
  cond ? pass++ : fail++;
};

const rec = (key, status, startedAt) => ({ key, status, startedAt });

// ---- 运行中置顶 ----
const list = [
  rec('c1', 'completed', 3000),
  rec('r1', 'running', 1000),   // 开始最早，但正在运行 → 应置顶
  rec('c2', 'completed', 4000),
  rec('r2', 'running', 2000)
];
const sorted = sortRecords(list);
assert('运行中置顶（即使开始时间最早）',
  sorted[0].key === 'r2' && sorted[1].key === 'r1');
assert('运行中内部仍按开始时间倒序（新的在前）', sorted[0].startedAt > sorted[1].startedAt);
assert('其余按开始时间倒序', sorted[2].key === 'c2' && sorted[3].key === 'c1');

// ---- stopping 也算"进行中" ----
const s2 = sortRecords([rec('c', 'completed', 9000), rec('s', 'stopping', 1)]);
assert('stopping 与 running 同属置顶区', s2[0].key === 's' && isLiveRecord(s2[0]));

// ---- 其它状态不置顶 ----
const s3 = sortRecords([
  rec('a', 'killed', 5000), rec('b', 'failed', 6000), rec('c', 'unknown', 7000), rec('d', 'completed', 100)
]);
assert('failed/killed/unknown 都不置顶，按时间倒序',
  s3.map((r) => r.key).join() === 'c,b,a,d');

// ---- 稳定与不可变 ----
const tie = [rec('t1', 'completed', 1000), rec('t2', 'completed', 1000), rec('t3', 'completed', 1000)];
assert('时间相同保持原顺序（稳定排序）', sortRecords(tie).map((r) => r.key).join() === 't1,t2,t3');
assert('不修改入参数组', list.map((r) => r.key).join() === 'c1,r1,c2,r2');

// ---- 边界 ----
assert('空数组安全', sortRecords([]).length === 0);
assert('非数组安全', sortRecords(undefined).length === 0 && sortRecords(null).length === 0);
assert('缺少 startedAt 视为 0',
  sortRecords([rec('x', 'completed', undefined), rec('y', 'completed', 5)])[0].key === 'y');
assert('isLiveRecord 判定', isLiveRecord(rec('a', 'running', 1)) && isLiveRecord(rec('b', 'stopping', 1))
  && !isLiveRecord(rec('c', 'completed', 1)) && !isLiveRecord(null));

console.log('\n结果: ' + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
