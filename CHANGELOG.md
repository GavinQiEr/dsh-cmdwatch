# Changelog

## 0.4.6 (2026-08-31)

### 修复：多分号命令的语句级 Tee 覆盖 + `>` 重定向 lookbehind 误伤

- **多分号（>2 条语句）**：按 `;` 语句边界逐条插 Tee——每条语句的第一个收集/
  消耗段插一个 Tee（首条建文件、其余 `-Append`）；同语句内后续段（如
  `Select -Last 1 | Out-File`）不重复插；无管道语句不插。实测 4 语句命令得到
  4 个 Tee（3 个 -Append）。
- **`cmd2 > b.txt` 未被识别**：`>` 正则的 `(?<![\d&])` lookbehind 检查的是匹配
  起点（空格）前一字符，`cmd2 >` 的空格前是 `2`，被误判为 `2>&1` 排除。改为
  `(?<![\d&])\s*>{1,2}(?!>)\s*`——lookbehind 直接作用于 `>` 前字符：`2>&1`
  仍排除、`cmd2 > f` 正确命中。
- 验证：`npm test` 32 用例全过（新增 3 语句/4 语句/混合重定向用例）。

## 0.4.5 (2026-08-31)

### 修复：多语句命令（`;` 分隔）只有第一条语句被 Tee 捕获

`rebuild_test_db.py ... | Select-Object -Last 1; pytest ... | Select-Object -Last 2`
这类命令：Tee 只插在**第一个**收集管道前，第二条语句（pytest）的管道未被覆盖，
进度丢失（面板只看到 rebuild 的 4 行）。修复：

- **每条语句都插 Tee**：收集/消耗段按语句边界（`;`）去重——同一语句内只插第一个
  段（后面的段在同一条管道链中，第一个 Tee 已捕获全量）
- 第一个 Tee 建文件，后续 Tee 用 `-Append`（pwsh `Tee-Object -Append` / bash
  `tee -a`；`-Append` 在 PowerShell 5.1/7 均支持）
- 验证：`npm test` 26 用例全过（新增多语句双 Tee 用例，含 -Append 断言）

## 0.4.4 (2026-08-31)

### 修复：任务完成后状态卡在"运行中"（Tee 任务终止状态丢失）

实测：8 条 Tee 后台任务完成后全部卡 `running`、无 `finishedAt`、11 个
`.cmdmon-*.log` 残留。根因：`dsh-jobs-local` 的 `onJobDone/onJobsChanged`
监听器按 owner 作用域链派发（`listenersFor(owner)` 只覆盖全局层 + owner 链上
的层），静态插件注册的监听器不在 owner 链上 → **终止事件收不到**；而 0.3.x 时代
是轮询 `jobs.read().snapshot` 兜底标记完成，0.4.1 对 Tee 任务跳过 read 后就断了。

修复（轮询兜底，不依赖事件）：
- 每 500ms 用 **`jobs.get(id, owner)`** 刷新所有 job 记录的状态——`get` 不消耗
  输出（区别于 `read`），且 jobs store 保留终止任务快照；不受流开关影响
- 状态转终止时：Tee 任务读剩余输出并清理日志文件（统一 `finishTeeRecord`）
- 非 Tee 任务保持 `jobs.read` 增量输出（受流开关控制）；`read.snapshot` 冗余更新
  状态无影响
- 清理了残留的 11 个 `.cmdmon-*.log`
- 验证：`npm test` 23 用例全过

## 0.4.3 (2026-08-31)

### 修复：Tee-Object -Encoding 仅 PowerShell 7 支持 → 5.1 下命令中止

0.4.2 给注入的 `Tee-Object` 加了 `-Encoding utf8`，但该参数**仅 PowerShell 7
支持**；实测环境是 **Windows PowerShell 5.1**（`Tee-Object` 参数表无 `Encoding`），
参数绑定失败 → 整条命令 `exit 1`、输出丢失。修复：

- **移除 `-Encoding utf8`**：`Tee-Object -FilePath '<f>'` 在 5.1 / 7 均有效
- 编码兼容完全交给读取端（0.4.2 的 `readTeeDelta` 按 BOM 自动识别）：
  5.1 写 UTF-16LE（BOM `FF FE`）→ 按 UTF-16LE 解码；7 写 utf8NoBOM → 按 UTF-8
