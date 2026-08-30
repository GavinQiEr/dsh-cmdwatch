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
| tarball 打包 | `dsh plugin --profile web add ./dsh-cmdwatch-0.2.0.tgz` |

> npm 方式需先 `npm publish`（见下方构建说明）；未发布前请用 git / 本地目录 / tarball 方式。

## 功能

- **前台命令**（pwsh/bash 等工具调用）：命令一发出即在面板出现（运行中蓝点闪烁），完成后显示输出
- **后台任务**（`run_in_background: true`）：实时显示命令行、状态、时间，点击展开完整输出
- **实时流**：默认开启，插件每 500ms 主动读取后台任务输出增量并推送到面板
- **自动滚动**：输出区自动滚到最新一行，焦点始终停在最新输出
- **长命令缩短**：压平换行、前 60% + … + 尾部 40%，悬停查看全文

## 构建（开发者）

```sh
npm install
npm run build:client   # esbuild 打包 client/index.jsx → client/client.js
npm pack               # 产出 dsh-cmdwatch-0.2.0.tgz
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

## License

MIT
