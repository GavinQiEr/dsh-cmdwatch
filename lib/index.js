// dsh-cmdwatch —— 命令窗（Host 半）
//
// 在宿主进程捕获 dsh 发起的命令与输出：
//   - 前台命令：tools/execute（开始，拿命令行）+ tools/result（结束，拿输出文本）
//   - 后台任务：jobs.onJobsChanged / onJobDone / list()（状态 + 命令行 label）
//   - 实时流：timer 每 500ms 对 running 任务 jobs.read() 拉增量输出（消耗性，
//     受 Client 端「实时流」开关控制；开启时 dsh 的 job_output 工具会读到空增量）
//
// 通过 webServer 注册 HTTP 端点向 Client 提供增量快照（静态插件没有动态插件的
// harness.handle / host.call，使用同源 HTTP 通道，参照 dsh-pocket 的方案）。

const name = 'dsh-cmdwatch';
const inject = ['webServer', 'shell'];

function apply(ctx) {
  const jobs = ctx.get('jobs');
  const timer = ctx.get('timer');
  const webServer = ctx.webServer;
  const shell = ctx.shell;

  // ---- 状态 ----
  const records = new Map(); // key: 'tool:<callId>' | 'job:<jobId>'
  const jobOwners = new Map(); // jobId -> Agent（该任务的 owner，jobs.read 的 caller）
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
      r = { key, ...init, lastSeq: 0 };
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

  // ---- 前台工具调用：开始 ----
  ctx.on('tools/execute', (exec, next) => {
    try {
      if (exec && exec.agent) owner = exec.agent;
      const toolName = exec && exec.name;
      const cmd = commandOf(toolName, exec && exec.arguments);
      const r = ensure('tool:' + String(exec.callId), {
        kind: 'tool', name: toolName, command: cmd || toolName,
        status: 'running', detail: undefined,
        startedAt: Date.now(), finishedAt: undefined,
        output: '', truncated: false,
        sessionId: exec && exec.agent ? exec.agent.id : undefined
      });
      r.status = 'running';
      r.finishedAt = undefined;
      touch(r);
    } catch (e) { console.error('cmdmon execute hook failed', e); }
    return next();
  });

  // ---- 前台工具调用：结果 ----
  ctx.on('tools/result', (exec, result) => {
    try {
      const toolName = exec && exec.name;
      const args = exec && exec.arguments;
      const value = result && result.value;
      // pwsh 后台启动：value = { kind: 'background', jobId }
      if (value && typeof value === 'object' && value.kind === 'background' && typeof value.jobId === 'string') {
        const r = ensure('job:' + value.jobId, {
          kind: 'job', name: toolName, command: commandOf(toolName, args) || toolName,
          status: 'running', detail: undefined,
          startedAt: Date.now(), finishedAt: undefined,
          output: '', truncated: false,
          sessionId: exec && exec.agent ? exec.agent.id : undefined
        });
        r.status = 'running';
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
        if (!jobOwner) continue; // 未登记 owner 的任务跳过（无法通过权限读）
        try {
          const read = jobs.read(id, jobOwner);
          if (read && read.text) appendOutput(r, read.text);
          if (read && read.snapshot) {
            const s = read.snapshot;
            r.status = s.status;
            r.detail = s.detail;
            r.finishedAt = s.finishedAt;
            touch(r);
          }
        } catch (e) {
          // 单个任务读取失败只跳过它，不中断整轮轮询
          console.error('cmdmon poll failed for ' + id, e);
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
            sessionId: r.sessionId === undefined ? null : r.sessionId
          });
        }
        json(res, 200, { seq, records: out, streamEnabled });
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
