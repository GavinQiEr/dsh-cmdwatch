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

import { analyzeCommand, buildStreamWrap } from './rewrite.js';
import { readFileSync, unlinkSync } from 'node:fs';

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

  // ---- 状态 ----
  const records = new Map(); // key: 'tool:<callId>' | 'job:<jobId>'
  const jobOwners = new Map(); // jobId -> Agent（该任务的 owner，jobs.read 的 caller）
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
    for (const k of keys) records.delete(k);
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
      const meta = { warnings: [], originalCommand: undefined, changed: false, teeFile: undefined };
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
                meta.warnings = [...meta.warnings,
                  '已插入 Tee 实时输出（日志：' + wrap.file + '，原管道语义保留）',
                  ...(wrap.injectedPython ? ['已注入 PYTHONUNBUFFERED（避免 python 块缓冲）'] : [])];
                diag(bg ? 'rewritten' : 'fgStream wrap', { tool: toolName, callId: exec && exec.callId, to: wrap.wrapped.slice(0, 160) });
              } else {
                meta.warnings = [...meta.warnings, '命令包装失败（工具参数为只读快照），已按原命令执行'];
              }
            }
          } catch (e3) {
            diag('stream wrap FAILED', { tool: toolName, bg, error: String(e3 && e3.message || e3) });
          }
        }
        // 前台且未启用实时输出时，才提示"完成后显示"
        if (!bg && meta.warnings.length && cfg.warn && !meta.teeFile) {
          meta.warnings = [...meta.warnings, '（该调用为前台执行，输出完成后才会显示；实时进度仅后台任务支持）'];
        }
        rewrites.set('tool:' + String(exec.callId), meta);
      }
      const r = ensure('tool:' + String(exec.callId), {
        kind: 'tool', name: toolName, command: cmd || toolName,
        status: 'running', detail: undefined,
        startedAt: Date.now(), finishedAt: undefined,
        output: '', truncated: false,
        sessionId: exec && exec.agent ? exec.agent.id : undefined,
        warnings: meta.warnings, originalCommand: meta.originalCommand, changed: meta.changed,
        fgStream: !bg && !!meta.teeFile // 前台工具记录直接流式；后台的流式在 job 记录上
      });
      r.status = 'running';
      r.finishedAt = undefined;
      r.warnings = meta.warnings;
      r.originalCommand = meta.originalCommand;
      r.changed = meta.changed;
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
        r.originalCommand = meta.originalCommand;
        r.changed = meta.changed;
        // 后台 Tee 实时输出：把文件轮询状态从工具记录转给 job 记录
        if (meta.teeFile) {
          r.fgStream = true;
          fgStreams.set('job:' + value.jobId, { file: meta.teeFile, offset: 0 });
        }
        // 记录该 job 的确切 owner（exec.agent 是启动它的 agent）
        if (exec && exec.agent) jobOwners.set(value.jobId, exec.agent);
        touch(r);
      }
      const key = 'tool:' + String(exec.callId);
      const r = records.get(key);
      if (!r) return;
      // 前台 Tee 实时输出收尾：读剩余、删日志文件
      if (r.fgStream) {
        const f = fgStreams.get(key);
        if (f) {
          try {
            const text = readTeeDelta(f);
            if (text) appendOutput(r, text);
          } catch (e) { /* 文件未创建/已删：忽略 */ }
          try { unlinkSync(f.file); } catch (e) { /* noop */ }
          fgStreams.delete(key);
        }
      }
      r.status = result && result.isError ? 'failed' : 'completed';
      r.finishedAt = Date.now();
      const text = textFromContent(result && result.content);
      if (toolName === 'job_output' && !streamEnabled && value && typeof value === 'object' && typeof value.text === 'string') {
        // 流模式关闭时，dsh 每次 job_output 的增量也展示出来
        appendOutput(r, value.text);
      }
      // 前台 Tee 记录的输出已由文件流式捕获（含尾部），不再重复追加工具结果
      if (r.fgStream) { touch(r); }
      else if (text) appendOutput(r, text);
      else touch(r);
    } catch (e) { console.error('cmdmon result hook failed', e); }
  });

  // ---- 后台任务：状态同步 ----
  function syncJob(snap, jobOwner) {
    if (!snap) return;
    const key = 'job:' + snap.id;
    const r = ensure(key, {
      kind: 'job', name: snap.kind, command: snap.label || snap.kind,
      status: snap.status, detail: snap.detail,
      startedAt: snap.startedAt, finishedAt: snap.finishedAt,
      output: '', truncated: false,
      sessionId: snap.ownerSession !== undefined ? snap.ownerSession : (jobOwner ? jobOwner.id : undefined)
    });
    r.name = snap.kind;
    r.command = snap.label || r.command;
    r.status = snap.status;
    r.detail = snap.detail;
    r.startedAt = snap.startedAt;
    r.finishedAt = snap.finishedAt;
    if (snap.ownerSession !== undefined) r.sessionId = snap.ownerSession;
    else if (jobOwner) r.sessionId = jobOwner.id;
    // 登记该 job 的确切 owner（回调携带的 Agent 实例）
    if (jobOwner) jobOwners.set(snap.id, jobOwner);
    // 终止时：读剩余 Tee 输出并清理日志文件
    if (r.fgStream && (r.status === 'completed' || r.status === 'failed' || r.status === 'killed')) {
      const f = fgStreams.get(key);
      if (f) {
        try {
          const text = readTeeDelta(f);
          if (text) appendOutput(r, text);
        } catch (e) { /* 文件未创建/已删：忽略 */ }
        try { unlinkSync(f.file); } catch (e) { /* noop */ }
        fgStreams.delete(key);
      }
    }
    touch(r);
  }
  if (jobs) {
    const offChanged = jobs.onJobsChanged((own) => {
      try {
        if (own) owner = own;
        const list = jobs.list(owner);
        for (const snap of list) syncJob(snap, owner);
      } catch (e) { console.error('cmdmon jobs changed failed', e); }
    });
    const offDone = jobs.onJobDone((snap, own) => {
      try {
        if (own) owner = own;
        syncJob(snap, own);
      } catch (e) { console.error('cmdmon jobs done failed', e); }
    });
    ctx.effect(() => { offChanged(); offDone(); });
    try {
      if (owner) for (const snap of jobs.list(owner)) syncJob(snap, owner);
    } catch (e) { /* noop */ }
  }

  // ---- 后台输出实时轮询（消耗性，受流开关控制）+ 前台 Tee 日志轮询 ----
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
      if (!streamEnabled || !jobs) return;
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
        try {
          const read = jobs.read(id, jobOwner);
          if (read && read.text) {
            if (!r.streamedOnce) {
              r.streamedOnce = true;
              dbg(`[cmdmon] stream started job=${id} bytes=${read.text.length}`);
              diag('stream started', { jobId: id, bytes: read.text.length });
            }
            appendOutput(r, read.text);
          }
          if (read && read.snapshot) {
            const s = read.snapshot;
            r.status = s.status;
            r.detail = s.detail;
            r.finishedAt = s.finishedAt;
            touch(r);
          }
        } catch (e) {
          // 单个任务读取失败只跳过它，不中断整轮轮询
          r.readError = String(e && e.message || e);
          console.error('cmdmon poll failed for ' + id, e);
          diag('poll FAILED', { jobId: id, error: String(e && e.message || e) });
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

  // 增量快照：GET /cmdmon/snapshot?since=N&session=<id>
  // session 参数存在时只返回该会话的记录（每个会话面板只看自己的命令）。
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/cmdmon/snapshot',
    handler: (req, res) => {
      try {
        const since = Number(queryOf(req).get('since')) || 0;
        const session = queryOf(req).get('session') || undefined;
        const out = [];
        for (const r of records.values()) {
          if (r.lastSeq <= since) continue;
          if (session !== undefined && r.sessionId !== session) continue;
          out.push({
            key: r.key, kind: r.kind, name: r.name, command: r.command,
            status: r.status,
            detail: r.detail === undefined ? null : r.detail,
            startedAt: r.startedAt,
            finishedAt: r.finishedAt === undefined ? null : r.finishedAt,
            output: r.output, truncated: r.truncated,
            sessionId: r.sessionId === undefined ? null : r.sessionId,
            warnings: r.warnings || [], originalCommand: r.originalCommand === undefined ? null : r.originalCommand,
            changed: !!r.changed,
            // 诊断字段（排查实时流问题）
            ownerRegistered: r.kind === 'job' ? jobOwners.has(r.key.slice(4)) : null,
            streamedOnce: !!r.streamedOnce,
            readError: r.readError === undefined ? null : r.readError,
            fgStream: !!r.fgStream
          });
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

  // 清空：POST /cmdmon/clear  body { session?: id }
  // 带 session 时只清该会话的记录，避免误清其他会话。
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/cmdmon/clear',
    handler: async (req, res) => {
      try {
        let session = undefined;
        try {
          const body = await readBody(req);
          if (body && typeof body.session === 'string') session = body.session;
        } catch (e) { /* 无 body 或非 JSON：视为全清 */ }
        if (session === undefined) {
          for (const f of fgStreams.values()) { try { unlinkSync(f.file); } catch (e) { /* noop */ } }
          fgStreams.clear();
          records.clear();
          rewrites.clear();
        } else {
          for (const key of [...records.keys()]) {
            if (records.get(key).sessionId === session) {
              const f = fgStreams.get(key);
              if (f) { try { unlinkSync(f.file); } catch (e) { /* noop */ } fgStreams.delete(key); }
              records.delete(key);
            }
          }
        }
        bump();
        json(res, 200, { seq });
      } catch (e) {
        json(res, 500, { error: String(e && e.message || e) });
      }
    }
  }));
}

export { name, inject, apply };
