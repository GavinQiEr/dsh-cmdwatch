# dsh-cmdwatch 命令窗

实时显示 dsh 发起的命令内容与执行输出，无需暂停对话即可查看前后台执行进度。

[中文](README.md) | [English](README.en.md)

**DSH Target**：`>=0.1.0-rc.6 <0.2.0`（已在 0.1.1-rc.2 验证）

> DSH 目前处于 developer preview，官方明示会有破坏性变更（breaking changes）。
> 本插件兼容区间与版本跟进记录见 `CHANGELOG.md`。

## 安装

### 一键安装（推荐）

```powershell
dsh plugin --profile web add github:GavinQiEr/dsh-cmdwatch
```

> `dsh` 不在 PATH 时，用 `npx '@deepseek-ai/dsh' plugin --profile web add ...` 代替。

安装后重启 web profile（`dsh web`），输入框上方会出现「命令监视」面板。

### 备选安装方式

| 方式 | 命令 |
| --- | --- |
| npm 包 | `dsh plugin --profile web add dsh-cmdwatch` |
| git 仓库（完整 URL） | `dsh plugin --profile web add https://github.com/GavinQiEr/dsh-cmdwatch.git` |
| 指定分支/提交 | `dsh plugin --profile web add github:GavinQiEr/dsh-cmdwatch#main` |
| 本地目录（开发调试） | `dsh plugin --profile web add /path/to/dsh-cmdwatch` |
| tarball 打包 | `dsh plugin --profile web add ./dsh-cmdwatch-0.3.2.tgz` |

> npm 方式需先 `npm publish`（见下方构建说明）；未发布前请用 git / 本地目录 / tarball 方式。

## 功能

- **后台任务**（`run_in_background: true`）：**实时进度流**——命令行、进度、状态、时间逐行滚动，点击展开完整输出
- **前台命令**（pwsh/bash 等工具调用）：命令一发出即在面板出现，**执行中同样实时滚动**（插件自动插入
  `Tee`/`tee` 把输出落盘后轮询；带 `Select-Object -Last` 等管道时 Tee 插在管道**之前**，工具结果语义不变）
- **会话隔离**：面板只显示**本会话**的命令（前台命令 + 后台任务），别的会话的命令
  一律不进这个面板——右侧栏所在的 `shell.overlay` 是 root scope 槽位、框架不传会话
  标识，面板因此从会话级槽位实例接力获取会话标识；拿不到标识时保持为空，绝不退化成
  "显示全部会话"。**切换会话时面板立即清空并刷新为当前会话的内容**，切回去仍能看到
  该会话的命令（宿主按会话保留记录，重新以 `since=0` 拉取）。
- **实时流**：默认开启，插件每 500ms 主动读取后台任务输出增量并推送到面板
- **运行中置顶**：正在运行/停止中的记录固定在最上方，其余按开始时间倒序（新命令在上）
- **自动滚动**：输出区自动滚到最新一行，焦点始终停在最新输出
- **长命令缩短**：压平换行、前 60% + … + 尾部 40%，悬停查看全文
- **命令净化**：dsh 自主拼出的命令若带收集型管道（`| Select-Object -Last N`、
  `| tail -n N`）或输出重定向（`| Out-File`、`>`）等阻断实时流的段，插件自动
  插入 `Tee-Object`/`tee`（插在**最早**的此类段之前）并注入 `PYTHONUNBUFFERED`，
  面板实时显示全量进度、**原管道语义完全保留**（`-Last N` 仍只回最后 N 行、
  `Out-File` 照常写文件）；行上只保留 `工具/任务` 类型徽标，**黄色 `⚠` 只在真正的问题**
  （包装失败、检测到阻断段却无法安全插 Tee 等）时出现；"已包装 Tee""实时捕获""已注入
  环境变量"等例行说明在**悬停提示**与展开行的**一行灰字**里呈现，不再占用行内空间

## 前台 vs 后台：怎么选

| 执行方式 | 实时进度 | 说明 |
| --- | --- | --- |
| **后台任务** `run_in_background: true` | ✅ 实时滚动 | 无收集/重定向段时走 `jobs` 官方通道抢读；有此类段时插件插 Tee 落盘并轮询文件，**长命令（pytest、构建、脚本）推荐** |
| **前台命令**（默认） | ✅ 实时滚动（Tee 捕获） | 插件插入 `Tee-Object`/`tee` 落盘并轮询，输出实时显示；Tee 插在收集/重定向段之前，**工具结果保持原样**（如 `-Last 3` 仍只回最后 3 行） |

**要实时看进度（如 pytest），两种方式都可以**：

