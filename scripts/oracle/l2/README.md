# Replay harness

Ticket M0-T05: the 22 replay scripts, the headless harness that records them, and the cross-check of five of them through real Electron. What the scripts and expectations mean to whoever replays them is in `bundle/README.md`, which is copied into the bundle as `l2/README.md`; this file is about the tooling.

## Layout

| Path | What |
| --- | --- |
| `scripts/<name>.json` | The 22 scripts. The generator copies each into the bundle beside its expectation |
| `replay/<name>.gen.ts` | One generator per script, so vitest records them side by side. It names what the script declares beyond its steps: refused invokes, transient states, a longer timeout |
| `readme.gen.ts` | Copies `bundle/README.md` into the bundle |
| `harness/instance.ts` | One start of the app, wired in the order of `src/main/index.ts` |
| `harness/runner.ts` | Runs a script against the harness: starts, steps, gates, the final state |
| `harness/events.ts`, `capture.ts`, `project.ts` | What a recording keeps of the events and of the folders; shared with the cross-check |
| `harness/stabilise.ts` | Makes five recordings one expectation and reports every rule it took |
| `harness/probe.dev.ts` | One recording, summarised for whoever is writing a script |
| `electron/` and `cross-check.mjs` | The same scripts through the built app, diffed against the bundle |

## Commands

| Command | What it does |
| --- | --- |
| `node scripts/oracle/generate.mjs l2` | Records every script five times and writes `l2/` in the bundle |
| `node scripts/oracle/generate.mjs l2/replay/<name>` | One script |
| `node scripts/oracle/l2/cross-check.mjs` | Builds the unpackaged app, replays the five cross-checked scripts through it, writes `l2/cross-check.json` when every diff is zero. App windows open while it runs. `ORACLE_L2_ONLY=<name>` replays one and writes nothing |
| `node scripts/oracle/l2/report.mjs` | Adds up the bundle's normalisation reports: per script what differed and what was normalised, then every rule with its paths |

`ORACLE_L2_RUNS=<n>` records n times instead of five (two at least). `ORACLE_GENERATOR=scripts/oracle/l2/harness/probe.dev.ts ORACLE_L2_SCRIPT=<name> npx vitest run --config scripts/oracle/vitest.config.ts` writes a summary of one recording into the scratch folder.

A generator writes a script's three files only when every recording normalised to the same value, no path differed without a rule, and no rule changed a path the recordings agreed on. The one thing let through there is `enc` writing `{ present: false }` for a `*_enc` column that is null in every row. Otherwise it fails, and the recordings stay in `<scratch>\unstable-<name>`.

After a change here, generate, then run the cross-check, then seal (`emit-schemas`, a commit, `manifest`, `verify`): the cross-check reads the expectations from the bundle and writes its record into it.

## Scratch folder

Every recording runs in its own folder under `ORACLE_SCRATCH`, by default `..\oracle-scratch` beside this repo, and deletes it when it passes. The folder must be outside both repos and outside any user profile: the app's logger masks a profile path as `[USER]`, and a masked root cannot be normalised. The cross-check points `TEMP` there too, for the driver's own folders. A probe summary, an unstable recording and a raw Electron trace hold scratch paths and generated ids, so they stay there and never go into the bundle or a repo.

## How a start is built

`startApp` loads the app's modules afresh (`vi.resetModules`), as each start is a new process, then does what `index.ts` does from `bootstrap` on, in its order: logging, the database and its migrations, the What's New seed, the fake platform through `createPlatform`, the vault probe, the services and adapters with the scenario's seed between Steam and Epic, the recovery load, `LaunchService` with the trace hook, the artwork and update services, `registerIpcHandlers`. Then the three things `index.ts` starts once the window is up: the library scan with its artwork, the database copy, the updater. A script's first step waits for those.

What stands in for Electron:

- `electron` is mocked (`harness/electron-mock.ts`): `ipcMain.handle` fills the instance's handler map, which is where a script's `invoke` enters; `app.getVersion()` is the version in `package.json`.
- The vault is `test/helpers/fake-vault.ts` with a random salt in front of every value (`harness/vault.ts`). The plain fake gives the same bytes for the same plaintext every time, which DPAPI never does: with it the `*_enc` rule changed values no two recordings disagreed on, and a ciphertext kept outside a `*_enc` column (the tokens in a Battle.net snapshot's `meta`) passed for stable until the cross-check met the real vault.
- There is no window, tray or renderer, so nothing polls. No `ipcTrace` recorder is set: `ipc` events stay out of the expectations.
- The update engine throws if it is ever asked for; in an unpackaged run the service never asks.

`quit()` is `index.ts`'s quit: `stopRunningSwitch('quit')`, the cleanup raced against two seconds, the database closed, the `exit` line. The path through the quit prompt (`quit confirmed during a switch`) needs a window and is not replayed.

`crash()` ends an instance the way a killed process ends: every timer the instance set is cleared (`harness/timers.ts` tracks them), its recorder hooks are taken off, its logger is pointed away from the data folder, and its database handle is closed, which leaves the same rows a killed process leaves in the write-ahead log. Nothing of its quit path runs. Only one instance is live at a time in a worker.

The harness runs under the oracle clock (`lib/clock.setup.mjs`, each generator's first import). Steam judges a remembered session by its age, so a plan's warnings depend on the date; no warning reaches an expectation, and the cross-check, which runs Electron on the real clock, shows the events and final state do not depend on it.

## Writing a script

- A step acts on state, never on time. `awaitJob` waits for the job's state, lets the app code run on to its next wait, and fails if the state is already gone: gate on a state the scenario's knobs hold open.
- A wait the scenario does by sleeping has no step. `stop` restarts with `runningAs: user_3` where the scenario sleeps until the fake Steam has signed in.
- Every invoke must succeed unless its generator lists the step under `refused` with the code, so a script cannot go wrong unnoticed. Answers are not part of an expectation.
- A job state the simulator holds for less than one poll shows up in some recordings only. Name it under `transient` in the generator and it is taken out of every recording. `self-update` has the one case: the fake updater reports its end 20 ms before the sign-in.
- An alias is known once the app has shown the id: accounts and games after a start, a job after its `launch:start`, a snapshot after its manifest is written.

## Cross-check

`electron/cross-check.check.ts` drives the built app with `scripts/app-driver.mjs`: each `invoke` goes through the page's own `window.oneLaunch.invoke`, a gate reads the job events from the trace file, `crash` is the driver's hard kill of the process it spawned, `shutdown` and the end of a script are its clean close. The final state is read from the scratch folders with the same code the harness uses, and compared by the oracle's rules.

- A stored secret is read through `electron/scratch-vault.ts`, which unwraps the scratch profile's own key with DPAPI and refuses any folder outside the scratch base.
- The fake registry lives in the app's memory, so its final state cannot be read from a running Electron; `final.registry` is the one part the cross-check leaves out. `l2/cross-check.json` lists everything left out, per script.
- `launcher status was slow` is the one WARN line no recording keeps (`harness/project.ts`): Electron logged it for all four launchers on some starts and not on others, when the renderer's first status call met a busy main process.
- The window has to paint for main to start its scan; a capture after every start forces that on a covered desktop.
