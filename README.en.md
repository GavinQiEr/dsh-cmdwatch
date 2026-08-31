# dsh-cmdwatch — Command Window

Real-time visibility into the commands dsh launches and their output, so you
can watch foreground and background execution progress without pausing the
conversation to ask dsh about it.

[中文](README.md) | [English](README.en.md)

**DSH Target**: `>=0.1.0-rc.6 <0.2.0` (verified on 0.1.1-rc.2)

> DSH is currently in developer preview; the official docs state that
> breaking changes are expected. The compatibility range and version tracking
> for this plugin live in `CHANGELOG.md`.

## Install

### One-command install (recommended)

```powershell
dsh plugin --profile web add github:GavinQiEr/dsh-cmdwatch
```

> If `dsh` is not on your PATH, use `npx '@deepseek-ai/dsh' plugin --profile web add ...` instead.

After installing, restart the web profile (`dsh web`); a "命令监视" panel
appears above the composer.

### Alternative installs

| Method | Command |
| --- | --- |
| npm package | `dsh plugin --profile web add dsh-cmdwatch` |
| git repo (full URL) | `dsh plugin --profile web add https://github.com/GavinQiEr/dsh-cmdwatch.git` |
| specific branch/commit | `dsh plugin --profile web add github:GavinQiEr/dsh-cmdwatch#main` |
| local directory (dev) | `dsh plugin --profile web add /path/to/dsh-cmdwatch` |
| packed tarball | `dsh plugin --profile web add ./dsh-cmdwatch-0.3.0.tgz` |

> The npm method requires `npm publish` first (see Build below); until then use
> the git / local directory / tarball methods.

## Features

- **Background jobs** (`run_in_background: true`): **live progress stream** — the
  command line, progress, status and timestamps scroll in line by line; click a
  row to expand the full output.
- **Foreground commands** (pwsh/bash and other tool calls): the command appears
  in the panel the moment it is issued (blinking blue dot while running) and
  shows its full output when it completes.
- **Per-session isolation**: each session's panel shows only its own commands;
  different sessions never share content.
- **Live stream**: enabled by default — the plugin polls background job output
  deltas every 500ms and pushes them to the panel.
- **Auto-scroll**: the output area scrolls to the newest line automatically, so
  focus always stays on the latest output.
- **Long-command shortening**: whitespace is flattened, long commands are shown
  as first 60% + … + last 40%; hover for the full text.
- **Command sanitizing**: when dsh issues a background command with a buffering
  pipeline (`| Select-Object -Last N`, `| tail -n N`, …) that would block live
  progress, the plugin strips it and injects `PYTHONUNBUFFERED` before dispatch;
  the panel shows a `改` (rewritten) badge with the original command, and a yellow
  `⚠` badge for patterns that are only warned about (`-First` / `head`).

## Foreground vs background: which to use

| Execution mode | Live progress | Notes |
| --- | --- | --- |
| **Background job** `run_in_background: true` | ✅ streaming | Uses the official `jobs` channel; the plugin polls every 500ms. **Recommended for long commands (pytest, builds, scripts)** |
| **Foreground command** (default) | ❌ shown on completion | Intermediate output stays inside the shell process and cannot be streamed by the framework; the full result still appears when done |

**To watch progress live (e.g. pytest), always use a background job**:

```powershell
# Ask dsh to run with run_in_background: true — the panel streams pytest output live
python -m pytest tests/... -q
```

> ⚠️ Since 0.3.0 the plugin strips collecting pipelines (`| Select-Object -Last N`
> / `| tail -n N`) and injects `PYTHONUNBUFFERED` for background commands, so live
> progress is no longer blocked by them; rewritten rows carry a `改` badge (hover /
> expand to see the original). To disable rewriting, set `rewrite: false` in the
> bundle config (warnings only).

## Configuration

| Key | Default | Description |
| --- | --- | --- |
| `rewrite` | `true` | Strip collecting pipelines from background commands |
| `pythonUnbuffered` | `true` | Inject `PYTHONUNBUFFERED` when python is detected |
| `warn` | `true` | Show panel warnings for collecting/terminating pipelines |

## Build (developers)

```sh
npm install
npm run build:client   # esbuild bundles client/index.jsx → client/client.js
npm pack               # produces dsh-cmdwatch-0.3.0.tgz
```

Publish to npm (optional, helps discovery and installation):

```sh
npm login
npm publish            # publishes dsh-cmdwatch
```

## Notes

- While "live stream" is on, the plugin consumes the background job's output
  deltas, so dsh's own `job_output` tool will read empty increments
  (`(no new output)`). This is a deliberate trade-off: the plugin watches the
  output for you, so you don't have to pause the conversation to have dsh
  check progress. If you need dsh to read the output itself, turn off the
  live-stream switch in the panel first.
- Records live in host-process memory and are cleared on restart (this is a
  live monitor, not a persistent log).
- Command sanitizing rewrites only **background** commands
  (`run_in_background: true`), at the `tools/execute` stage after the
  `tools/pre-execute` permission gate — it only strips the buffering pipeline
  tail and injects an environment variable, never changing the program or its
  arguments; foreground commands are untouched.

## License

MIT