```powershell
# 前台（默认）：插件自动插 Tee，面板实时滚动，dsh 拿到的结果不变
python -m pytest tests/... -q
```

> ⚠️ 插件会在命令执行前自动插入 `Tee-Object`/`tee`（pwsh/bash），输出落盘到
> 工作区/临时目录的 `.cmdmon-<callId>.log`，插件轮询该文件实现实时显示；命令
> 完成后自动删除日志。Tee 插在**最早的收集型/输出重定向段之前**——面板看到全量
> 渐进输出，而 dsh 的原管道（`-Last`、`Out-File`、`Get-Content` 等）原样保留、
> 工具结果零改变。多语句/多行命令按**顶层语句（`;` 或换行）逐条**覆盖——不会出现"只有
> 最后一条语句的输出进面板"；换行是否算语句边界按 PowerShell/bash 续行规则判定（行尾
> `|`、`,`、反引号等视为续行）。赋值/`export`、控制流（`exit`/`return`…）、`if`/`foreach`
> 等语句块会被跳过（接了会改变语义或直接语法错误）；这类"部分覆盖"的调用会在完成时用
> 完整工具结果补全面板输出。是否被包装/是否实时捕获，看**悬停提示**（含原始命令）与展开行
> 的一行灰字；行上不再挂「改」「实时」徽标。若不想让插件包装命令，可设 `rewrite: false`
> （后台）或 `foregroundStream: false`（前台，回退到"完成后显示"）。

## 配置

| 配置项 | 默认 | 说明 |
| --- | --- | --- |
| `rewrite` | `true` | 后台命令存在收集/重定向段时插入 Tee 实时输出 |
| `pythonUnbuffered` | `true` | 命中 python 时注入 `PYTHONUNBUFFERED`（避免块缓冲） |
| `foregroundStream` | `true` | 前台命令插入 Tee 落盘并实时显示 |
| `warn` | `true` | 面板警示收集型/重定向/提前终止型管道 |
| `debug` | `false` | 向宿主终端输出 `[cmdmon]` 诊断日志（排查用） |

在 cordis.patch.yml 的插件行加 `config` 即可：

```yaml
- insert:
    - id: dsh-cmdwatch
      name: dsh-cmdwatch
      config:
        rewrite: false   # 例：只警示，不自动改写
```

## 构建（开发者）

```sh
npm install
npm run build:client   # esbuild 打包 client/index.jsx → client/client.js
npm test               # 单测 + 宿主集成测试（204 用例：命令净化 108 / owner 登记 32 / 会话隔离 25 / 面板排序 11 / 宿主时序 28）
npm pack               # 产出 dsh-cmdwatch-0.5.8.tgz
```

发布到 npm（可选，便于收录与安装）：

```sh
npm login
npm publish            # 发布 dsh-cmdwatch
```

## 注意事项

- 「实时流」开启时，后台任务的输出增量会被插件消费，dsh 模型的 `job_output`
  工具将读到空增量（`(no new output)`）——这是设计取舍：插件替你盯着输出，
  无需暂停对话让 dsh 查进度。需要 dsh 亲自读输出时，先关掉面板上的「实时流」。
- 记录保存在宿主进程内存中，进程重启后清空（动态监控场景，非持久化日志）。
- 命令净化在 `tools/execute` 阶段、权限检查（`tools/pre-execute`）之后改写命令
  ——只**插入 Tee 管道**（落盘日志）并注入环境变量，不改变运行的程序、参数与
  原管道语义（`-Last`、`Out-File`、`Get-Content` 等工具结果不变）。
- **后台任务会显示两条记录**：带「工具」类型徽标的工具调用行（输出只有
  `started background job ...`）与带「任务」类型徽标的任务行——**实时输出只进
  任务行**（无管道时走 jobs 通道、有管道时走 Tee 日志），展开任务行查看。前台
  命令只有一条工具记录，执行中实时输出就在该行，完成后日志文件自动删除。
- 排查实时流问题时，开 `debug: true` 看宿主终端 `[cmdmon]` 日志，或用
  `/cmdmon/snapshot?all=1` 读 `diagEvents`（面板用的请求一律带 `session=<id>`，不带
  `session` 时端点只返回无会话归属的记录，避免串会话）；面板展开行也会给出诊断提示。
- 会话隔离的两条硬约束（宿主侧强制）：`/cmdmon/snapshot` 不带 `session` 时不返回任何
  有会话归属的记录（`all=1` 仅供排查）；`/cmdmon/clear` 不带参数时什么都不清，必须显式
  `{ session }` 或 `{ all: true }`。

## License

MIT
