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

import { analyzeCommand } from './rewrite.js';

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
  const cfg = {
    rewrite: config?.rewrite !== false,
    pythonUnbuffered: config?.pythonUnbuffered !== false,
    warn: config?.warn !== false
  };

  // ---- 状态 ----
  const records = new Map(); // key: 'tool:<callId>' | 'job:<jobId>'
  const jobOwners = new Map(); // jobId -> Agent（该任务的 owner，jobs.read 的 caller）
  const rewrites = new Map(); // 'tool:<callId>' -> { warnings, originalCommand, changed }（供 job 记录继承）
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

  // ---- 前台工具调用：开始（含命令净化）----
  ctx.on('tools/execute', (exec, next) => {
    try {
      if (exec && exec.agent) owner = exec.agent;
      const toolName = exec && exec.name;
      const args = exec && exec.arguments;
      let cmd = commandOf(toolName, args);
      // 命令净化：分析原始命令；后台任务且开启 rewrite 时改写 exec.arguments。
      // 注意 exec.arguments 是 dsh-tools createExecution 的 deepFreeze 只读快照，
      // 原地赋值会抛错——改为整体替换 exec.arguments 为新对象（exec 在 execute
      // 阶段可写，官方 timeout 插件改 exec.signal 同理），改写后的命令会被真实执行；
      // 权限门 tools/pre-execute 已在此前基于原始命令通过，因此只剥离缓冲管道尾巴，
      // 绝不改变程序与参数语义。
      const meta = { warnings: [], originalCommand: undefined, changed: false };
      const bg = !!(args && args.run_in_background === true);
      // 诊断：后台调用无条件记录（即使没有警示/改写），确认钩子是否触发
      if (bg) {
        const c = (args && args.command || '').slice(0, 200);
        console.log(`[cmdmon] execute bg tool=${toolName} callId=${exec && exec.callId} cmd=${JSON.stringify(c)}`);
        diag('execute bg', { tool: toolName, callId: exec && exec.callId, cmd: c });
      }
      if (args && typeof args.command === 'string') {
        let analyzed;
        try {
          analyzed = analyzeCommand(args.command, {
            rewrite: cfg.rewrite && bg,
            pythonUnbuffered: cfg.pythonUnbuffered && bg,
            detect: cfg.warn,
            shell: toolName === 'bash' ? 'bash' : 'pwsh'
          });
        } catch (err) {
          // 净化失败：绝不阻断工具调用，记录诊断 + 降级为警示
          console.error('cmdmon analyzeCommand failed', err);
          diag('analyzeCommand FAILED', { tool: toolName, bg, error: String(err && err.message || err), stack: err && err.stack });
          analyzed = {
            command: args.command, changed: false, original: args.command,
            warnings: ['命令净化失败：' + (err && err.message || err)]
          };
        }
        meta.warnings = analyzed.warnings;
        if (analyzed.changed && analyzed.command !== args.command) {
          // exec.arguments 是 createExecution 里 snapshotJsonValue + deepFreeze 的
          // 只读快照（实测赋值抛 "Cannot assign to read only property 'command'"），
          // 不能原地改写；但 exec 本身在 execute 阶段可写（官方 dsh-tool-call-timeout-policy
          // 改 exec.signal 同理），因此整体替换 exec.arguments 为新对象，dispatch 时
          // tool.execute(exec.arguments, exec) 会读到改写后的命令。
          let assigned = false;
          try { args.command = analyzed.command; assigned = true; } catch (e1) { /* deepFreeze：原地失败 */ }
          if (!assigned) {
            try {
              exec.arguments = { ...args, command: analyzed.command };
              assigned = true;
            } catch (e2) {
              diag('rewrite assign FAILED', { tool: toolName, error: String(e2 && e2.message || e2) });
            }
          }
          if (assigned) {
            cmd = analyzed.command;
            meta.originalCommand = analyzed.original;
            meta.changed = true;
            diag('rewritten', { tool: toolName, to: analyzed.command.slice(0, 160) });
          } else {
            meta.warnings = [...meta.warnings, '命令改写失败（工具参数为只读快照），已按原命令执行'];
          }
        }
        // 诊断：宿主控制台输出净化决策，便于排查"没改写/没流"
        if (meta.changed || meta.warnings.length || bg) {
          console.log(`[cmdmon] execute tool=${toolName} bg=${bg} changed=${meta.changed} warnings=${meta.warnings.length}`);
          if (meta.changed) console.log(`[cmdmon] rewrite:\n  ${JSON.stringify(meta.originalCommand)}\n  -> ${JSON.stringify(cmd)}`);
        }
        // 前台执行且检测到缓冲管道：补充说明（实时进度只对后台任务生效）
        if (!bg && meta.warnings.length && cfg.warn) {
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
        warnings: meta.warnings, originalCommand: meta.originalCommand, changed: meta.changed
      });
      r.status = 'running';
      r.finishedAt = undefined;
      r.warnings = meta.warnings;
      r.originalCommand = meta.originalCommand;
      r.changed = meta.changed;
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
        console.log(`[cmdmon] job registered ${value.jobId} tool=${toolName} owner=${exec && exec.agent ? 'yes(' + exec.agent.id + ')' : 'NO!'} changed=${meta.changed} warnings=${meta.warnings.length}`);
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
        // 记录该 job 的确切 owner（exec.agent 是启动它的 agent）
        if (exec && exec.agent) jobOwners.set(value.jobId, exec.agent);
        touch(r);
      }
      const key = 'tool:' + String(exec.callId);
      const r = records.get(key);
      if (!r) return;
      r.status = result && result.isError ? 'failed' : 'completed';
      r.finishedAt = Date.now();
      const text = textFromContent(result && result.content);
      if (toolName === 'job_output' && !streamEnabled && value && typeof value === 'object' && typeof value.text === 'string') {
        // 流模式关闭时，dsh 每次 job_output 的增量也展示出来
        appendOutput(r, value.text);
      }
      if (text) appendOutput(r, text);
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

  // ---- 后台输出实时轮询（消耗性，受流开关控制）----
  if (timer) {
    const offPoll = timer.interval(() => {
      if (!streamEnabled || !jobs) return;
      for (const r of records.values()) {
        if (r.kind !== 'job') continue;
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
              console.log(`[cmdmon] stream started job=${id} bytes=${read.text.length}`);
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
            readError: r.readError === undefined ? null : r.readError
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
          records.clear();
          rewrites.clear();
        } else {
          for (const key of [...records.keys()]) {
            if (records.get(key).sessionId === session) records.delete(key);
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
