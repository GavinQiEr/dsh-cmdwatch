# Changelog

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
