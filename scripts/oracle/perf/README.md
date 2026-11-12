# Performance baseline

Ticket M0-T10: the numbers "lighter and faster" is judged against. `measure.mjs` measures the packaged exe (`dist\win-unpacked\OneLaunch.exe`) on scratch data folders and writes `perf/baseline.json` and `perf/METHOD.md` into the bundle. What each number means, and how to measure the same on the Rust build, is in `METHOD.md`, which is copied into the bundle unchanged; this file is about the tooling.

Unlike every other layer of the bundle these numbers do not repeat: two runs on the same machine differ by milliseconds and fractions of a percent. The baseline keeps every raw sample and gives the spread (min, median, nearest-rank p95, max); nothing is trimmed or normalised.

## Layout

| Path | What |
| --- | --- |
| `measure.mjs` | One run: a primer start, the warm series with the `launchers:status` timings, then the idle sessions on the warm folder and on the large fixture database. Writes the bundle files and a raw copy in the scratch folder |
| `lib.mjs` | `PerfDriver` (the repo's `Driver` in packaged mode on a data folder it lays itself, a free-port probe, a check after every connect that the port's browser process is the spawned child), the browser-target socket, the counter helper's client, the statistics |
| `proc-counters.ps1` | A long-lived PowerShell that opens one process by id with query-limited access and returns its memory counters and CPU times, or posts `WM_CLOSE` to one process's own visible top-level windows. It lists no process. It works for any exe, which is what the Rust measurement needs |
| `METHOD.md` | The method, copied into the bundle as `perf/METHOD.md` |
| `check.mjs` | The ticket's acceptance checks against the bundle |

## Commands

| Command | What it does |
| --- | --- |
| `npm run build` | Builds `dist\win-unpacked`; the run measures whatever is there |
| `node scripts/oracle/perf/measure.mjs` | The full run, about 20 minutes. App windows open and close on the desktop |
| `node scripts/oracle/perf/measure.mjs --out=<folder> --starts=2 --settle-s=2 --window-s=3 --windows=1 --status-repeats=2` | A trial run in a minute, into a scratch bundle holding `PIN` and `fixtures/db/onelaunch-large-v5.db` |
| `node scripts/oracle/perf/check.mjs [--skip-verify]` | The acceptance checks; `--skip-verify` leaves out the minutes-long `verify.mjs` pass |

Flags of `measure.mjs`: `--starts` warm starts (20), `--settle-s` seconds of rest before each idle state (30), `--window-s` length of one CPU window (60), `--windows` windows per idle state (3), `--status-repeats` back-to-back `launchers:status` calls (20).

## What a run controls

- Every folder is under `T10_SCRATCH`, by default `..\oracle-scratch\t10` beside this repo, outside both repos and any user profile. `TEMP` and `TMP` point at `<scratch>\temp` for the run and for the app, so Node's compile cache of the app sits there too and is warm from the second start on.
- The data folders are laid by the tooling (`primer`, `warm`, `large`), passed as `--data-dir=`, and kept after the run for a look. The single-instance lock follows the data folder, so an installed copy running in the tray is neither reached nor disturbed; the check on each connect refuses a port whose browser process is not the child just spawned.
- The packaged exe never enters fake mode, so it reads this PC's real launchers, read-only. `launchers:status` is the only launcher call the run makes, and only its time and the number of launchers with an install are kept. The large database's start runs the app's usual library scan, which marks the fixture's games not installed on a PC that does not have them.
- Process ids come only from `SystemInfo.getProcessInfo` on the browser target. Nothing is matched by image name and no process is listed.
- Desktop: the paint marks need a visible window. Run with the desktop unlocked, the display on and nothing over the app's window; every start records the page's visibility, and the check refuses starts that were not visible unless the baseline says why.

## Reading the output

`baseline.json`: `measured` (pin, branch commit, the `src` diff from the pin), `machine`, `app` versions, `discarded` starts, `warmStart` (stats per mark and every sample), `launchersStatus`, `idle.warmFolder` and `idle.largeDb` (per state a `summary` of stats and the `session` with every window and memory sample), `largeDb` (the state the large database came up in), `install`.
