// dsh-cmdwatch —— 命令窗（Client 半源码）
//
// 构建：esbuild 打包成 client/client.js（window.__ModuleLoader__.load 格式）
// 数据：通过同源 fetch 轮询 Host 半的 HTTP 端点（/cmdmon/snapshot 等），
//       与 dsh-pocket 的 /dsh-pocket 通道同款方案。
import { createElement as h, useState, useEffect, useRef } from 'react';
import { pickSessionId, createSessionRelay, sessionSwitchReset } from './session.js';
import { isLiveRecord, partitionRecords } from './order.js';

const name = 'dsh-cmdwatch';
const inject = ['slots', 'connection'];

// 会话隔离：shell.overlay 是 root scope 槽位（框架不传会话 share），拿不到 sessionId 的
// 实例绝不能去请求"全部会话"的记录——那正是别的会话命令串进本会话面板的入口。
// 会话级槽位实例把观察到的会话标识交给 relay，root scope 实例订阅它（见 client/session.js）。
const sessionRelay = createSessionRelay();

const CSS = `
.cmdmon { font-size: 12px; color: var(--dsw-alias-label-primary); }
/* 右侧栏：风格与左侧 SidebarRoot 一致（同背景/边框/内边距/滚动条） */
.cmdmon-sidebar-wrap { position: absolute; inset: 0; pointer-events: none; z-index: 25; }
.cmdmon-sidebar { position: absolute; top: 0; right: 0; bottom: 0; width: 340px; max-width: 55vw; padding: 6px 12px; overflow-y: auto; box-sizing: border-box; pointer-events: auto; background: var(--dsw-specific-sidebar-fill); color: var(--dsw-alias-label-primary); border-left: 1px solid var(--dsw-alias-border-l1); --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2); --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2); transition: transform .2s var(--ds-ease-in-out); }
.cmdmon-sidebar.cmdmon-collapsed { transform: translateX(105%); }
.cmdmon-sidebar .cmdmon-body { max-height: none; }
.cmdmon-reopen { position: fixed; right: 0; top: 50%; transform: translateY(-50%); pointer-events: auto; z-index: 26; border: 1px solid var(--dsw-alias-border-l1); border-right: none; border-radius: 6px 0 0 6px; background: var(--dsw-specific-sidebar-fill); color: var(--dsw-alias-label-primary); cursor: pointer; padding: 12px 6px; font-size: 14px; }
/* 折叠把手：面板左边缘悬浮标签（贴面板、垂直居中），不占用头部操作区 */
.cmdmon-collapse { position: absolute; right: 340px; top: 50%; transform: translateY(-50%); pointer-events: auto; z-index: 26; border: 1px solid var(--dsw-alias-border-l1); border-right: none; border-radius: 6px 0 0 6px; background: var(--dsw-specific-sidebar-fill); color: var(--dsw-alias-label-primary); cursor: pointer; padding: 12px 6px; font-size: 14px; }
.cmdmon-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 6px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); }
.cmdmon-toggle { background: none; border: none; color: inherit; cursor: pointer; font-size: 12px; padding: 2px 4px; }
.cmdmon-actions { display: flex; align-items: center; gap: 10px; }
.cmdmon-stream { display: inline-flex; align-items: center; gap: 4px; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.cmdmon-clear { background: none; border: 1px solid var(--dsw-alias-border-l1); border-radius: 4px; color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 11px; padding: 1px 6px; }
.cmdmon-posbtn { background: none; border: 1px solid var(--dsw-alias-border-l1); border-radius: 4px; color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 11px; padding: 1px 6px; }
.cmdmon-body { margin-top: 4px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); max-height: 320px; overflow: auto; }
.cmdmon-empty { padding: 10px; color: var(--dsw-alias-label-secondary); text-align: center; }
/* 「已完成」组：默认收起，位于主表（运行中 + 刚完成）下方 */
.cmdmon-body.cmdmon-done { margin-top: 6px; }
.cmdmon-done-head { padding: 4px 8px; cursor: pointer; color: var(--dsw-alias-label-secondary); font-size: 11px; user-select: none; }
.cmdmon-done-head:hover { background: var(--dsw-alias-bg-layer-2); }
.cmdmon-item { border-bottom: 1px solid var(--dsw-alias-border-l1); }
.cmdmon-item:last-child { border-bottom: none; }
.cmdmon-row { display: flex; align-items: center; gap: 8px; padding: 4px 8px; cursor: pointer; }
.cmdmon-row:hover { background: var(--dsw-alias-bg-layer-2); }
.cmdmon-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.cmdmon-run { background: var(--dsw-alias-brand-primary); animation: cmdmon-blink 1s infinite; }
.cmdmon-warn { background: var(--dsw-alias-state-warn-primary); }
.cmdmon-ok { background: var(--dsw-alias-state-success-primary); }
.cmdmon-err { background: var(--dsw-alias-state-error-primary); }
.cmdmon-mut { background: var(--dsw-alias-label-secondary); }
@keyframes cmdmon-blink { 50% { opacity: 0.35; } }
.cmdmon-cmd { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-family: ui-monospace, Consolas, 'Courier New', monospace; }
.cmdmon-status { flex: none; font-size: 11px; }
.cmdmon-time { flex: none; color: var(--dsw-alias-label-secondary); font-size: 11px; }
.cmdmon-out { margin: 0; padding: 6px 8px; max-height: 200px; overflow: auto; white-space: pre-wrap; word-break: break-all; font-family: ui-monospace, Consolas, 'Courier New', monospace; font-size: 11px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
.cmdmon-badges { flex: none; display: inline-flex; align-items: center; gap: 4px; }
.cmdmon-badge { flex: none; font-size: 10px; line-height: 14px; padding: 0 4px; border-radius: 3px; white-space: nowrap; }
.cmdmon-badge-kind { color: var(--dsw-alias-label-secondary); border: 1px solid var(--dsw-alias-border-l1); }
.cmdmon-badge-warn { color: var(--dsw-alias-state-warn-primary); border: 1px solid var(--dsw-alias-state-warn-primary); }
.cmdmon-warn-line { margin: 0; padding: 4px 8px; font-size: 11px; line-height: 1.5; color: var(--dsw-alias-state-warn-primary); background: var(--dsw-alias-bg-layer-2); border-bottom: 1px solid var(--dsw-alias-border-l1); white-space: pre-wrap; word-break: break-all; }
.cmdmon-orig-line { margin: 0; padding: 4px 8px; font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); border-bottom: 1px solid var(--dsw-alias-border-l1); white-space: pre-wrap; word-break: break-all; }
/* 例行说明（已包装/已注入等）：一行灰字，不占 ⚠ 也不占多行 */
.cmdmon-note-line { margin: 0; padding: 3px 8px; font-size: 10px; line-height: 1.5; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); border-bottom: 1px solid var(--dsw-alias-border-l1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
`;