- 实测：5.1 下 `1..3 | Tee-Object -FilePath f` 正常、文件头 `FF FE`、BOM 解码
  输出干净
- 验证：`npm test` 23 用例全过（含"Tee 不带 -Encoding"断言）

## 0.4.2 (2026-08-31)

### 修复：Tee 日志编码（实测 UTF-16LE 被按 UTF-8 读成乱码）

真实 pytest 运行中发现：`Tee-Object -FilePath` 默认用 **UTF-16LE（带 BOM）** 写
日志，插件按 UTF-8 读取 → 开头出现 `��`（BOM 误读）、字符间混入 NUL。修复：

- 注入的 Tee 显式加 `-Encoding utf8`（pwsh 7 为无 BOM UTF-8）
- 读取时按 BOM 自动识别编码：`FF FE` → UTF-16LE 解码、`EF BB BF` → 跳过 BOM；
  首次读取定编码，后续按偏移增量读取
- 验证：`npm test` 23 用例全过；真实 pytest（4524 用例）实时流式显示正常

## 0.4.1 (2026-08-31)

### 修复：剥离管道策略改为统一「插入 Tee」——Out-File/重定向管道也能实时

`... | Select-Object -Last 2 | Out-File f; Get-Content f` 这类命令此前不显示
进度：剥离 `Select-Object -Last` 后输出仍被 `Out-File` 吞掉（stdout 无内容），
且改变了工具结果语义。0.4.1 统一改为**插入 Tee**（不再剥离）：

- Tee 插在**最早**的收集型（`-Last`/`tail`/`sort` 等）或**输出消耗型**
  （`Out-File`/`Set-Content`/`Out-Null`/`>` 重定向）段之前——面板读到全量渐进
  输出，dsh 的原管道（`-Last 2 | Out-File; Get-Content`）**原样保留、结果零改变**。
- 后台任务仅在存在收集/消耗段时包装（否则 jobs 通道本身可流式，不引入日志文件）；
  前台任务总是包装。两者统一走 `.cmdmon-<callId>.log` 文件轮询（`fgStream` 机制），
  Tee 文件在任务/调用完成后自动删除。
- `analyzeCommand` 改为纯检测（警示）；改写逻辑收敛到 `buildStreamWrap`。
- 验证：`npm test` 22 用例全过（含 `2>&1 | Select-Object -Last 2 | Out-File f;
  Get-Content f` 的 Tee 插入点、`>` 重定向、后台无段不包装等）。

## 0.4.0 (2026-08-31)

### 新增：前台命令实时输出（Tee 捕获）

前台命令（默认执行方式）此前"完成后才显示"。0.4.0 起默认实时：

- `tools/execute` 阶段给 pwsh/bash 前台命令插入 `Tee-Object`（bash 用 `tee`），
  输出落盘到工作区/临时目录的 `.cmdmon-<callId>.log`，插件 500ms 轮询文件把增量
  推到面板（运行中即逐行滚动，完成后自动删除日志文件）。
- **插在收集型管道之前**：如 `... 2>&1 | Select-Object -Last 3` 变为
  `... 2>&1 | Tee-Object -FilePath f | Select-Object -Last 3`——面板看到全量
  渐进输出，**工具结果仍按原管道返回**（dsh 要最后 3 行还是最后 3 行，语义零改变）。
- 命中 python 时同样注入 `PYTHONUNBUFFERED`（避免块缓冲）。
- 安全护栏：仅单行命令、尾部不以 `;`/`}`/`exit 1` 等收尾、未包装过才插入；
  插入失败只降级为警示，不影响命令执行。
- 配置 `foregroundStream`（默认 `true`）；面板带「实时」徽标。
- 验证：`npm test` 34 用例全过（含 Tee 包装 13 例）；实测 Tee 机制——结果保真
  （返回最后 2 行）、日志全量（6 行）、运行中渐进写入（12s 任务 2s 时文件已有
  7 行）。

## 0.3.2 (2026-08-31)

