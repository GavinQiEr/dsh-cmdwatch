# Changelog

## 0.5.12

### 新增：`/cmdmon/wait` 精确等待端点（长轮询，零预估）

主进程等待子进程常常只能"估个时间再睡"——子进程早跑完了，等待方还不知道。
`job_output` 的 `wait: true` 虽是事件驱动，但只对**任务 owner** 可用，且默认等待
只有 30s（上限 10min）。本端点把"精确等待"变成任何进程/会话都能用的原语：

```
GET /cmdmon/wait?key=job:pwsh-3&timeout_ms=600000
GET /cmdmon/wait?key=job:pwsh-3&session=<id>
GET /cmdmon/wait?timeout_ms=600000            # 不带 key：等待当前可见范围全部结束
```

- 目标记录进入终止状态（`completed`/`failed`/`killed`）**立即返回**，不白等
- 记录尚未出现时持续等待（可等一个即将启动的任务）；超时返回 `timedOut: true`
- 会话隔离与 `snapshot` 同一套规则（无 `session` 只看无归属记录；`all=1` 排查用）
- `timeout_ms` 默认 600000、上限 3600000；客户端断开即停止轮询
- 返回体含 `record`（与面板同字段，含 `status`/`finishedAt`/`output`）

用法示例（PowerShell）：

```powershell
# 零预估等待任务完成；返回后 record.status 即为终态
$r = Invoke-RestMethod 'http://127.0.0.1:3080/cmdmon/wait?key=job:pwsh-3&timeout_ms=600000'
if (-not $r.timedOut) { "done: $($r.record.status)" }
```

顺带把 snapshot 的记录序列化抽成 `serializeRecord()`，两个端点共用同一套字段。

## 0.5.11

### 优化：原始命令默认折叠，纵向空间让给运行输出

- 展开行里的「原始命令」从"整段平铺"改为**默认一行**（超长省略号；悬停行标题同样能看到
  全文），点击这一行才展开完整内容（内部最多 120px 滚动）—— 多行长脚本不再把运行输出
  挤出可视区。
- 运行中记录的输出区高度由固定 200px 放宽到 **40vh**，盯进度时能多看几行。
- 展开/收起逻辑抽成 `toggleExpanded()`（client/order.js），记录行与「原始命令」共用，
  新增 3 个用例（点同一条收起 / 点别的切换 / 从无到有展开）。

验证：`npm test` **222 用例全过**（rewrite 108 + jobsync 32 + session 25 + order 29 + 宿主集成 28）。

## 0.5.10

### 新增：顶部运行中的记录自动展开

- 主表**最上面那条运行中/停止中的记录自动展开**，执行中直接看输出滚动，不用每次点一下。
- **尊重手动操作**：手动收起过的那条不再被自动展开；换了新的运行中记录、或手动展开了
  别的记录后，自动展开继续生效（`nextAutoExpand()`，client/order.js）。
- 没有运行中的记录时**不动展开态**（用户正看完成结果时不抢走）；只有最顶上那条占展开位，
  多条并行不会把面板撑满，其余点一下即可。

验证：`npm test` **219 用例全过**（rewrite 108 + jobsync 32 + session 25 + order 26 + 宿主集成 28）。

## 0.5.9

### 新增：完成 5 秒后自动折叠进「已完成」组

- 为避免视觉干扰：记录完成后仍在主表**停留 5 秒**（能看清状态翻转与结果），随后自动折叠
  进下方的「已完成 (N)」组；运行中 / 停止中的记录继续固定在主表顶部。
- 「已完成」组默认**收起**，点击标题展开/收起（状态记在 localStorage）；主表与已完成组
  内部都按开始时间倒序（新命令在上）。
- 主表为空但已完成组非空时，主表显示"当前没有运行中的命令"，不再误显示"暂无记录"。
- 纯逻辑 `partitionRecords(records, now, lingerMs)` / `recordDoneAt()`（client/order.js），
  新增 9 个用例：三段分组、**4999ms 留主表 / 5000ms 进已完成**的边界、组内倒序、
  缺 `finishedAt` 的终态记录直接归档（不会一直占主表）、时钟偏差、自定义停留时长、
  不改入参、空/非法输入。
