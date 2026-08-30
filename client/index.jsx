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
.cmdmon-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 6px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); }
.cmdmon-toggle { background: none; border: none; color: inherit; cursor: pointer; font-size: 12px; padding: 2px 4px; }
.cmdmon-actions { display: flex; align-items: center; gap: 10px; }
.cmdmon-stream { display: inline-flex; align-items: center; gap: 4px; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.cmdmon-clear { background: none; border: 1px solid var(--dsw-alias-border-l1); border-radius: 4px; color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 11px; padding: 1px 6px; }
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

function CmdMonView({ timer, sessionId }) {
  const [records, setRecords] = useState(new Map());
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState(null);
  const [stream, setStream] = useState(true);
  const seqRef = useRef(0);
  const outRef = useRef(null);

  useEffect(() => {
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
  }, []);

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

  return h('div', { className: 'cmdmon' },
    h('div', { className: 'cmdmon-head' },
      h('button', {
        className: 'cmdmon-toggle',
        onClick: () => setOpen((v) => !v)
      }, (open ? '▾' : '▸') + ' 命令监视' + (running > 0 ? ' (' + running + ' 运行中)' : '')),
      h('div', { className: 'cmdmon-actions' },
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
                h('span', { className: 'cmdmon-cmd', title: r.command }, shorten(r.command, 100)),
                h('span', { className: 'cmdmon-status ' + statusCls(r.status) }, statusLabel(r.status)),
                h('span', { className: 'cmdmon-time' }, fmtTime(r))
              ),
              expanded === r.key && h('pre', { ref: outRef, className: 'cmdmon-out' },
                (r.output || '(无输出)') + (r.truncated ? '\n…[输出已截断]' : '')
              )
            )
          )
    )
  );
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
  ctx.slots.inject('conversation.input.dock', () => slots.register(
    { name: 'conversation.input.dock', id: 'cmdmon', order: 30, label: '命令监视' },
    (props) => h(CmdMonView, { timer, sessionId: props && props.sessionId })
  ));
}

export { name, inject, apply };
