# dsh-cmdwatch — Command Window

Real-time visibility into the commands dsh launches and their output, so you
can watch foreground and background execution progress without pausing the
conversation to ask dsh about it.

[中文](README.md) | [English](README.en.md)

## One-command install

```powershell
dsh plugin --profile web add github:GavinQiEr/dsh-cmdwatch
```

**DSH Target**: `>=0.1.0-rc.6 <0.2.0` (verified on 0.1.1-rc.2)

> DSH is currently in developer preview; the official docs state that
> breaking changes are expected. The compatibility range and version tracking
> for this plugin live in `CHANGELOG.md`.

## Features

- **Foreground commands** (pwsh/bash and other tool calls): the command appears
  in the panel the moment it is issued (blinking blue dot while running) and
  shows its output when it completes.
- **Background jobs** (`run_in_background: true`): live command line, status,
  and timestamps; click a row to expand the full output.
- **Live stream**: enabled by default — the plugin polls background job output
  deltas every 500ms and pushes them to the panel.
- **Auto-scroll**: the output area scrolls to the newest line automatically, so
  focus always stays on the latest output.
- **Long-command shortening**: whitespace is flattened, long commands are shown
  as first 60% + … + last 40%; hover for the full text.

After installing, restart the web profile (`dsh web`); a "命令监视" panel
appears above the composer.

## Alternative installs

```powershell
# From a local directory (development)
dsh plugin --profile web add /path/to/dsh-cmdwatch

# From a packed tarball
dsh plugin --profile web add ./dsh-cmdwatch-0.1.0.tgz
```

## Build (developers)

```sh
npm install
npm run build:client   # esbuild bundles client/index.jsx → client/client.js
npm pack               # produces dsh-cmdwatch-0.1.0.tgz
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

## License

MIT
