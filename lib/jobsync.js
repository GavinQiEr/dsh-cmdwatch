// dsh-cmdwatch —— 任务 owner 登记与读取错误分类（纯逻辑，可单测，不依赖宿主）
//
// 背景（实测事故）：jobs.read(id, caller) / jobs.get(id, caller) 的权限判定看 caller
// 属于哪个会话。插件原先在 syncJob() 里**无条件** `jobOwners.set(snap.id, jobOwner)`，
// 而 jobOwner 来自 onJobsChanged/onJobDone 的 owner 派发参数——那是"事件发生时的
// 调用者"，跨会话（同一宿主跑多个会话/子代理）就会把别的会话的 agent 写到本会话任务上：
//
//   job:pwsh-37 session=session-3db4d1f5…（记录里的 sessionId 正确）
//   ownerRegistered=true（但 Map 里那条登记是别的会话的 agent）
//   → jobs.read 报 "job pwsh-37 belongs to another session"
//   → 面板零输出、状态永远 running、Tee 日志不清理、diagEvents 每 500ms 被刷满
//
// 规则（对应上面三个后果）：
//   1. 只有"启动该任务的工具调用"（tools/result 里的 exec.agent）是**权威** owner；
//   2. 事件携带的 owner 只做兜底——尚无登记时才写入，**绝不复写**已有登记；
//   3. 读取被拒（caller 会话不符）后不再重试，避免 500ms 刷屏；任务已不在任务库
//      （store 淘汰）时按"状态未知"收尾，而不是永远卡在运行中。

/**
 * 归类 jobs.read / jobs.get 抛出的错误。
 * - `denied`：caller 会话不符或无权限 —— 重试无意义
 * - `gone`：任务已不在任务库 —— 状态无法再确认，应收尾
 * - `other`：临时错误（保留原来的重试与诊断行为）
 * @param {unknown} message
 * @returns {'denied'|'gone'|'other'}
 */
function classifyJobError(message) {
  const m = message === undefined || message === null ? '' : String(message);
  if (/another session|not permitted|permission denied|forbidden|denied|无权限/i.test(m)) return 'denied';
  if (/not found|unknown job|no such job|no longer|expired|evicted|不存在/i.test(m)) return 'gone';
  return 'other';
}

/**
 * jobId → caller Agent 的登记表：权威登记可覆盖，兜底登记只写一次。
 * @returns {{
 *   register: (jobId: string, agent: unknown, authoritative?: boolean) => boolean,
 *   get: (jobId: string) => unknown,
 *   has: (jobId: string) => boolean,
 *   clear: (jobId: string) => boolean,
 *   clearAll: () => void,
 *   readonly size: number
 * }}
 */
function createOwnerRegistry() {
  const owners = new Map();
  return {
    /** @returns {boolean} 是否写入/更新了登记（兜底时已有登记则返回 false） */
    register(jobId, agent, authoritative = false) {
      if (!jobId || !agent) return false;
      if (!authoritative && owners.has(jobId)) return false;
      owners.set(jobId, agent);
      return true;
    },
    get(jobId) { return owners.get(jobId); },
    has(jobId) { return owners.has(jobId); },
    clear(jobId) { return owners.delete(jobId); },
    clearAll() { owners.clear(); },
    get size() { return owners.size; }
  };
}

/**
 * 渲染 jobs.read 的增量文本。兼容两种真实形状：
 *   - 0.1.5+：`{ chunks: [{ text, channel }], lossy, result?, job }`（本次实测的宿主）
 *   - 旧版：`{ text, snapshot }`
 * chunk 渲染规则与官方 `dsh-tool-jobs` 一致：stdout 与无标签块按序拼接，stderr 归并到
 * 一个 `[stderr]` 段；`log` 是给观察者的旁白，不进正文。
 * @param {unknown} read
 * @returns {string}
 */
function renderJobRead(read) {
  if (!read || typeof read !== 'object') return '';
  const r = /** @type {any} */ (read);
  if (typeof r.text === 'string') return r.text; // 旧形状
  const chunks = Array.isArray(r.chunks) ? r.chunks : [];
  const visible = chunks.filter((c) => c && c.channel !== 'log');
  const out = visible.filter((c) => c.channel !== 'stderr').map((c) => (typeof c.text === 'string' ? c.text : '')).join('');
  const err = visible.filter((c) => c.channel === 'stderr').map((c) => (typeof c.text === 'string' ? c.text : '')).join('');
  const separator = out.length > 0 && !out.endsWith('\n') ? '\n' : '';
  return out + (err.length > 0 ? separator + '[stderr]\n' + err : '');
}

/** 读结果里的任务视图：新形状 `read.job`，旧形状 `read.snapshot` */
function jobViewOf(read) {
  if (!read || typeof read !== 'object') return undefined;
  const r = /** @type {any} */ (read);
  if (r.job && typeof r.job === 'object') return r.job;
  if (r.snapshot && typeof r.snapshot === 'object') return r.snapshot;
  return undefined;
}

/** 任务是否已终止（dsh-jobs-local 的 isTerminal 词汇表） */
function isTerminalJobStatus(status) {
  return status === 'completed' || status === 'failed' || status === 'killed';
}

export { classifyJobError, createOwnerRegistry, renderJobRead, jobViewOf, isTerminalJobStatus };
