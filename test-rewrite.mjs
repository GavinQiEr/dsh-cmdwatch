// dsh-cmdwatch 命令净化单测：node test-rewrite.mjs
import { analyzeCommand, buildStreamWrap, quotedRanges, statementBreaks, topLevelComment, canTailTee, compactMatch, isSilentStatement } from './lib/rewrite.js';

let pass = 0, fail = 0;
const assert = (name, cond) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name);
  cond ? pass++ : fail++;
};

// ---- analyzeCommand：检测（纯警示，不改写）----
const a1 = analyzeCommand('foo 2>&1 | Select-Object -Last 4');
assert('检测 Select-Object -Last', a1.warnings.some((w) => w.includes('Select-Object -Last 4')));
assert('检测不改写', a1.command === 'foo 2>&1 | Select-Object -Last 4' && !a1.changed);

const a2 = analyzeCommand('foo | sort | Select-Object -First 5 | Out-File x.txt');
assert('检测 sort/-First/Out-File 三类', ['Sort-Object', '-First', 'Out-File'].every((k) => a2.warnings.some((w) => w.includes(k))));

const a3 = analyzeCommand('git status');
assert('无管道无警示', a3.warnings.length === 0);

const a4 = analyzeCommand("python -c \"print('a|b')\"");
assert('引号内管道不误伤', a4.warnings.length === 0);

// ---- buildStreamWrap：Tee 包装 ----
const wrap = (cmd, opts) => buildStreamWrap(cmd, { tool: 'pwsh', callId: 'call_00_abc', ...opts });

const w1 = wrap("$env:MYSQL_ROOT_PASSWORD='p'; & .\\venv\\Scripts\\python.exe -m pytest tests -q 2>&1 | Select-Object -Last 2 | Out-File $env:TEMP\\f.txt -Encoding utf8; Get-Content $env:TEMP\\f.txt", { workdir: 'C:\\repo' });
assert('Tee 插在最早的收集管道之前（Select-Object 前）', w1.wrapped.includes("2>&1 | Tee-Object -FilePath 'C:\\repo\\.cmdmon-call_00_abc.log' | Select-Object -Last 2 | Out-File"));
assert('Out-File 与 Get-Content 原样保留', w1.wrapped.includes('Out-File $env:TEMP\\f.txt -Encoding utf8') && w1.wrapped.includes('Get-Content $env:TEMP\\f.txt'));
assert('Tee 不带 -Encoding（兼容 PowerShell 5.1）', /Tee-Object -FilePath 'C:\\repo\\.cmdmon-call_00_abc\.log' \|/.test(w1.wrapped));
assert('python 注入 PYTHONUNBUFFERED', w1.wrapped.startsWith("$env:PYTHONUNBUFFERED='1';") && w1.injectedPython);

const w2 = wrap('npm run build 2>&1 | Select-Object -Last 4', { mode: 'bg' });
assert('后台 + 收集管道 → Tee 插在 -Last 前', w2.wrapped.includes('| Tee-Object -FilePath') && w2.wrapped.includes('| Select-Object -Last 4'));

const w3 = wrap('python -m pytest tests -q', { mode: 'bg' });
assert('后台无收集/消耗段 → 不包装（jobs 通道可流式）', w3 === null);

const w4 = wrap('python -m pytest tests -q', { mode: 'fg' });
assert('前台无管道 → Tee 追加尾部', w4.wrapped.includes("| Tee-Object -FilePath") && w4.injectedPython);

const w5 = wrap('cmd > result.txt', { mode: 'fg' });
assert('重定向 > → Tee 插在重定向前', /cmd \| Tee-Object .+ > result\.txt/.test(w5.wrapped));

const w6 = wrap('foo 2>&1 | tail -n 3', { workdir: 'W' });
assert('tail 管道插 Tee 于前', w6.wrapped.includes('| Tee-Object') && w6.wrapped.includes('| tail -n 3'));

const w7 = wrap('x | Out-Null', { mode: 'fg' });
assert('Out-Null 前插 Tee', w7.wrapped.includes('| Tee-Object') && w7.wrapped.includes('| Out-Null'));