- 面板加了一个 1 秒时钟：空闲时轮询不触发重渲染，靠它让"到期折叠"准时发生。

验证：`npm test` **213 用例全过**（rewrite 108 + jobsync 32 + session 25 + order 20 + 宿主集成 28）。

## 0.5.8

### 新增：运行中的记录置顶

- 面板列表把**运行中 / 停止中**的记录固定在最上方，其余仍按开始时间倒序（新命令在上）。
- 前台命令（工具记录）与后台任务（任务记录）一视同仁 —— 两者都可能正在跑。
- 纯逻辑抽到 `client/order.js`（`sortRecords()` / `isLiveRecord()`），新增 `test-order.mjs`
  11 个用例：置顶（即使开始最早）、同类内倒序、`stopping` 归属置顶区、
  `failed`/`killed`/`unknown` 不置顶、稳定排序、不改入参、空/非法输入。

验证：`npm test` **204 用例全过**（rewrite 108 + jobsync 32 + session 25 + order 11 + 宿主集成 28）。

## 0.5.7

### 修复：脚本块内插 Tee → 同一日志被两个 Tee 同时打开（真机报错）

- 现象：`$show = { $r.records | Where-Object { … } }` 这类脚本块定义 + 后面 `& $show | …`
  的命令，插件把 Tee 插进了脚本块**内部**，外层语句尾部又插了一个指向同一日志的 Tee →
  两个 Tee 同时打开同一文件，`Tee-Object` 报
  `The process cannot access the file … because it is being used by another process`；
  且脚本块只在被调用时执行，"最左的 Tee 建文件"顺序失效（`-Append` 先于建文件执行）。
- 修复：**跳过落在 `{}` 内部的插入点**（脚本块/函数体），只在外层语句上插；块内管道由
  该语句尾部的 Tee 覆盖（当该语句可安全接管道时）。
- 顺带修掉两个语句边界误判（均为真机暴露）：
  - `… | Out-Null`、`Write-Output` 这类**命令名自带连字符**的行尾被误判为续行参数 →
    换行不算语句边界；改为要求 `-` 前必须是空白；
  - 下一行以 `&` 开头（PowerShell 调用运算符，如 `& $show`）被误判为 bash `&&` 续行；
    改为只有成对 `&&` 才算续行。
- 删除冗余护栏 `tailUnsafe`：`canTailTee` 已覆盖 `}`/`;`/控制流，而它曾误伤
  `1..4 | ForEach-Object { … }`（有顶层管道、本可安全接 Tee）。

验证：真实 PowerShell 对照 **33 个用例**（新增 8 个回归：脚本块定义+调用、块内收集管道、
函数体含过滤器、行尾命令名、调用运算符开头等）：**stdout 与 exit code 逐例一致**。
`npm test` **193 用例全过**（rewrite 108 + jobsync 32 + session 25 + 宿主集成 28）。

## 0.5.6

### 优化：行上只剩类型徽标（「实时」「改」收掉）

- 每行原本最多挂 4 个徽标（`工具/任务`、`实时`、`改`、`⚠`），现在只保留
  `工具/任务`（区分工具记录与任务记录）与 `⚠`（只在真问题时出现）。
- 「已包装 Tee」「实时捕获」的信息改由**悬停提示**（原始命令 + 例行说明）与
  **展开行的一行灰字**承载，不再占用行内空间。

验证：`npm test` 187 用例全过（rewrite 102 + jobsync 32 + session 25 + 宿主集成 28）。

## 0.5.5

### 新增：切换会话时面板随之刷新（显示隔离）+ 切回恢复

- 现象：面板按会话增量累积记录（客户端 Map），切换会话后旧会话的命令仍留在面板里，
  和新会话的内容混着显示。
