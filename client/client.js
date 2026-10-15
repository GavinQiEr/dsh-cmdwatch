window.__ModuleLoader__.load({
  id: "dsh-cmdwatch",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// client/index.jsx
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(index_exports);
var import_react = require("react");

// client/session.js
function pickSessionId(props) {
  if (!props || typeof props !== "object") return void 0;
  const zone = props.zone && typeof props.zone === "object" ? props.zone : void 0;
  const session = props.session && typeof props.session === "object" ? props.session : void 0;
  const candidates = [
    props.sessionId,
    zone && zone.sessionId,
    session && session.id,
    zone && zone.session && zone.session.id,
    props.conversationId,
    zone && zone.conversationId
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return void 0;
}
function createSessionRelay() {
  let current;
  const listeners = /* @__PURE__ */ new Set();
  return {
    /** @returns {string|undefined} 记录后的会话标识（空值忽略，不广播） */
    learn(id) {
      if (typeof id !== "string" || id.length === 0) return current;
      if (id === current) return current;
      current = id;
      for (const fn of [...listeners]) {
        try {
          fn(current);
        } catch (e) {
        }
      }
      return current;
    },
    current() {
      return current;
    },
    /** @returns {() => void} 退订 */
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    get size() {
      return listeners.size;
    }
  };
}
function sessionSwitchReset(prevSession, nextSession) {
  if (prevSession === nextSession) return null;
  return { seq: 0, records: /* @__PURE__ */ new Map(), expanded: null };
}

// client/order.js
var DONE_LINGER_MS = 5e3;
function isLiveRecord(record) {
  if (!record) return false;
  return record.status === "running" || record.status === "stopping";
}
function recordDoneAt(record) {
  if (!record) return 0;
  return record.finishedAt || record.startedAt || 0;
}
var byStartDesc = (a, b) => (b && b.startedAt || 0) - (a && a.startedAt || 0);
function partitionRecords(records, now, lingerMs = DONE_LINGER_MS) {
  const live = [];
  const fresh = [];
  const done = [];
  const at = typeof now === "number" ? now : Date.now();
  for (const r of Array.isArray(records) ? records : []) {
    if (isLiveRecord(r)) {
      live.push(r);
      continue;
    }
    if (at - recordDoneAt(r) < lingerMs) fresh.push(r);
    else done.push(r);
  }
  return {
    live: live.sort(byStartDesc),
    fresh: fresh.sort(byStartDesc),
    done: done.sort(byStartDesc)
  };
}
function pickAutoExpandTarget(live) {
  const list = Array.isArray(live) ? live : [];
  if (list.length === 0) return void 0;
  return list.find((r) => r && r.kind === "job") || list[0];
}
function nextAutoExpand({ current, topLiveKey, manualCollapsedKey }) {
  if (!topLiveKey) return void 0;
  if (manualCollapsedKey === topLiveKey) return void 0;
  if (current === topLiveKey) return void 0;
  return topLiveKey;
}
function toggleExpanded(current, key) {
  return current === key ? null : key;
}

// client/index.jsx
var name = "dsh-cmdwatch";
var inject = ["slots", "connection"];
var sessionRelay = createSessionRelay();
var CSS = `
.cmdmon { font-size: 12px; color: var(--dsw-alias-label-primary); }
/* \u53F3\u4FA7\u680F\uFF1A\u98CE\u683C\u4E0E\u5DE6\u4FA7 SidebarRoot \u4E00\u81F4\uFF08\u540C\u80CC\u666F/\u8FB9\u6846/\u5185\u8FB9\u8DDD/\u6EDA\u52A8\u6761\uFF09 */
.cmdmon-sidebar-wrap { position: absolute; inset: 0; pointer-events: none; z-index: 25; }
.cmdmon-sidebar { position: absolute; top: 0; right: 0; bottom: 0; width: 340px; max-width: 55vw; padding: 6px 12px; overflow-y: auto; box-sizing: border-box; pointer-events: auto; background: var(--dsw-specific-sidebar-fill); color: var(--dsw-alias-label-primary); border-left: 1px solid var(--dsw-alias-border-l1); --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2); --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2); transition: transform .2s var(--ds-ease-in-out); }
.cmdmon-sidebar.cmdmon-collapsed { transform: translateX(105%); }
.cmdmon-sidebar .cmdmon-body { max-height: none; }
.cmdmon-reopen { position: fixed; right: 0; top: 50%; transform: translateY(-50%); pointer-events: auto; z-index: 26; border: 1px solid var(--dsw-alias-border-l1); border-right: none; border-radius: 6px 0 0 6px; background: var(--dsw-specific-sidebar-fill); color: var(--dsw-alias-label-primary); cursor: pointer; padding: 12px 6px; font-size: 14px; }
/* \u6298\u53E0\u628A\u624B\uFF1A\u9762\u677F\u5DE6\u8FB9\u7F18\u60AC\u6D6E\u6807\u7B7E\uFF08\u8D34\u9762\u677F\u3001\u5782\u76F4\u5C45\u4E2D\uFF09\uFF0C\u4E0D\u5360\u7528\u5934\u90E8\u64CD\u4F5C\u533A */
.cmdmon-collapse { position: absolute; right: 340px; top: 50%; transform: translateY(-50%); pointer-events: auto; z-index: 26; border: 1px solid var(--dsw-alias-border-l1); border-right: none; border-radius: 6px 0 0 6px; background: var(--dsw-specific-sidebar-fill); color: var(--dsw-alias-label-primary); cursor: pointer; padding: 12px 6px; font-size: 14px; }
.cmdmon-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 6px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); }
.cmdmon-toggle { background: none; border: none; color: inherit; cursor: pointer; font-size: 12px; padding: 2px 4px; }
.cmdmon-actions { display: flex; align-items: center; gap: 10px; }
.cmdmon-stream { display: inline-flex; align-items: center; gap: 4px; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.cmdmon-clear { background: none; border: 1px solid var(--dsw-alias-border-l1); border-radius: 4px; color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 11px; padding: 1px 6px; }
.cmdmon-posbtn { background: none; border: 1px solid var(--dsw-alias-border-l1); border-radius: 4px; color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 11px; padding: 1px 6px; }
.cmdmon-body { margin-top: 4px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); max-height: 320px; overflow: auto; }
.cmdmon-empty { padding: 10px; color: var(--dsw-alias-label-secondary); text-align: center; }
/* \u300C\u5DF2\u5B8C\u6210\u300D\u7EC4\uFF1A\u9ED8\u8BA4\u6536\u8D77\uFF0C\u4F4D\u4E8E\u4E3B\u8868\uFF08\u8FD0\u884C\u4E2D + \u521A\u5B8C\u6210\uFF09\u4E0B\u65B9 */
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
.cmdmon-orig-line { margin: 0; padding: 4px 8px; font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); border-bottom: 1px solid var(--dsw-alias-border-l1); }
/* \u539F\u59CB\u547D\u4EE4\uFF1A\u9ED8\u8BA4\u4E00\u884C\uFF08\u8D85\u957F\u7701\u7565\uFF09\uFF0C\u70B9\u51FB\u5C55\u5F00\u5B8C\u6574\u5185\u5BB9 \u2014\u2014 \u628A\u7EB5\u5411\u7A7A\u95F4\u7559\u7ED9\u8FD0\u884C\u8F93\u51FA */
.cmdmon-orig-head { cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cmdmon-orig-head:hover { color: var(--dsw-alias-label-primary); }
.cmdmon-orig-body { margin: 4px 0 0; max-height: 120px; overflow: auto; white-space: pre-wrap; word-break: break-all; color: var(--dsw-alias-label-secondary); font-family: ui-monospace, Consolas, 'Courier New', monospace; }
/* \u8FD0\u884C\u4E2D\u7684\u8BB0\u5F55\uFF1A\u8F93\u51FA\u533A\u591A\u7ED9\u4E00\u4E9B\u9AD8\u5EA6\uFF0C\u4FBF\u4E8E\u76EF\u8FDB\u5EA6 */
.cmdmon-item.cmdmon-live .cmdmon-out { max-height: 40vh; }
/* \u4F8B\u884C\u8BF4\u660E\uFF08\u5DF2\u5305\u88C5/\u5DF2\u6CE8\u5165\u7B49\uFF09\uFF1A\u4E00\u884C\u7070\u5B57\uFF0C\u4E0D\u5360 \u26A0 \u4E5F\u4E0D\u5360\u591A\u884C */
.cmdmon-note-line { margin: 0; padding: 3px 8px; font-size: 10px; line-height: 1.5; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); border-bottom: 1px solid var(--dsw-alias-border-l1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
`;
function shorten(text, maxLen) {
  if (!text) return text;
  const flat = String(text).replace(/\s+/g, " ").trim();
  if (flat.length <= maxLen) return flat;
  const head = Math.floor(maxLen * 0.6);
  const tail = maxLen - head - 1;
  return flat.slice(0, head) + "\u2026" + flat.slice(-tail);
}
async function snapshot(since, sessionId) {
  const params = new URLSearchParams({ since: String(since) });
  if (sessionId) params.set("session", sessionId);
  const res = await fetch("/cmdmon/snapshot?" + params.toString(), {
    headers: { Accept: "application/json" }
  });
  if (!res.ok) throw new Error("snapshot " + res.status);
  return res.json();
}
function CmdMonView({ timer, slotProps, position }) {
  const activePos = getActivePosition();
  const active = position === activePos;
  const observed = pickSessionId(slotProps);
  const [relayed, setRelayed] = (0, import_react.useState)(() => sessionRelay.current());
  const session = observed !== void 0 ? observed : relayed;
  const [records, setRecords] = (0, import_react.useState)(/* @__PURE__ */ new Map());
  const [open, setOpen] = (0, import_react.useState)(true);
  const [expanded, setExpanded] = (0, import_react.useState)(null);
  const [stream, setStream] = (0, import_react.useState)(true);
  const [collapsed, setCollapsed] = (0, import_react.useState)(() => {
    try {
      return localStorage.getItem("cmdmon.sidebarCollapsed") === "1";
    } catch (e) {
      return false;
    }
  });
  const [doneOpen, setDoneOpen] = (0, import_react.useState)(() => {
    try {
      return localStorage.getItem("cmdmon.doneOpen") === "1";
    } catch (e) {
      return false;
    }
  });
  const [origOpenKey, setOrigOpenKey] = (0, import_react.useState)(null);
  const seqRef = (0, import_react.useRef)(0);
  const outRef = (0, import_react.useRef)(null);
  const manualCollapsedRef = (0, import_react.useRef)(null);
  const toggleCollapse = () => {
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem("cmdmon.sidebarCollapsed", next ? "1" : "0");
      } catch (e) {
      }
      return next;
    });
  };
  const toggleDone = () => {
    setDoneOpen((v) => {
      const next = !v;
      try {
        localStorage.setItem("cmdmon.doneOpen", next ? "1" : "0");
      } catch (e) {
      }
      return next;
    });
  };
  const [, setClock] = (0, import_react.useState)(0);
  (0, import_react.useEffect)(() => {
    const iv = setInterval(() => setClock((n) => n + 1), 1e3);
    return () => clearInterval(iv);
  }, []);
  (0, import_react.useEffect)(() => {
    if (observed !== void 0) {
      sessionRelay.learn(observed);
      setRelayed(observed);
      return void 0;
    }
    setRelayed(sessionRelay.current());
    return sessionRelay.subscribe((id) => setRelayed(id));
  }, [observed]);
  const sessionRef = (0, import_react.useRef)(session);
  (0, import_react.useEffect)(() => {
    const reset = sessionSwitchReset(sessionRef.current, session);
    if (!reset) return;
    sessionRef.current = session;
    seqRef.current = reset.seq;
    setRecords(reset.records);
    setExpanded(reset.expanded);
  }, [session]);
  (0, import_react.useEffect)(() => {
    if (!active) return;
    if (session === void 0) return;
    const tick = async () => {
      try {
        const res = await snapshot(seqRef.current, session);
        if (!res) return;
        if (sessionRef.current !== session) return;
        if (typeof res.seq === "number") seqRef.current = res.seq;
        if (typeof res.streamEnabled === "boolean") setStream(res.streamEnabled);
        if (Array.isArray(res.records) && res.records.length > 0) {
          setRecords((prev) => {
            const next = new Map(prev);
            for (const r of res.records) next.set(r.key, r);
            return next;
          });
        }
      } catch (err) {
      }
    };
    if (timer && typeof timer.interval === "function") {
      const off = timer.interval(tick, 700);
      tick();
      return off;
    }
    const iv = setInterval(tick, 700);
    tick();
    return () => clearInterval(iv);
  }, [active, session]);
  (0, import_react.useEffect)(() => {
    if (outRef.current) outRef.current.scrollTop = outRef.current.scrollHeight;
  }, [records, expanded]);
  const partitioned = partitionRecords([...records.values()], Date.now());
  const liveItems = [...partitioned.live, ...partitioned.fresh];
  const doneItems = partitioned.done;
  const running = partitioned.live.length;
  const autoTarget = pickAutoExpandTarget(partitioned.live);
  const topLiveKey = autoTarget ? autoTarget.key : void 0;
  (0, import_react.useEffect)(() => {
    const next = nextAutoExpand({
      current: expanded,
      topLiveKey,
      manualCollapsedKey: manualCollapsedRef.current
    });
    if (next !== void 0) setExpanded(next);
  }, [topLiveKey]);
  const statusLabel = (s) => ({
    running: "\u8FD0\u884C\u4E2D",
    stopping: "\u505C\u6B62\u4E2D",
    completed: "\u5B8C\u6210",
    killed: "\u5DF2\u7EC8\u6B62",
    failed: "\u5931\u8D25"
  })[s] || s;
  const statusCls = (s) => ({
    running: "cmdmon-run",
    stopping: "cmdmon-warn",
    completed: "cmdmon-ok",
    killed: "cmdmon-mut",
    failed: "cmdmon-err"
  })[s] || "cmdmon-mut";
  const fmtTime = (r) => {
    if (!r.startedAt) return "";
    const d = new Date(r.startedAt);
    const p = (n) => String(n).padStart(2, "0");
    return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  };
  const toggle = (key) => setExpanded((prev) => {
    const next = toggleExpanded(prev, key);
    manualCollapsedRef.current = next === null ? key : null;
    return next;
  });
  const cmdTitle = (r) => {
    const lines = [];
    if (r.originalCommand) lines.push("\u539F\u59CB\u547D\u4EE4\uFF1A" + r.originalCommand);
    if (r.changed) lines.push("\uFF08\u547D\u4EE4\u5DF2\u88AB\u63D2\u4EF6\u5305\u88C5 Tee \u5B9E\u65F6\u8F93\u51FA\uFF0C\u539F\u7BA1\u9053\u8BED\u4E49\u4FDD\u7559\uFF1A-Last/Out-File/Get-Content \u7B49\u7ED3\u679C\u4E0D\u53D8\uFF09");
    if (Array.isArray(r.warnings)) for (const w of r.warnings) lines.push("\u26A0 " + w);
    if (Array.isArray(r.notes)) for (const n of r.notes) lines.push("\xB7 " + n);
    return lines.length ? lines.join("\n") : r.command;
  };
  const doClear = async () => {
    if (session === void 0) return;
    try {
      const res = await fetch("/cmdmon/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session })
      }).then((r) => r.json());
      setRecords(/* @__PURE__ */ new Map());
      if (res && typeof res.seq === "number") seqRef.current = res.seq;
    } catch (err) {
    }
  };
  const doStream = async (enabled) => {
    setStream(enabled);
    try {
      await fetch("/cmdmon/setStream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled })
      });
    } catch (err) {
    }
  };
  const doSwitchPosition = () => setActivePosition(nextPosition(position));
  const posLabel = position === "sidebar" ? "\u53F3\u4FA7" : "\u5E95\u90E8";
  if (!active) return null;
  const rowOf = (r) => (0, import_react.createElement)(
    "div",
    { className: "cmdmon-item" + (isLiveRecord(r) ? " cmdmon-live" : ""), key: r.key },
    (0, import_react.createElement)(
      "div",
      { className: "cmdmon-row", onClick: () => toggle(r.key) },
      (0, import_react.createElement)("span", { className: "cmdmon-dot " + statusCls(r.status) }),
      (0, import_react.createElement)(
        "span",
        { className: "cmdmon-badges" },
        (0, import_react.createElement)("span", {
          className: "cmdmon-badge cmdmon-badge-kind",
          title: r.kind === "job" ? "\u540E\u53F0\u4EFB\u52A1\u8BB0\u5F55\uFF1A\u5B9E\u65F6\u8F93\u51FA\u663E\u793A\u5728\u6B64\u884C\uFF08\u70B9\u51FB\u5C55\u5F00\uFF09" : "\u5DE5\u5177\u8C03\u7528\u8BB0\u5F55\uFF1A\u540E\u53F0\u4EFB\u52A1\u7684\u5B9E\u65F6\u8F93\u51FA\u5728\u5BF9\u5E94\u7684\u300C\u4EFB\u52A1\u300D\u884C"
        }, r.kind === "job" ? "\u4EFB\u52A1" : "\u5DE5\u5177"),
        // 「实时」「改」徽标已按需求收掉：包装/实时信息改为悬停提示（原始命令 + 例行说明）
        // 与展开行里的一行说明，行上只保留类型与真问题（⚠）
        Array.isArray(r.warnings) && r.warnings.length > 0 ? (0, import_react.createElement)("span", { className: "cmdmon-badge cmdmon-badge-warn", title: r.warnings.join("\n") }, "\u26A0") : null
      ),
      (0, import_react.createElement)("span", { className: "cmdmon-cmd", title: cmdTitle(r) }, shorten(r.command, 100)),
      (0, import_react.createElement)("span", { className: "cmdmon-status " + statusCls(r.status) }, statusLabel(r.status)),
      (0, import_react.createElement)("span", { className: "cmdmon-time" }, fmtTime(r))
    ),
    expanded === r.key && (0, import_react.createElement)(
      "div",
      { className: "cmdmon-detail" },
      Array.isArray(r.warnings) && r.warnings.map((w) => (0, import_react.createElement)("div", { className: "cmdmon-warn-line", key: w }, "\u26A0 " + w)),
      r.changed && r.originalCommand ? (0, import_react.createElement)(
        "div",
        { className: "cmdmon-orig-line" },
        // 原始命令默认只占一行（点击展开完整内容）——把纵向空间留给运行输出
        (0, import_react.createElement)("div", {
          className: "cmdmon-orig-head",
          title: origOpenKey === r.key ? "\u70B9\u51FB\u6536\u8D77\u539F\u59CB\u547D\u4EE4" : "\u70B9\u51FB\u5C55\u5F00\u5B8C\u6574\u539F\u59CB\u547D\u4EE4\uFF08\u60AC\u505C\u884C\u6807\u9898\u4E5F\u80FD\u770B\u5230\uFF09",
          onClick: () => setOrigOpenKey((k) => toggleExpanded(k, r.key))
        }, (origOpenKey === r.key ? "\u25BE " : "\u25B8 ") + "\u539F\u59CB\u547D\u4EE4\uFF1A" + shorten(r.originalCommand, 70)),
        origOpenKey === r.key ? (0, import_react.createElement)("pre", { className: "cmdmon-orig-body" }, r.originalCommand) : null
      ) : null,
      // 例行说明（已包装 Tee / 已注入 PYTHONUNBUFFERED 等）：一行灰字，不挂 ⚠
      Array.isArray(r.notes) && r.notes.length > 0 ? (0, import_react.createElement)("div", { className: "cmdmon-note-line", title: r.notes.join(" \xB7 ") }, r.notes.join(" \xB7 ")) : null,
      r.kind === "job" && r.status === "running" && r.ownerRegistered === false ? (0, import_react.createElement)("div", { className: "cmdmon-warn-line" }, "\u26A0 \u8BCA\u65AD\uFF1A\u4EFB\u52A1 owner \u672A\u767B\u8BB0\uFF0C\u63D2\u4EF6\u65E0\u6CD5\u8BFB\u53D6\u8F93\u51FA\uFF08\u5B9E\u65F6\u6D41\u4E0D\u53EF\u7528\uFF09") : null,
      r.readError ? (0, import_react.createElement)("div", { className: "cmdmon-warn-line" }, "\u26A0 \u8BCA\u65AD\uFF1A\u8BFB\u53D6\u5931\u8D25 " + r.readError) : null,
      r.kind === "tool" && r.status === "running" ? (0, import_react.createElement)(
        "div",
        { className: "cmdmon-orig-line" },
        r.fgStream ? "\u524D\u53F0\u547D\u4EE4\u5B9E\u65F6\u8F93\u51FA\uFF08Tee \u6355\u83B7\uFF09\uFF0C\u6B63\u5728\u6D41\u5F0F\u663E\u793A" : "\u5DE5\u5177\u8C03\u7528\u8BB0\u5F55\uFF1A\u540E\u53F0\u4EFB\u52A1\u7684\u5B9E\u65F6\u8F93\u51FA\u8BF7\u5C55\u5F00\u4E0B\u65B9\u5BF9\u5E94\u7684\u300C\u4EFB\u52A1\u300D\u884C"
      ) : null,
      (0, import_react.createElement)(
        "pre",
        { ref: outRef, className: "cmdmon-out" },
        (r.output || "(\u65E0\u8F93\u51FA)") + (r.truncated ? "\n\u2026[\u8F93\u51FA\u5DF2\u622A\u65AD]" : "")
      )
    )
  );
  const panel = (0, import_react.createElement)(
    "div",
    { className: "cmdmon" + (position === "sidebar" ? " cmdmon-sidebar" + (collapsed ? " cmdmon-collapsed" : "") : "") },
    (0, import_react.createElement)(
      "div",
      { className: "cmdmon-head" },
      (0, import_react.createElement)("button", {
        className: "cmdmon-toggle",
        title: session === void 0 ? "\u7B49\u5F85\u4F1A\u8BDD\u6807\u8BC6\uFF1A\u9762\u677F\u53EA\u663E\u793A\u5F53\u524D\u4F1A\u8BDD\u7684\u547D\u4EE4" : "\u53EA\u663E\u793A\u5F53\u524D\u4F1A\u8BDD\u7684\u547D\u4EE4\uFF08\u4F1A\u8BDD\uFF1A" + session + "\uFF09",
        onClick: () => setOpen((v) => !v)
      }, (open ? "\u25BE" : "\u25B8") + " \u547D\u4EE4\u76D1\u89C6" + (running > 0 ? " (" + running + " \u8FD0\u884C\u4E2D)" : "")),
      (0, import_react.createElement)(
        "div",
        { className: "cmdmon-actions" },
        (0, import_react.createElement)("button", {
          className: "cmdmon-posbtn",
          title: "\u5207\u6362\u9762\u677F\u4F4D\u7F6E\uFF08\u5E95\u90E8 / \u53F3\u4FA7 \u5FAA\u73AF\uFF09",
          onClick: doSwitchPosition
        }, "\u2195 " + posLabel),
        (0, import_react.createElement)(
          "label",
          { className: "cmdmon-stream", title: "\u5F00\u542F\u540E\u63D2\u4EF6\u4E3B\u52A8\u8BFB\u53D6\u540E\u53F0\u4EFB\u52A1\u8F93\u51FA\u6D41\uFF08dsh \u7684 job_output \u53EF\u80FD\u8BFB\u5230\u7A7A\u589E\u91CF\uFF09" },
          (0, import_react.createElement)("input", { type: "checkbox", checked: stream, onChange: (e) => doStream(e.target.checked) }),
          " \u5B9E\u65F6\u6D41"
        ),
        (0, import_react.createElement)("button", { className: "cmdmon-clear", onClick: doClear }, "\u6E05\u7A7A")
      )
    ),
    // 主表：运行中 + 刚完成（5 秒停留期内）
    open && (0, import_react.createElement)(
      "div",
      { className: "cmdmon-body" },
      liveItems.length === 0 ? (0, import_react.createElement)(
        "div",
        { className: "cmdmon-empty" },
        session === void 0 ? "\uFF08\u7B49\u5F85\u4F1A\u8BDD\u6807\u8BC6\uFF1A\u53EA\u663E\u793A\u672C\u4F1A\u8BDD\u7684\u547D\u4EE4\uFF0C\u62FF\u4E0D\u5230\u4F1A\u8BDD\u4FE1\u606F\u65F6\u4FDD\u6301\u4E3A\u7A7A\uFF09" : doneItems.length > 0 ? "\u5F53\u524D\u6CA1\u6709\u8FD0\u884C\u4E2D\u7684\u547D\u4EE4" : "\u6682\u65E0\u547D\u4EE4\u6267\u884C\u8BB0\u5F55"
      ) : liveItems.map(rowOf)
    ),
    // 已完成组：完成 5 秒后自动折叠到这里，默认收起（避免视觉干扰）
    open && doneItems.length > 0 && (0, import_react.createElement)(
      "div",
      { className: "cmdmon-body cmdmon-done" },
      (0, import_react.createElement)("div", {
        className: "cmdmon-done-head",
        title: "\u5DF2\u5B8C\u6210\u8BB0\u5F55\uFF08\u5B8C\u6210\u540E 5 \u79D2\u81EA\u52A8\u6536\u5230\u8FD9\u91CC\uFF09\uFF0C\u70B9\u51FB\u5C55\u5F00/\u6536\u8D77",
        onClick: toggleDone
      }, (doneOpen ? "\u25BE" : "\u25B8") + " \u5DF2\u5B8C\u6210 (" + doneItems.length + ")"),
      doneOpen && doneItems.map(rowOf)
    )
  );
  if (position === "sidebar") {
    return (0, import_react.createElement)(
      "div",
      { className: "cmdmon-sidebar-wrap" },
      panel,
      collapsed ? (0, import_react.createElement)("button", { className: "cmdmon-reopen", title: "\u5C55\u5F00\u547D\u4EE4\u76D1\u89C6\uFF08\u53F3\u4FA7\u680F\uFF09", onClick: toggleCollapse }, "\xAB") : (0, import_react.createElement)("button", { className: "cmdmon-collapse", title: "\u6298\u53E0\u547D\u4EE4\u76D1\u89C6\uFF08\u53F3\u4FA7\u680F\uFF09", onClick: toggleCollapse }, "\xBB")
    );
  }
  return panel;
}
var POSITIONS = {
  top: "conversation.input.dock",
  bottom: "conversation.composer.dock",
  sidebar: "shell.overlay"
};
function getActivePosition() {
  try {
    const v = localStorage.getItem("cmdmon.position");
    if (v === "bottom" || v === "sidebar") return v;
  } catch (e) {
  }
  return "bottom";
}
function nextPosition(cur) {
  return cur === "sidebar" ? "bottom" : "sidebar";
}
function setActivePosition(p) {
  try {
    localStorage.setItem("cmdmon.position", p);
  } catch (e) {
  }
  try {
    window.location.reload();
  } catch (e) {
  }
}
function apply(ctx) {
  const tagId = "dsh-cmdwatch/style.css";
  if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="' + tagId + '"]') === null) {
    const tag = document.createElement("style");
    tag.dataset.plugin = "dsh-cmdwatch";
    tag.dataset.pluginCss = tagId;
    tag.textContent = CSS;
    document.head.appendChild(tag);
  }
  const slots = ctx.slots;
  const timer = ctx.get("timer");
  for (const pos of ["bottom", "sidebar"]) {
    const slotName = POSITIONS[pos];
    ctx.slots.inject(slotName, () => slots.register(
      {
        name: slotName,
        id: "cmdmon-" + pos,
        order: pos === "sidebar" ? 90 : 30,
        priority: -1,
        label: pos === "bottom" ? "\u547D\u4EE4\u76D1\u89C6(\u4E0B)" : "\u547D\u4EE4\u76D1\u89C6(\u53F3\u4FA7)"
      },
      (props) => (0, import_react.createElement)(CmdMonView, { timer, slotProps: props, position: pos })
    ));
  }
}

    return module.exports;
  }
});
