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
assert('Tee 插在最早的收集管道之前（Select-Object 前）', w1.wrapped.includes("2>&1 | Tee-Object -FilePath 'C:\\repo\\.cmdmon-call_00_abc.log' -Encoding utf8 | Select-Object -Last 2 | Out-File"));
assert('Out-File 与 Get-Content 原样保留', w1.wrapped.includes('Out-File $env:TEMP\\f.txt -Encoding utf8') && w1.wrapped.includes('Get-Content $env:TEMP\\f.txt'));
assert('Tee 显式 UTF-8 编码', w1.wrapped.includes('Tee-Object -FilePath') && w1.wrapped.includes('-Encoding utf8'));
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