- 修复：会话切换时**清空累积记录并归零游标**（新增纯逻辑 `sessionSwitchReset()`），
  随即用 `since=0` 重新拉取新会话的**全部**历史记录，并**立即**刷新（不再等下一个
  轮询周期）。宿主按会话保留记录，所以**切回原会话仍能看到该会话的命令**。
- 竞态：切换瞬间在途的旧会话请求返回后直接丢弃，避免旧记录混进刚清空的面板。
- 面板标题的悬停提示写明当前会话 id，便于确认隔离是否生效；同一会话重复轮询不清空
  （只在会话真正变化时重置）。

验证：`npm test` 187 用例全过（rewrite 102 + jobsync 32 + session 25 + 宿主集成 28）。

## 0.5.4

### 新增：多行命令也能实时显示（按行拆语句）+ 部分覆盖时完成补全

- 背景：此前多行命令一律不包装（`if (command.includes('\n')) return null`），面板只能
  "完成后显示"，记录里会留一句"检测到 N 处阻断段，但未包装（多行命令）"。
- 现在把**顶层换行**与 `;` 一起当作语句边界，逐条在尾部插 Tee。换行是不是边界严格按
  PowerShell / bash 的续行规则判定（拿不准就当续行 = 不拆，宁可少包不可改坏）：
  - 行尾是 `|` `,` `=` `+` `-` `*` `/` `%` `&` 反引号 `\` 等 → 续行；
  - 行尾是孤立参数/运算符（`-and`、`-Pattern`）→ 续行；
  - 下一行以 `|` `&` `,` `)` 开头（PS7 支持前置管道）→ 续行；
  - 空行、引号内、here-string 内、注释内、括号/花括号内 → 不是边界。
- 行尾注释：Tee 插在 `#` **之前**；纯注释行不插（否则"建文件"会被浪费在注释上）。
- 语句块（`if`/`foreach`/`while`/`try`/`function` 等以 `}` 收尾）与赋值语句仍然跳过
  —— 它们接管道要么语法错误，要么改变作用域/语义。
- **部分覆盖补全**：包装只覆盖部分语句时（如块内输出进不了日志），记录标记 `partial`，
  并在**完成时用完整工具结果替换**面板输出，保证最终看到全部输出；全覆盖时保持"只显示
  Tee 内容"，不重复追加。赋值/注释/控制流等本来没有 stdout 的语句不算漏。
- 未包装时的面板提示改成一行说明（`检测到 N 处阻断段，但未包装（原因），输出完成后才显示`），
  且不再挂 ⚠。

验证：真实 PowerShell 逐例对比"原始命令 vs 包装后命令"（**25 个用例**，含 17 个多行场景：
here-string、反引号续行、行尾/前置管道、行尾注释、纯注释行、`if`/`foreach`/`while`/`try`/
`function`、多行收集管道、stderr 等）：**stdout 与 exit code 逐例完全一致**。`npm test`
**183 用例全过**（rewrite 102 + jobsync 32 + session 21 + 宿主集成 28）。

## 0.5.3

### 优化：面板视觉噪声 —— 例行说明不再挂 ⚠

- 现象：前台命令总会被包装，而"已插入 Tee 实时输出（日志：<长路径>…）"也塞进了
  `warnings`，于是 70 条记录里 23 条挂 ⚠；多行脚本的 `Where-Object` 匹配文本还带换行，
  展开行被撑成一大坨。
- 修复：
  - 例行说明（已插入 Tee / 已注入 `PYTHONUNBUFFERED` / 未包装时"完成后显示"）改走
    新字段 `notes`：**不挂 ⚠**，只在展开行显示**一行灰字**（超长省略号截断，完整内容
    在悬停提示里）；面板行上只剩 `工具/任务`、`改`（已包装）、`实时`（运行中）这几个紧凑徽标。
  - `warnings` 只保留真正需要留意的问题：包装失败、净化失败、检测到阻断段但未能包装。
  - 警示里的匹配片段压平换行并截断到 48 字符；同一语句内重复出现的同类管道只保留一条。

