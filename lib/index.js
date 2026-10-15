// dsh-cmdwatch —— 命令窗（Host 半）
//
// 在宿主进程捕获 dsh 发起的命令与输出：
//   - 前台命令：tools/execute（开始，拿命令行）+ tools/result（结束，拿输出文本）
//   - 后台任务：jobs.onJobsChanged / onJobDone / list()（状态 + 命令行 label）
//   - 实时流：timer 每 500ms 对 running 任务 jobs.read() 拉增量输出（消耗性，
//     受 Client 端「实时流」开关控制；开启时 dsh 的 job_output 工具会读到空增量）
//   - 命令净化：dsh 自主拼出的命令可能带收集型管道（| Select-Object -Last N 等）
//     阻断实时流。tools/execute 中间件被框架允许原地改写 exec.arguments（官方
//     dsh-tool-call-timeout-policy 同款用法），此处剥离收集型管道并可选注入
//     PYTHONUNBUFFERED；检测与改写均记录在面板上（警示 ⚠ / 已改写徽标）。
//
// 通过 webServer 注册 HTTP 端点向 Client 提供增量快照（静态插件没有动态插件的
// harness.handle / host.call，使用同源 HTTP 通道，参照 dsh-pocket 的方案）。

import { defineTool } from "@deepseek-ai/dsh-tools";
import { analyzeCommand, buildStreamWrap } from './rewrite.js';
import { classifyJobError, createOwnerRegistry, isTerminalJobStatus, jobViewOf, renderJobRead } from './jobsync.js';
import { readFileSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process'; // ESM：不能用裸 require（0.5.13 修复）

const name = 'dsh-cmdwatch';
const inject = ['webServer', 'shell'];

function apply(ctx, config) {
  const jobs = ctx.get('jobs');
  const timer = ctx.get('timer');
  const webServer = ctx.webServer;
  const shell = ctx.shell;
  // 净化配置（默认全开，可在 bundle 配置里关闭）：
  //   rewrite: 剥离收集型管道（仅后台任务）
  //   pythonUnbuffered: 命中 python 时注入 PYTHONUNBUFFERED
  //   warn: 面板警示收集型/提前终止型管道
  //   foregroundStream: 前台命令插入 Tee 落盘，面板实时显示（默认开）
  //   debug: 是否向宿主终端输出 [cmdmon] 诊断日志（默认关闭；诊断缓冲
  //          diagEvents 始终记录，排查时开 debug 或直接读 /cmdmon/snapshot）
  const cfg = {
    rewrite: config?.rewrite !== false,
    pythonUnbuffered: config?.pythonUnbuffered !== false,
    warn: config?.warn !== false,
    foregroundStream: config?.foregroundStream !== false,
    debug: config?.debug === true
  };
  // 终端信息日志：默认静默（debug 开关控制）；错误日志始终保留
  const dbg = (...a) => { if (cfg.debug) console.log(...a); };
  // jobs 的访问判定是**会话 id 字符串**比较（dsh-jobs-local: `job.owner.id !== caller`
  // 抛 "belongs to another session"），官方工具也传 `exec.agent?.id`。传 Agent 对象
  // 一律被拒——这正是"任务能看到、输出一条都读不到"的根因。统一在这里取 id 字符串。
  const callerId = (agent) => (
    typeof agent === 'string' ? agent
      : (agent && typeof agent.id === 'string' ? agent.id : undefined)
  );

  // ---- 状态 ----
  const records = new Map(); // key: 'tool:<callId>' | 'job:<jobId>'
  // jobId -> Agent（该任务的 owner，jobs.read/get 的 caller）。
  // 权威登记来自 tools/result（启动该任务的 exec.agent），事件兜底登记绝不复写（见 lib/jobsync.js）
  const jobOwners = createOwnerRegistry();
  const rewrites = new Map(); // 'tool:<callId>' -> { warnings, originalCommand, changed }（供 job 记录继承）
  const fgStreams = new Map(); // 'tool:<callId>' -> { file, offset }（前台 Tee 日志读取状态）
  const diagEvents = []; // 诊断事件环形缓冲，随 snapshot 输出（无需看宿主终端）
  const MAX_DIAG = 80;
  function diag(msg, extra) {
    diagEvents.push({ t: Date.now(), msg, ...(extra || {}) });
    if (diagEvents.length > MAX_DIAG) diagEvents.splice(0, diagEvents.length - MAX_DIAG);
  }
  let seq = 0;
  let owner = undefined; // 最近一次 tools/execute 的 agent（仅供 job 记录兜底关联）
  let streamEnabled = true;
  const MAX_OUTPUT = 400 * 1024;
  const MAX_RECORDS = 120;
  const bump = () => ++seq;

  function trim() {
    if (records.size <= MAX_RECORDS) return;
    const keys = [...records.keys()].slice(0, records.size - MAX_RECORDS);
    for (const k of keys) {
      const r = records.get(k);
      // 丢弃前先收尾：Tee 日志要删、owner 登记要清，否则文件与登记表会持续泄漏
      if (r && r.fgStream) finishTeeRecord(r, k);
      if (k.startsWith('job:')) jobOwners.clear(k.slice(4));
      records.delete(k);
    }
  }
  function ensure(key, init) {
    let r = records.get(key);
    if (!r) {
      r = { key, warnings: [], originalCommand: undefined, changed: false, ...init, lastSeq: 0 };
      records.set(key, r);
      trim();
    }
    return r;
  }
  function touch(r) { r.lastSeq = bump(); }
  function appendOutput(r, text) {
    if (!text) return;
    r.output = (r.output || '') + text;
    if (r.output.length > MAX_OUTPUT) {
      r.output = r.output.slice(-MAX_OUTPUT);
      r.truncated = true;
    }
    touch(r);
  }
  // 读取 Tee 日志增量：首次读取时按 BOM 识别编码（UTF-16LE / UTF-8+BOM），
  // 避免 Tee 默认 UTF-16 被按 UTF-8 读成乱码（实测 FF FE + 3D 00 ...）
  function readTeeDelta(f) {
    const buf = readFileSync(f.file);
    if (f.encoding === undefined) {
      if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) { f.encoding = 'utf16le'; f.skip = 2; }
      else if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) { f.encoding = 'utf8'; f.skip = 3; }
      else { f.encoding = 'utf8'; f.skip = 0; }
    }
    if (buf.length <= f.offset) return '';
    const start = Math.max(f.offset, f.skip);
    const text = buf.slice(start).toString(f.encoding === 'utf16le' ? 'utf16le' : 'utf8');
    f.offset = buf.length;
    return text;
  }
  // Tee 任务终止收尾：读剩余输出、删日志文件、注销轮询状态
  function finishTeeRecord(r, key) {
    const f = fgStreams.get(key);
    if (!f) return;
    try {
      const text = readTeeDelta(f);
      if (text) appendOutput(r, text);
    } catch (e) { /* 文件未创建/已删：忽略 */ }
    try { unlinkSync(f.file); } catch (e) { /* noop */ }
    fgStreams.delete(key);
  }
  // 读取被拒（caller 不属于任务所在会话）：标记后不再重试，且只诊断一次——
  // 否则每 500ms 一条 poll FAILED 会把 80 条 diagEvents 缓冲刷满（实测）。
  function noteReadDenied(r, id, msg) {
    r.readDenied = true;
    r.readError = msg;
    if (r.deniedLogged) return;
    r.deniedLogged = true;
    console.error(`cmdmon: 无权读取任务 ${id} 的输出（${msg}）`);
    diag('poll denied', { jobId: id, error: msg });
  }
  // 任务已不在任务库：状态无法再确认，不谎报 completed，收尾 Tee 日志后停止轮询
  function finalizeGoneJob(r, key) {
    if (r.fgStream) finishTeeRecord(r, key);
    r.status = 'unknown';
    r.finishedAt = r.finishedAt || Date.now();
    touch(r);
  }
  function textFromContent(content) {
    if (!Array.isArray(content)) return '';
    let out = '';
    for (const b of content) {
      if (b && b.type === 'text' && typeof b.text === 'string') out += b.text;
    }
    return out;
  }
  function commandOf(name, args) {
    if (args && typeof args === 'object') {
      if (typeof args.command === 'string') return args.command;
      if (name === 'job_output' && typeof args.job_id === 'string') return 'job_output ' + args.job_id;
      if (name === 'job_kill' && typeof args.job_id === 'string') return 'job_kill ' + args.job_id;
      if (name === 'job_list') return 'job_list';
    }
    return '';
  }

  // ---- 前台工具调用：开始（含命令净化 + 实时输出包装）----
  ctx.on('tools/execute', (exec, next) => {
    try {
      if (exec && exec.agent) owner = exec.agent;
      const toolName = exec && exec.name;
      const args = exec && exec.arguments;
      let cmd = commandOf(toolName, args);
      // 命令净化：检测管道 + 插入 Tee（pwsh Tee-Object / bash tee）把输出落盘，
      // 插件轮询文件实现实时显示。Tee 插在最早的收集/消耗段之前，原管道语义
      // 保留（-Last、Out-File、Get-Content 等工具结果不变）。
      // 注意 exec.arguments 是 dsh-tools createExecution 的 deepFreeze 只读快照，
      // 原地赋值会抛错——整体替换 exec.arguments 为新对象（exec 在 execute 阶段
      // 可写，官方 timeout 插件改 exec.signal 同理），改写后的命令会被真实执行；
      // 权限门 tools/pre-execute 已在此前基于原始命令通过，因此只插入 Tee 管道，
      // 绝不改变程序与参数语义。
      // meta.warnings = 需要留意的**问题**（挂 ⚠ 徽标）；meta.notes = 例行说明
      // （已包装、已注入等，只在展开行里用一行灰字显示）——此前把例行说明也塞进
      // warnings，导致每条前台命令都挂 ⚠ 外加一段长路径，视觉噪声过大。
      const meta = { warnings: [], notes: [], originalCommand: undefined, changed: false, teeFile: undefined, partial: false };
      const bg = !!(args && args.run_in_background === true);
      // 诊断：后台调用无条件记录（即使没有警示/改写），确认钩子是否触发
      if (bg) {
        const c = (args && args.command || '').slice(0, 200);
        dbg(`[cmdmon] execute bg tool=${toolName} callId=${exec && exec.callId} cmd=${JSON.stringify(c)}`);
        diag('execute bg', { tool: toolName, callId: exec && exec.callId, cmd: c });
      }
      if (args && typeof args.command === 'string') {
        let analyzed;
        try {
          analyzed = analyzeCommand(args.command, { detect: cfg.warn });
        } catch (err) {
          // 净化失败：绝不阻断工具调用，记录诊断 + 降级为警示
          console.error('cmdmon analyzeCommand failed', err);
          diag('analyzeCommand FAILED', { tool: toolName, bg, error: String(err && err.message || err), stack: err && err.stack });
          analyzed = { command: args.command, changed: false, original: args.command, warnings: ['命令净化失败：' + (err && err.message || err)] };
        }
        meta.warnings = analyzed.warnings;
        // 实时输出包装：后台仅在存在收集/消耗段时包装（jobs 通道本身可流式）；
        // 前台总是包装。命中 python 时注入 PYTHONUNBUFFERED。
        const wrapEnabled = bg ? (cfg.rewrite && cfg.pythonUnbuffered) : cfg.foregroundStream;
        if (wrapEnabled && (toolName === 'pwsh' || toolName === 'bash')) {
          try {
            const wrap = buildStreamWrap(args.command, {
              tool: toolName,
              callId: exec && exec.callId,
              workdir: typeof args.workdir === 'string' ? args.workdir : undefined,
              mode: bg ? 'bg' : 'fg'
            });
            if (wrap) {
              let assigned = false;
              try { args.command = wrap.wrapped; assigned = true; } catch (e1) { /* deepFreeze：原地失败 */ }
              if (!assigned) {
                try { exec.arguments = { ...args, command: wrap.wrapped }; assigned = true; }
                catch (e2) { diag('rewrite assign FAILED', { tool: toolName, error: String(e2 && e2.message || e2) }); }
              }
              if (assigned) {
                cmd = wrap.wrapped;
                meta.originalCommand = analyzed.original;
                meta.changed = true;
                meta.teeFile = wrap.file;
                // 已成功包装 → 例行说明进 notes，检测到的阻断段不再挂 ⚠（已经处理掉了）
                meta.notes = [
                  meta.warnings.length > 0
                    ? '已插入 Tee（位于收集/重定向段之前，原管道语义保留）'
                    : '已插入 Tee 实时输出',
                  ...(wrap.injectedPython ? ['已注入 PYTHONUNBUFFERED'] : []),
                  ...(wrap.partial ? ['部分语句（语句块/赋值等）无法包装，完成后显示完整输出'] : [])
                ];
                meta.partial = !!wrap.partial;
                meta.warnings = [];
                diag(bg ? 'rewritten' : 'fgStream wrap', { tool: toolName, callId: exec && exec.callId, to: wrap.wrapped.slice(0, 160) });
              } else {
                meta.warnings = [...meta.warnings, '命令包装失败（工具参数为只读快照），已按原命令执行'];
              }
            }
          } catch (e3) {
            diag('stream wrap FAILED', { tool: toolName, bg, error: String(e3 && e3.message || e3) });
          }
        }
        // 没能包装（多行命令、语句块收尾、赋值等）：属于命令形态限制而非故障 ——
        // 检测结果与原因合并成一行说明，不占 ⚠（⚠ 只留给包装/净化失败这类真问题）
        if (!bg && !meta.teeFile && meta.warnings.length) {
          // 0.5.4 起多行命令也会按语句包装，走到这里说明整条命令都是语句块/赋值等
          // 无法安全插管道的形态 —— 说清原因，别让人以为是"多行就不管了"
          meta.notes = [...meta.notes,
            `检测到 ${meta.warnings.length} 处阻断段，但整条命令是语句块/赋值等形态（无法安全插 Tee），输出完成后才显示`];
          meta.warnings = [];
        }
        rewrites.set('tool:' + String(exec.callId), meta);
      }
      const r = ensure('tool:' + String(exec.callId), {
        kind: 'tool', name: toolName, command: cmd || toolName,
        status: 'running', detail: undefined,
        startedAt: Date.now(), finishedAt: undefined,
        output: '', truncated: false,
        sessionId: exec && exec.agent ? exec.agent.id : undefined,
        warnings: meta.warnings, notes: meta.notes, originalCommand: meta.originalCommand, changed: meta.changed,
        partial: meta.partial,
        fgStream: !bg && !!meta.teeFile // 前台工具记录直接流式；后台的流式在 job 记录上
      });
      r.status = 'running';
      r.finishedAt = undefined;
      r.warnings = meta.warnings;
      r.notes = meta.notes;
      r.originalCommand = meta.originalCommand;
      r.changed = meta.changed;
      r.partial = meta.partial;
      r.fgStream = !bg && !!meta.teeFile;
      // 前台：登记文件轮询状态
      if (r.fgStream && meta.teeFile) {
        fgStreams.set('tool:' + String(exec.callId), { file: meta.teeFile, offset: 0 });
      }
      touch(r);
    } catch (e) {
      console.error(`cmdmon execute hook failed tool=${exec && exec.name} bg=${!!(exec && exec.arguments && exec.arguments.run_in_background === true)}`, e);
      diag('execute hook FAILED', {
        tool: exec && exec.name,
        bg: !!(exec && exec.arguments && exec.arguments.run_in_background === true),
        error: String(e && e.message || e),
        stack: e && e.stack
      });
    }
    return next();
  });

  // ---- 前台工具调用：结果 ----
  ctx.on('tools/result', (exec, result) => {
    try {
      const toolName = exec && exec.name;
      const args = exec && exec.arguments;
      const value = result && result.value;
      // 继承 tools/execute 阶段的净化元数据（warnings / 原始命令 / 是否改写）
      const metaKey = 'tool:' + String(exec.callId);
      const meta = rewrites.get(metaKey) || { warnings: [], originalCommand: undefined, changed: false };
      rewrites.delete(metaKey);
      // pwsh 后台启动：value = { kind: 'background', jobId }
      if (value && typeof value === 'object' && value.kind === 'background' && typeof value.jobId === 'string') {
        dbg(`[cmdmon] job registered ${value.jobId} tool=${toolName} owner=${exec && exec.agent ? 'yes(' + exec.agent.id + ')' : 'NO!'} changed=${meta.changed} warnings=${meta.warnings.length}`);
        diag('job registered', { jobId: value.jobId, tool: toolName, owner: exec && exec.agent ? exec.agent.id : null, changed: meta.changed });
        const r = ensure('job:' + value.jobId, {
          kind: 'job', name: toolName, command: commandOf(toolName, args) || toolName,
          status: 'running', detail: undefined,
          startedAt: Date.now(), finishedAt: undefined,
          output: '', truncated: false,
          sessionId: exec && exec.agent ? exec.agent.id : undefined
        });
        r.status = 'running';
        // 显式写入净化元数据：job 记录可能已被 onJobsChanged(syncJob) 先创建，
        // ensure 不会覆盖 init，必须在这里赋值（修复警示/原始命令丢失）
        r.warnings = meta.warnings;
        r.notes = meta.notes;
        r.partial = meta.partial;
        r.originalCommand = meta.originalCommand;
        r.changed = meta.changed;
        // 后台 Tee 实时输出：把文件轮询状态从工具记录转给 job 记录
        if (meta.teeFile) {
          r.fgStream = true;
          fgStreams.set('job:' + value.jobId, { file: meta.teeFile, offset: 0 });
        }
        // 记录该 job 的确切 owner（exec.agent 就是启动它的 agent）——**权威登记**：
        // 存会话 id 字符串（jobs 的 caller 语义），可覆盖事件兜底写进来的错误 owner，
        // 并解除"读取被拒"标记重新尝试读取
        if (jobOwners.register(value.jobId, callerId(exec && exec.agent), true)) {
          r.readDenied = false;
          r.deniedLogged = false;
          r.readError = undefined;
        }
        touch(r);
      }
      const key = 'tool:' + String(exec.callId);
      const r = records.get(key);
      if (!r) return;
      // 前台 Tee 实时输出收尾：读剩余、删日志文件
      if (r.fgStream) finishTeeRecord(r, key);
      r.status = result && result.isError ? 'failed' : 'completed';
      r.finishedAt = Date.now();
      const text = textFromContent(result && result.content);
      if (toolName === 'job_output' && !streamEnabled && value && typeof value === 'object' && typeof value.text === 'string') {
        // 流模式关闭时，dsh 每次 job_output 的增量也展示出来
        appendOutput(r, value.text);
      }
      // 前台 Tee 记录的输出已由文件流式捕获（含尾部），不再重复追加工具结果。
      // 例外：包装只覆盖了部分语句（语句块/赋值等没插 Tee）时，日志缺少那部分输出，
      // 完成后用完整工具结果**替换**，避免面板少显示（运行中仍显示已有的实时内容）。
      if (r.fgStream) {
        if (r.partial && text) {
          r.output = text;
          if (r.output.length > MAX_OUTPUT) { r.output = r.output.slice(-MAX_OUTPUT); r.truncated = true; }
        }
        touch(r);
      }
      else if (text) appendOutput(r, text);
      else touch(r);
    } catch (e) { console.error('cmdmon result hook failed', e); }
  });

  // ---- 后台任务：状态同步 ----
  function syncJob(snap, jobOwner) {
    if (!snap) return;
    const key = 'job:' + snap.id;
    // 会话 id：本版本 jobs 视图暴露的是 `owner`（会话 id 字符串），旧字段名是 ownerSession
    const snapOwner = snap.owner !== undefined ? snap.owner : snap.ownerSession;
    const fallbackCaller = callerId(jobOwner);
    const r = ensure(key, {
      kind: 'job', name: snap.kind, command: snap.label || snap.kind,
      status: snap.status, detail: snap.detail,
      startedAt: snap.startedAt, finishedAt: snap.finishedAt,
      output: '', truncated: false,
      sessionId: snapOwner !== undefined ? snapOwner : fallbackCaller
    });
    r.name = snap.kind;
    r.command = snap.label || r.command;
    r.status = snap.status;
    r.detail = snap.detail;
    r.startedAt = snap.startedAt;
    r.finishedAt = snap.finishedAt;
    if (snapOwner !== undefined) r.sessionId = snapOwner;
    else if (fallbackCaller !== undefined) r.sessionId = fallbackCaller;
    // owner 兜底登记（存会话 id 字符串）：事件携带的 caller 可能来自其他会话
    // （owner 作用域派发的"最后调用者"），因此只在尚无登记时写入，绝不复写权威登记
    jobOwners.register(snap.id, fallbackCaller, false);
    // 终止时：读剩余 Tee 输出并清理日志文件
    if (r.fgStream && isTerminalJobStatus(r.status)) {
      finishTeeRecord(r, key);
    }
    touch(r);
  }
  if (jobs) {
const _has_onJobsChanged = typeof jobs.onJobsChanged === 'function';
const _onJobsChanged = _has_onJobsChanged ? jobs.onJobsChanged.bind(jobs) : () => () => {};
// dsh-jobs 0.2.x 不再提供 onJobsChanged：缺失时退化为空订阅，状态刷新走 jobs.get 轮询
// ── pwsh_stream：把「前台命令」变成走 jobs 通道的流式执行 ─────────────────────
// 0.2.x 明确排除输入改写（Input rewriting is excluded），所以前台命令拿不到实时
// 输出；这个工具的执行天然写进 job 输出环，面板的「任务行」本来就是实时的。
// 整段防御性包裹：作用域/服务不满足时只跳过注册，绝不影响既有功能。
try {
  const _toolsSvc =
    (typeof ctx !== "undefined" && ctx && ctx.tools) ||
    (typeof tools !== "undefined" && tools) || null;
  const _jobsSvc =
    (typeof ctx !== "undefined" && ctx && ctx.jobs) ||
    (typeof jobs !== "undefined" && jobs) || null;
  if (_toolsSvc && _jobsSvc && typeof _toolsSvc.register === "function" && typeof defineTool === "function") {
    _toolsSvc.register(defineTool({
      name: "pwsh_stream",
      description: "执行 PowerShell 命令，输出实时流式显示在「命令监视」面板（长命令用这个）",
      parameters: { command: { type: "string" }, cwd: { type: "string" } },
      output: {
        // dsh-tools 新版要求 object schema 显式声明 additionalProperties，否则 defineTool
        // 直接抛错（此前被静默 try/catch 吞掉，导致 pwsh_stream 从未注册成功）
        schema: { type: "object", additionalProperties: false, properties: { output: { type: "string" }, code: { type: "number" } } },
        render: (_args, value) => [{ type: "text", text: String((value && value.output) || "") }],
      },
      presentCall: (args) => ({ card: "terminal", command: args.command, cwd: args.cwd }),
      presentResult: (_args, result) => ({
        card: "terminal",
        output: (result && result.content ? result.content.map((b) => b.text || "").join("") : ""),
      }),
      async execute(args, exec) {
        let settle = null;
        const done = new Promise((res) => { settle = res; });
        let code = 0;
        _jobsSvc.start({
          kind: "pwsh",
          label: args.command,
          owner: exec && exec.agent ? exec.agent.id : undefined,
          run(job) {
            const child = spawn(
              "pwsh",
              ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", args.command],
              { cwd: args.cwd, signal: exec ? exec.signal : undefined },
            );
            let all = "";
            job.append(`$ ${args.command}\n`, { channel: "stdout" });
            const push = (buf, channel) => {
              const t = buf.toString();
              all += t;
              job.append(t, { channel });
            };
            child.stdout.on("data", (b) => push(b, "stdout"));
            child.stderr.on("data", (b) => push(b, "stderr"));
            child.on("close", (c) => {
              code = typeof c === "number" ? c : 0;
              settle({ status: code === 0 ? "completed" : "failed", detail: `exit code: ${code}`, result: all });
            });
            return { cancel: () => { try { child.kill(); } catch (e) {} }, done };
          },
        });
        const outcome = await done;
        return { output: (outcome && outcome.result) || "", code };
      },
    }));
  }
} catch (e) {
  // 注册失败不影响既有功能
}

    const offChanged = _onJobsChanged((own) => {
      try {
        if (own) owner = own;
        const list = jobs.list(callerId(owner));
        for (const snap of list) syncJob(snap, owner);
      } catch (e) { console.error('cmdmon jobs changed failed', e); }
    });
const _has_onJobDone = typeof jobs.onJobDone === 'function';
const _onJobDone = _has_onJobDone ? jobs.onJobDone.bind(jobs) : () => () => {};
// dsh-jobs 0.2.x 不再提供 onJobDone：缺失时退化为空订阅，状态刷新走 jobs.get 轮询
    const offDone = _onJobDone((snap, own) => {
      try {
        if (own) owner = own;
        syncJob(snap, own);
      } catch (e) { console.error('cmdmon jobs done failed', e); }
    });
    ctx.effect(() => { offChanged(); offDone(); });
    try {
      const initialCaller = callerId(owner);
      if (initialCaller !== undefined) for (const snap of jobs.list(initialCaller)) syncJob(snap, owner);
    } catch (e) { /* noop */ }
  }

  // ---- 后台输出实时轮询 + Tee 日志轮询 + 任务状态兜底 ----
  // 注意：onJobDone/onJobsChanged 监听器按 owner 作用域链派发（ScopedLayers），
  // 静态插件注册的监听器可能不在 owner 链上，终止事件收不到——因此用
  // jobs.get(id, owner) 每 500ms 轮询状态兜底（不消耗输出，store 保留终止任务）。
  if (timer) {
    const offPoll = timer.interval(() => {
      // Tee 日志文件轮询（前台工具记录 + 后台任务记录；不受流开关影响）
      for (const r of records.values()) {
        if (!r.fgStream) continue;
        if (r.status !== 'running' && r.status !== 'stopping') continue;
        const f = fgStreams.get(r.key);
        if (!f) continue;
        try {
          const text = readTeeDelta(f);
          if (text) appendOutput(r, text);
        } catch (e) { /* 文件尚未创建或已被清理：跳过 */ }
      }
      // 任务状态兜底：所有 job 记录用 jobs.get 刷新（不消耗输出，不受流开关影响）
      if (jobs) {
        for (const r of records.values()) {
          if (r.kind !== 'job') continue;
          if (r.status !== 'running' && r.status !== 'stopping') continue;
          const id = r.key.slice(4);
          const jobOwner = jobOwners.get(id);
          if (!jobOwner) continue;
          if (r.readDenied) continue; // 已确认 caller 不属于该任务会话：不再重试
          try {
            const snap = jobs.get(id, jobOwner);
            if (snap) {
              r.status = snap.status;
              r.detail = snap.detail;
              r.finishedAt = snap.finishedAt;
              if (isTerminalJobStatus(snap.status)) {
                if (r.fgStream) finishTeeRecord(r, r.key); // Tee 任务终止：读剩余+清理日志
                // 包装只覆盖了部分语句（语句块/赋值等）：Tee 日志缺那部分输出，
                // 终止时补读一次任务输出并**替换**，保证面板最终看到完整结果
                if (r.partial && !r.readDenied) {
                  try {
                    const full = renderJobRead(jobs.read(id, jobOwner));
                    if (full) {
                      r.output = full;
                      if (r.output.length > MAX_OUTPUT) { r.output = r.output.slice(-MAX_OUTPUT); r.truncated = true; }
                    }
                  } catch (e) { /* 读不到就保留已有输出 */ }
                }
                touch(r);
              }
            }
          } catch (e) {
            const msg = String(e && e.message || e);
            const kind = classifyJobError(msg);
            if (kind === 'denied') noteReadDenied(r, id, msg);
            else if (kind === 'gone') finalizeGoneJob(r, r.key);
            else if (!r.fgStream) r.readError = msg;
          }
        }
      }
      if (!streamEnabled || !jobs) return;
      // 非 Tee 后台任务：jobs.read 增量输出（消耗性，受流开关控制）
      for (const r of records.values()) {
        if (r.kind !== 'job') continue;
        if (r.fgStream) continue; // Tee 文件已提供实时输出，避免重复读
        if (r.status !== 'running' && r.status !== 'stopping') continue;
        const id = r.key.slice(4);
        const jobOwner = jobOwners.get(id);
        if (!jobOwner) {
          r.readError = 'owner 未登记，无法读取输出';
          continue; // 未登记 owner 的任务跳过（无法通过权限读）
        }
        if (r.readDenied) continue; // 已被拒：不再重试，避免每 500ms 刷诊断
        try {
          const read = jobs.read(id, jobOwner);
          // 真实形状是 { chunks, lossy, result?, job }；旧版是 { text, snapshot }
          const text = renderJobRead(read);
          if (text) {
            if (!r.streamedOnce) {
              r.streamedOnce = true;
              dbg(`[cmdmon] stream started job=${id} bytes=${text.length}`);
              diag('stream started', { jobId: id, bytes: text.length });
            }
            appendOutput(r, text);
          }
          // 结算结果只补一次（官方 job_output 也是这个语义）
          if (read && typeof read.result === 'string' && read.result.length > 0 && !r.resultAppended) {
            r.resultAppended = true;
            appendOutput(r, (r.output && !r.output.endsWith('\n') ? '\n' : '') + read.result);
          }
          const view = jobViewOf(read);
          if (view) {
            r.status = view.status;
            r.detail = view.detail;
            r.finishedAt = view.finishedAt;
            if (isTerminalJobStatus(view.status)) {
              if (r.fgStream) finishTeeRecord(r, r.key);
            }
            touch(r);
          }
        } catch (e) {
          // 单个任务读取失败只跳过它，不中断整轮轮询
          const msg = String(e && e.message || e);
          const kind = classifyJobError(msg);
          if (kind === 'denied') {
            // caller 会话不符：重试无意义，标记一次即可（不再刷 console/diag）
            noteReadDenied(r, id, msg);
          } else {
            r.readError = msg;
            console.error('cmdmon poll failed for ' + id, e);
            diag('poll FAILED', { jobId: id, error: msg });
          }
        }
      }
    }, 500);
    ctx.effect(() => offPoll);
  }

  // ---- HTTP 端点（Client 轮询）----
  function json(res, code, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(code, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(body);
  }
  function readBody(req) {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (c) => { data += c; });
      req.on('end', () => {
        try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
      });
      req.on('error', reject);
    });
  }
  function queryOf(req) {
    const url = new URL(req.url, 'http://localhost');
    return url.searchParams;
  }

  // 记录序列化（snapshot / wait 共用，字段与面板一致）
  function serializeRecord(r) {
    return {
      key: r.key, kind: r.kind, name: r.name, command: r.command,
      status: r.status,
      detail: r.detail === undefined ? null : r.detail,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt === undefined ? null : r.finishedAt,
      output: r.output, truncated: r.truncated,
      sessionId: r.sessionId === undefined ? null : r.sessionId,
      warnings: r.warnings || [], notes: r.notes || [],
      originalCommand: r.originalCommand === undefined ? null : r.originalCommand,
      changed: !!r.changed,
      // 诊断字段（排查实时流问题）
      ownerRegistered: r.kind === 'job' ? jobOwners.has(r.key.slice(4)) : null,
      readDenied: !!r.readDenied,
      partial: !!r.partial,
      streamedOnce: !!r.streamedOnce,
      readError: r.readError === undefined ? null : r.readError,
      fgStream: !!r.fgStream
    };
  }
  const isTerminalStatus = (s) => s === 'completed' || s === 'failed' || s === 'killed';
  // 会话可见性：与 snapshot 同一套规则（无 session 参数只看无归属记录；all=1 为排查用）
  function visibleTo(r, session, wantAll) {
    if (wantAll) return true;
    if (session === undefined) return r.sessionId === undefined;
    return r.sessionId === session;
  }

  // 增量快照：GET /cmdmon/snapshot?since=N&session=<id>
  // 会话隔离：面板必须带上自己的 session；不带（且未显式 all=1 做排查）时，
  // 只返回没有会话归属的记录，绝不把其它会话的命令回给这个面板——即使某个客户端
  // 位置拿不到会话标识（如 root scope 的 shell.overlay），也不会串会话。
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/cmdmon/snapshot',
    handler: (req, res) => {
      try {
        const q = queryOf(req);
        const since = Number(q.get('since')) || 0;
        const session = q.get('session') || undefined;
        const wantAll = q.get('all') === '1';
        const out = [];
        for (const r of records.values()) {
          if (r.lastSeq <= since) continue;
          if (!visibleTo(r, session, wantAll)) continue;
          out.push(serializeRecord(r));
        }
        json(res, 200, {
          seq, records: out, streamEnabled,
          diag: { timer: !!timer, jobs: !!jobs },
          diagEvents: diagEvents.slice(-60)
        });
      } catch (e) {
        json(res, 500, { error: String(e && e.message || e) });
      }
    }
  }));

  // 精确等待（长轮询）：GET /cmdmon/wait?key=<recordKey>&timeout_ms=N[&session=<id>|&all=1]
  // 目标记录进入终止状态（completed/failed/killed）时立即返回；不带 key 时等待当前
  // 可见范围内**没有** running/stopping 记录。供任何进程/会话做零预估等待：
  // job_output 只对任务 owner 可用且有 30s 默认等待上限，而这里跨会话、无上限预估。
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/cmdmon/wait',
    handler: async (req, res) => {
      const q = queryOf(req);
      const key = q.get('key') || undefined;
      const session = q.get('session') || undefined;
      const wantAll = q.get('all') === '1';
      const rawTimeout = Number(q.get('timeout_ms'));
      const timeoutMs = Math.min(
        Math.max(Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 600000, 1),
        3600000
      );
      const t0 = Date.now();
      let closed = false;
      req.on('close', () => { closed = true; });
      try {
        for (;;) {
          const rec = key !== undefined ? records.get(key) : undefined;
          const recVisible = rec !== undefined && visibleTo(rec, session, wantAll);
          if (key !== undefined) {
            if (recVisible && isTerminalStatus(rec.status)) {
              json(res, 200, {
                ok: true, key, found: true, waitedMs: Date.now() - t0,
                timedOut: false, record: serializeRecord(rec)
              });
              return;
            }
          } else {
            const pending = [...records.values()].filter((r) =>
              visibleTo(r, session, wantAll) && (r.status === 'running' || r.status === 'stopping'));
            if (pending.length === 0) {
              json(res, 200, {
                ok: true, key: null, found: true, waitedMs: Date.now() - t0,
                timedOut: false, pending: 0
              });
              return;
            }
          }
          if (closed) return; // 客户端已断开：静默结束，不再写响应
          if (Date.now() - t0 >= timeoutMs) {
            json(res, 200, {
              ok: true, key: key === undefined ? null : key,
              found: key === undefined ? true : recVisible,
              waitedMs: Date.now() - t0, timedOut: true,
              record: recVisible ? serializeRecord(rec) : null
            });
            return;
          }
          await new Promise((r) => setTimeout(r, 300));
        }
      } catch (e) {
        try { json(res, 500, { error: String(e && e.message || e) }); } catch (e2) { /* noop */ }
      }
    }
  }));

  // 流开关：POST /cmdmon/setStream  body { enabled }
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/cmdmon/setStream',
    handler: async (req, res) => {
      try {
        const body = await readBody(req);
        streamEnabled = !!(body && body.enabled);
        json(res, 200, { streamEnabled });
      } catch (e) {
        json(res, 400, { error: String(e && e.message || e) });
      }
    }
  }));

  // 清空：POST /cmdmon/clear  body { session: id } | { all: true }
  // 会话隔离：必须显式指定要清哪个会话；不带参数时**什么都不清**（此前无 body 会被
  // 当成"全清"，一个拿不到会话标识的面板点「清空」就会清掉所有会话的记录）。
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/cmdmon/clear',
    handler: async (req, res) => {
      try {
        let session = undefined;
        let wipeAll = false;
        try {
          const body = await readBody(req);
          if (body && typeof body.session === 'string') session = body.session;
          if (body && body.all === true) wipeAll = true;
        } catch (e) { /* 无 body 或非 JSON：视为未指定 */ }
        let cleared = 'none';
        if (wipeAll) {
          for (const f of fgStreams.values()) { try { unlinkSync(f.file); } catch (e) { /* noop */ } }
          fgStreams.clear();
          records.clear();
          rewrites.clear();
          jobOwners.clearAll();
          cleared = 'all';
        } else if (session !== undefined) {
          for (const key of [...records.keys()]) {
            if (records.get(key).sessionId === session) {
              const f = fgStreams.get(key);
              if (f) { try { unlinkSync(f.file); } catch (e) { /* noop */ } fgStreams.delete(key); }
              if (key.startsWith('job:')) jobOwners.clear(key.slice(4));
              records.delete(key);
            }
          }
          cleared = session;
        }
        bump();
        json(res, 200, { seq, cleared });
      } catch (e) {
        json(res, 500, { error: String(e && e.message || e) });
      }
    }
  }));
}

export { name, inject, apply };