function shorten(text, maxLen) {
  if (!text) return text;
  const flat = String(text).replace(/\s+/g, ' ').trim();
  if (flat.length <= maxLen) return flat;
  const head = Math.floor(maxLen * 0.6);
  const tail = maxLen - head - 1;
  return flat.slice(0, head) + '…' + flat.slice(-tail);
}

async function snapshot(since, sessionId) {
  const params = new URLSearchParams({ since: String(since) });
  if (sessionId) params.set('session', sessionId);
  const res = await fetch('/cmdmon/snapshot?' + params.toString(), {
    headers: { Accept: 'application/json' }
  });
  if (!res.ok) throw new Error('snapshot ' + res.status);
  return res.json();
}

function CmdMonView({ timer, slotProps, position }) {
  // 隐藏未选中的位置实例（同时不发起轮询）
  const activePos = getActivePosition();
  const active = position === activePos;
  // 会话级槽位（input.dock / composer.dock）能直接从 props 拿到会话标识；
  // root scope 的侧栏实例拿不到，只能等会话级实例把标识交过来（此前这一路缺失，
  // 于是请求不带 session 参数、宿主返回全部会话的记录 → 串会话）。
  const observed = pickSessionId(slotProps);
  const [relayed, setRelayed] = useState(() => sessionRelay.current());
  const session = observed !== undefined ? observed : relayed;
  const [records, setRecords] = useState(new Map());
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState(null);
  const [stream, setStream] = useState(true);
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('cmdmon.sidebarCollapsed') === '1'; } catch (e) { return false; }
  });
  // 「已完成」组展开状态（默认折叠，避免视觉干扰；localStorage 持久化）
  const [doneOpen, setDoneOpen] = useState(() => {
    try { return localStorage.getItem('cmdmon.doneOpen') === '1'; } catch (e) { return false; }
  });
  const seqRef = useRef(0);
  const outRef = useRef(null);
  // 右侧栏折叠/展开（localStorage 持久化，只对 sidebar 位置生效）
  const toggleCollapse = () => {
    setCollapsed((c) => {
      const next = !c;
      try { localStorage.setItem('cmdmon.sidebarCollapsed', next ? '1' : '0'); } catch (e) { /* noop */ }
      return next;
    });
  };
  const toggleDone = () => {
    setDoneOpen((v) => {
      const next = !v;
      try { localStorage.setItem('cmdmon.doneOpen', next ? '1' : '0'); } catch (e) { /* noop */ }
      return next;
    });
  };

  // 每秒重渲染一次：让"完成后停留 5 秒"到期时自动折叠进「已完成」组
  // （空闲时轮询不会触发重渲染，所以需要这个时钟）
  const [, setClock] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setClock((n) => n + 1), 1000);
    return () => clearInterval(iv);
  }, []);

  // 看到会话标识就交给 relay，看不到就订阅（未选中位置的隐藏实例 hooks 照常运行）
  useEffect(() => {
    if (observed !== undefined) {
      sessionRelay.learn(observed);
      setRelayed(observed);
      return undefined;
    }
    setRelayed(sessionRelay.current());
    return sessionRelay.subscribe((id) => setRelayed(id));
  }, [observed]);

  // 会话切换：清掉上一个会话累积的记录并归零游标，面板随之刷新为当前会话的内容；
  // 宿主按会话保留记录，所以切回去时 `since=0` 会把该会话的命令重新拉回来。
  const sessionRef = useRef(session);
  useEffect(() => {
    const reset = sessionSwitchReset(sessionRef.current, session);
    if (!reset) return;
    sessionRef.current = session;
    seqRef.current = reset.seq;
    setRecords(reset.records);
    setExpanded(reset.expanded);
  }, [session]);

  useEffect(() => {
    if (!active) return; // 隐藏实例不轮询
    if (session === undefined) return; // 还不知道是哪个会话：宁可不显示，也不串会话
    const tick = async () => {
      try {
        const res = await snapshot(seqRef.current, session);
        if (!res) return;
        // 请求飞行期间可能已经切换会话：过期响应直接丢弃，别把上一个会话的记录
        // 塞进刚清空的面板
        if (sessionRef.current !== session) return;
        if (typeof res.seq === 'number') seqRef.current = res.seq;
        if (typeof res.streamEnabled === 'boolean') setStream(res.streamEnabled);
        if (Array.isArray(res.records) && res.records.length > 0) {
          setRecords((prev) => {
            const next = new Map(prev);
            for (const r of res.records) next.set(r.key, r);
            return next;
          });
        }
      } catch (err) { /* 轮询错误忽略 */ }
    };
    if (timer && typeof timer.interval === 'function') {
      const off = timer.interval(tick, 700);
      tick(); // 会话切换后立即拉一次，面板即时刷新（不必等 700ms）
      return off;
    }
    const iv = setInterval(tick, 700);
    tick();
    return () => clearInterval(iv);
  }, [active, session]);

  // 输出区自动滚动到最新一行
  useEffect(() => {
    if (outRef.current) outRef.current.scrollTop = outRef.current.scrollHeight;
  }, [records, expanded]);

  // 运行中/停止中的记录置顶；完成 5 秒后自动折叠进下方「已完成」组（见 client/order.js）
  const partitioned = partitionRecords([...records.values()], Date.now());
  const liveItems = [...partitioned.live, ...partitioned.fresh];
  const doneItems = partitioned.done;
  const running = partitioned.live.length;
  const statusLabel = (s) => ({
    running: '运行中', stopping: '停止中', completed: '完成',
    killed: '已终止', failed: '失败'
  }[s] || s);
  const statusCls = (s) => ({
    running: 'cmdmon-run', stopping: 'cmdmon-warn', completed: 'cmdmon-ok',
    killed: 'cmdmon-mut', failed: 'cmdmon-err'
  }[s] || 'cmdmon-mut');
  const fmtTime = (r) => {
    if (!r.startedAt) return '';
    const d = new Date(r.startedAt);
    const p = (n) => String(n).padStart(2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  };
  const toggle = (key) => setExpanded((prev) => (prev === key ? null : key));
  // 行标题：原始命令 + 警示
  const cmdTitle = (r) => {
    const lines = [];
    if (r.originalCommand) lines.push('原始命令：' + r.originalCommand);
    if (r.changed) lines.push('（命令已被插件包装 Tee 实时输出，原管道语义保留：-Last/Out-File/Get-Content 等结果不变）');
    if (Array.isArray(r.warnings)) for (const w of r.warnings) lines.push('⚠ ' + w);
    if (Array.isArray(r.notes)) for (const n of r.notes) lines.push('· ' + n);
    return lines.length ? lines.join('\n') : r.command;
  };
  const doClear = async () => {
    // 只清自己的会话：拿不到会话标识时不清（避免误清其它会话的记录）
    if (session === undefined) return;
    try {
      const res = await fetch('/cmdmon/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session })
      }).then((r) => r.json());
      setRecords(new Map());
      if (res && typeof res.seq === 'number') seqRef.current = res.seq;
    } catch (err) { /* noop */ }
  };
  const doStream = async (enabled) => {
    setStream(enabled);
    try {
      await fetch('/cmdmon/setStream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled })
      });
    } catch (err) { /* noop */ }
  };
  // 切换面板位置（顶/底/右 循环），持久化到 localStorage 后 reload 让三个 mount 按新值渲染
  const doSwitchPosition = () => setActivePosition(nextPosition(position));
  const posLabel = position === 'sidebar' ? '右侧' : '底部';

  // 未选中位置 → 不渲染（也不轮询，上面 useEffect 已 gate）
  if (!active) return null;

  // 单条记录（主表与「已完成」组共用同一渲染）
  const rowOf = (r) => h('div', { className: 'cmdmon-item', key: r.key },
    h('div', { className: 'cmdmon-row', onClick: () => toggle(r.key) },
      h('span', { className: 'cmdmon-dot ' + statusCls(r.status) }),
      h('span', { className: 'cmdmon-badges' },
        h('span', {
          className: 'cmdmon-badge cmdmon-badge-kind',
          title: r.kind === 'job' ? '后台任务记录：实时输出显示在此行（点击展开）' : '工具调用记录：后台任务的实时输出在对应的「任务」行'
        }, r.kind === 'job' ? '任务' : '工具'),
        // 「实时」「改」徽标已按需求收掉：包装/实时信息改为悬停提示（原始命令 + 例行说明）
        // 与展开行里的一行说明，行上只保留类型与真问题（⚠）
        Array.isArray(r.warnings) && r.warnings.length > 0
          ? h('span', { className: 'cmdmon-badge cmdmon-badge-warn', title: r.warnings.join('\n') }, '⚠')
          : null
      ),
      h('span', { className: 'cmdmon-cmd', title: cmdTitle(r) }, shorten(r.command, 100)),
      h('span', { className: 'cmdmon-status ' + statusCls(r.status) }, statusLabel(r.status)),
      h('span', { className: 'cmdmon-time' }, fmtTime(r))
    ),
    expanded === r.key && h('div', { className: 'cmdmon-detail' },
      Array.isArray(r.warnings) && r.warnings.map((w) => h('div', { className: 'cmdmon-warn-line', key: w }, '⚠ ' + w)),
      r.changed && r.originalCommand && h('div', { className: 'cmdmon-orig-line' }, '原始命令：' + r.originalCommand),
      // 例行说明（已包装 Tee / 已注入 PYTHONUNBUFFERED 等）：一行灰字，不挂 ⚠
      Array.isArray(r.notes) && r.notes.length > 0
        ? h('div', { className: 'cmdmon-note-line', title: r.notes.join(' · ') }, r.notes.join(' · '))
        : null,
      r.kind === 'job' && r.status === 'running' && r.ownerRegistered === false
        ? h('div', { className: 'cmdmon-warn-line' }, '⚠ 诊断：任务 owner 未登记，插件无法读取输出（实时流不可用）')
        : null,
      r.readError
        ? h('div', { className: 'cmdmon-warn-line' }, '⚠ 诊断：读取失败 ' + r.readError)
        : null,
      r.kind === 'tool' && r.status === 'running'
        ? h('div', { className: 'cmdmon-orig-line' },
            r.fgStream ? '前台命令实时输出（Tee 捕获），正在流式显示' : '工具调用记录：后台任务的实时输出请展开下方对应的「任务」行')
        : null,
      h('pre', { ref: outRef, className: 'cmdmon-out' },
        (r.output || '(无输出)') + (r.truncated ? '\n…[输出已截断]' : '')
      )
    )
  );

  const panel = h('div', { className: 'cmdmon' + (position === 'sidebar' ? ' cmdmon-sidebar' + (collapsed ? ' cmdmon-collapsed' : '') : '') },
    h('div', { className: 'cmdmon-head' },
      h('button', {
        className: 'cmdmon-toggle',
        title: session === undefined
          ? '等待会话标识：面板只显示当前会话的命令'
          : '只显示当前会话的命令（会话：' + session + '）',
        onClick: () => setOpen((v) => !v)
      }, (open ? '▾' : '▸') + ' 命令监视' + (running > 0 ? ' (' + running + ' 运行中)' : '')),
      h('div', { className: 'cmdmon-actions' },
        h('button', {
          className: 'cmdmon-posbtn',
          title: '切换面板位置（底部 / 右侧 循环）',
          onClick: doSwitchPosition
        }, '↕ ' + posLabel),
        h('label', { className: 'cmdmon-stream', title: '开启后插件主动读取后台任务输出流（dsh 的 job_output 可能读到空增量）' },
          h('input', { type: 'checkbox', checked: stream, onChange: (e) => doStream(e.target.checked) }),
          ' 实时流'
        ),
        h('button', { className: 'cmdmon-clear', onClick: doClear }, '清空')
      )
    ),
    // 主表：运行中 + 刚完成（5 秒停留期内）
    open && h('div', { className: 'cmdmon-body' },
      liveItems.length === 0
        ? h('div', { className: 'cmdmon-empty' },
            session === undefined
              ? '（等待会话标识：只显示本会话的命令，拿不到会话信息时保持为空）'
              : (doneItems.length > 0 ? '当前没有运行中的命令' : '暂无命令执行记录'))
        : liveItems.map(rowOf)
    ),
    // 已完成组：完成 5 秒后自动折叠到这里，默认收起（避免视觉干扰）
    open && doneItems.length > 0 && h('div', { className: 'cmdmon-body cmdmon-done' },
      h('div', {
        className: 'cmdmon-done-head',
        title: '已完成记录（完成后 5 秒自动收到这里），点击展开/收起',
        onClick: toggleDone
      }, (doneOpen ? '▾' : '▸') + ' 已完成 (' + doneItems.length + ')'),
      doneOpen && doneItems.map(rowOf)
    )
  );

  // sidebar：包一层 wrapper；折叠按钮是面板左边缘的悬浮标签（垂直居中），
  // 折叠后面板滑出屏幕、右侧边缘浮现「«」重新展开按钮
  if (position === 'sidebar') {
    return h('div', { className: 'cmdmon-sidebar-wrap' },
      panel,
      collapsed
        ? h('button', { className: 'cmdmon-reopen', title: '展开命令监视（右侧栏）', onClick: toggleCollapse }, '«')
        : h('button', { className: 'cmdmon-collapse', title: '折叠命令监视（右侧栏）', onClick: toggleCollapse }, '»')
    );
  }
  return panel;
}

