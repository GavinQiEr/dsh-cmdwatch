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

// 收集型管道：缓冲上游全部输出，命令结束前无中间输出（\|&?\s* 兼容 bash |&）
const COLLECTING = [
  { re: /\|&?\s*(?:Select-Object|select)\s+-Last\s+\d+\s*/gi, label: '收集型管道 Select-Object -Last N（缓冲全部输出，命令结束前无中间输出）' },
  { re: /\|&?\s*tail\s+(?:-n\s+)?-?\d+\s*/gi, label: '收集型管道 tail -n N（缓冲全部输出，命令结束前无中间输出）' },
  { re: /\|&?\s*(?:Format-Table|Format-List|Format-Wide|Format-Custom)\b[^|;\r\n]*/gi, label: '格式型管道 Format-*（需收集全部输出计算布局）' },
  { re: /\|&?\s*(?:ConvertTo-Json|ConvertTo-Html|ConvertTo-Xml)\b[^|;\r\n]*/gi, label: '转换型管道 ConvertTo-*（需收集全部输出构建）' },
  { re: /\|&?\s*Out-String\b[^|;\r\n]*/gi, label: '拼接型管道 Out-String（需收集全部输出拼字符串）' },
  { re: /\|&?\s*wc\b[^|;\r\n]*/gi, label: '统计型管道 wc（需收集全部输出计数）' },
];

// 尾部收集型：收集后排序/分组/统计，结束前无中间输出
const TAIL_COLLECTING = [
  { re: /\|&?\s*(?:Sort-Object|sort)\b[^|;\r\n]*/gi, label: '收集型管道 Sort-Object（需收集全部输出排序）' },
  { re: /\|&?\s*(?:Group-Object|group)\b[^|;\r\n]*/gi, label: '收集型管道 Group-Object（需收集全部输出分组）' },
  { re: /\|&?\s*(?:Measure-Object|measure)\b[^|;\r\n]*/gi, label: '收集型管道 Measure-Object（需收集全部输出统计）' },
];

// 输出消耗型管道：输出写入文件/丢弃，stdout 无内容（Tee 必须插在它之前）
const CONSUMING = [
  { re: /\|&?\s*(?:Out-File|Set-Content|Add-Content|Out-Null)\b[^|;\r\n]*/gi, label: '输出重定向管道（Out-File/Set-Content/Out-Null），stdout 无内容' },
  // 重定向 > / >>：排除 2>&1（> 紧邻数字/&），但 cmd2 > f（> 前是空格）应命中
  { re: /(?<![\d&])\s*>{1,2}(?!>)\s*/g, label: '重定向 > / >>（输出写入文件，stdout 无内容）' },
];

// 过滤型管道：只放行匹配行/项，其余输出被丢弃（Tee 必须插在它之前才能看到全量）
const FILTERING = [
  { re: /\|&?\s*(?:Select-String|findstr|grep|egrep|fgrep)\b[^|;\r\n]*/gi, label: '过滤管道（Select-String/grep 等只放行匹配行，其余输出被丢弃）' },
  { re: /\|&?\s*(?:Where-Object|where)\b[^|;\r\n]*/gi, label: '过滤管道 Where-Object（只放行匹配项，其余输出被丢弃）' },
];

// 提前终止型：只放行前 N 行/项并截断上游（Tee 插在它之前可拿到截断前的输出）
const TERMINATING = [
  { re: /\|&?\s*(?:Select-Object|select)\s+-First\s+\d+/gi, label: '提前终止管道 Select-Object -First N（可能提前截断上游命令）' },
  { re: /\|&?\s*head\s+(?:-n\s+)?\d+/gi, label: '提前终止管道 head -n N（可能提前截断上游命令）' },
];

/**
 * 计算命令中处于**引号内部**的字符区间 `[start, end)`。
 *
 * 为什么需要：下面所有管道/重定向正则都直接跑在整条命令字符串上，而引号里的
 * `>`、`|`、`| Out-File` 只是**字符串字面量**，不是 shell 语法。不做引号排除会
 * 把 Tee 插进引号内部，直接破坏命令 —— 实测：
 *
 *   git log --format='%an <%ae>'
 *   → git log --format='%an <| Tee-Object -FilePath '...' ...>'
 *
 * `_Last N` 之类的管道正则靠"`|` 后必须跟特定命令名"侥幸躲过大部分误判，但
 * 重定向正则 `>` 匹配任意 `>`，命中率极高（提交信息、`--format`、`-c "a > b"` 等）。
 *
 * 覆盖：单引号 / 双引号 / 反引号（pwsh 子表达式）/ pwsh here-string（`@'...'@`、`@"..."@`）。
 * 转义：pwsh 单引号内 `''` 表示一个引号；双引号内反引号转义；bash 反斜杠转义。
 * 未闭合的引号按"一直到结尾都是引号内"处理（宁可少包装，不可改坏命令）。
 *
 * @param {string} command
 * @returns {Array<[number, number]>}
 */
