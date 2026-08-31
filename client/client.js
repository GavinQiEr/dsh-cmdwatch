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
var name = "dsh-cmdwatch";
var inject = ["slots", "connection"];
var CSS = `
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
.cmdmon-badges { flex: none; display: inline-flex; align-items: center; gap: 4px; }
.cmdmon-badge { flex: none; font-size: 10px; line-height: 14px; padding: 0 4px; border-radius: 3px; white-space: nowrap; }
.cmdmon-badge-kind { color: var(--dsw-alias-label-secondary); border: 1px solid var(--dsw-alias-border-l1); }
.cmdmon-badge-warn { color: var(--dsw-alias-state-warn-primary); border: 1px solid var(--dsw-alias-state-warn-primary); }
.cmdmon-badge-rewrite { color: #fff; background: var(--dsw-alias-state-warn-primary); }
.cmdmon-warn-line { margin: 0; padding: 4px 8px; font-size: 11px; line-height: 1.5; color: var(--dsw-alias-state-warn-primary); background: var(--dsw-alias-bg-layer-2); border-bottom: 1px solid var(--dsw-alias-border-l1); white-space: pre-wrap; word-break: break-all; }
.cmdmon-orig-line { margin: 0; padding: 4px 8px; font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); border-bottom: 1px solid var(--dsw-alias-border-l1); white-space: pre-wrap; word-break: break-all; }
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
function CmdMonView({ timer, sessionId }) {
  const [records, setRecords] = (0, import_react.useState)(/* @__PURE__ */ new Map());
  const [open, setOpen] = (0, import_react.useState)(true);
  const [expanded, setExpanded] = (0, import_react.useState)(null);
  const [stream, setStream] = (0, import_react.useState)(true);
  const seqRef = (0, import_react.useRef)(0);
  const outRef = (0, import_react.useRef)(null);
  (0, import_react.useEffect)(() => {
    const tick = async () => {
      try {
        const res = await snapshot(seqRef.current, sessionId);
        if (!res) return;
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
      return timer.interval(tick, 700);
    }
    const iv = setInterval(tick, 700);
    return () => clearInterval(iv);
  }, []);
  (0, import_react.useEffect)(() => {
    if (outRef.current) outRef.current.scrollTop = outRef.current.scrollHeight;
  }, [records, expanded]);
  const items = [...records.values()].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  const running = items.filter((r) => r.status === "running" || r.status === "stopping").length;
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
  const toggle = (key) => setExpanded((prev) => prev === key ? null : key);
  const cmdTitle = (r) => {
    const lines = [];
    if (r.originalCommand) lines.push("\u539F\u59CB\u547D\u4EE4\uFF1A" + r.originalCommand);
    if (r.changed) lines.push("\uFF08\u547D\u4EE4\u5DF2\u88AB\u63D2\u4EF6\u6539\u5199\uFF1A\u53BB\u9664\u6536\u96C6\u578B\u7F13\u51B2\u7BA1\u9053\uFF0C\u672A\u6539\u53D8\u7A0B\u5E8F\u4E0E\u53C2\u6570\uFF09");
    if (Array.isArray(r.warnings)) for (const w of r.warnings) lines.push("\u26A0 " + w);
    return lines.length ? lines.join("\n") : r.command;
  };
  const doClear = async () => {
    try {
      const body = sessionId ? JSON.stringify({ session: sessionId }) : "{}";
      const res = await fetch("/cmdmon/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body
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
  return (0, import_react.createElement)(
    "div",
    { className: "cmdmon" },
    (0, import_react.createElement)(
      "div",
      { className: "cmdmon-head" },
      (0, import_react.createElement)("button", {
        className: "cmdmon-toggle",
        onClick: () => setOpen((v) => !v)
      }, (open ? "\u25BE" : "\u25B8") + " \u547D\u4EE4\u76D1\u89C6" + (running > 0 ? " (" + running + " \u8FD0\u884C\u4E2D)" : "")),
      (0, import_react.createElement)(
        "div",
        { className: "cmdmon-actions" },
        (0, import_react.createElement)(
          "label",
          { className: "cmdmon-stream", title: "\u5F00\u542F\u540E\u63D2\u4EF6\u4E3B\u52A8\u8BFB\u53D6\u540E\u53F0\u4EFB\u52A1\u8F93\u51FA\u6D41\uFF08dsh \u7684 job_output \u53EF\u80FD\u8BFB\u5230\u7A7A\u589E\u91CF\uFF09" },
          (0, import_react.createElement)("input", { type: "checkbox", checked: stream, onChange: (e) => doStream(e.target.checked) }),
          " \u5B9E\u65F6\u6D41"
        ),
        (0, import_react.createElement)("button", { className: "cmdmon-clear", onClick: doClear }, "\u6E05\u7A7A")
      )
    ),
    open && (0, import_react.createElement)(
      "div",
      { className: "cmdmon-body" },
      items.length === 0 ? (0, import_react.createElement)("div", { className: "cmdmon-empty" }, "\u6682\u65E0\u547D\u4EE4\u6267\u884C\u8BB0\u5F55") : items.map(
        (r) => (0, import_react.createElement)(
          "div",
          { className: "cmdmon-item", key: r.key },
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
              Array.isArray(r.warnings) && r.warnings.length > 0 ? (0, import_react.createElement)("span", { className: "cmdmon-badge cmdmon-badge-warn", title: r.warnings.join("\n") }, "\u26A0") : null,
              r.changed ? (0, import_react.createElement)("span", { className: "cmdmon-badge cmdmon-badge-rewrite", title: "\u547D\u4EE4\u5DF2\u88AB\u63D2\u4EF6\u6539\u5199\uFF08\u53BB\u9664\u6536\u96C6\u578B\u7F13\u51B2\u7BA1\u9053\uFF09" }, "\u6539") : null
            ),
            (0, import_react.createElement)("span", { className: "cmdmon-cmd", title: cmdTitle(r) }, shorten(r.command, 100)),
            (0, import_react.createElement)("span", { className: "cmdmon-status " + statusCls(r.status) }, statusLabel(r.status)),
            (0, import_react.createElement)("span", { className: "cmdmon-time" }, fmtTime(r))
          ),
          expanded === r.key && (0, import_react.createElement)(
            "div",
            { className: "cmdmon-detail" },
            Array.isArray(r.warnings) && r.warnings.map((w) => (0, import_react.createElement)("div", { className: "cmdmon-warn-line", key: w }, "\u26A0 " + w)),
            r.changed && r.originalCommand && (0, import_react.createElement)("div", { className: "cmdmon-orig-line" }, "\u539F\u59CB\u547D\u4EE4\uFF1A" + r.originalCommand),
            r.kind === "job" && r.status === "running" && r.ownerRegistered === false ? (0, import_react.createElement)("div", { className: "cmdmon-warn-line" }, "\u26A0 \u8BCA\u65AD\uFF1A\u4EFB\u52A1 owner \u672A\u767B\u8BB0\uFF0C\u63D2\u4EF6\u65E0\u6CD5\u8BFB\u53D6\u8F93\u51FA\uFF08\u5B9E\u65F6\u6D41\u4E0D\u53EF\u7528\uFF09") : null,
            r.readError ? (0, import_react.createElement)("div", { className: "cmdmon-warn-line" }, "\u26A0 \u8BCA\u65AD\uFF1A\u8BFB\u53D6\u5931\u8D25 " + r.readError) : null,
            r.kind === "tool" && r.status === "running" ? (0, import_react.createElement)("div", { className: "cmdmon-orig-line" }, "\u5DE5\u5177\u8C03\u7528\u8BB0\u5F55\uFF1A\u540E\u53F0\u4EFB\u52A1\u7684\u5B9E\u65F6\u8F93\u51FA\u8BF7\u5C55\u5F00\u4E0B\u65B9\u5BF9\u5E94\u7684\u300C\u4EFB\u52A1\u300D\u884C") : null,
            (0, import_react.createElement)(
              "pre",
              { ref: outRef, className: "cmdmon-out" },
              (r.output || "(\u65E0\u8F93\u51FA)") + (r.truncated ? "\n\u2026[\u8F93\u51FA\u5DF2\u622A\u65AD]" : "")
            )
          )
        )
      )
    )
  );
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
  ctx.slots.inject("conversation.input.dock", () => slots.register(
    { name: "conversation.input.dock", id: "cmdmon", order: 30, label: "\u547D\u4EE4\u76D1\u89C6" },
    (props) => (0, import_react.createElement)(CmdMonView, { timer, sessionId: props && props.sessionId })
  ));
}

    return module.exports;
  }
});
