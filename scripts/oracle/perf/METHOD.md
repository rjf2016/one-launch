# Performance baseline: method

The numbers in `baseline.json` are what "lighter and faster" is judged against in Milestone 7 and ratcheted from Milestone 3. They were measured on the packaged Electron build at the pin (`measured.pin`), built from the tooling branch (`measured.branchCommit`), whose `src/` differs from the pin only by the dev-only recording hooks listed in `measured.srcDiffStatFromPin` (they are inert in a packaged build).

**These numbers do not repeat identically.** Every other layer of the bundle does; this one is timings and counters of a live process on a desktop PC. Two runs differ by milliseconds and by fractions of a percent of a core. So every raw sample is kept, each metric gives its spread (`min`, `median`, `p95`, `max`, `n`), and nothing is trimmed or normalised. The p95 is nearest-rank: the smallest sample with at least 95 % of the samples at or below it (with 20 samples, the 19th). Compare a Rust run with these by median and p95 over at least as many samples, on the same machine (`machine`), and never from one start.

## The machine and the build

`machine` holds what a reader needs to interpret the numbers and nothing that identifies the PC: CPU model and logical cores, memory, Windows build (`node:os`), the GPUs Chromium lists (`SystemInfo.getInfo`), power line and active power scheme (`System.Windows.Forms.SystemInformation.PowerStatus`, `powercfg /getactivescheme`). The page reported a device pixel ratio of `warmFolderScreen.devicePixelRatio` and a window of `warmFolderScreen.inner` CSS pixels. `app` gives the app, Electron, Chrome and Node versions.

## How a run goes

```powershell
npm run build
node scripts/oracle/perf/measure.mjs
node scripts/oracle/perf/check.mjs
```

1. **Primer.** One start on its own empty folder, discarded (`discarded[0]`): the first start after a build is the one the antivirus scans the new exe on.
2. **Warm series.** One start on an empty folder, discarded (`discarded[1]`): it creates the database, the Chromium profile and the caches. On that start the run turns `artwork.autoFetch` off, presses Skip setup on the setup guide, waits until Chromium has written the vault key to `chromium\Local State`, and waits for the first library scan. Then 20 warm starts on the same folder (`warmStart.samples`), each closed through the page's `window.close()` before the next. Warm means exactly that: same folder, guide dismissed, first scan done, artwork auto-fetch off, vault key on disk, Chromium's code and shader caches and Node's compile cache filled.
3. **`launchers:status`.** In each warm start, after its startup scan has finished, one call (the first of that process); after the last start, 20 calls back to back with 250 ms between them.
4. **Idle, warm folder.** The last warm start stays up: the visible state, then the window is closed to the tray and the hidden state.
5. **Idle, large database.** A new folder seeded with a copy of `fixtures/db/onelaunch-large-v5.db` as `data\onelaunch.db` before the first start; that first start is discarded (`discarded[2]`), `artwork.autoFetch` is turned off, the vault key is waited for, and the app is restarted once (`largeDb.warmStart`); then the visible and hidden states as above.

Every data folder is under the scratch folder and passed as `--data-dir=`; `TEMP` and `TMP` point into the scratch folder for the app as well. The single-instance lock follows the data folder, so an installed copy running in the tray is never reached. The debug port comes from a free-port probe, and after every connect the run checks that the browser process behind the port (`SystemInfo.getProcessInfo`, type `browser`) is the child it spawned. The packaged exe reads this PC's real launchers; everything the run does is read-only, and nothing read from a launcher is kept beyond the number of launchers with an install.

The desktop matters: Chromium presents no frame for a window that is covered, minimised, on a locked desktop or on a display that is off, and the page then reports `hidden`. Every start records the page's `visibility` and its `visibilityEntries` (the page's visibility-state timeline from navigation start); a start that was not visible throughout is not a baseline sample.

## Metric: `warm-start`

Warm start to interactive, from the creation of the process: `warmStart.fromProcessCreationMs.interactive` (median and p95 over `warmStart.samples`), with the same statistics for every intermediate mark under `warmStart.fromProcessCreationMs`, and from the spawn call in `warmStart.interactiveFromSpawnMs`.

**Interactive** is `max(pageLibraryFrameMs, pageFirstContentfulPaintMs)`: the later of the renderer's `startup:library-frame` mark (two animation frames after the library's data was committed) and Chromium's first contentful paint (the presentation time of the first frame with content). Only then is the library, with its data, on screen, and input reaches mounted handlers (IPC is registered at `ipcMs`, before the page has even loaded). `libraryFrame` alone is a requestAnimationFrame callback time, which comes before the frame is presented; first contentful paint alone could, on another build, be an earlier frame without the library. In every warm start here the library's data was committed before the first paint (`warmStart.libraryDataBeforeFirstPaintInEveryStart`), so the first presented frame already held the library and first contentful paint is the later of the two.

