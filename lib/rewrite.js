// dsh-cmdwatch —— 命令净化（纯逻辑，可单测，不依赖宿主）
//
// dsh 自主生成的命令可能带"收集型管道"（`| Select-Object -Last 4`、`| tail -n 4`、
// `| Sort-Object`）或"输出消耗型管道"（`| Out-File`、`| Set-Content`、`>` 重定向）：
//   收集型 —— 必须等上游全部输出完才产生输出，stdout 在命令结束前是空的；
//   消耗型 —— 输出直接写入文件/丢弃，stdout 全程无内容。
// 两者都会让命令窗看不到实时进度。剥离收集型管道并不能救消耗型（如
// `... | Select-Object -Last 2 | Out-File f` 剥离后输出仍被 Out-File 吞掉），
// 且会改变工具结果语义。因此统一采用**插入 Tee**（pwsh `Tee-Object` / bash `tee`）：
// 把输出落盘供插件轮询，Tee 插在**最早**的收集/消耗段之前——面板看到全量渐进
// 输出，而 dsh 的原管道（-Last、Out-File、Get-Content 等）原样保留，工具结果
// 语义零改变。
//
//   - analyzeCommand：检测并返回警示（收集/消耗/提前终止）
//   - buildStreamWrap：插入 Tee 包装命令（后台任务仅在存在收集/消耗段时包装，
//     否则 jobs 通道本身就能流式；前台任务总是包装）

import { join } from 'node:path';
import { tmpdir } from 'node:os';

// 收集型管道：缓冲上游全部输出，命令结束前无中间输出
const COLLECTING = [
  { re: /\|\s*(?:Select-Object|select)\s+-Last\s+\d+\s*/gi, label: '收集型管道 Select-Object -Last N（缓冲全部输出，命令结束前无中间输出）' },
  { re: /\|\s*tail\s+(?:-n\s+)?-?\d+\s*/gi, label: '收集型管道 tail -n N（缓冲全部输出，命令结束前无中间输出）' },
];

// 尾部收集型：收集后排序/分组/统计，结束前无中间输出
const TAIL_COLLECTING = [
  { re: /\|\s*(?:Sort-Object|sort)\b[^|]*/gi, label: '收集型管道 Sort-Object（需收集全部输出排序）' },
  { re: /\|\s*(?:Group-Object|group)\b[^|]*/gi, label: '收集型管道 Group-Object（需收集全部输出分组）' },
  { re: /\|\s*(?:Measure-Object|measure)\b[^|]*/gi, label: '收集型管道 Measure-Object（需收集全部输出统计）' },
];

// 输出消耗型管道：输出写入文件/丢弃，stdout 无内容（Tee 必须插在它之前）
const CONSUMING = [
  { re: /\|\s*(?:Out-File|Set-Content|Add-Content|Out-Null)\b[^|]*/gi, label: '输出重定向管道（Out-File/Set-Content/Out-Null），stdout 无内容' },
  { re: /(?<![\d&])(\s>{1,2}\s)/g, label: '重定向 > / >>（输出写入文件，stdout 无内容）' },
];

// 提前终止型：只警示（Tee 插在它之前仍可拿到前缀输出，但不改动语义）
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
 * 检测命令中的收集/消耗/提前终止管道，返回警示（不改写）。
 * @returns {{command: string, changed: boolean, original: string, warnings: string[]}}
 */
function analyzeCommand(command, opts = {}) {
  const original = command;
  const warnings = [];
  const detect = opts.detect !== false;
  if (typeof command !== 'string' || !command.trim()) {
    return { command, changed: false, original, warnings: [] };
  }
  if (detect) {
    for (const w of findMatches(command, COLLECTING)) warnings.push(w.label + `（${w.match}）`);
    for (const w of findMatches(command, TAIL_COLLECTING)) warnings.push(w.label + `（${w.match}）`);
    for (const w of findMatches(command, CONSUMING)) warnings.push(w.label + `（${w.match}）`);
    for (const w of findMatches(command, TERMINATING)) warnings.push(w.label + `（${w.match}）`);
  }
  return { command, changed: false, original, warnings };
}

/**
 * 插入 Tee（pwsh `Tee-Object` / bash `tee`）把命令输出落盘，供插件轮询实现
 * 实时显示。Tee 插在**最早**的收集/消耗段之前；无此类段时追加到命令尾部
 * （前台任务）或返回 null（后台任务——jobs 通道本身即可流式）。
 *
 * 返回 null 表示不适合包装（命令原样执行）。
 * @param {string} command 原始命令行
 * @param {object} [opts]
 * @param {'pwsh'|'bash'} [opts.tool]
 * @param {string} [opts.callId]
 * @param {string} [opts.workdir] 提供时日志文件落在 workdir（命令里用相对名）
 * @param {'fg'|'bg'} [opts.mode='fg'] 'bg' 时无收集/消耗段则返回 null
 * @returns {{wrapped: string, file: string, injectedPython: boolean}|null}
 */
function buildStreamWrap(command, opts = {}) {
  const tool = opts.tool;
  const callId = opts.callId || 'x';
  const mode = opts.mode || 'fg';
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

  // 找最早的收集/消耗段插入点
  const segments = [...COLLECTING, ...TAIL_COLLECTING, ...CONSUMING];
  let insertAt = -1;
  for (const p of segments) {
    p.re.lastIndex = 0;
    const m = p.re.exec(command);
    if (m) {
      const pipeIdx = m[0].indexOf('|');
      const idx = m.index + (pipeIdx >= 0 ? pipeIdx : 0);
      if (insertAt === -1 || idx < insertAt) insertAt = idx;
    }
  }
  // 后台任务无收集/消耗段：jobs 通道本身可流式，无需包装
  if (mode === 'bg' && insertAt < 0) return null;

  const fileName = `.cmdmon-${String(callId).replace(/[^A-Za-z0-9_-]/g, '_')}.log`;
  const filePath = workdir ? join(workdir, fileName) : join(tmpdir(), fileName);
  const quote = (p) => (tool === 'pwsh'
    ? `'${String(p).replace(/'/g, "''")}'`
    : `"${String(p).replace(/"/g, '\\"').replace(/\$/g, '\\$')}"`);
  const tee = (tool === 'pwsh' ? '| Tee-Object -FilePath ' : '| tee ') + quote(filePath);

  let wrapped;
  if (insertAt >= 0) {
    const left = command.slice(0, insertAt).trimEnd();
    wrapped = left + ' ' + tee + ' ' + command.slice(insertAt).trimStart();
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

export { analyzeCommand, buildStreamWrap, COLLECTING, TAIL_COLLECTING, CONSUMING, TERMINATING };