const w8 = wrap("$env:DB=1; & python a.py 2>&1 | Select-Object -Last 1; & python b.py 2>&1 | Select-Object -Last 2", { workdir: 'W' });
assert('多语句：每个收集管道都插 Tee', (w8.wrapped.match(/\| Tee-Object -FilePath/g) || []).length === 2);
assert('第一个 Tee 不带 -Append', /Tee-Object -FilePath .+ \| Select-Object -Last 1; & python b\.py/.test(w8.wrapped));
assert('第二个 Tee 带 -Append', /Tee-Object -FilePath .+ -Append \| Select-Object -Last 2/.test(w8.wrapped));

// 三个分号（四条语句），且含重定向/Out-File 混排
const w9 = wrap("cmd1 | Select-Object -Last 1 | Out-File a.txt; cmd2 > b.txt; cmd3 | tail -n 2; cmd4 | Select-Object -Last 3", { workdir: 'W' });
const tees9 = w9.wrapped.match(/\| Tee-Object -FilePath/g) || [];
assert('四个语句 → 四个 Tee', tees9.length === 4);
assert('同语句内 Out-File 不重复插（Select 后）', !/Select-Object -Last 1 \| Tee-Object -FilePath .+ \| Out-File a\.txt/.test(w9.wrapped));
assert('第三/四个 Tee 带 -Append', (w9.wrapped.match(/-Append/g) || []).length === 3);
assert('cmd2 > b.txt 重定向被捕获', /cmd2 \| Tee-Object -FilePath .+ -Append > b\.txt/.test(w9.wrapped));

const w10 = wrap("$env:A=1; & python a.py 2>&1 | Select-Object -Last 1; $env:B=2; & python b.py 2>&1 | Select-Object -Last 2; Write-Output done", { workdir: 'W' });
assert('多语句：收集段前插 + 无管道语句尾部插（共 3 个 Tee）',
  (w10.wrapped.match(/\| Tee-Object -FilePath/g) || []).length === 3);
assert('无管道语句改为尾部追加 Tee', /Write-Output done \| Tee-Object/.test(w10.wrapped));
assert('赋值语句不插 Tee（避免把值打进 stdout）',
  !/\$env:A=1 \| Tee-Object/.test(w10.wrapped) && !/\$env:B=2 \| Tee-Object/.test(w10.wrapped));

// 过滤/终止管道：Tee 插在过滤器/终止器之前，捕获全量
const w11 = wrap('python -m pytest tests -q 2>&1 | Select-String -Pattern "SKIPPED|skipped" | Select-Object -First 12', { workdir: 'W' });
assert('Select-String 前插 Tee', /2>&1 \| Tee-Object -FilePath .+ \| Select-String -Pattern/.test(w11.wrapped));
assert('过滤结果仍到 -First', /Select-String -Pattern "SKIPPED\|skipped" \| Select-Object -First 12/.test(w11.wrapped));

const w12 = wrap('cmd | Where-Object { $_ -match "x" } | Select-Object -First 3', { workdir: 'W' });
assert('Where-Object 前插 Tee', /cmd \| Tee-Object -FilePath .+ \| Where-Object/.test(w12.wrapped));

const w13 = wrap('pytest 2>&1 | Select-Object -First 5', { workdir: 'W' });
assert('-First 前插 Tee', /pytest 2>&1 \| Tee-Object -FilePath .+ \| Select-Object -First 5/.test(w13.wrapped));

const w14 = wrap('make test 2>&1 | grep -i error | head -n 3', { tool: 'bash', workdir: '/tmp' });
assert('bash grep 前插 tee', w14.wrapped.startsWith('make test 2>&1 | tee ') && w14.wrapped.includes('| grep -i error | head -n 3'));

// 0.4.8 新增：格式/转换/拼接/统计型 + bash |& + 尾部护栏放宽
const w15 = wrap('pytest 2>&1 | Format-Table Name,Time', { workdir: 'W' });
assert('Format-Table 前插 Tee', /pytest 2>&1 \| Tee-Object -FilePath .+ \| Format-Table/.test(w15.wrapped));