### 修复：前台多语句命令只捕获最后一条语句 → 面板少显示

- 根因：尾部追加策略只把 Tee 贴到整条命令的**最后一个语句**，于是
  `1..8 | % { …逐秒输出… }; Write-Output 'FG-DONE'` 的 Tee 日志里只有 `FG-DONE`
  （实测 9 字节），面板看着像"命令什么也没输出"。工具结果本身不受影响，但面板误导。
- 修复：按**顶层** `;`（引号内、括号/花括号内的不算）拆语句，逐条在尾部插 Tee
  （首条建文件、其余 `-Append`）；语句内已有收集/消耗段的仍走"插在段之前"。
  以下语句跳过，保证语义零改变：
  - 赋值 / `export`（`$env:A='1' | Tee` 会把值打进 stdout；bash `export A=1 | tee`
    会让赋值只在子 shell 生效）；
  - 控制流 `exit/return/break/continue/throw`；
  - 以语句块 `}` 收尾的（`if`/`foreach` 接管道是语法错误，实测确认；而
    `… | ForEach-Object { … }` 这种**管道里的脚本块参数**可以接，按顶层 `|` 区分）。
- 后台任务不受影响：无收集/消耗段时仍交给 jobs 通道（不引入日志文件）；
  已有插入型 Tee 时其余语句一并补齐，避免混合语句漏输出。

验证：真实 PowerShell 逐例对比"原始命令 vs 包装后命令"（8 个用例，含实测事故用例、
赋值、`if`/`for` 语句块、收集管道、引号内分号、`exit` 收尾）：**stdout 与 exit code
逐例完全一致**，Tee 日志覆盖全部语句输出。`npm test` **157 用例全过**
（rewrite 81 + jobsync 32 + session 21 + 宿主集成 23）。

## 0.5.2

### 修复：跨会话命令串进本会话面板 + 后台任务读不到输出 / 卡「运行中」/ Tee 日志不清理

按"跨会话命令不进本会话面板，本会话的前台命令与后台任务都要显示"的语义收口。

**会话隔离（前端）**

- 根因：`shell.overlay` 是 **root scope** 槽位（框架 `renderSlot("shell.overlay", {})`
  不传会话 share），挂在右侧栏的面板拿不到 `sessionId`，请求于是不带 `session` 参数，
  宿主把**全部会话**的记录回给了它 —— 别的会话的命令就串进了本会话面板。
  而 `conversation.input.dock` / `conversation.composer.dock` 是 `scope: "session"`，
  这几个实例能从 props 直接拿到会话标识。
- 修复：会话级实例把会话标识交给模块级 relay（`client/session.js`），root scope 的
  侧栏实例订阅它；**拿不到会话标识时不发请求**（显示"等待会话标识"），宁可空着也不串会话。
- 宿主侧的 `/cmdmon/snapshot` 同步收紧：不带 `session` 参数时**不返回任何有会话归属的
  记录**（此前等于"返回全部"），排查需要全量时显式带 `all=1`。
- `/cmdmon/clear` 同样收紧：不带参数**什么都不清**（此前无 body 被当成"全清"），
  指定 `{ session }` 才清该会话，`{ all: true }` 才全清；顺带修掉客户端「清空」按钮
  引用已不存在变量、点击即抛 `ReferenceError` 的问题。
- 本会话内部不受影响：工具记录（前台命令）与任务记录（后台任务）照常按会话展示。

**后台任务读取（宿主）**

- **根因一（决定性）**：`dsh-jobs-local` 的隔离判定是 `job.owner.id !== caller` ——
  **caller 是会话 id 字符串**，官方工具也传 `exec.agent?.id`；插件一直传 Agent **对象**，
  于是 `jobs.read` / `jobs.get` 必然抛 "belongs to another session"。表现就是实测到的：
  任务能看到、`ownerRegistered=true`、但输出一条读不到、状态永远 `running`、Tee 日志残留。
  （0.1.1 那次"改用各 job 自身 owner"的修复因此从未真正生效。）
