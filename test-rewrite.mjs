// 临时单测：node test-rewrite.mjs
import { analyzeCommand, buildForegroundTee } from './lib/rewrite.js';

const cases = [
  {
    name: '用户原始 pytest 命令（后台）',
    cmd: "$env:MYSQL_ROOT_PASSWORD='Hong880712!'; & .\\venv\\Scripts\\python.exe -m pytest tests -q --tb=short -p no:cacheprovider 2>&1 | Select-Object -Last 4",
    opts: { shell: 'pwsh' }
  },
  { name: '无管道普通命令', cmd: 'git status', opts: {} },
  { name: 'bash tail 管道', cmd: 'python -m pytest tests -q 2>&1 | tail -n 4', opts: { shell: 'bash' } },
  { name: 'sort 尾部', cmd: 'ls | sort -r', opts: { shell: 'bash' } },
  { name: '中间 -Last', cmd: 'cmd1 | Select-Object -Last 2 | cmd2', opts: {} },
  { name: 'Select -First（只警示不改写）', cmd: 'pytest 2>&1 | Select-Object -First 5', opts: {} },
  { name: '引号内含管道（不应误伤）', cmd: "python -c \"print('a|b')\"", opts: {} },
  { name: '已有 -u（不重复注入）', cmd: 'python -u run.py', opts: {} },
  { name: 'rewrite 关闭时只警示', cmd: 'x | select -last 3', opts: { rewrite: false } },
  { name: '多级尾部收集（叠两个）', cmd: 'foo | Measure-Object | Select-Object -Last 1', opts: {} },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const r = analyzeCommand(c.cmd, c.opts);
  console.log('=== ' + c.name + ' ===');
  console.log('changed :', r.changed);
  console.log('rewritten:', JSON.stringify(r.command));
  console.log('warnings:', JSON.stringify(r.warnings));
  console.log();
  pass++;
}

// 关键断言
const main = cases[0];
const r0 = analyzeCommand(main.cmd, main.opts);
const assert = (name, cond) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name);
  cond ? pass++ : fail++;
};
assert('用户命令去掉了 Select-Object -Last 4', !r0.command.includes('Select-Object -Last 4') && r0.changed);
assert('用户命令保留了 pytest 主体', r0.command.includes('-m pytest tests -q --tb=short'));
assert('用户命令注入 PYTHONUNBUFFERED', r0.command.includes('PYTHONUNBUFFERED'));
assert('用户命令保留 2>&1', r0.command.includes('2>&1'));
assert('保留原始命令', r0.original === main.cmd);
assert('警示包含收集型管道说明', r0.warnings.some((w) => w.includes('Select-Object -Last')));
assert('改写后警示标注"已自动剥离"', r0.warnings.some((w) => w.startsWith('已自动剥离：收集型管道')));

const r1 = analyzeCommand('x | select -last 3', { rewrite: false });
assert('rewrite=false 不改写', r1.command === 'x | select -last 3' && !r1.changed);
assert('rewrite=false 仍警示', r1.warnings.length > 0);

const r2 = analyzeCommand('foo | Measure-Object | Select-Object -Last 1', {});
assert('叠两个收集管道都去掉', !r2.command.includes('Measure-Object') && !r2.command.includes('Select-Object'));

const r3 = analyzeCommand("python -c \"print('a|b')\"", {});
assert('引号内管道不误伤', r3.command.includes("print('a|b')") && !r3.command.includes('Select-Object') && !r3.command.includes('tail'));

// ---- buildForegroundTee（前台实时输出包装）----
const tee = (cmd, opts) => buildForegroundTee(cmd, { tool: 'pwsh', callId: 'call_00_abc', ...opts });

const t1 = tee('python -m pytest tests -q 2>&1 | Select-Object -Last 4', { workdir: 'C:\\repo' });
assert('Tee 插在收集管道之前', t1.wrapped.includes("| Tee-Object -FilePath 'C:\\repo\\.cmdmon-call_00_abc.log' | Select-Object -Last 4"));
assert('Tee 包装注入 PYTHONUNBUFFERED', t1.wrapped.startsWith("$env:PYTHONUNBUFFERED='1';") && t1.injectedPython);
assert('Tee 返回绝对文件路径', t1.file === 'C:\\repo\\.cmdmon-call_00_abc.log');

const t2 = tee('git status', {});
assert('无管道时 Tee 追加到尾部', t2.wrapped === "git status | Tee-Object -FilePath '" + t2.file + "'");

const t3 = tee('bash-echo', { tool: 'bash', workdir: '/tmp' });
assert('bash 用 tee', t3.wrapped.startsWith('bash-echo | tee "') && t3.wrapped.includes('.cmdmon-call_00_abc.log"'));

const t4 = tee('foo 2>&1 | tail -n 3', { workdir: 'W' });
assert('tail 管道同样插 Tee 于前', t4.wrapped.includes('| Tee-Object') && t4.wrapped.includes('| tail -n 3'));

assert('尾部分号跳过', tee('foo;', {}) === null);
assert('尾部右花括号跳过', tee('foo }', {}) === null);
assert('exit 收尾跳过', tee('foo; exit 1', {}) === null);
assert('return 收尾跳过', tee('foo; return', {}) === null);
assert('多行跳过', tee('a\nb', {}) === null);
assert('已包装跳过', tee('x | Tee-Object -FilePath .cmdmon-a.log', {}) === null);
assert('非 shell 工具跳过', buildForegroundTee('read', { tool: 'read', callId: 'c' }) === null);

console.log('\n结果: ' + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