### 变更：终端日志默认静默

排查完成，`[cmdmon]` 信息日志不再刷宿主终端：

- 新增 `debug` 配置（默认 `false`）——开启后才输出 `execute bg` / `rewrite` /
  `job registered` / `stream started` 等信息日志
- 错误日志（钩子/轮询失败）始终保留；诊断缓冲 `diagEvents` 照常记录，排查时
  开 `debug` 或直接读 `/cmdmon/snapshot` 均可

## 0.3.1 (2026-08-31)

### 修复：命令改写从未生效（exec.arguments 是只读快照）

0.3.0 的改写逻辑在真实运行时**从未触发**：`dsh-tools` 的 `createExecution` 对
`exec.arguments` 执行 `snapshotJsonValue + deepFreeze`，参数对象是深度冻结的只读
快照，`args.command = ...` 原地赋值必然抛 `TypeError: Cannot assign to read only
property 'command'`，异常被钩子 catch 吞掉后：工具记录不创建、改写不生效、命令
带着收集型管道照跑，实时输出继续被管道缓冲。

**修复**：改写不再依赖原地赋值——原地失败后**整体替换 `exec.arguments`** 为
`{ ...args, command: 改写后 }`（`exec` 本身在 execute 阶段可写，官方
`dsh-tool-call-timeout-policy` 改 `exec.signal` 同理），dispatch 时
`tool.execute(exec.arguments, exec)` 读到改写后的命令。替换失败时降级为面板警示，
工具记录始终保留。

**验证**（模拟进程，重启后实测）：后台任务 `1..5 | ForEach-Object {...} |
Select-Object -Last 2` 被改写成去掉管道的形式，工具/任务记录均 `changed=true` +
「已自动剥离」警示 + 保留原始命令，任务输出从"最后 2 行"变为"全部 5 行"，且
`stream started` 证明运行中即逐行流式。

### 新增：诊断事件缓冲

- `diagEvents` 环形缓冲随 `/cmdmon/snapshot` 返回（无需看宿主终端即可定位钩子行为）
- 记录：`execute bg`（后台调用）、`rewritten`、`job registered`、`stream started`、
  `execute hook FAILED` / `analyzeCommand FAILED`（带异常栈）、`poll FAILED`
- job 记录元数据（警示/原始命令/改写标记）显式继承，不再因 `onJobsChanged` 先创建而丢失

## 0.3.0 (2026-08-31)

### 新增：命令净化（检测 + 自动改写）

dsh 自主拼出的命令可能带**收集型管道**（`| Select-Object -Last N`、`| tail -n N`、
`| Sort-Object` 等）——这类 cmdlet 必须等上游全部输出完才产生输出，shell 进程的
stdout 在命令结束前一直是空的，后台任务的实时流因此看不到任何进度。0.3.0 在
`tools/execute` 中间件中直接处理（框架允许原地改写 `exec.arguments`，官方
`dsh-tool-call-timeout-policy` 同款用法）：

- **自动改写（仅后台任务 `run_in_background: true`）**：剥离收集型管道
  （`2>&1 | Select-Object -Last 4` → 原命令），保持语义等价——同样的程序、
  同样的参数，只是不截断输出；命中 python 时自动注入 `PYTHONUNBUFFERED=1`
  （pwsh 用 `$env:PYTHONUNBUFFERED='1';`，bash 用 `export PYTHONUNBUFFERED=1;`），
  避免 python 在管道下的块缓冲，实现逐行实时输出。
- **面板警示**：检测到收集型/提前终止型管道（`-First` / `head` 只警示不改写）
  时，记录行显示黄色 `⚠` 徽标，展开后列出具体警示与原始命令；被改写的记录
  显示 `改` 徽标，悬停/展开可看原始命令全文。
- **配置**：默认全开，可在 bundle 配置关闭——`{ rewrite: false }` 关闭改写、
  `{ pythonUnbuffered: false }` 关闭注入、`{ warn: false }` 关闭警示。
- **纯逻辑独立成模块**：`lib/rewrite.js`（不依赖宿主），`npm test` 运行
  20 个用例覆盖（含用户实测的 pytest + Select-Object -Last 场景）。