- **根因二**：真实 `jobs.read()` 返回 `{ chunks, lossy, result?, job }`，插件按
  `{ text, snapshot }` 读取 → `read.text` 恒为 undefined，**即使 caller 正确也拿不到输出**。
- **根因三**：`syncJob()` 无条件覆写 owner 登记，跨会话事件会把别的会话的 caller 顶上来。
- 修复：
  - 新增纯逻辑模块 `lib/jobsync.js`：caller 统一取**会话 id 字符串**（`callerId()`），
    owner 登记分权威/兜底（只有 `tools/result` 的 `exec.agent` 可覆盖，兜底只补空缺）；
  - `renderJobRead()` / `jobViewOf()`：按官方规则渲染 `chunks`（stdout 顺序拼接、stderr 归并
    `[stderr]` 段、`log` 旁白不进正文），同时兼容旧形状 `{ text, snapshot }`；
    结算结果 `result` 只补一次；`isTerminalJobStatus()` 统一终止判定；
  - 读取被拒后标记 `readDenied` 并停止重试（诊断只记一次）；任务已不在任务库时按 `unknown`
    收尾并清理 Tee 日志；`trim()` 丢弃记录前收尾 Tee 日志与 owner 登记；
    `/cmdmon/clear` 同步清理登记表；`snapshot` 增加 `readDenied` 诊断字段。
- 假宿主集成测试同步改为**忠实模拟真实契约**（caller 是会话 id 字符串、`list` 按 caller 过滤、
  `read` 返回 `{ chunks, job }`、视图字段为 `owner`），这类 API 错配因此能被测试挡住。

验证：`npm test` 132 用例全过（rewrite 58 + jobsync 32 + session 21 + 宿主集成 21）。

## 0.5.1

### 新增：`pwsh_stream` 工具 —— 前台命令也能实时（绕开 0.2.x 的改写限制）

DSH 0.2.x 明确排除输入改写（`Input rewriting is excluded because arguments are already
logged`），插件赖以工作的 Tee 注入因此失效 —— 前台命令只剩"完成后显示"，没有实时输出。

新增工具 `pwsh_stream`：命令由它执行时输出写进 `ctx.jobs` 的输出环，面板既有的
「任务行」实时通道天然生效，**无需改写命令、无需改客户端**。

- 注册：`ctx.tools.register(defineTool({ … }))`（与官方 `dsh-tool-bash` 同款写法）
- 呈现：`presentCall/presentResult` 声明为 `terminal` 卡片
- 取消：转发 `exec.signal` 到子进程，并实现 `JobHooks.cancel`
- 整段注册防御性包裹：作用域/服务不满足时只跳过，绝不影响既有功能

## 0.5.0

### 兼容 DSH 0.2.x（jobs 事件接口变更）+ 面板位置去掉「顶部」

- **适配 `@deepseek-ai/dsh-jobs` 0.2.x**：该版本把 jobs 重构成抽象 `JobRegistry`，
  移除了 `onJobsChanged` / `onJobDone` 事件订阅（改走 `JobEvents`），`snapshot` 也一并消失。
  插件在初始化时调用这两个方法会抛 `TypeError`，使**整个宿主半挂不上** ——
  现象正是"面板可见，却一条记录都没有"。现在两者缺失时退化为空订阅，
  状态刷新继续走 0.4.4 起就有的 `jobs.get` 500ms 轮询兜底。
- `peerDependencies` 放宽为 `>=0.1.1-rc.2 <0.3.0`（同时容纳 0.1.x 与 0.2.x）。
- **面板位置只保留「底部 / 右侧」**：桌面端顶部已有其他 UI，面板停靠顶部会与其打架。
  已记住 `top` 的浏览器会平滑落到「底部」；不再向 `conversation.input.dock` 注入实例。
## 0.4.15

### 修复：引号内的 `>` / `|` 被误判为管道/重定向，Tee 被插进引号内部改坏命令

**症状**（实测事故）：

```powershell
git log -5 --format='%an <%ae>'
```

