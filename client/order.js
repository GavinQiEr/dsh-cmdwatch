// dsh-cmdwatch —— 面板排序（纯逻辑，可单测，不依赖 DOM/宿主）
//
// 规则：**运行中（running）/ 停止中（stopping）的记录置顶**，其余按开始时间倒序
// （新命令在上）。同级内保持"新的在上"，时间相同则维持原有顺序（Array.sort 稳定）。
// 置顶对"工具记录"（前台命令）和"任务记录"（后台任务）一视同仁 —— 两者都可能正在跑。

/** 该记录是否处于"正在进行"状态 */
function isLiveRecord(record) {
  if (!record) return false;
  return record.status === 'running' || record.status === 'stopping';
}

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
    return (b && b.startedAt ? b.startedAt : 0) - (a && a.startedAt ? a.startedAt : 0);
  });
}

export { isLiveRecord, sortRecords };
