// 临时单测：node test-rewrite.mjs
import { analyzeCommand } from './lib/rewrite.js';

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

const r1 = analyzeCommand('x | select -last 3', { rewrite: false });
assert('rewrite=false 不改写', r1.command === 'x | select -last 3' && !r1.changed);
assert('rewrite=false 仍警示', r1.warnings.length > 0);

const r2 = analyzeCommand('foo | Measure-Object | Select-Object -Last 1', {});
assert('叠两个收集管道都去掉', !r2.command.includes('Measure-Object') && !r2.command.includes('Select-Object'));

const r3 = analyzeCommand("python -c \"print('a|b')\"", {});
assert('引号内管道不误伤', r3.command.includes("print('a|b')") && !r3.command.includes('Select-Object') && !r3.command.includes('tail'));

console.log('\n结果: ' + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
