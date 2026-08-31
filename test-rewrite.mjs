// dsh-cmdwatch 命令净化单测：node test-rewrite.mjs
import { analyzeCommand, buildStreamWrap } from './lib/rewrite.js';

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
assert('三语句（含无管道语句）→ 两个 Tee', (w10.wrapped.match(/\| Tee-Object -FilePath/g) || []).length === 2);
assert('无管道语句不插 Tee', /Write-Output done \| Tee-Object/.test(w10.wrapped) === false);

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

// 护栏
assert('尾部分号跳过', wrap('foo;', {}) === null);
assert('尾部右花括号跳过', wrap('foo }', {}) === null);
assert('exit 收尾跳过', wrap('foo; exit 1', {}) === null);
assert('return 收尾跳过', wrap('foo; return', {}) === null);
assert('多行跳过', wrap('a\nb', {}) === null);
assert('已包装跳过', wrap('x | Tee-Object -FilePath .cmdmon-a.log', {}) === null);
assert('非 shell 工具跳过', buildStreamWrap('read', { tool: 'read', callId: 'c' }) === null);
assert('bash 用 tee', (() => { const t = wrap('bash-echo', { tool: 'bash', workdir: '/tmp' }); return t.wrapped.startsWith('bash-echo | tee "') && t.wrapped.includes('.cmdmon-call_00_abc.log"'); })());

console.log('\n结果: ' + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
