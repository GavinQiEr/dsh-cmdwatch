// dsh-cmdwatch 会话隔离单测：node test-session.mjs
import { createSessionRelay, pickSessionId, sessionSwitchReset } from './client/session.js';

let pass = 0, fail = 0;
const assert = (name, cond) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name);
  cond ? pass++ : fail++;
};

// ---- pickSessionId：不同槽位给字段的方式不同 ----
assert('sessionId 直给', pickSessionId({ sessionId: 'session-a' }) === 'session-a');
assert('zone.sessionId（conversation.input.dock 传 zone）', pickSessionId({ zone: { sessionId: 'session-b' } }) === 'session-b');
assert('session.id', pickSessionId({ session: { id: 'session-c' } }) === 'session-c');
assert('zone.session.id', pickSessionId({ zone: { session: { id: 'session-d' } } }) === 'session-d');
assert('conversationId 兜底', pickSessionId({ conversationId: 'session-e' }) === 'session-e');
assert('sessionId 优先于 zone', pickSessionId({ sessionId: 'session-a', zone: { sessionId: 'session-b' } }) === 'session-a');
assert('root scope 空 props → undefined', pickSessionId({}) === undefined);
assert('undefined / null → undefined', pickSessionId(undefined) === undefined && pickSessionId(null) === undefined);
assert('空串与非法类型 → undefined',
  pickSessionId({ sessionId: '' }) === undefined
  && pickSessionId({ sessionId: 123 }) === undefined
  && pickSessionId({ zone: { sessionId: null } }) === undefined);

// ---- relay：会话级实例 learn，root scope 实例 subscribe ----
const relay = createSessionRelay();
assert('初始为空', relay.current() === undefined);

const seen = [];
const off = relay.subscribe((id) => seen.push(id));
assert('learn 广播给订阅者', relay.learn('session-a') === 'session-a' && seen.join() === 'session-a');
assert('重复 learn 不重复广播', relay.learn('session-a') === 'session-a' && seen.length === 1);
assert('空值被忽略', relay.learn('') === 'session-a' && relay.learn(undefined) === 'session-a' && seen.length === 1);
assert('learn 新会话会广播', relay.learn('session-b') === 'session-b' && seen.join() === 'session-a,session-b');
assert('current 反映最新', relay.current() === 'session-b' && relay.size === 1);
off();
assert('退订后不再接收', relay.learn('session-c') === 'session-c' && seen.length === 2 && relay.size === 0);

const bad = createSessionRelay();
let goodGot = 0;
bad.subscribe(() => { throw new Error('订阅者抛错'); });
bad.subscribe(() => { goodGot++; });
bad.learn('session-x');
assert('单个订阅者抛错不影响其它订阅者', goodGot === 1 && bad.current() === 'session-x');

// ---- 隔离语义：root scope 实例拿不到会话时不得去请求数据 ----
const fresh = createSessionRelay();
const gateWith = (r, props) => {
  const observed = pickSessionId(props);
  return observed !== undefined ? observed : r.current();
};
assert('会话级实例可直接取到会话', gateWith(fresh, { zone: { sessionId: 'session-a' } }) === 'session-a');
assert('root scope 实例在无中继时不取数据（返回 undefined 而非全量）', gateWith(fresh, {}) === undefined);
fresh.learn('session-a');
assert('root scope 实例拿到中继后可取数据', gateWith(fresh, {}) === 'session-a');
assert('会话级实例优先于中继', gateWith(fresh, { sessionId: 'session-z' }) === 'session-z');

// ---- 会话切换：面板要清空并归零游标（否则上个会话的记录会留在面板里混着显示）----
assert('同一会话不重置（避免每次轮询都清空）', sessionSwitchReset('session-a', 'session-a') === null);
const sw = sessionSwitchReset('session-a', 'session-b');
assert('切换会话 → 重置记录与游标',
  sw !== null && sw.seq === 0 && sw.records instanceof Map && sw.records.size === 0 && sw.expanded === null);
assert('从未知会话切到已知会话也重置（面板首次拿到会话时清一次）',
  sessionSwitchReset(undefined, 'session-a') !== null);
assert('切回原会话同样重置（宿主按会话保留，可重新拉回该会话的命令）',
  sessionSwitchReset('session-b', 'session-a') !== null);

console.log('\n结果: ' + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