The marks, each in ms from process creation (`process.getCreationTime()` in main):

| Field | Where it comes from |
| --- | --- |
| `spawnToCreatedMs` | `creationEpochMs` of main's `startup` log line minus the moment the driver called `spawn`; `spawnToCreatedOutsideMs` is the same from the process's creation time read from outside (`GetProcessTimes`) |
| `processToNodeMs` | `app:info` `startup`: before any app code runs (Windows loading a 246 MB exe, the antivirus, Chromium's own start) |
| `moduleLoadedMs`, `readyMs`, `dbMs`, `vaultMs`, `ipcMs`, `windowCreatedMs` | main's `startup` log line: main module evaluated, `ready`, database open and migrated, vault probed, IPC handlers registered, window created |
| `windowShownMs`, `didFinishLoadMs`, `readyToShowMs` | the same line and `app:info`: window shown, page loaded, `ready-to-show` (main's first-paint signal) |
| `pageNavigationStartMs` … `pageLibraryFrameMs` | the page's `performance` entries moved onto the process-creation origin: navigation start, `startup:module`, `startup:prefetched`, `startup:render`, `startup:first-commit`, `first-paint`, `first-contentful-paint`, `startup:library-data`, `startup:library-frame` |
| `spawnToDriverReadyMs` | when the driver first saw "Library" in the page; it polls every 250 ms, so it is coarse |

**From outside, any exe:** the spawn time and the process's creation time (`GetProcessTimes` on the spawned pid, through `proc-counters.ps1`), which give `spawnToCreatedOutsideMs`. Nothing later can be seen from outside without the app's help: a window can be on screen long before it shows anything.

**From the app's own marks; what the Rust build must offer:** one log line per start, like main's `startup` line, holding the process creation time in epoch ms and every mark in ms from it: at least `readyMs` (event loop up), `dbMs`, `vaultMs`, the moment the UI accepts input (the counterpart of `ipcMs`), `windowCreatedMs`, `windowShownMs`, `firstFramePresentedMs` (the first frame presented, the counterpart of `first-paint`), `libraryDataMs` (the library's data in the view model) and `libraryFramePresentedMs` (the first presented frame that shows the library with its data). Interactive on the Rust build is `libraryFramePresentedMs`, which is what `max(pageLibraryFrameMs, pageFirstContentfulPaintMs)` approximates here. The line should also say whether the window was visible and unoccluded when that frame was presented, the counterpart of the page's visibility. Compare Rust's `libraryFramePresentedMs` with `warmStart.fromProcessCreationMs.interactive`, and Rust's spawn-to-created with `warmStart.spawnToCreatedMs`.

Command for the Rust build (no CDP; warm the folder the same way first: one discarded start after the build, one discarded start on the empty folder, the guide dismissed, the first scan done, artwork auto-fetch off):

```powershell
$t0 = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$p = Start-Process -FilePath '<rust exe>' -ArgumentList '--data-dir=<scratch>\warm\data' -PassThru
"counters $($p.Id)" | powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts\oracle\perf\proc-counters.ps1
Select-String -Path '<scratch>\warm\data\logs\onelaunch.log' -Pattern ' startup \{' | Select-Object -Last 1
```

`creationFileTime` in the helper's answer is a Windows FILETIME (100 ns since 1601): epoch ms = FILETIME / 10000 − 11644473600000; spawn to created is that minus `$t0`. Close the app the way its user would and repeat at least 20 times.

## Metric: `memory`

Memory across all of the app's processes, with the window visible and with it hidden to the tray, after a settling time, several samples each. Two sessions: the warm folder (`idle.warmFolder`) and the large database (`idle.largeDb`).

| Field | Meaning |
| --- | --- |
| `idle.warmFolder.summary.visible.memoryBytes.privateWorkingSet`, `idle.warmFolder.summary.hidden.memoryBytes.privateWorkingSet`, `idle.largeDb.summary.visible.memoryBytes.privateWorkingSet`, `idle.largeDb.summary.hidden.memoryBytes.privateWorkingSet` | Summed over all processes: private pages resident in RAM (`PrivateWorkingSetSize`); what Task Manager's Memory column shows. The headline |
| `idle.warmFolder.summary.visible.memoryBytes.workingSet`, `idle.warmFolder.summary.hidden.memoryBytes.workingSet`, `idle.largeDb.summary.visible.memoryBytes.workingSet`, `idle.largeDb.summary.hidden.memoryBytes.workingSet` | Summed `WorkingSetSize`: private and shared resident pages; shared pages (the Electron DLLs mapped by every process) count once per process, so the sum overstates |
| `idle.warmFolder.summary.visible.memoryBytes.privateBytes`, `idle.warmFolder.summary.hidden.memoryBytes.privateBytes`, `idle.largeDb.summary.visible.memoryBytes.privateBytes`, `idle.largeDb.summary.hidden.memoryBytes.privateBytes` | Summed `PrivateUsage`: private committed memory ("private bytes", commit charge), resident or not |

Each `memoryBytes` also has `byType` (browser, renderer, GPU, network service as `SystemInfo.getProcessInfo` names them). The samples are in `idle.<session>.session.<state>.memory`, taken at the start and end of each CPU window: after the settling time (`parameters.settleS` seconds) and then every `parameters.windowS` seconds, `parameters.windows + 1` samples per state. The counters come from `GetProcessMemoryInfo` with `PROCESS_MEMORY_COUNTERS_EX2`, on a handle opened by pid with `PROCESS_QUERY_LIMITED_INFORMATION` (`proc-counters.ps1`), for exactly the pids the browser target lists.

The visible state starts once the startup scan has finished; the window is in front, unminimised, the Library view on screen. The hidden state is entered by posting `WM_CLOSE` to the app's own visible top-level window, as the caption button does; with "Minimize One Launch to System Tray" on (the default) the window hides, the app logs `window hidden to the tray` (`idle.<session>.session.hiddenToTrayLogged`), and the page reports `hidden` (`hiddenAfter`). Processes Chromium does not list in `SystemInfo.getProcessInfo` (a crash handler, short-lived PowerShell or `reg.exe` children of a status pass) are not counted, and cannot be without listing processes.

**From outside, any exe:** all of it. The Rust build gives its pid at spawn; if it keeps any long-lived child process, it must report that child's pid (in its startup line), since nothing may be found by image name. Hide it to the tray the same way (`close <pid>` to the helper posts `WM_CLOSE` to the pid's visible top-level windows) and confirm the hide from its own log line, the counterpart of `window hidden to the tray`.

Command (the Rust build: the pid from `Start-Process -PassThru`; run after the settling time, then every 60 s):

```powershell
"counters <pid>" | powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts\oracle\perf\proc-counters.ps1
"close <pid>" | powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts\oracle\perf\proc-counters.ps1
```

`workingSet`, `privateWorkingSet` and `privateBytes` in its answer are bytes. Compare like with like: a Rust total against the Electron total of the same counter and state.

## Metric: `idle-cpu`

Idle CPU, visible and hidden, with the large fixture database: CPU time consumed over a window, as a percentage of one core, per process type and summed. `idle.largeDb.summary.visible.cpuPctOfCore.total` and `idle.largeDb.summary.hidden.cpuPctOfCore.total` (from Chromium's `cpuTime`), with `idle.largeDb.summary.visible.cpuPctOfCore.totalFromOsCounters` and `idle.largeDb.summary.hidden.cpuPctOfCore.totalFromOsCounters` (from the kernel's own process times) beside them, and `byType`. The warm folder's are in `idle.warmFolder.summary` for comparison.

A window is `parameters.windowS` seconds; there are `parameters.windows` per state, after `parameters.settleS` seconds of rest. At each end of a window the run asks the browser target for `SystemInfo.getProcessInfo` (each process's `cpuTime`, cumulative seconds) and, for the same pids, `GetProcessTimes` (kernel plus user time). Per window: Δ`cpuTime` ÷ wall seconds × 100 is the percentage of one core (100 is one core fully busy). A process present at only one end of a window is listed under `unmatched` and left out of that window. Nothing touches the page during a window. The kernel's times advance in scheduler ticks (about 15.6 ms), so over a near-idle minute `totalFromOsCounters` is coarse; Chromium's `cpuTime` is finer.

What the app was doing: nothing it was asked for. The renderer polls `artwork:status` and `updates:status` every 60 s from the sidebar, the updater is unavailable for a scratch data folder and makes no request, and artwork auto-fetch is off. The large database's state is described below under "The large database".

**From outside, any exe:** all of it, through `GetProcessTimes` for the pid (`kernel100ns + user100ns`, in 100 ns units). The Rust build has no `cpuTime`, so compare its `GetProcessTimes` numbers with `totalFromOsCounters`, not with the `cpuTime` totals, and use windows at least as long as these.

Command (the Rust build, seeded the same way: a copy of the fixture as `data\onelaunch.db` before the first start, one discarded start, auto-fetch off, one restart, the scan finished, 30 s of rest):

```powershell
"counters <pid>" | powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts\oracle\perf\proc-counters.ps1
Start-Sleep -Seconds 60
"counters <pid>" | powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts\oracle\perf\proc-counters.ps1
```

CPU % of one core = Δ(`kernel100ns` + `user100ns`) ÷ 10^7 ÷ wall seconds × 100.

## Metric: `install-size`

`install.unpacked` (`bytes`, `files`, `folders`): every file under `dist\win-unpacked` after this ticket's `npm run build`, which is what the installer lays down (apart from the uninstaller it adds). `install.parts` breaks out the exe, `resources\app.asar`, `resources\app.asar.unpacked` (the better-sqlite3 prebuild) and `locales`.

**From outside, any exe:** all of it. For the Rust build, the same count over the folder its installer lays down, or its build output folder.

```powershell
Get-ChildItem -LiteralPath '<install folder>' -Recurse -File | Measure-Object -Property Length -Sum | Select-Object Count, Sum
```

## Metric: `installer-size`

`install.installer` (`bytes`, and `digest` in SRI form: `sha256-` and the base64 digest) of `dist\OneLaunch-1.0.0-beta.3-setup.exe`. **This is the released installer of 1.0.0-beta.3, the owner's release build, built earlier than the pin; this ticket did not build it** (an installer build is the owner's). The pin is the same version.

**From outside, any exe:** the Rust installer's size and digest.

```powershell
(Get-Item -LiteralPath '<installer.exe>').Length
Get-FileHash -LiteralPath '<installer.exe>' -Algorithm SHA256
```

## Metric: `launchers-status`

`launchers:status` latency, read-only, against this PC's real launchers: `launchersStatus.firstCallPerStartMs` (the first call in each of the 20 warm processes, after its startup scan) and `launchersStatus.repeatedCallsMs` (20 calls back to back in one process), with every sample (`firstCallSamples`, `repeatedSamples`). Measured in the page with `performance.now()` around `window.oneLaunch.invoke('launchers:status')`, so it includes the IPC round trip (well under a millisecond) and the whole status pass: for each launcher the install detection, the running check and the health report, which spawn `reg.exe` and PowerShell children. `installedLaunchers` is how many of the four launchers answered with an install; nothing else of the answer was kept.

**From the app's own marks; what the Rust build must offer:** the Rust build has no IPC to time from outside. It must time its own status pass (the four launchers' detection, running check and health, as one refresh) and log one line per refresh with its duration in ms, and offer a way to ask for a refresh that is not a user click (a command-line or debug trigger), so the first refresh after start and a run of 20 can be timed the same way. Compare with `launchersStatus.firstCallPerStartMs` and `launchersStatus.repeatedCallsMs`. It reads real launchers, so the same rules apply: read-only, nothing kept but timings and a count.

Command (Electron, the whole run; the status timings are steps 3 of it):

```powershell
node scripts/oracle/perf/measure.mjs
```

## The large database

`fixtures/db/onelaunch-large-v5.db` holds 200 accounts, 1,000 games (950 installed), 500 artwork rows and 10,000 launch-history rows, with secrets encrypted under another machine's key. What the app came up in is in `largeDb`:

- It opened the database without a migration (it is at version 5).
- The fixture holds no vault probe, so the app stored a fresh one under this folder's new key and reported the vault readable (`largeDb.stateWhileMeasured.vaultReadable`); the fixture's own encrypted values (passwords, sessions) cannot be decrypted with that key, which only shows when one is used. No error line was logged (`largeDb.stateWhileMeasured.errorLines`). Nothing was reset or repaired.
- The first start's library scan read this PC's real launchers, found none of the fixture's games and marked them not installed (games are never deleted). From then on the Library view showed this PC's installed games; their number and names are not recorded. The 200 accounts and the 10,000 launch-history rows stayed.
- On screen while measured: the Library view, no setup guide, no What's New card, no dialog (`largeDb.stateWhileMeasured.screen`).

## What this run saw

- Every warm start and every discarded start reported the page `visible` from navigation start on, with every mark present (`warmStart.allVisible`).
- About 460 ms of the roughly 760 ms to interactive passes before any app code runs (`processToNodeMs`): Windows loading the exe and Chromium's start, which the app cannot shorten. The Rust build is judged on the whole span from process creation.
- The discarded starts are slower than the warm ones by about 300 ms (`discarded`), as expected of a first start on an empty folder.

## Known limits

- One machine, one run. The numbers describe this PC; a Rust comparison belongs on the same PC.
- Processes not listed by `SystemInfo.getProcessInfo` are not counted (above).
- Switch-flow timings have no packaged baseline: fake launchers exist only in an unpackaged build.