const w16 = wrap('cmd | ConvertTo-Json | Out-File x.json', { workdir: 'W' });
assert('ConvertTo-Json 前插 Tee（同语句 Out-File 不重复）', (w16.wrapped.match(/\| Tee-Object -FilePath/g) || []).length === 1 && w16.wrapped.includes('| ConvertTo-Json'));

const w17 = wrap('cmd | Out-String | Set-Content f.txt', { workdir: 'W' });
assert('Out-String 前插 Tee', /cmd \| Tee-Object -FilePath .+ \| Out-String/.test(w17.wrapped));

const w18 = wrap('pytest 2>&1 | wc -l', { workdir: 'W' });
assert('wc 前插 Tee', /pytest 2>&1 \| Tee-Object -FilePath .+ \| wc -l/.test(w18.wrapped));

const w19 = wrap('make test 2>&1 |& grep error', { tool: 'bash', workdir: '/tmp' });
assert('bash |& 管道前插 tee', w19.wrapped.startsWith('make test 2>&1 | tee ') && w19.wrapped.includes('|& grep error'));

const w20 = wrap('foo | Select-Object -Last 3; exit 0', { mode: 'bg', workdir: 'W' });
assert('有收集段时尾部 exit 不阻止插入', /foo \| Tee-Object -FilePath .+ \| Select-Object -Last 3; exit 0/.test(w20.wrapped));

// ---- 引号内的 `>` / `|` 是字符串字面量，不是重定向/管道（0.4.15 修复）----
// 实测事故：git log --format='%an <%ae>' 被改写成
//   git log --format='%an <| Tee-Object -FilePath '...' ...>'
// Tee 被插进了引号内部，命令被改坏、输出被污染。
const q1 = analyzeCommand("git log -1 --format='%an <%ae>'");
assert('引号内 > 不产生重定向警示', q1.warnings.length === 0);

const q2 = analyzeCommand('echo "a > b"');
assert('双引号内 > 不产生重定向警示', q2.warnings.length === 0);

const q3 = analyzeCommand('cmd > result.txt');
assert('引号外的 > 仍然警示（未误伤真重定向）', q3.warnings.some((w) => w.includes('重定向')));

const q4 = wrap("git log -1 --format='%an <%ae>'", { workdir: 'W' });
assert('引号内 > 不插 Tee（改尾部追加）', /--format='%an <%ae>' \| Tee-Object -FilePath/.test(q4.wrapped));
assert('格式串原样保留，未被切断', q4.wrapped.includes("--format='%an <%ae>'"));
assert('只插了一个 Tee', (q4.wrapped.match(/\| Tee-Object -FilePath/g) || []).length === 1);

const q5 = wrap("git log -1 --format='%an <%ae>' > out.txt", { workdir: 'W' });
assert('引号内有 > 时，引号外的真重定向仍被捕获', /--format='%an <%ae>' \| Tee-Object -FilePath .+ > out\.txt/.test(q5.wrapped));