### 验证

- `npm test`：20/20 通过——用户 pytest 命令改写后保留主体与 `2>&1`、注入
  `PYTHONUNBUFFERED`、保留原始命令；`-First`/`head` 只警示不改写；引号内管道
  不误伤；已有 `-u` 不重复注入；rewrite 关闭时只警示。
- 权限顺序说明：`tools/pre-execute`（deny/ask 检查）先于 `tools/execute` 基于
  原始命令通过；改写只剥离缓冲管道尾巴，不改变程序与参数，不引入新的执行面。

## 0.2.0 (2026-08-31)

### 新增

- **会话隔离**：每条记录带 `sessionId`（工具来自 `exec.agent.id`，任务来自
  `snap.ownerSession`）；`snapshot` 端点支持 `?session=<id>` 过滤，`clear` 端点
  支持 `{session}` 按会话清理。同一工作区下不同会话的面板各看各的命令，
  不再互相串内容。

### 前台流式化：尝试与结论（未合入）

尝试让**前台命令**执行期间也实时推送输出，两个方案均因架构限制失败，已回退：

- **v1（包装 `shell.run`）**：sandbox executor 重写了 `run`，直接覆盖会破坏 sandbox
  语义（denied 检测 / SandboxUnavailableError），且需手动复刻超时与 stdout/stderr
  分离，脆弱易错。
- **v2（包装 `subprocess.spawn`）**：用动态探测插件验证，Cordis 的服务方法被代理
  锁定（`denyContext` 包装器），`spawn = fn` 赋值被静默丢弃，从未落到真实实例——
  服务方法无法被第三方插件 patch。

**结论**：静态插件架构下，前台命令执行中的中间输出只在 shell 进程内、无官方事件
钩子可订阅，**前台流式化不可行**。前台命令在完成后显示完整结果；实时进度请使用
**后台任务**（`run_in_background: true`，走 `jobs` 官方通道，已验证完美流式）。

### 验证

- 后台任务实时进度：pytest 风格 25/30 项任务，执行中逐行滚动（2 秒捕获 15 行，
  最新 `test_15 ... 60%`），完成后全部行捕获，状态流转 running → completed 正确。
- 会话隔离：不同 session 面板数据完全独立，伪造 session 过滤返回 0 条。
- 前台命令：完成后完整输出（含 `[stderr]` 段），sessionId 标记正确。
- ⚠️ 经验：`| Select-Object -Last N` 会缓冲整个管道输出，命令结束前中间输出
  不会产生——需要实时监控的命令不要加该管道。

## 0.1.1 (2026-08-30)

### 修复

- **后台任务输出轮询改用各 job 自身 owner**：此前用单个全局 `owner` 变量读取所有
  后台任务，静态插件运行在宿主组合会收到所有 agent 的工具调用，owner 被其他会话/
  子代理的调用覆盖后 `jobs.read()` 权限失败，导致"能看到任务执行但没有输出"，
  而 dsh 的 `job_output` 工具（用任务自己的 owner 读）却能读到。现在每个 job 通过
  `jobOwners` Map 绑定启动它的确切 Agent，轮询按 job 的 owner 读取。
- **单任务读取失败不再中断整轮轮询**：try/catch 移到每个 job 内部，一个任务失败
  只跳过它，其余任务照常捕获。

### 验证

- 重启 web 加载修复后：任务运行中实时捕获 7 行 → 完成后完整捕获 15 行；
  `job_output` 读到 `(no new output)` 证明插件完整抢读；状态流转 running → completed 正确。

## 0.1.0 (2026-08-30)

- 首发：命令监视器可安装插件（dsh-cmdwatch）
- Host 半：捕获前台命令（tools/execute + tools/result）与后台任务（jobs 事件 + 输出轮询）
- Client 半：输入框上方「命令监视」面板，实时流开关、自动滚动、长命令缩短
- 通信：Host webServer HTTP 端点 + Client fetch 轮询（同源通道）
- 分发：dsh.bundle.patch 自动注入 cordis 行；dsh.client 声明浏览器端模块
- 验证：0.1.1-rc.2 下安装、组合注入、输出捕获均通过