function quotedRanges(command) {
  const ranges = [];
  const n = command.length;
  let i = 0;
  let start = -1;
  let quote = null;   // "'" | '"' | "`"
  let hereEnd = null; // here-string 终止标记："'@" | '"@'

  while (i < n) {
    const ch = command[i];

    // here-string：直到行首出现 '@ / "@
    if (hereEnd) {
      if (ch === '\n' && command.startsWith(hereEnd, i + 1)) {
        i += 1 + hereEnd.length;
        ranges.push([start, i]);
        hereEnd = null;
        start = -1;
        continue;
      }
      i++;
      continue;
    }

    if (quote) {
      if (quote === "'") {
        if (ch === "'" && command[i + 1] === "'") { i += 2; continue; } // pwsh '' 转义
        if (ch === "'") { ranges.push([start, i + 1]); quote = null; start = -1; i++; continue; }
        i++;
        continue;
      }
      if (ch === '\\') { i += 2; continue; }                 // bash 反斜杠转义
      if (quote === '"' && ch === '`') { i += 2; continue; } // pwsh 反引号转义
      if (ch === quote) { ranges.push([start, i + 1]); quote = null; start = -1; i++; continue; }
      i++;
      continue;
    }

    if (ch === '\\') { i += 2; continue; }                   // bash 引号外反斜杠转义
    // pwsh here-string 起始：@' 或 @" 且其后到行尾只能是空白
    if (ch === '@' && (command[i + 1] === "'" || command[i + 1] === '"')) {
      const nl = command.indexOf('\n', i + 2);
      if (nl !== -1 && command.slice(i + 2, nl).trim() === '') {
        start = i;
        hereEnd = command[i + 1] + '@';
        i = nl + 1;
        continue;
      }
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; start = i; i++; continue; }
    i++;
  }

  if (start >= 0) ranges.push([start, n]); // 未闭合：保守视为引号内
  return ranges;
}

/** 给定下标是否落在某个引号区间内 */
function isQuoted(index, ranges) {
  for (const [s, e] of ranges) {
    if (index >= s && index < e) return true;
  }
  return false;
}

/**
 * 顶层语句分隔符：不在引号/注释内、也不在任何括号/花括号内的 `;` **或真正的换行**。
 *
 * 换行是不是语句边界，按 PowerShell / bash 的续行规则判断（判错会把 Tee 插进未结束的
 * 语句里，所以拿不准时一律当成"续行"= 不拆）：
 *   - 行尾是 `|` `,` `(` `=` `+` `-` `*` `/` `%` `&` `` ` `` `\` 等 → 续行；
 *   - 行尾是一个孤立的参数/运算符（`-and`、`-Pattern`）→ 续行；
 *   - 下一行以 `|` `&` `,` `)` 开头（PS7 允许前置管道）→ 续行；
 *   - 空行、引号内、here-string 内、注释内、括号/花括号/方括号内 → 不是边界。
 * `for ($i=0; $i -lt 3; $i++) { … }` 的分号在括号里、`Write-Output 'a;b'` 的分号在引号里，
 * 都不算边界。
 * @param {string} command
 * @returns {number[]} 分隔符下标
 */
