# Recording hooks and capture spike

Notes for ticket M0-T04: what the dev-only recording hooks write, and the answers to the three capture questions the oracle design left untested. Measured on Electron 44.7.0 (Chrome 152), unpackaged and as `dist\win-unpacked`.

## The hooks

`ONELAUNCH_ORACLE_TRACE=1` makes the app append one JSON line per event to `<dataDir>\oracle-trace.jsonl`. It is read once, in `src/main/index.ts`, and only counts when all of these hold:

- the build is unpackaged;
- the run is on fake launchers (`ONELAUNCH_FAKE_LAUNCHERS` resolved to a folder);
- the data folder came from `--data-dir=` or `ONELAUNCH_DATA_DIR`, never the default one.

Otherwise nothing is installed: the hook slots stay `null` or absent and each call site is one optional call.

| Hook | Where | Set by |
| --- | --- | --- |
| `FakeReport.onEvent`, `emit`, `job`, `fileWrite` | `src/main/launchers/sim/report.ts` | `index.ts` under the gate; a harness sets `onEvent` itself |
| `atomicWrites.observer` | `src/main/services/backup.ts`, in `writeFilesAtomic` after each rename | `index.ts` under the gate |
| `trace` dependency of `LaunchService` | `src/main/services/launch.ts`, at the end of `timeSteps` and in `onAttention` | `index.ts` under the gate |
| `ipcTrace.record` | `src/main/ipc/handle.ts`, after the envelope is built | `index.ts` under the gate |

`materializeScenario` now returns the platform with its `report`, which is how `index.ts` and a harness reach the one sequence counter.

Three things differ from the ticket's wording, each because the file it names is outside the write scope:

- The IPC recorder is a module-level slot (`ipcTrace`), not a `createRegistrar` option: the registrar is built in `src/main/ipc/index.ts`.
- The kill's tree flag comes from wrapping `processes.kill` in `scenario.ts`, the way `recordingRegistry` wraps the registry: the kill listener in `sim/processes.ts` is not told the flag. `fake-platform.json` is unchanged (`elevated.mjs` still passes on it).
- `finally` in `LaunchService.run` has no call of its own: it already calls `timeSteps`, which now ends with the trace call, so the final state is recorded once.

## Events

Every event has `seq` and `k`. `seq` starts at 0 on each app start and rises by one across all kinds.

| `k` | Fields |
| --- | --- |
| `ipc` | `channel`, `req` (absent when the call had none), `res` (the envelope) |
| `job` | `job` (the job id), `state`, `steps` as `[id, status, title, detail]`, `attention`, `switched`, `handOff`, `backupId`, `restored`, `error` |
| `plat` | `op`, then per op: |

| `op` | Fields |
| --- | --- |
| `proc.start` | `exe` (full path), `args` |
| `proc.close` | `exe` (image name), `args: ["<close>"]` |
| `proc.kill` | `exe` (image name), `args: []`, `tree` |
| `reg.set` | `path`, `value` (the literal `"binary"` for a binary value) |
| `reg.delete` | `path` |
| `file.write` | `path`, `sha256` of the bytes written |
| `shell.open`, `net.fetch` | `url` |
| `clip.write`, `clip.clear` | none: the text is never recorded |
| `login.set` | `openAtLogin` |
| `riot.launch` | `id` (`<product>.<patchline>`) |

What a consumer has to know:

- An `ipc` event is written when the answer is ready, so what the handler did comes before it (`clip.write`, then `accounts:copy`).
- The job a `launch:start` answer carries is its first state; the first `job` event is the first change after it.
- The UI asked `launch:status` 22 times across the four jobs of `play-all`; the trace has 68 `job` events for them.
- Two consecutive `job` events can be identical (6 in `play-all`): the adapter's last progress call, then the service setting the same steps once the switch settles.
- A Steam shutdown is a `proc.start` with `-shutdown`; `proc.close` is the close request the other three launchers get.
- `file.write` covers everything that goes through `writeFilesAtomic`: the adapters' launcher files and the backup service's `manifest.json`. Simulator writes do not appear.
- A raw trace holds the scratch paths (with the Windows user name) and generated ids. It is never bundle material before the normaliser has run over it.

## Redaction

Done in `handle.ts` before the recorder is called, so no recorder can see the value:

| Channel | Masked |
| --- | --- |
| `accounts:create`, `accounts:setPassword` | `req.password` |
| `vault:setSecret` | `req.value` |
| `vault:getSecret` | `res.data.value` |