被改写成

```powershell
git log -5 --format='%an <| Tee-Object -FilePath '...' ...>'
```

Tee 落进了**单引号内部**：git 收到的 format 串变成 `%an <%ae | Tee-Object ... >`，
输出被污染（每条提交的作者邮箱后面都跟着一段 Tee 命令行），命令语义被改变 ——
与"工具结果零改变"的设计承诺相反。

**根因**：所有管道/重定向正则都直接跑在整条命令字符串上，不区分引号内外。
`| Select-Object` 之类靠"`|` 后必须跟特定命令名"侥幸躲过大部分误判，但重定向正则
`/(?<![\d&])\s*>{1,2}(?!>)\s*/g` 匹配**任意** `>` —— 引号里的 `>`（提交信息、
`--format`、`-c "a > b"`）全部中招。

**修复**：新增 `quotedRanges()` 计算引号内部区间，检测与插入点定位都跳过这些区间。
覆盖单引号 / 双引号 / 反引号 / pwsh here-string（`@'...'@`、`@"..."@`），
处理 pwsh `''` 双写转义、双引号内反引号转义、bash 反斜杠转义；未闭合引号保守视为引号内
（宁可少包装，不可改坏命令）。`quotedRanges` 已导出，便于单测与复用。

**未误伤真重定向**：`git log --format='%an <%ae>' > out.txt` 仍会在引号外的 `>` 前插 Tee。

验证：`npm test` 58 用例全过（原有 43 + 新增 15）。

> 注：0.4.9–0.4.14 的改动只在 commit message 里记了版本号，未补 CHANGELOG 与
> package.json 的 `version`（仍为 0.4.8）。

## 0.4.8 (2026-08-31)

### 新增：格式/转换/拼接/统计型管道 + bash |& 支持 + 尾部护栏放宽

系统性盘点"会吞掉/阻断输出"的管道类型后补齐：

- **格式型**：`Format-Table/Format-List/Format-Wide/Format-Custom`（需收集全部
  输出计算布局）→ Tee 插在它之前
- **转换型**：`ConvertTo-Json/ConvertTo-Html/ConvertTo-Xml`（需收集全部构建）
- **拼接型**：`Out-String`（拼全部输入为字符串）
- **统计型**：bash `wc`（需收集全部计数）
- **bash `|&` 管道**：所有段正则支持 `|&`（合并 stderr 的管道语法）
- **尾部护栏放宽**：`;`/`}`/`exit` 收尾只在"尾部追加 Tee"时阻止；命令中已有
  收集/过滤等段时走"插入型"包装，尾部原样保留
- 验证：`npm test` 43 用例全过

### 已知限制（不包装，但属命令形态本身特性）

- 多行命令（含 `\n`）：尾部拼接风险高，跳过包装（后台无段时 jobs 通道仍可流式）
- `Write-Host`/`Out-Host`：写控制台而非管道，工具结果本来就不含，面板无从显示
- `ForEach-Object` 变换：流式透传不阻塞，jobs 通道可见；不额外包装

## 0.4.7 (2026-08-31)

### 修复：过滤管道（Select-String/grep/Where-Object）吞掉输出 → 无进度

`pytest ... 2>&1 | Select-String -Pattern "SKIPPED|skipped" | Select-Object -First 12`
这类命令：`Select-String` 只放行匹配行，pytest 进度点全被丢弃，job stdout 为空，
面板无进度（实测 job 记录 out=0）。修复：

- 新增**过滤型管道**段（`Select-String`/`findstr`/`grep`/`egrep`/`fgrep`/
  `Where-Object`）和**提前终止型**段（`Select-Object -First N`/`head -n N`）
  纳入 Tee 插入点——Tee 插在过滤/终止器**之前**捕获全量输出，过滤器与
  `-First` 照常工作、工具结果不变
- 面板警示同步覆盖过滤型管道
- 验证：`npm test` 37 用例全过（新增 Select-String/Where-Object/-First/grep 用例）

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
