// dsh-cmdwatch 面板排序/分组单测：node test-order.mjs
import { DONE_LINGER_MS, isLiveRecord, partitionRecords, recordDoneAt, sortRecords } from './client/order.js';

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

// ---- 分组：运行中 / 刚完成（5 秒停留）/ 已完成 ----
const done = (key, startedAt, finishedAt) => ({ key, status: 'completed', startedAt, finishedAt });
const now = 1_000_000;
const groups = partitionRecords([
  rec('run1', 'running', 100),
  rec('run2', 'stopping', 200),
  done('fresh1', 300, now - 1000),     // 完成 1 秒 → 仍留在主表
  done('fresh2', 400, now - 4999),     // 完成 4999ms → 仍留在主表（边界内）
  done('old1', 500, now - 5000),       // 恰好 5000ms → 进已完成组（边界外）
  done('old2', 600, now - 60000)
], now);
assert('运行中一组、刚完成一组、已完成一组',
  groups.live.length === 2 && groups.fresh.length === 2 && groups.done.length === 2);
assert('停留边界：4999ms 留主表，5000ms 进已完成',
  groups.fresh.map((r) => r.key).sort().join() === 'fresh1,fresh2'
  && groups.done.map((r) => r.key).sort().join() === 'old1,old2');
assert('各分组内部按开始时间倒序',
  groups.live[0].key === 'run2' && groups.fresh[0].key === 'fresh2' && groups.done[0].key === 'old2');
assert('DONE_LINGER_MS 默认 5 秒', DONE_LINGER_MS === 5000);
assert('缺 finishedAt 的终态记录直接进已完成组（不会一直占主表）',
  partitionRecords([{ key: 'k', status: 'failed', startedAt: now - 10_000 }], now).done.length === 1);
assert('finishedAt 缺失时 recordDoneAt 退回 startedAt',
  recordDoneAt({ status: 'completed', startedAt: 42 }) === 42 && recordDoneAt({}) === 0);
assert('时钟偏差（完成时刻在未来）按刚完成处理',
  partitionRecords([done('future', 1, now + 5000)], now).fresh.length === 1);
assert('可自定义停留时长', (() => {
  const p = partitionRecords([done('x', 1, now - 1200)], now, 1000);
  return p.done.length === 1 && p.fresh.length === 0;
})());
assert('分组不修改入参且空输入安全',
  (() => { const input = [done('a', 1, now - 99999)]; partitionRecords(input, now); return input[0].key === 'a'; })()
  && partitionRecords(undefined, now).done.length === 0 && partitionRecords(null, now).live.length === 0);

console.log('\n结果: ' + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