- The field becomes `"<redacted>"` whether or not the request carried one, so the marker says nothing about what was sent; `hasSecret` in the answer does.
- A request on one of those three channels that is not a plain object (a bare string, a list) is masked whole.
- The mask is by channel and field. A secret typed into any other field (an account's notes, a setting) is recorded as typed, so capture scripts use placeholders only.

`redaction.spike.ts` plants a value in each of those places with no app running; `trace-run.mjs planted` does the same through the real preload and IPC, then searches every file of the data folder outside Chromium's profile for the planted values. Both ran before anything else was recorded. The first caught a list payload being spread into an object with its contents kept; that is fixed.

## Running

```powershell
$env:ORACLE_GENERATOR = 'scripts/oracle/spike/redaction.spike.ts'; npx vitest run --config scripts/oracle/vitest.config.ts
npx electron-vite build
node scripts/oracle/spike/trace-run.mjs planted
node scripts/oracle/spike/trace-run.mjs play-all --out=<a folder outside the repo>
node scripts/oracle/spike/trace-run.mjs play-all --untraced
node scripts/oracle/spike/cdp-probe.mjs
npm run build
node scripts/oracle/spike/trace-run.mjs packaged
node scripts/oracle/spike/cdp-probe.mjs --packaged
```

`trace-run.mjs <scenario>` takes any fake-launcher scenario in `scripts/scenarios/`. The packaged runs read this PC's real launchers, read-only, like `npm run smoke:packaged`; they print counts and role names, never page text.

## Question 1: do the layout-sidecar calls work with `devTools:false`?

Yes, both, unpackaged and packaged. `devTools:false` only removes the DevTools window; the page target reached through `--remote-debugging-port` answers every domain tried.

- `DOMSnapshot.captureSnapshot` with a `computedStyles` whitelist, `includePaintOrder` and `includeDOMRects` returns one document with bounds, paint order, and offset and client rects for every layout node, the whitelisted styles for all but one of them (182 of 183 on the fake library), and the text boxes.
- `Accessibility.getFullAXTree` returns roles and names, and every node with a `backendDOMNodeId` joins the snapshot's `nodes.backendNodeId`, with one exception: the two `DIV`s inside the search field's built-in shadow tree (one ignored, one `generic`), which the snapshot does not list. The `textbox` itself joins. The sidecar should drop AX nodes that do not join rather than fail on them.
- Also answered: `Emulation.setLocaleOverride`, `Emulation.setTimezoneOverride` (the page then reports `UTC`, `en-US`), `DOM.enable`, `CSS.enable`, `CSS.forcePseudoState`, `Animation.enable`.

## Question 2: does the browser target's `SystemInfo.getProcessInfo` return the app's PIDs?

Yes. On the page target the call is refused ("only supported on the browser target"), so it needs a second socket, to the `webSocketDebuggerUrl` that `http://127.0.0.1:<port>/json/version` returns; the driver itself needs no change (`browserCall` in `cdp-probe.mjs`).

- It returns one `browser` entry whose `id` is the process the driver spawned, and one entry each for the renderer, the GPU process and the network service. Windows' own parent ids, asked by process id, name the browser process as the parent of all three.
- Every entry has `cpuTime`. Memory is not in the answer; it has to be read per PID.
- No image name is needed at any point, so the owner's installed copy cannot be picked up.

## Question 3: where does the built `.ico` land?

`dist\.icon-ico\icon.ico`. electron-builder writes it on every `npm run build` from `build\icon.png` (`electron-builder.yml` names no icon and sets `buildResources: build`); it is the icon that tool gives the exe, which this spike did not read back out of the exe. It holds seven PNG-compressed images at 32 bits: 16, 24, 32, 48, 64, 128 and 256 pixels. There is no `.ico` in `build\` and none as a file under `dist\win-unpacked`. Whether two builds give the same bytes was not measured.

## What the replay-expectation schema does not fit

Checked by `trace-run.mjs` against the `event` definition, over `play-all` twice, `play-riot`, `elevated`, `handover`, `recovery` and the planted run.

Fits: every recorded event validates once the job id is aliased (`@job:n`); as recorded, the only failure is that id's pattern. All twelve `op` names match the pattern and every step is four strings. Two recordings of `play-all` gave the same 68 `job` events and the same interleaving of `job` and `plat` events after ids, timestamps and roots were masked, and the normaliser's root rules left no scratch path in the three traces they were run over (`play-all`, `elevated`, `handover`), including Steam's exe path, which comes back lower-cased.

Does not fit, or the schema is silent:

1. `seq` restarts at 0 on each app start. A script with a crash and a restart (`recovery`: three starts) gives three rising runs, and the verify script's "seq rises" check fails on them joined. The harness has to renumber or keep one list per start.
2. `file.write` of a backup's `manifest.json` has a `sha256` that differs between recordings: the manifest holds its creation time and absolute source paths. The schema allows only 64 hex characters there and the normaliser has no rule for a hash. Every launcher-file write hashed the same in both recordings. The harness's own observer gets the bytes, so it can hash a normalised projection; the app's trace cannot.
3. The same event's `path`, the `backupId` of a job event and the backup step's `detail` hold the snapshot id, which is timestamp-shaped. It needs its `@backup` alias inside strings before the `<ts>` rule sees it.
4. `ipc` events have no branch in the schema and no comparison rule in its description. They pass only because nothing beyond `seq` and `k` is required. Their count is poll-driven (`launch:status`: 22 in `play-all`, 139 in `handover`), so they cannot be compared in exact order.
5. `net.fetch` events are the artwork queue's background work. They landed at the same positions in both recordings, but nothing ties them to the switch, so "platform events in exact order" needs them left out or in a lane of their own.
6. The job fields beyond `job`, `state` and `steps` are not in the schema: allowed, never checked. `attention.until` is an ISO time, and step details carry `{data}` and `{launchers}` paths.
7. The design's example names a process by `image`; the events carry `exe`, `args` and, on a kill, `tree`. The schema constrains none of them.
8. A binary registry write records `"value": "binary"`, as `fake-platform.json` always has. Which bytes were written shows only in the final state.

No schema was changed.
