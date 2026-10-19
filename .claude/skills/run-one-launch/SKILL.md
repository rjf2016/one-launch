---
name: run-one-launch
description: Build and drive One Launch over CDP to see a change working - screenshots of any view, the Play flow against fake launchers, crash recovery, a second start. Use before handing any change over.
allowed-tools: Bash(node scripts/drive.mjs scripts/scenarios/*), Bash(npx electron-vite build), Bash(npm run dev:fake), Bash(npm run dev:fake *), Bash(agent-browser connect *), Bash(agent-browser snapshot *), Bash(agent-browser screenshot *), Bash(agent-browser wait *), Bash(agent-browser errors), Bash(agent-browser console), Bash(agent-browser close), Read, Glob, Grep
---

# Drive One Launch

The app is driven with plain Node over the Chrome DevTools Protocol by `scripts/app-driver.mjs`. Every run starts the app on a fresh scratch data folder (`--data-dir=`), so the real `%APPDATA%\OneLaunch` is never touched. With `--fake` it also runs against fake launchers (in-process fakes seeded from `test/fake-launchers/<name>/`), so Play, Stop, rollback, restore, and recovery are safe to exercise: nothing on the real machine changes. Without `--fake` the app reads whatever this PC has, read-only.

## Build, then run a scenario

```powershell
npx electron-vite build                                   # refreshes out/, which an unpackaged run uses; a few seconds
node scripts/drive.mjs scripts/scenarios/views.mjs --shots=<your scratchpad>\shots
node scripts/drive.mjs scripts/scenarios/play-all.mjs --fake --shots=<your scratchpad>\shots
```

- `npm run build` is only for `npm run smoke:packaged` (packaged exe); it fails with `EBUSY` while `dist\win-unpacked\One Launch.exe` is running.
- Flags: `--fake[=<name|folder>]` (default `all-four`), `--knobs=<json>` (per-launcher simulator knobs, deep-merged over the scenario's), `--keep` (keep the scratch folder), `--shots=<dir>`, `--port=<n>`, `--packaged` (never with `--fake`), `--hold[=<minutes>]` (keep the app up at the scenario's end state for an interactive look, below).
- `drive.mjs` runs only a `.mjs` file directly in `scripts/scenarios/` and starts only the repo's own builds; that is what makes its pre-approval in `.claude/settings.json` safe. Type the scenario path with forward slashes so the command matches the approved form.
- Output: one `PASS`/`FAIL` line per check, the screenshot paths, and `Scenario <name> passed.` or `FAILED (n)`. On a failure the scratch folder is kept and its log and `fake-platform.json` are copied next to the screenshots; a screenshot `at-failure.png` is taken if the app is still up.
- Look at the screenshots (Read them) before claiming a view looks right.

## Committed scenarios (`scripts/scenarios/`)

| Scenario | Proves |
| --- | --- |
| `views.mjs` | Library (with `--fake`, VALORANT's tile shows the game's own icon standing in for a cover), Accounts, an account, Settings at 1280x800 and 960x600; search; sort and card menus by keyboard. The check for any renderer change. |
| `packaged-smoke.mjs` | The packaged exe starts on a scratch folder, answers, keeps updates off (`custom-data-folder`), is refused page permissions, has its fuses set, carries electron-updater, quits with 0, no ERROR line (`npm run smoke:packaged`). |
| `update.mjs` (`fake: 'none'`) | The updater against a loopback feed and a throwaway key (about a minute): no traffic with automatic updates off; unsigned, tampered and 503 refusals; a signed update to "ready", the sidebar card, Restart to update (installer stubbed); a background check once the switch is on, installed at quit; only the shared staging id is sent. |
| `startup-timing.mjs` | The packaged exe's startup timings from spawn to the painted library, main's marks and the renderer's, for a first start on an empty folder and two warm starts on the same folder. Run it five times after `npm run build`, discard the first (Defender scans the new exe), compare medians. `--args="--trace-startup=devtools.timeline,v8,blink.user_timing,loading,gpu,viz,cc,toplevel --trace-startup-format=json --trace-startup-file=<file> --trace-startup-duration=2"` on any scenario writes a Chromium startup trace. |
| `play-steam.mjs`, `play-epic.mjs`, `play-battlenet.mjs`, `play-all.mjs` | Play on a non-current account: every dialog stage, the launch URI or command, one snapshot, no ERROR line. |
| `play-riot.mjs` | Play VALORANT against the fake Riot Client, twice. With "Start Riot games for you" off: the outgoing sign-in saved, one snapshot, the whole file swapped, the client started with no arguments, then handed the shortcut's `--launch-product` / `--launch-patchline`, which only opens the game's page (Riot's auto-launch flag is off), so the dialog ends "Switched to" with the hand-over to Play. Then with it on (the default): the switch back, the one launch request to the client's local server (`riotLaunchRequests` in the fake report), the game started, "Launched as". No game process touched either way. Also the Riot pass of `play-all.mjs`. |
| `already-active.mjs` | Steam already signed in as the target: the plan says so, nothing closed, written, or snapshotted. |
| `rollback.mjs` | Steam never comes back after the writes: failed, `loginusers.vdf` and `AutoLoginUser` put back byte for byte. |
| `self-update.mjs`, `elevated.mjs` | Steam updating itself before the sign-in; a Steam Windows will not let us close (nothing changed). |
| `stop.mjs` | Stop while closing, after the start, and after the sign-in, with the sentence each one ends with. |
| `handover.mjs` | Attention panel, Copy login and Copy password (recorded, never the real clipboard), Stop waiting, the needs-sign-in timeout, and an Epic sign-in the "user" finishes by hand. |
| `wrong-account.mjs`, `unowned.mjs` | Epic signs in as another account's id: rollback; an id nobody holds: adopted. A sign-in nobody owns (Epic, Battle.net, Riot): plan warning, Kept snapshot, its Restore. |
| `restore.mjs`, `recovery.mjs`, `quit-during-switch.mjs` | Settings › Backups restore (refused while Steam runs); crash mid-switch (`killHard`), the recovery prompt, Restore and Keep as is; the quit prompt mid-switch (with the tray setting off), both answers. |
| `close-to-tray.mjs` | Closing the window hides it and the app stays up (the default), a second start brings it back, the Settings toggle off makes the same close quit with 0. |
| `first-run.mjs` (`fake: 'none'`) | A PC with no launchers: the setup guide step by step (four Locate rows, the phase demo, Add by hand, Back, finishing into an account form), four "Not installed" rows, Show again and Escape, a second start with no guide, no ERROR line (the CI runner's state). |
| `whats-new.mjs` (`fake: 'none'`) | The What's New card: a fresh folder counts the running version as seen (no card), a folder that last saw an older version shows it once at 1280x800 and 960x600, closing records the version, the next start shows nothing, the switch off keeps it closed and still records the version, Settings › Show opens it, Escape closes it. The card parts run only when an entry exists at or below the running version. |
| `import.mjs`, `preview.mjs` | Import accounts from Steam and Battle.net; Preview mode, the preview stage, `DRY_RUN`, "Turn preview off and play now". |
| `needs-update.mjs` | Battle.net wants to update Overwatch and the Riot Client VALORANT: the Update badges, the pickers' notes, both switches run, both launches fail with the client's reason, and no launch command is sent. |
| `game-running.mjs` | Overwatch runs on after the Battle.net client exited: the switch starts the client, the launch is refused at once as already running, no launch command sent. |
| `hold.mjs` | Nothing by itself: starts the app (fake with `--fake`, else read-only) and leaves it up for an interactive look (below), up to 30 minutes. |

A launcher started by something else mid-switch has no scenario: the poll count that triggers it is not predictable through the UI, and `test/pipeline.test.ts` and the adapter tests cover it. Stop between the writes and the start is likewise pipeline-only (it lasts microseconds against a fake).

## An ad hoc scenario

Write `scripts/scenarios/adhoc-check.mjs` (any `adhoc-*.mjs` there is gitignored; delete it when you are done) and run it with `node scripts/drive.mjs scripts/scenarios/adhoc-check.mjs --fake --shots=<scratchpad>\shots`. It can import `./lib.mjs` like a committed scenario:

```js
export const name = 'check';
export default async (d) => {
  await d.click('Settings');
  await d.waitFor('Advanced');
  await d.click('Launchers');
  await d.waitFor('Re-check');
  await d.shot('settings-launchers');
  d.check('the Steam row is healthy', await d.has('Healthy'));
};
```

Settings has tabs (General, Launchers, Artwork, Backups, Advanced): `click('<tab>')` selects one, then wait for that panel's own text. "Advanced" is a tab label, so `waitFor('Advanced')` only proves the page painted.

Driver API (`d`): `invoke(channel, payload)` (unwrapped IPC; throws with `.code`), `invokeRaw`, `evaluate(fn, ...args)`, `text()`, `has(text)`, `waitFor(text | fn, { timeoutMs, absent })`, `waitForJob(jobId, state | fn)`, `click(name | { contains } | { selector }, { nth })`, `focus(...)`, `type(text)`, `key('Enter' | 'ArrowDown' | 'a', { ctrl, shift, alt })`, `viewport(w, h)` / `viewport(null)`, `shot(name)`, `timeline(fn, everyMs, forMs)`, `readLog()`, `assertNoErrorLines([allowRegex])`, `fakeReport()`, `launcherFile(rel)`, `restart({ knobs })` (a second start; `knobs` replaces the run's `knobs.json`), `secondInstance()` (a second copy on the same folder while the first runs; it hands over, shows the first's window, and exits 0), `killHard()`, `closeWindow()` + `waitForExit()`, `close()`, `check(name, ok, detail)`, `env` (extra child environment; set it in `before(d)`, it applies to every spawn). The runner closes the app and checks for ERROR lines itself when the scenario has not. A function given to `waitFor` runs in the page, so it cannot use `d` or outer variables; a string is page text, not an expression. Optional `export async function before(d)` / `after(d)` run around the whole scenario (a local server whose port the child must know).

Scenario options: `export const options = { fake: '<folder>', knobs: { knobs: { steam, epic, battlenet, riot }, processes, timing: { steam, epic, battlenet, riot }, quitDuringSwitch } }`; the knob names are in `src/main/launchers/sim/types.ts`, `epic.ts`, `battlenet.ts`, `riot.ts`, the timings in `scenario.ts` (`SIM_TIMING`). `--knobs=<json>` on the command line replaces them. A running Riot game is a process-table knob: `--knobs='{"processes":{"table":[{"name":"VALORANT-Win64-Shipping","pid":1,"path":null}]}}'` makes every Riot switch refuse.

`scripts/scenarios/lib.mjs`: `skipSetup(d, { shot })` (closes the setup guide a folder with no accounts opens, screenshot first; returns whether there was one), `startPlay(d, { game, account, tag })`, `watchDialog(d, { until, tag })` (answers a confirm stage once, screenshots the running state, fails on "Try again" unless `until` matched), `finishDialog(d, tag)`, `playThrough(d, { game, account, launcher, expect })`, `switchThrough(d, { account, login, launcher })` (Switch to this account from the account page, no game), `waitForVaultKey(d)`, `fixture(rel)`, `journalExists(d)`, `readJournal(d)`, `recentFor(d, game)`.

## An interactive look (agent-browser)

The scenarios are the proof. `agent-browser` (vercel-labs' CLI, installed on this PC) is for looking around in a running app and for the hot-reload loop while polishing the renderer: it attaches to the CDP port of a run one of our scripts started, reads the accessibility tree, screenshots, clicks by ref, and captures renderer console output. Start one of these in the background:

```powershell
node scripts/drive.mjs scripts/scenarios/hold.mjs --fake --port=9333   # the built app (out/), up to 30 min; any scenario takes --hold[=<minutes>] to stay up at its end state
npm run dev:fake                                                        # electron-vite dev with hot reload on a fresh scratch folder, fake launchers, CDP port 9334 (-- --fake=<name> --knobs=<json> --port=<n> --keep)
```

Both print the port. The hold ends when the file its `HOLD` line names exists, when the app is quit from the page, or at the deadline; the usual close, exit-code and ERROR-line checks run after it. The dev run ends when the app quits and deletes its scratch folder unless `--keep`. A renderer edit shows in the dev window in well under a second with no rebuild; a main or preload edit still needs the run started again.

```powershell
agent-browser connect 9333
agent-browser snapshot -i -c                                   # the accessibility tree with @eN refs: what click(name) and a screen reader see
agent-browser screenshot --annotate <scratchpad>\library.png   # the window with the refs drawn on; `screenshot <path>` without them
agent-browser click @e6
agent-browser wait --text "Advanced"
agent-browser errors                                           # renderer errors; `console` for all output, which the main log does not carry
agent-browser close                                            # drops the session; the app stays up
agent-browser eval "setTimeout(() => window.close(), 50)"      # quits the app, which ends a dev run
```

- Never `--auto-connect`, and never `connect` to a port one of the two commands above did not print: every launcher client is a Chromium app too, and the Riot rules apply to looking.
- Without `--fake` the run reads the real launchers, so stay read-only: `snapshot` and `screenshot`, no `click` on Play, Restore, Switch, or a Settings toggle. The Accounts views of a real run put account names into the transcript; look at them with `--fake` (placeholder names) or not at all.
- `.claude/settings.json` pre-approves the read-only subcommands; `click`, `fill`, `press` and `eval` ask every time, on purpose.
- The first command of a session starts a daemon that inherits the shell's pipes, so never pipe it (`connect ... | tail -1` hangs until the daemon exits); run `connect` bare or redirect it to a file. Later commands pipe fine. `close --all` ends every daemon.
- Recording (`record start`) needs ffmpeg, which is not installed; it is a dependency, so ask first.

## Gotchas

- A fresh data folder with no accounts opens the setup guide over the Library, a modal that swallows Escape and the shortcuts. The `all-four` seed has it dismissed; with `--fake=none` or no `--fake`, call `skipSetup(d)` first unless the guide is the point (`views.mjs` and `update.mjs` do). Its entrances take about 400 ms, so settle before a screenshot of it. The What's New card never opens on a fresh folder (main records the running version as seen), so nothing needs to skip it; `whats-new.mjs` seeds `whatsNew.lastSeen` = `0.0.0` and restarts to see it.
- Target buttons by accessible name (aria-label, else text): `click('Play Rocket League')`, `click({ contains: 'Persona One' })` for a row.
- Menus close on scroll; `click` scrolls first and clicks in a second evaluate. Keyboard needs `key()`, not synthetic events.
- Native dialogs (Locate…, Choose portrait image…) cannot be answered over CDP; only call them with a payload that is refused first.
- The launch dialog is app-level and survives navigation; close it before the next step.
- `restart()` for second-start flows; `killHard()` for crash flows (the journal stays, the next start offers recovery). A hard kill in the first ~10 s of a data folder's first session loses the vault key (Chromium has not written `chromium\Local State` yet): call `waitForVaultKey(d)` first.
- `close()` is the renderer's `window.close()`, which skips main's close handlers: during a switch it acts as "Quit anyway" with no prompt. `closeWindow()` sends WM_CLOSE (the caption button's path): with "Keep running in the system tray" on (the default) the window hides and the app stays up; store `window.closeToTray` = `false` first to reach the quit prompt, which `knobs.quitDuringSwitch` answers. The tray icon cannot be clicked over CDP; `secondInstance()` brings a hidden window back.
- A refusal before anything is touched (a running launcher, preview mode, an elevated launcher, a game that needs an update) logs at WARN, so it needs no allow-list. A switch that fails after its first write (a rollback) logs `switch failed` at ERROR: allow that one line, `d.assertNoErrorLines([/\[main:steam\] switch failed /])`. The log is one file across `restart()`s.
- Skipped steps show no detail line; assert on the phase list ("not needed") or `Show details` ("skipped") instead.
- `settings:set` refuses the launcher path keys; fake scenarios seed accounts themselves.
- Never `--packaged` with `--fake`: the packaged exe ignores `ONELAUNCH_FAKE_LAUNCHERS` on purpose. Never point `--data-dir` under `%APPDATA%`.
- In fake mode Play is expected. Against real launchers (no `--fake`) never call `launch:start`, click Play, or press Restore.