function statementBreaks(command) {
  const ranges = quotedRanges(command);
  const out = [];
  let depth = 0;
  const n = command.length;
  for (let i = 0; i < n; i++) {
    if (isQuoted(i, ranges)) continue;
    const ch = command[i];
    if (ch === '(' || ch === '{' || ch === '[') { depth += 1; continue; }
    if (ch === ')' || ch === '}' || ch === ']') { if (depth > 0) depth -= 1; continue; }
    // 注释：`#` 在行首或空白之后才算注释，直接跳到行尾（注释里的分号/换行都不是边界）
    if (ch === '#' && (i === 0 || /\s/.test(command[i - 1]))) {
      const nl = command.indexOf('\n', i);
      if (nl < 0) break;
      i = nl - 1;
      continue;
    }
    if (depth !== 0) continue;
    if (ch === ';') { out.push(i); continue; }
    if (ch !== '\n') continue;
    let p = i - 1;
    while (p >= 0 && (command[p] === ' ' || command[p] === '\t' || command[p] === '\r')) p -= 1;
    if (p < 0 || command[p] === '\n') continue; // 空行
    const prefix = command.slice(0, p + 1);
    if (/[|,([{=+\-*/%&!<>`\\]/.test(command[p])) continue; // 行尾续行符
    // 行尾是孤立的参数/运算符（`-and`、`-Pattern`）→ 续行；但 `-` 前必须是空白，
    // 否则 `... | Out-Null`、`Write-Output` 这种**命令名自带连字符**会被误判成续行
    if (/(^|\s)-[A-Za-z]\w*$/.test(prefix)) continue;
    let q = i + 1;
    while (q < n && (command[q] === ' ' || command[q] === '\t' || command[q] === '\r')) q += 1;
    if (q < n) {
      const head = command[q];
      // `|`/`,`/`)` 开头 → 续行；`&` 只有成对（bash `&&`）才是续行，
      // 单独的 `&` 是 PowerShell 调用运算符（如 `& $show`），那是新语句
      if (head === '|' || head === ',' || head === ')') continue;
      if (head === '&' && command[q + 1] === '&') continue;
    }
    out.push(i);
  }
  return out;
}

/** 语句体里顶层注释 `#` 的下标（没有则 -1）——Tee 必须插在它**之前** */
function topLevelComment(text) {
  const ranges = quotedRanges(text);
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (isQuoted(i, ranges)) continue;
    const ch = text[i];
    if (ch === '(' || ch === '{' || ch === '[') depth += 1;
    else if (ch === ')' || ch === '}' || ch === ']') { if (depth > 0) depth -= 1; }
    else if (ch === '#' && depth === 0 && (i === 0 || /\s/.test(text[i - 1]))) return i;
  }
  return -1;
}

/** 每个下标处的花括号深度（引号内不计）——判断某个插入点是否落在脚本块内部 */
function braceDepthAt(command, ranges) {
  const depth = new Array(command.length).fill(0);
  let d = 0;
  for (let i = 0; i < command.length; i++) {
    if (!isQuoted(i, ranges)) {
      const ch = command[i];
      if (ch === '{') d += 1;
      else if (ch === '}' && d > 0) d -= 1;
    }
    depth[i] = d;
  }
  return depth;
}

/**
 * 语句以 `}` 收尾时，能否在其后接管道。
 * `1..8 | ForEach-Object { … }` 里的 `{…}` 是 cmdlet 的**脚本块参数**，后面接
 * `| Tee-Object` 合法；而 `if (…) { … }` / `foreach (…) { … }` 是**语句块**，
 * PowerShell 直接报语法错误（实测），必须跳过。
 * 判据：`}` 之前存在顶层 `|`，且该管道右侧不是块关键字。
 */
function canPipeFromBlock(text) {
  const ranges = quotedRanges(text);
  let depth = 0;
  let lastPipe = -1;
  for (let i = 0; i < text.length; i++) {
    if (isQuoted(i, ranges)) continue;
    const ch = text[i];
    if (ch === '(' || ch === '{' || ch === '[') depth += 1;
    else if (ch === ')' || ch === '}' || ch === ']') { if (depth > 0) depth -= 1; }
    else if (ch === '|' && depth === 0) {
      if (text[i + 1] === '|') { i += 1; continue; } // `||` 逻辑或，不是管道
      lastPipe = i;
    }
  }
  if (lastPipe < 0) return false;
  const after = text.slice(lastPipe + 1).replace(/^&?\s*/, '');
  // 关键字必须后接空白或 `(`：否则 `ForEach-Object` 会被 `foreach` 前缀误伤
  return !/^(if|else|elseif|foreach|for|while|do|switch|try|catch|finally|function|class)([\s(]|$)/i.test(after);
}

/** 该语句本身不产生 stdout（赋值/export/注释/控制流）——跳过它不算"漏了输出" */
function isSilentStatement(statement) {
  const s = statement.trim();
  if (!s) return true;
  if (s.startsWith('#')) return true;
  if (/^(exit|return|break|continue|throw)\b/i.test(s)) return true;
  if (/^\$[A-Za-z_][\w:]*(\[[^\]]*\])?\s*=/.test(s)) return true;
  if (/^(export\s+)?[A-Za-z_][A-Za-z0-9_]*=/.test(s)) return true;
  return false;
}

/**
 * 该语句能否在尾部安全接一个 Tee（不改变语义）。排除：
 *   - 空语句；以 `;` / `\` 收尾
 *   - 以 `}` 收尾的语句块（`if`/`foreach` 等接管道是语法错误），
 *     但管道里的脚本块参数（`… | ForEach-Object { … }`）可以
 *   - 控制流 `exit/return/break/continue/throw`（接了会改控制流，且本来没有多余输出）
 *   - 赋值与 export：`$env:A='1' | Tee` 会把值打进 stdout 改变工具结果；
 *     bash 的 `export A=1 | tee` 会让赋值只在子 shell 生效（语义破坏）
 * @param {string} statement
 * @returns {boolean}
 */
function canTailTee(statement) {
  const s = statement.trim();
  if (!s) return false;
  if (s.startsWith('#')) return false; // 纯注释：追加毫无意义，还会把"建文件"浪费掉
  if (s.endsWith('}')) return canPipeFromBlock(s);
  if (/[;\\]$/.test(s)) return false;
  if (/^(exit|return|break|continue|throw)\b/i.test(s)) return false;
  if (/^\$[A-Za-z_][\w:]*(\[[^\]]*\])?\s*=/.test(s)) return false;
  if (/^(export\s+)?[A-Za-z_][A-Za-z0-9_]*=/.test(s)) return false;
  return true;
}

// 警示里的匹配片段：压平换行并截断——多行脚本的匹配文本会带上整段脚本，
// 原样铺进面板会把展开行撑成一大坨（实测）
function compactMatch(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > 48 ? flat.slice(0, 48) + '…' : flat;
}

function findMatches(command, patterns) {
  const found = [];
  const ranges = quotedRanges(command);
  const push = (label, raw) => {
    const match = compactMatch(raw);
    // 同一条语句里出现多次同种管道（如两处 Where-Object）只保留一条
    if (found.some((f) => f.label === label && f.match === match)) return;
    found.push({ label, match });
  };
  for (const p of patterns) {
    if (p.re.global) {
      p.re.lastIndex = 0;
      let m;
      while ((m = p.re.exec(command)) !== null) {
        // 引号内的字面量不是 shell 语法：既不警示也不改写
        if (!isQuoted(m.index, ranges)) push(p.label, m[0]);
      }
    } else {
      const m = p.re.exec(command);
      if (m && !isQuoted(m.index, ranges)) push(p.label, m[0]);
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
    for (const w of findMatches(command, FILTERING)) warnings.push(w.label + `（${w.match}）`);
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
  const trimmed = command.trim();
  // 已包装过则跳过（防重入/重复包装）
  if (/cmdmon-[A-Za-z0-9_-]+\.log/i.test(trimmed)) return null;

  // 找所有收集/消耗/过滤/终止段的插入点（多语句命令每条语句都可能带管道）
  const segments = [...COLLECTING, ...TAIL_COLLECTING, ...CONSUMING, ...FILTERING, ...TERMINATING];
  const ranges = quotedRanges(command);
  const braceDepth = braceDepthAt(command, ranges);
  const insertions = [];
  for (const p of segments) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(command)) !== null) {
      // 引号内的 `>` / `| Out-File` 是字符串字面量，不是管道/重定向：
      // 在它前面插 Tee 会把 Tee 插进引号内部，直接改坏命令（见 quotedRanges 注释）
      if (isQuoted(m.index, ranges)) continue;
      const pipeIdx = m[0].indexOf('|');
      const idx = m.index + (pipeIdx >= 0 ? pipeIdx : 0);
      if (isQuoted(idx, ranges)) continue;
      // 落在 `{}` 内部的段不插：脚本块/函数体只在被调用时执行，插入点与书写顺序
      // 不一致（"最左建文件"失效）；外层同一管道若也有 Tee，两个 Tee 会同时打开
      // 同一个文件 → "being used by another process"（实测踩坑）
      if (braceDepth[idx] > 0) continue;
      if (!insertions.includes(idx)) insertions.push(idx);
    }
  }
  insertions.sort((a, b) => a - b);
  // 后台任务无收集/消耗段：jobs 通道本身可流式，无需包装
  if (mode === 'bg' && insertions.length === 0) return null;

  const fileName = `.cmdmon-${String(callId).replace(/[^A-Za-z0-9_-]/g, '_')}.log`;
  const filePath = workdir ? join(workdir, fileName) : join(tmpdir(), fileName);
  const quote = (p) => (tool === 'pwsh'
    ? `'${String(p).replace(/'/g, "''")}'`
    : `"${String(p).replace(/"/g, '\\"').replace(/\$/g, '\\$')}"`);
  // 注意：不能给 Tee-Object 加 -Encoding 参数——该参数仅 PowerShell 7 支持，
  // Windows PowerShell 5.1 会参数绑定失败导致整条命令 exit 1（实测踩坑）。
  // 5.1 默认写 UTF-16LE（带 BOM）、7 默认写 utf8NoBOM，插件读取端按 BOM 自动
  // 识别编码（readTeeDelta），两种都能正确解码，无需显式指定编码。
  // 第一个 Tee 建文件，后续 Tee 用 -Append 追加（-Append 在 5.1/7 均支持）
  const teeCreate = (tool === 'pwsh' ? '| Tee-Object -FilePath ' : '| tee ') + quote(filePath);
  const teeAppend = (tool === 'pwsh' ? '| Tee-Object -FilePath ' : '| tee -a ') + quote(filePath)
    + (tool === 'pwsh' ? ' -Append' : '');

  // 语句区间 [start, end)：end 含末尾的分隔符（`;` 或换行；最后一段到命令尾）
  const statements = [];
  {
    let start = 0;
    for (const s of statementBreaks(command)) {
      statements.push({ start, end: s + 1, breakAt: s, hasBreak: true });
      start = s + 1;
    }
    statements.push({ start, end: command.length, breakAt: command.length, hasBreak: false });
  }

  // 插入点两类：
  //   insert —— 语句内**最早**的收集/消耗/过滤/终止段之前（后面的段在同一条管道链上，
  //             首个 Tee 已捕获全量，不必重复）；
  //   tail   —— 该语句没有 insert 点时，在语句尾部追加。整条命令只贴尾部的话，
  //             只有最后一条语句的输出进日志（实测：`主命令; Write-Output done`
  //             面板只显示 done），所以按语句逐条覆盖（多行脚本同理，按行拆）。
  const points = [];
  let uncovered = 0; // 没能覆盖的语句（语句块/赋值/控制流）：它们的输出进不了日志
  statements.forEach((st, i) => {
    const raw = command.slice(st.start, st.breakAt);
    const commentAt = topLevelComment(raw); // Tee 必须插在行尾注释之前
    const body = commentAt >= 0 ? raw.slice(0, commentAt) : raw;
    const inside = insertions.filter((idx) => idx >= st.start && idx < st.breakAt);
    if (inside.length > 0) {
      points.push({ at: inside[0], kind: 'insert' });
      return;
    }
    // canTailTee 已覆盖 `}`/`;`/控制流等所有不安全收尾（`}` 结尾还要看是不是
    // 管道里的脚本块参数），这里不再另设一道会误伤 `… | ForEach-Object { … }` 的护栏
    if (!canTailTee(body)) {
      // 只有"本该有输出"的语句没覆盖才算漏（赋值/注释/控制流本来就无 stdout）
      if (!isSilentStatement(body)) uncovered += 1;
      return;
    }
    points.push({ at: st.start + body.length, kind: 'tail', pipeEnded: body.trimEnd().endsWith('|') });
  });
  if (points.length === 0) return null;

  // 从右往左插入，保持索引有效；最左（第一个执行）建文件，其余 -Append。
  // 只裁空格/制表符：多行命令的换行必须保留（trimStart 会把行并到一起）
  let wrapped = command;
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i];
    const tee = i === 0 ? teeCreate : teeAppend;
    const left = wrapped.slice(0, p.at).replace(/[ \t]+$/, '');
    const right = wrapped.slice(p.at).replace(/^[ \t]+/, '');
    const piece = (p.kind === 'tail' && p.pipeEnded) ? tee.slice(1) : ' ' + tee;
    wrapped = left + piece + ' ' + right;
  }
  wrapped = wrapped.replace(/[ \t]+$/, '');

  // python 块缓冲：需要逐行才实时
  let injectedPython = false;
  if (/\bpython\b/.test(wrapped) && !/PYTHONUNBUFFERED/i.test(wrapped) && !/(^|\s)-u(\s|$)/.test(wrapped)) {
    wrapped = (tool === 'bash' ? 'export PYTHONUNBUFFERED=1; ' : "$env:PYTHONUNBUFFERED='1'; ") + wrapped;
    injectedPython = true;
  }

  return { wrapped, file: filePath, injectedPython, partial: uncovered > 0 };
}

export { analyzeCommand, buildStreamWrap, quotedRanges, statementBreaks, topLevelComment, canTailTee, compactMatch, isSilentStatement, COLLECTING, TAIL_COLLECTING, CONSUMING, FILTERING, TERMINATING };