// 面板位置：'top'（输入框上方）/ 'bottom'（输入框下方 composer.dock）/
//          'sidebar'（右侧悬浮栏，注入 shell.overlay 列表 slot）。
// 注意：不能注入 'details'——它是 single slot，已被会话的 DetailsPanel 占用，
// 抢占会导致面板整体消失。'shell.overlay' 是 list 型 overlay 层（可交互、可共存）。
// 用 localStorage 持久化用户选择；同时注入三个位置，未选中的隐藏。
const POSITIONS = {
  top: 'conversation.input.dock',
  bottom: 'conversation.composer.dock',
  sidebar: 'shell.overlay'
};
function getActivePosition() {
  try { const v = localStorage.getItem('cmdmon.position'); if (v === 'bottom' || v === 'sidebar') return v; } catch (e) { /* noop */ }
  return 'bottom';
}
function nextPosition(cur) { return cur === 'sidebar' ? 'bottom' : 'sidebar'; }
function setActivePosition(p) {
  try { localStorage.setItem('cmdmon.position', p); } catch (e) { /* noop */ }
  // 简单可靠：触发 reload 让三个 mount 按新值渲染（注入在 apply 一次性完成）
  try { window.location.reload(); } catch (e) { /* noop */ }
}

function apply(ctx) {
  // 注入样式（静态 Client 半没有 styles builtin，用 style 标签，参照 dsh-pocket）
  const tagId = 'dsh-cmdwatch/style.css';
  if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="' + tagId + '"]') === null) {
    const tag = document.createElement('style');
    tag.dataset.plugin = 'dsh-cmdwatch';
    tag.dataset.pluginCss = tagId;
    tag.textContent = CSS;
    document.head.appendChild(tag);
  }
  const slots = ctx.slots;
  const timer = ctx.get('timer');
  // 两个位置都注入；CmdMonView 内部根据 active position 决定显示/隐藏，
  // 隐藏的实例直接 return null、不发起轮询（但 hooks 照常运行，会话级实例
  // 因此仍能把 sessionId 交给 relay 供右侧栏实例使用）。
  for (const pos of ['bottom', 'sidebar']) {
    const slotName = POSITIONS[pos];
    ctx.slots.inject(slotName, () => slots.register(
      {
        name: slotName,
        id: 'cmdmon-' + pos,
        order: pos === 'sidebar' ? 90 : 30,
        priority: -1,
        label: pos === 'bottom' ? '命令监视(下)' : '命令监视(右侧)'
      },
      (props) => h(CmdMonView, { timer, slotProps: props, position: pos })
    ));
  }
}

export { name, inject, apply };
