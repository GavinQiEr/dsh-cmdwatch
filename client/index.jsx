// dsh-cmdwatch —— 命令窗（Client 半源码）
//
// 构建：esbuild 打包成 client/client.js（window.__ModuleLoader__.load 格式）
// 数据：通过同源 fetch 轮询 Host 半的 HTTP 端点（/cmdmon/snapshot 等），
//       与 dsh-pocket 的 /dsh-pocket 通道同款方案。
import { createElement as h, useState, useEffect, useRef } from 'react';

const name = 'dsh-cmdwatch';
const inject = ['slots', 'connection'];

const CSS = `
.cmdmon { font-size: 12px; color: var(--dsw-alias-label-primary); }
/* 右侧栏：风格与左侧 SidebarRoot 一致（同背景/边框/内边距/滚动条） */
.cmdmon-sidebar-wrap { position: absolute; inset: 0; pointer-events: none; z-index: 25; }
.cmdmon-sidebar { position: absolute; top: 0; right: 0; bottom: 0; width: 340px; max-width: 55vw; padding: 6px 12px; overflow-y: auto; box-sizing: border-box; pointer-events: auto; background: var(--dsw-specific-sidebar-fill); color: var(--dsw-alias-label-primary); border-left: 1px solid var(--dsw-alias-border-l1); --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2); --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2); transition: transform .2s var(--ds-ease-in-out); }
.cmdmon-sidebar.cmdmon-collapsed { transform: translateX(105%); }
.cmdmon-sidebar .cmdmon-body { max-height: none; }
.cmdmon-reopen { position: fixed; right: 0; top: 50%; transform: translateY(-50%); pointer-events: auto; z-index: 26; border: 1px solid var(--dsw-alias-border-l1); border-right: none; border-radius: 6px 0 0 6px; background: var(--dsw-specific-sidebar-fill); color: var(--dsw-alias-label-primary); cursor: pointer; padding: 12px 6px; font-size: 14px; }
.cmdmon-collapse { background: none; border: 1px solid var(--dsw-alias-border-l1); border-radius: 4px; color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 11px; padding: 1px 6px; }
.cmdmon-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 6px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); }
.cmdmon-toggle { background: none; border: none; color: inherit; cursor: pointer; font-size: 12px; padding: 2px 4px; }
.cmdmon-actions { display: flex; align-items: center; gap: 10px; }
.cmdmon-stream { display: inline-flex; align-items: center; gap: 4px; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.cmdmon-clear { background: none; border: 1px solid var(--dsw-alias-border-l1); border-radius: 4px; color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 11px; padding: 1px 6px; }
.cmdmon-posbtn { background: none; border: 1px solid var(--dsw-alias-border-l1); border-radius: 4px; color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 11px; padding: 1px 6px; }
.cmdmon-body { margin-top: 4px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); max-height: 320px; overflow: auto; }
.cmdmon-empty { padding: 10px; color: var(--dsw-alias-label-secondary); text-align: center; }
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
.cmdmon-badge-fg { color: var(--dsw-alias-brand-primary); border: 1px solid var(--dsw-alias-brand-primary); }
.cmdmon-badge-warn { color: var(--dsw-alias-state-warn-primary); border: 1px solid var(--dsw-alias-state-warn-primary); }
.cmdmon-badge-rewrite { color: #fff; background: var(--dsw-alias-state-warn-primary); }
.cmdmon-warn-line { margin: 0; padding: 4px 8px; font-size: 11px; line-height: 1.5; color: var(--dsw-alias-state-warn-primary); background: var(--dsw-alias-bg-layer-2); border-bottom: 1px solid var(--dsw-alias-border-l1); white-space: pre-wrap; word-break: break-all; }
.cmdmon-orig-line { margin: 0; padding: 4px 8px; font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); border-bottom: 1px solid var(--dsw-alias-border-l1); white-space: pre-wrap; word-break: break-all; }
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

function CmdMonView({ timer, sessionId, position }) {
  // 隐藏未选中的位置实例（同时不发起轮询）
  const activePos = getActivePosition();
  const active = position === activePos;
  const [records, setRecords] = useState(new Map());
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState(null);
  const [stream, setStream] = useState(true);
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('cmdmon.sidebarCollapsed') === '1'; } catch (e) { return false; }
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

  useEffect(() => {
    if (!active) return; // 隐藏实例不轮询
    const tick = async () => {
      try {
        const res = await snapshot(seqRef.current, sessionId);
        if (!res) return;
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
      return timer.interval(tick, 700);
    }
    const iv = setInterval(tick, 700);
    return () => clearInterval(iv);
  }, [active]);

  // 输出区自动滚动到最新一行
  useEffect(() => {
    if (outRef.current) outRef.current.scrollTop = outRef.current.scrollHeight;
  }, [records, expanded]);

  const items = [...records.values()].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  const running = items.filter((r) => r.status === 'running' || r.status === 'stopping').length;
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
    return lines.length ? lines.join('\n') : r.command;
  };
  const doClear = async () => {
    try {
      const body = sessionId ? JSON.stringify({ session: sessionId }) : '{}';
      const res = await fetch('/cmdmon/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
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
  const posLabel = position === 'top' ? '顶部' : position === 'bottom' ? '底部' : '右侧';

  // 未选中位置 → 不渲染（也不轮询，上面 useEffect 已 gate）
  if (!active) return null;

  const panel = h('div', { className: 'cmdmon' + (position === 'sidebar' ? ' cmdmon-sidebar' + (collapsed ? ' cmdmon-collapsed' : '') : '') },
    h('div', { className: 'cmdmon-head' },
      h('button', {
        className: 'cmdmon-toggle',
        onClick: () => setOpen((v) => !v)
      }, (open ? '▾' : '▸') + ' 命令监视' + (running > 0 ? ' (' + running + ' 运行中)' : '')),
      h('div', { className: 'cmdmon-actions' },
        h('button', {
          className: 'cmdmon-posbtn',
          title: '切换面板位置（顶部 / 底部 / 右侧 循环）',
          onClick: doSwitchPosition
        }, '↕ ' + posLabel),
        position === 'sidebar'
          ? h('button', {
              className: 'cmdmon-collapse',
              title: collapsed ? '展开右侧栏' : '折叠右侧栏',
              onClick: toggleCollapse
            }, collapsed ? '«' : '»')
          : null,
        h('label', { className: 'cmdmon-stream', title: '开启后插件主动读取后台任务输出流（dsh 的 job_output 可能读到空增量）' },
          h('input', { type: 'checkbox', checked: stream, onChange: (e) => doStream(e.target.checked) }),
          ' 实时流'
        ),
        h('button', { className: 'cmdmon-clear', onClick: doClear }, '清空')
      )
    ),
    open && h('div', { className: 'cmdmon-body' },
      items.length === 0
        ? h('div', { className: 'cmdmon-empty' }, '暂无命令执行记录')
        : items.map((r) =>
            h('div', { className: 'cmdmon-item', key: r.key },
              h('div', { className: 'cmdmon-row', onClick: () => toggle(r.key) },
                h('span', { className: 'cmdmon-dot ' + statusCls(r.status) }),
                h('span', { className: 'cmdmon-badges' },
                  h('span', {
                    className: 'cmdmon-badge cmdmon-badge-kind',
                    title: r.kind === 'job' ? '后台任务记录：实时输出显示在此行（点击展开）' : '工具调用记录：后台任务的实时输出在对应的「任务」行'
                  }, r.kind === 'job' ? '任务' : '工具'),
                  r.fgStream
                    ? h('span', { className: 'cmdmon-badge cmdmon-badge-fg', title: '前台命令已启用实时输出（Tee 捕获日志）' }, '实时')
                    : null,
                  Array.isArray(r.warnings) && r.warnings.length > 0
                    ? h('span', { className: 'cmdmon-badge cmdmon-badge-warn', title: r.warnings.join('\n') }, '⚠')
                    : null,
                  r.changed
                    ? h('span', { className: 'cmdmon-badge cmdmon-badge-rewrite', title: '命令已由插件包装 Tee 实时输出（原管道语义保留）' }, '改')
                    : null
                ),
                h('span', { className: 'cmdmon-cmd', title: cmdTitle(r) }, shorten(r.command, 100)),
                h('span', { className: 'cmdmon-status ' + statusCls(r.status) }, statusLabel(r.status)),
                h('span', { className: 'cmdmon-time' }, fmtTime(r))
              ),
              expanded === r.key && h('div', { className: 'cmdmon-detail' },
                Array.isArray(r.warnings) && r.warnings.map((w) => h('div', { className: 'cmdmon-warn-line', key: w }, '⚠ ' + w)),
                r.changed && r.originalCommand && h('div', { className: 'cmdmon-orig-line' }, '原始命令：' + r.originalCommand),
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
            )
          )
    )
  );

  // sidebar：包一层 wrapper（折叠时面板滑出屏幕，右侧露出「«」重新展开按钮）
  if (position === 'sidebar') {
    return h('div', { className: 'cmdmon-sidebar-wrap' },
      panel,
      collapsed && h('button', {
        className: 'cmdmon-reopen',
        title: '展开命令监视（右侧栏）',
        onClick: toggleCollapse
      }, '«')
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
  try { const v = localStorage.getItem('cmdmon.position'); if (v === 'top' || v === 'bottom' || v === 'sidebar') return v; } catch (e) { /* noop */ }
  return 'top';
}
function nextPosition(cur) { return cur === 'top' ? 'bottom' : cur === 'bottom' ? 'sidebar' : 'top'; }
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
  // 三个位置都注入；CmdMonView 内部根据 active position 决定显示/隐藏，
  // 隐藏的实例直接 return null、不发起轮询。
  for (const pos of ['top', 'bottom', 'sidebar']) {
    const slotName = POSITIONS[pos];
    ctx.slots.inject(slotName, () => slots.register(
      {
        name: slotName,
        id: 'cmdmon-' + pos,
        order: pos === 'sidebar' ? 90 : 30,
        priority: -1,
        label: pos === 'top' ? '命令监视' : pos === 'bottom' ? '命令监视(下)' : '命令监视(右侧)'
      },
      (props) => h(CmdMonView, { timer,
        sessionId: props && (props.sessionId || (props.zone && props.zone.sessionId)),
        position: pos })
    ));
  }
}

export { name, inject, apply };
