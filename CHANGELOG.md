# Changelog

## 0.2.0 (2026-08-31)

### 新增

- **前台命令流式化**：包装 `ctx.subprocess.spawn`，旁路镜像 `handle.collected`
  （offset-based 非消耗 reader）增量输出。前台 pwsh/bash 长命令（如 pytest）执行
  期间面板实时滚动输出，无需再依赖 `run_in_background`；不替换执行、不改超时/
  sandbox/退出码/stderr 分离语义，工具与模型侧结果与未装插件时完全一致。
- **会话隔离**：每条记录带 `sessionId`（工具来自 `exec.agent.id`，任务来自
  `snap.ownerSession`）；`snapshot` 端点支持 `?session=<id>` 过滤，`clear` 端点
  支持 `{session}` 按会话清理。同一工作区下不同会话的面板各看各的命令，
  不再互相串内容。

### 修复

- 前台流式化 v1 方案（包装 `shell.run`）废弃：sandbox executor 重写了 `run`，
  直接覆盖会破坏 sandbox 语义（denied 检测 / SandboxUnavailableError），且需手动
  复刻超时与 stdout/stderr 分离，脆弱易错。v2 改在更底层、单一入口的
  `subprocess.spawn` 旁路镜像，语义零破坏。

### 验证

- 后台 owner 修复（0.1.1）在重启后复测通过：任务运行中实时捕获、完成后完整输出。
- 前台 pytest（无 `Select-Object -Last` 管道）完整捕获 101 行输出；
  `[stderr]` 段正确合并；`1 failed, 53 passed` 统计与退出码 1 正确传达。
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
