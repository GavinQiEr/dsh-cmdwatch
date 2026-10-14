// dsh-cmdwatch —— 面板排序与分组（纯逻辑，可单测，不依赖 DOM/宿主）
//
// 规则：
//   1. **运行中（running）/ 停止中（stopping）的记录置顶**；
//   2. 刚完成的记录在主表里**停留 5 秒**（让人看到状态翻转与结果），随后自动折叠进
//      下方「已完成」组；主表与已完成组内部都按开始时间倒序（新命令在上）。
// 置顶/分组对"工具记录"（前台命令）和"任务记录"（后台任务）一视同仁。

/** 完成后在主表停留的时长（毫秒） */
const DONE_LINGER_MS = 5000;

/** 该记录是否处于"正在进行"状态 */
function isLiveRecord(record) {
  if (!record) return false;
  return record.status === 'running' || record.status === 'stopping';
}

/** 记录的完成时刻（缺 finishedAt 时退回 startedAt；再缺就是 0 = 视为很久以前） */
function recordDoneAt(record) {
  if (!record) return 0;
  return record.finishedAt || record.startedAt || 0;
}

const byStartDesc = (a, b) => ((b && b.startedAt) || 0) - ((a && a.startedAt) || 0);

/**
 * 面板排序：运行中置顶，其余按 startedAt 倒序。
 * @param {Array<object>} records
 * @returns {Array<object>} 新数组（不修改入参）
 */
function sortRecords(records) {
  const list = Array.isArray(records) ? [...records] : [];
  return list.sort((a, b) => {
    const liveA = isLiveRecord(a) ? 0 : 1;
    const liveB = isLiveRecord(b) ? 0 : 1;
    if (liveA !== liveB) return liveA - liveB;
    return byStartDesc(a, b);
  });
}

/**
 * 把记录分成三段：运行中 / 刚完成（还在主表停留期内）/ 已完成（折叠进下方组）。
 * @param {Array<object>} records
 * @param {number} now 当前时间（毫秒）
 * @param {number} [lingerMs] 停留时长，默认 5000
 * @returns {{live: Array<object>, fresh: Array<object>, done: Array<object>}} 各组均已按开始时间倒序
 */
function partitionRecords(records, now, lingerMs = DONE_LINGER_MS) {
  const live = [];
  const fresh = [];
  const done = [];
  const at = typeof now === 'number' ? now : Date.now();
  for (const r of Array.isArray(records) ? records : []) {
    if (isLiveRecord(r)) { live.push(r); continue; }
    // 停留期内（含时钟偏差导致的"未来完成时刻"）算刚完成
    if (at - recordDoneAt(r) < lingerMs) fresh.push(r);
    else done.push(r);
  }
  return {
    live: live.sort(byStartDesc),
    fresh: fresh.sort(byStartDesc),
    done: done.sort(byStartDesc)
  };
}

/**
 * 顶部运行中记录的**自动展开**决策。
 * 规则：只看主表最上面那条运行中的记录；已经被用户手动收起过的那条不再自动展开
 * （尊重手动操作）；已经展开的不重复动作；没有运行中的记录时**不动**（用户正看完成
 * 结果时不要抢走展开态）。
 * @param {object} state
 * @param {string|null} state.current 当前展开的记录 key
 * @param {string|undefined} state.topLiveKey 主表最上面那条运行中记录的 key
 * @param {string|null} state.manualCollapsedKey 被用户手动收起的 key
 * @returns {string|undefined} 要展开的 key；undefined = 保持现状
 */
function nextAutoExpand({ current, topLiveKey, manualCollapsedKey }) {
  if (!topLiveKey) return undefined;
  if (manualCollapsedKey === topLiveKey) return undefined;
  if (current === topLiveKey) return undefined;
  return topLiveKey;
}

/** 单项展开/收起：点同一条则收起，点别的则切换过去（记录行与"原始命令"共用） */
function toggleExpanded(current, key) {
  return current === key ? null : key;
}

export { DONE_LINGER_MS, isLiveRecord, recordDoneAt, sortRecords, partitionRecords, nextAutoExpand, toggleExpanded };
