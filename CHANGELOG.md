# Changelog

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
