// dsh-cmdwatch —— 命令净化（纯逻辑，可单测，不依赖宿主）
//
// dsh 自主生成的命令可能带"收集型管道"（如 `| Select-Object -Last 4`、
// `| tail -n 4`、`| Sort-Object`）：这类 cmdlet 必须等上游全部输出完才产生
// 输出，shell 进程的 stdout 在命令结束前一直是空的，命令窗的实时流因此看不到
// 任何进度。本模块在 tools/execute 阶段检测并（可选）改写命令：
//   - 剥离收集型管道（保持语义等价：同样的程序、同样的参数，只是不截断输出）
//   - 可选注入 PYTHONUNBUFFERED，避免 python 在管道下的块缓冲
//   - 对"提前终止型"管道（-First / head）只警示不改写（改动会改变执行结果）
//   - 前台命令实时输出：插入 Tee（pwsh）/ tee（bash）把输出落盘供插件轮询，
//     插在收集型管道之前，工具结果语义保持不变（-Last 等仍生效）

import { join } from 'node:path';
import { tmpdir } from 'node:os';

// 收集型管道：出现在命令任意位置都会缓冲上游输出，移除是安全的
const COLLECTING = [
  { re: /\|\s*(?:Select-Object|select)\s+-Last\s+\d+\s*/gi, label: '收集型管道 Select-Object -Last N（缓冲全部输出，命令结束前无中间输出）' },
  { re: /\|\s*tail\s+(?:-n\s+)?-?\d+\s*/gi, label: '收集型管道 tail -n N（缓冲全部输出，命令结束前无中间输出）' },
];

// 尾部收集型：仅当它是最后一个管道段时才移除（避免改动中间管道语义）
const TAIL_COLLECTING = [
  { re: /\|\s*(?:Sort-Object|sort)\b[^|]*$/i, label: '收集型管道 Sort-Object（需收集全部输出排序）' },
  { re: /\|\s*(?:Group-Object|group)\b[^|]*$/i, label: '收集型管道 Group-Object（需收集全部输出分组）' },
  { re: /\|\s*(?:Measure-Object|measure)\b[^|]*$/i, label: '收集型管道 Measure-Object（需收集全部输出统计）' },
];

// 提前终止型：不改写，只警示
const TERMINATING = [
  { re: /\|\s*(?:Select-Object|select)\s+-First\s+\d+/gi, label: '提前终止管道 Select-Object -First N（可能提前截断上游命令）' },
  { re: /\|\s*head\s+(?:-n\s+)?\d+/gi, label: '提前终止管道 head -n N（可能提前截断上游命令）' },
];

function findMatches(command, patterns) {
  const found = [];
  for (const p of patterns) {
    if (p.re.global) {
      p.re.lastIndex = 0;
      let m;
      while ((m = p.re.exec(command)) !== null) found.push({ label: p.label, match: m[0].trim() });
    } else {
      const m = p.re.exec(command);
      if (m) found.push({ label: p.label, match: m[0].trim() });
    }
  }
  return found;
}

/**
 * 分析（并可选改写）一条命令。
 * @param {string} command 原始命令行
 * @param {object} [opts]
 * @param {boolean} [opts.rewrite=true] 是否剥离收集型管道
 * @param {boolean} [opts.pythonUnbuffered=true] 命中 python 时是否注入 PYTHONUNBUFFERED
 * @param {boolean} [opts.detect=true] 是否收集警示（关掉则 warnings 恒为空）
 * @param {'bash'|'pwsh'} [opts.shell='pwsh'] 注入环境变量时使用的语法
 * @returns {{command: string, changed: boolean, original: string, warnings: string[]}}
 */
function analyzeCommand(command, opts = {}) {
  const original = command;
  let warnings = [];
  const detect = opts.detect !== false;
  const rewrite = opts.rewrite !== false;
  const pythonUnbuffered = opts.pythonUnbuffered !== false;
  const shell = opts.shell === 'bash' ? 'bash' : 'pwsh';
  let cmd = command;
  let changed = false;

  if (typeof command !== 'string' || !command.trim()) {
    return { command, changed: false, original, warnings: [] };
  }

  // 1. 检测（无论是否改写都收集，供面板警示）
  if (detect) {
    for (const w of findMatches(cmd, COLLECTING)) warnings.push(w.label + `（${w.match}）`);
    for (const w of findMatches(cmd, TAIL_COLLECTING)) warnings.push(w.label + `（${w.match}）`);
    for (const w of findMatches(cmd, TERMINATING)) warnings.push(w.label + `（${w.match}）`);
  }

  // 2. 改写（可选）
  if (rewrite) {
    let next = cmd;
    // 2a. 移除任意位置的收集型管道
    for (const p of COLLECTING) { p.re.lastIndex = 0; next = next.replace(p.re, ''); }
    // 2b. 循环移除尾部收集型段（一次只去掉一个尾部，可能叠多个）
    for (let i = 0; i < 3; i++) {
      const before = next;
      for (const p of TAIL_COLLECTING) { p.re.lastIndex = 0; next = next.replace(p.re, ''); }
      if (next === before) break;
    }
    // 2c. 清理残留：双管道连写、首尾空白（不碰引号内的内容）
    next = next.replace(/\s*\|\s*\|\s*/g, ' | ').trim();
    changed = next !== cmd;
    if (changed) cmd = next;
    // 2d. python 块缓冲（可选注入）
    if (pythonUnbuffered && /\bpython\b/.test(cmd) && !/PYTHONUNBUFFERED/i.test(cmd) && !/(^|\s)-u(\s|$)/.test(cmd)) {
      cmd = (shell === 'bash' ? 'export PYTHONUNBUFFERED=1; ' : "$env:PYTHONUNBUFFERED='1'; ") + cmd;
      warnings.push('已注入 PYTHONUNBUFFERED（避免 python 在管道下的块缓冲，实现逐行实时输出）');
      changed = true;
    }
  }

  // 3. 若已改写，把收集型管道警示标注为"已剥离"，避免用户误以为没处理
  if (changed) {
    warnings = warnings.map((w) =>
      (w.includes('收集型管道') && !w.startsWith('已自动剥离')) ? '已自动剥离：' + w : w
    );
  }

  return { command: cmd, changed, original, warnings };
}