const q6 = wrap('cmd "x | Out-File y"', { workdir: 'W' });
assert('双引号内 | Out-File 不被当作管道', !/\| Tee-Object -FilePath .+ "x/.test(q6.wrapped) && q6.wrapped.includes('"x | Out-File y"'));

const q7 = wrap("Write-Output 'it''s > x'", { workdir: 'W' });
assert('pwsh 单引号双写转义后仍识别为引号内', q7.wrapped.includes("'it''s > x'"));

const q8 = wrap("python -c \"print('a > b')\"", { workdir: 'W' });
assert('嵌套引号内的 > 不插 Tee', q8.wrapped.includes("\"print('a > b')\""));

assert('quotedRanges 单引号区间', (() => { const r = quotedRanges("a 'b > c' d"); return r.length === 1 && r[0][0] === 2 && r[0][1] === 9; })());
assert('quotedRanges 双引号区间', (() => { const r = quotedRanges('a "b" c'); return r.length === 1 && r[0][0] === 2 && r[0][1] === 5; })());
assert('quotedRanges 无引号返回空', quotedRanges('a | b > c').length === 0);
assert('quotedRanges 未闭合引号按引号内处理', quotedRanges("cmd 'oops > x").length === 1);

const q9 = analyzeCommand("@'\nfoo > bar\n'@\nWrite-Output x");
assert('pwsh here-string 内的 > 不警示', q9.warnings.length === 0);

// 0.5.3：警示文案压缩（多行脚本的匹配片段不能再把展开行撑成一坨）
assert('compactMatch 压平换行', compactMatch(' a\n\n  b   c ') === 'a b c');
assert('compactMatch 超长截断', compactMatch('x'.repeat(80)).length === 49 && compactMatch('x'.repeat(80)).endsWith('…'));
const m1 = analyzeCommand("cmd | Where-Object {\n  $_ -ne ''\n}\ncmd2 | Where-Object {\n  $_ -ne ''\n}");
assert('多行匹配片段被压成单行', m1.warnings.every((w) => !w.includes('\n')));
assert('同一管道重复出现只保留一条警示', m1.warnings.filter((w) => w.includes('Where-Object')).length === 1);
assert('警示文案长度受限（不撑爆面板）', m1.warnings.every((w) => w.length < 120));

// 0.5.2：语句级尾部覆盖（前台多语句命令此前只捕获最后一条语句）
const s1 = wrap('cmd1; cmd2', { workdir: 'W' });
assert('多语句：第一条建文件、第二条 -Append',
  /cmd1 \| Tee-Object -FilePath .+; cmd2 \| Tee-Object -FilePath .+ -Append/.test(s1.wrapped));

const s2 = wrap("$env:A='1'; python x.py", { workdir: 'W' });
assert('赋值语句原样保留、主命令尾部插 Tee',
  s2.wrapped.includes("$env:A='1';") && /python x\.py \| Tee-Object -FilePath/.test(s2.wrapped)
  && !/\$env:A='1' \| Tee-Object/.test(s2.wrapped));
assert('多语句下 python 仍注入 PYTHONUNBUFFERED', s2.injectedPython && s2.wrapped.startsWith("$env:PYTHONUNBUFFERED='1';"));

const s3 = wrap('for ($i=0; $i -lt 3; $i++) { "x$i" }; Write-Output done', { workdir: 'W' });
assert('for 头内分号不是语句边界（循环体整体不加尾部 Tee）', s3.wrapped.includes('for ($i=0; $i -lt 3; $i++) { "x$i" };'));
assert('for 之后的无管道语句仍插 Tee', /Write-Output done \| Tee-Object -FilePath/.test(s3.wrapped));
assert('for 语句只插了一个尾部 Tee', (s3.wrapped.match(/\| Tee-Object -FilePath/g) || []).length === 1);

const s4 = wrap("Write-Output 'a;b'; Get-Item x", { workdir: 'W' });
assert('引号内分号不是语句边界', (s4.wrapped.match(/\| Tee-Object -FilePath/g) || []).length === 2
  && s4.wrapped.includes("Write-Output 'a;b' | Tee-Object"));

const s5 = wrap('export A=1; make test', { tool: 'bash', workdir: '/tmp' });
assert('bash export 不插 tee（避免赋值落进子 shell）', s5.wrapped.startsWith('export A=1; make test | tee "') === true);

const s6 = wrap('foo; exit 1', { workdir: 'W' });
assert('exit 收尾：只包装可包装的语句，控制流原样', /foo \| Tee-Object -FilePath .+; exit 1$/.test(s6.wrapped));
assert('尾部分号：包装前一条语句（不再整体放弃）', /^foo \| Tee-Object -FilePath .+;$/.test(wrap('foo;', { workdir: 'W' }).wrapped));

const s7 = buildStreamWrap('cmd1; cmd2', { tool: 'pwsh', callId: 'c', mode: 'bg' });
assert('后台无收集段：仍交给 jobs 通道（不包装）', s7 === null);
const s8 = buildStreamWrap('cmd1 | Select-Object -Last 1; cmd2', { tool: 'pwsh', callId: 'c', mode: 'bg', workdir: 'W' });
assert('后台已有插入型 Tee：其余语句也补齐尾部 Tee',
  (s8.wrapped.match(/\| Tee-Object -FilePath/g) || []).length === 2);

assert('statementBreaks 跳过括号/引号内的分号',
  statementBreaks('for ($i=0; $i -lt 3; $i++) { a }; b').length === 1
  && statementBreaks('a "x;y"; b').length === 1);
// 0.5.4：换行也是语句边界（遵守续行规则）
assert('statementBreaks：普通换行算边界', statementBreaks('a\nb').length === 1);
assert('statementBreaks：行尾管道是续行', statementBreaks('a |\nb').length === 0);
assert('statementBreaks：下一行前置管道是续行', statementBreaks('a\n  | b').length === 0);
assert('statementBreaks：行尾逗号/等号/反引号是续行',
  statementBreaks('a,\nb').length === 0 && statementBreaks('$x =\n1').length === 0 && statementBreaks('a `\nb').length === 0);
assert('statementBreaks：行尾孤立运算符是续行', statementBreaks('$x -and\n$y').length === 0);
assert('statementBreaks：块内/引号内换行不是边界',
  statementBreaks('if ($true) {\n  a\n}\nb').length === 1 && statementBreaks("a 'x\ny'\nb").length === 1);
assert('statementBreaks：空行不成语句', statementBreaks('a\n\nb').length === 1);
assert('statementBreaks：注释里的分号不算边界', statementBreaks('a # x;y\nb').length === 1);
assert('topLevelComment 定位行尾注释', topLevelComment('cmd # note') === 4 && topLevelComment("cmd 'a#b'") === -1);
assert('canTailTee 拒绝赋值/export/控制流/块结尾/纯注释',
  !canTailTee("$env:A=1") && !canTailTee('export A=1') && !canTailTee('exit 0')
  && !canTailTee('if (x) { a }') && !canTailTee('  ') && !canTailTee('# 只是注释')
  && canTailTee('python x.py'));

// 0.5.4：多行脚本按行拆语句逐条插 Tee（换行保留，不再整体放弃）
const m2 = wrap('Write-Output one\nWrite-Output two', { workdir: 'W' });
assert('多行：两条语句各插一个 Tee',
  (m2.wrapped.match(/\| Tee-Object -FilePath/g) || []).length === 2
  && /Write-Output one \| Tee-Object -FilePath .+\nWrite-Output two \| Tee-Object -FilePath .+ -Append/.test(m2.wrapped));

const m3 = wrap('$body = @\'\nline1\nline2\n\'@\nWrite-Output "after"', { workdir: 'W' });
assert('多行：here-string 原样保留（内部换行不算语句边界）', m3.wrapped.includes("@'\nline1\nline2\n'@"));
assert('多行：here-string 赋值语句不插 Tee', !/\$body = @'[\s\S]*Tee-Object/.test(m3.wrapped.split("'@")[0] + "'@"));
assert('多行：here-string 之后（第 4 行）的语句插 Tee', /'@\nWrite-Output "after" \| Tee-Object -FilePath/.test(m3.wrapped));

const m4 = wrap('cmd1 # 行尾注释\ncmd2', { workdir: 'W' });
assert('多行：Tee 插在行尾注释之前', /cmd1 \| Tee-Object -FilePath .+ # 行尾注释\ncmd2 \| Tee-Object -FilePath .+ -Append/.test(m4.wrapped));

const m5 = wrap('# 纯注释行\nWrite-Output real', { workdir: 'W' });
assert('多行：纯注释行不插 Tee（建文件留给真正的语句）',
  m5.wrapped.startsWith('# 纯注释行\n') && (m5.wrapped.match(/\| Tee-Object -FilePath/g) || []).length === 1
  && !m5.wrapped.includes('-Append'));

const m6 = wrap('Get-Item a |\n  Select-String x\nWrite-Output done', { workdir: 'W' });
assert('多行：行尾管道续行时，Tee 插在过滤器之前（捕获全量）',
  /Get-Item a \| Tee-Object -FilePath .+ \|\n  Select-String x\nWrite-Output done \| Tee-Object -FilePath .+ -Append/.test(m6.wrapped));

const m7 = wrap('if ($true) {\n  "blk"\n}\nWrite-Output after', { workdir: 'W' });
assert('多行：if 语句块整体跳过，后续语句照常插 Tee',
  (m7.wrapped.match(/\| Tee-Object -FilePath/g) || []).length === 1
  && /if \(\$true\) \{\n  "blk"\n\}\nWrite-Output after \| Tee-Object -FilePath/.test(m7.wrapped));

// partial：语句块等"有输出但没法包装"的语句 → 标记为部分覆盖（宿主据此在完成时补全）
assert('全语句覆盖时 partial=false',
  wrap('Write-Output one\nWrite-Output two', { workdir: 'W' }).partial === false);
assert('语句块未覆盖时 partial=true',
  wrap('foreach ($i in 1..3) {\n  "i=$i"\n}\nWrite-Output done', { workdir: 'W' }).partial === true);
assert('赋值/注释等无输出语句不算漏（partial=false）',
  wrap("$env:A='1'; Write-Output x", { workdir: 'W' }).partial === false
  && wrap('# 注释\nWrite-Output real', { workdir: 'W' }).partial === false);
assert('isSilentStatement 判定', isSilentStatement("$x = 1") && isSilentStatement('export A=1')
  && isSilentStatement('# c') && isSilentStatement('exit 0') && !isSilentStatement('Write-Output x'));

// 实测事故复现：前台 `1..8 | % {…逐秒输出…}; Write-Output done`
// 此前只把 Tee 贴到整条命令尾部 → 面板只拿到最后一条语句（done），前面的输出全丢
const s9 = wrap('1..8 | ForEach-Object { "FG-$_" }; Write-Output done', { workdir: 'W' });
assert('管道脚本块语句也能尾部插 Tee（实测事故用例）',
  /1\.\.8 \| ForEach-Object \{ "FG-\$_" \} \| Tee-Object -FilePath .+; Write-Output done \| Tee-Object -FilePath .+ -Append/.test(s9.wrapped));
assert('该用例插了 2 个 Tee（覆盖两条语句）', (s9.wrapped.match(/\| Tee-Object -FilePath/g) || []).length === 2);
assert('语句块（if/foreach）后不接管道（语法错误）',
  canTailTee('if ($true) { "x" }') === false && canTailTee('foreach ($i in 1..2) { $i }') === false);
assert('管道块参数可接管道', canTailTee('1..3 | ForEach-Object { $_ }') === true);
assert('逻辑或 || 不被当成管道（普通语句仍可尾部包 Tee）', canTailTee('cmd1 || cmd2') === true);
const s10 = wrap('cmd1 || cmd2', { workdir: 'W' });
assert('|| 语句正常尾部包 Tee（不误判为管道块）', /cmd1 \|\| cmd2 \| Tee-Object -FilePath/.test(s10.wrapped));

// 护栏
assert('尾部右花括号跳过', wrap('foo }', {}) === null);
assert('多行现在会被包装（0.5.4 起，换行按续行规则拆语句）',
  (() => { const t = wrap('a\nb', { workdir: 'W' }); return t !== null && (t.wrapped.match(/\| Tee-Object -FilePath/g) || []).length === 2; })());
assert('已包装跳过', wrap('x | Tee-Object -FilePath .cmdmon-a.log', {}) === null);
assert('非 shell 工具跳过', buildStreamWrap('read', { tool: 'read', callId: 'c' }) === null);
assert('bash 用 tee', (() => { const t = wrap('bash-echo', { tool: 'bash', workdir: '/tmp' }); return t.wrapped.startsWith('bash-echo | tee "') && t.wrapped.includes('.cmdmon-call_00_abc.log"'); })());

console.log('\n结果: ' + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
