// dsh-cmdwatch —— 会话标识解析与传递（纯逻辑，可单测，不依赖宿主/DOM）
//
// 为什么需要：面板要"只显示本会话的命令"，就必须知道自己是哪个会话。
// DSH 客户端槽位分 scope：
//   - conversation.input.dock / conversation.composer.dock 等 scope=session 的槽位，
//     框架会把会话 share（sessionId 等）注入组件 props —— 面板能拿到会话标识；
//   - shell.overlay 是 scope=root（`renderSlot("shell.overlay", {})`），**没有任何会话
//     share** —— 挂在右侧栏的面板此前拿不到 sessionId，于是 /cmdmon/snapshot 请求不带
//     session 参数，宿主返回全部会话的记录，别的会话的命令就串进了本会话面板。
//
// 解法：模块级 relay —— 会话级实例（即使因为未选中位置而渲染成 null，hooks 照常运行）
// 把观察到的 sessionId 交给 relay，root scope 的侧栏实例订阅它。同一页面只有一份模块
// 实例，因此 relay 天然是"当前标签页"的会话；拿不到任何会话标识时**不发请求**，
// 宁可空着也不串会话。

/** 从槽位 props 里解析会话标识（框架在不同槽位/版本下给的字段名不完全一致） */
function pickSessionId(props) {
  if (!props || typeof props !== 'object') return undefined;
  const zone = props.zone && typeof props.zone === 'object' ? props.zone : undefined;
  const session = props.session && typeof props.session === 'object' ? props.session : undefined;
  const candidates = [
    props.sessionId,
    zone && zone.sessionId,
    session && session.id,
    zone && zone.session && zone.session.id,
    props.conversationId,
    zone && zone.conversationId
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
  }
  return undefined;
}

/** 会话标识中转：会话级实例 learn()，root scope 实例 subscribe()/current() */
function createSessionRelay() {
  let current;
  const listeners = new Set();
  return {
    /** @returns {string|undefined} 记录后的会话标识（空值忽略，不广播） */
    learn(id) {
      if (typeof id !== 'string' || id.length === 0) return current;
      if (id === current) return current;
      current = id;
      for (const fn of [...listeners]) {
        try { fn(current); } catch (e) { /* 订阅者异常不影响其它订阅者 */ }
      }
      return current;
    },
    current() { return current; },
    /** @returns {() => void} 退订 */
    subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    get size() { return listeners.size; }
  };
}

/**
 * 会话切换时面板要重置的本地状态。
 * 面板按会话增量累积记录（Map），切换会话必须清空，否则上一个会话的命令会继续留在面板里
 * 混着显示；游标也要归零，才能用 `since=0` 重新拉取新会话的**全部**历史记录（宿主按会话
 * 保留记录，所以切回去还能看到该会话的命令）。
 * @param {string|undefined} prevSession
 * @param {string|undefined} nextSession
 * @returns {{seq: number, records: Map<string, unknown>, expanded: null}|null} null = 无需重置
 */
function sessionSwitchReset(prevSession, nextSession) {
  if (prevSession === nextSession) return null;
  return { seq: 0, records: new Map(), expanded: null };
}

export { pickSessionId, createSessionRelay, sessionSwitchReset };