/**
 * 前台命令实时输出包装：在命令中插入 Tee（pwsh）/ tee（bash），把输出落盘，
 * 供插件轮询文件实现实时显示。插在第一个收集型管道之前——文件拿到全量渐进
 * 输出，工具结果仍按原管道截断（-Last 等语义不变）。
 *
 * 返回 null 表示不适合包装（跳过，命令原样执行）。
 * @param {string} command 原始命令行
 * @param {object} [opts]
 * @param {'pwsh'|'bash'} [opts.tool]
 * @param {string} [opts.callId]
 * @param {string} [opts.workdir] 提供时日志文件落在 workdir（命令里用相对名）
 * @returns {{wrapped: string, file: string, injectedPython: boolean}|null}
 */
function buildForegroundTee(command, opts = {}) {
  const tool = opts.tool;
  const callId = opts.callId || 'x';
  const workdir = typeof opts.workdir === 'string' && opts.workdir ? opts.workdir : undefined;
  if (typeof command !== 'string' || !command.trim()) return null;
  if (tool !== 'pwsh' && tool !== 'bash') return null;
  // 单行才包装：多行命令尾部拼接风险高
  if (command.includes('\n') || command.includes('\r')) return null;
  const trimmed = command.trim();
  // 尾部防呆：不以这些字符/关键字收尾才包装
  if (/[{};\\]$/.test(trimmed)) return null;
  if (/(^|[;\s])(exit|return|break|continue|throw)(\s+\d+)?\s*$/i.test(trimmed)) return null;
  // 已包装过则跳过（防重入/重复包装）
  if (/cmdmon-[A-Za-z0-9_-]+\.log/i.test(trimmed)) return null;

  const fileName = `.cmdmon-${String(callId).replace(/[^A-Za-z0-9_-]/g, '_')}.log`;
  const filePath = workdir ? join(workdir, fileName) : join(tmpdir(), fileName);
  const quote = (p) => (tool === 'pwsh'
    ? `'${String(p).replace(/'/g, "''")}'`
    : `"${String(p).replace(/"/g, '\\"').replace(/\$/g, '\\$')}"`);
  const tee = (tool === 'pwsh' ? '| Tee-Object -FilePath ' : '| tee ') + quote(filePath);

  // 找第一个收集型管道的 '|' 位置，把 Tee 插到它前面
  let insertAt = -1;
  const all = [...COLLECTING, ...TAIL_COLLECTING];
  for (const p of all) {
    p.re.lastIndex = 0;
    const m = p.re.exec(command);
    if (m) {
      const idx = m.index + m[0].indexOf('|');
      if (insertAt === -1 || idx < insertAt) insertAt = idx;
    }
  }
  let wrapped;
  if (insertAt >= 0) {
    wrapped = command.slice(0, insertAt) + tee + ' ' + command.slice(insertAt).trimStart();
  } else if (trimmed.endsWith('|')) {
    wrapped = trimmed + tee.slice(1); // 命令以管道收尾：直接接 Tee
  } else {
    wrapped = trimmed + ' ' + tee;
  }

  // python 块缓冲：需要逐行才实时
  let injectedPython = false;
  if (/\bpython\b/.test(wrapped) && !/PYTHONUNBUFFERED/i.test(wrapped) && !/(^|\s)-u(\s|$)/.test(wrapped)) {
    wrapped = (tool === 'bash' ? 'export PYTHONUNBUFFERED=1; ' : "$env:PYTHONUNBUFFERED='1'; ") + wrapped;
    injectedPython = true;
  }

  return { wrapped, file: filePath, injectedPython };
}

export { analyzeCommand, buildForegroundTee, COLLECTING, TAIL_COLLECTING, TERMINATING };
