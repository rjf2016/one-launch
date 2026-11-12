# Update transcripts

Ticket M0-T06: what the updater does on each condition of its feed, recorded through the real engine (electron-updater) in the repo's own unpackaged build, on a loopback test feed, fake launchers `none` and a scratch data folder. Each condition is recorded three times and written to `<out>/l2/updates/` only when the three normalise to one transcript. What a transcript holds and how to compare against it is in `bundle/README.md`, which is copied into the bundle as `l2/updates/README.md`; this file is about the tooling.

## Layout

| Path | What |
| --- | --- |
| `capture.mjs` | Records every condition (or the ones named), stabilises the recordings, writes the transcripts, their normalisation reports and the bundle README |
| `check.mjs` | The ticket's acceptance checks, plus the 12.2 case, the verify findings and a scan of the transcripts |
| `conditions.mjs` | The conditions: which keys the build trusts, what the feed serves, which steps run |
| `record.mjs` | One recording: starts the app through `../ui/kit.mjs`'s `ShotDriver`, drives the steps, observes, reads the log, cuts it all into steps |
| `feed.mjs` | The loopback feed: records every request, answers through the condition's gate |
| `stabilise.mjs` | The tooling's own normalisation rules, then `../lib/normalise.mjs` over the recordings |
| `timers-preload.cjs` | Loaded into the app's main process: records the update timer being armed, firing and cleared |
| `bundle/README.md` | The bundle's README for `l2/updates/` |

## Commands

| Command | What it does |
| --- | --- |
| `node scripts/oracle/updates/capture.mjs` | Records all conditions three times each and writes `l2/updates/` |
| `node scripts/oracle/updates/capture.mjs <name> <name>` | Those conditions only |
| `node scripts/oracle/updates/capture.mjs --repeat [<name> ...]` | Records again and compares with the bundle's transcripts byte for byte (`SAME` or `DIFF` per condition); writes nothing into the bundle, a differing transcript goes to the scratch folder |
| `node scripts/oracle/updates/capture.mjs --readme` | Copies `bundle/README.md` into the bundle and records nothing |
| `node scripts/oracle/updates/check.mjs` | The checks; one `PASS` or `FAIL` line each, exit 0 only when all pass |

`--runs=<n>` records n times instead of three (two at least), `--out <folder>` names another bundle root (it needs `fixtures/updates`). The app must already be built (`out/`); nothing here builds it. App windows open while a capture runs. One full capture takes about 22 minutes (1321 s measured): 23 conditions, three recordings each, about 18 to 25 seconds a recording (the first check waits its 15 s), 35 seconds for `auto-off-during-download`, which waits for a second timer.

## Scratch folder

`ORACLE_SCRATCH`, by default `..\oracle-scratch\t06` beside the repo. Each recording runs in `run-<condition>` under it (data folder, fake launchers, control folder, `TEMP`), which the kit empties first and the recorder deletes after. Recordings that do not normalise to one transcript are kept in `unstable-<condition>` with a report; they hold scratch paths and ports, so they never go into the bundle.

## What a capture controls

- **Keys.** Only the throwaway key in the bundle's `fixtures/updates/README-keys.json`; no key is made, read or asked for. The signed manifest is the fixture `latest.yml`, so its signature bytes are the same on every run. A condition that needs another signature or key id edits the manifest text (`conditions.mjs` says how); `wrong-key` names the id `0000000000000000`, which no key has, because there is no second throwaway key to sign with.
- **Installer.** The 50 placeholder bytes the fixture manifest was signed over (ASCII text, not an executable), checked against the manifest's sha512 before anything runs. `hash-mismatch` serves 50 other ASCII bytes.
- **Version and dates.** The manifest's version `1.0.0-beta.4` and release date are the fixture's; the app is `package.json`'s version. Main runs on the oracle clock (the kit's preload), which only moves `Date`.
- **Feed.** `ONELAUNCH_UPDATE_FEED` is `http://127.0.0.1:<free port>/` and `ONELAUNCH_UPDATE_KEYS` the throwaway key (empty for `no-keys`). The driver strips both from its own environment first. `network-failure` names a port that was free a moment before and has nothing listening.
- **Log level.** The unpackaged build logs at `info`; the start step sets `logLevel` to `debug` through `settings:set`, so electron-updater's own lines (which the engine lowers to DEBUG) reach the log. That is the one setting a capture changes before the first check.
- **What the download can reach.** In test-feed mode the engine points electron-updater's cache at the data folder (`<data>\update-cache\pending`), and its updater overrides `doInstall` to log `update install (test feed, installer not run)` and return; the quit handler is never added (`autoInstallOnAppQuit` off) and no `publisherName` is configured, so no signature-verification process runs either. Nothing the feed serves is executed, at quit or on Restart to update.

## How states are observed

The service's state lives in a private field, so it is read the way the renderer reads it: a loop injected into the page calls `window.oneLaunch.invoke('updates:status')` back to back and keeps every answer that differs from the one before; the recorder copies that list every 15 ms. Nothing under `src/` changes.

What it can miss: a state that lasts less than one IPC round trip. Every state the feed can hold open is held instead of raced: the feed answers `latest.yml` only once `checking` has been seen, and the installer only once `downloading` has been seen, so both are in every recording. `update-ready` sends its installer in three parts, the second 1.2 s after the first (electron-updater reports progress at most once a second) and the last only once that report has been seen. The one state nothing can hold is `downloading` at 100 percent: electron-updater reports it when the body ends, and the service replaces it with `ready` or `failed` a few milliseconds later. Some recordings see it and some do not, so it is taken out of every recording (the `transient` rule).

A manual check's own answer (`updates:check` returns the state it set) is recorded in its step as `answer`.

## Timers

`timers-preload.cjs` replaces `setTimeout` and `clearTimeout` in the main process (on `node:timers`, because Electron copies that module's `setTimeout` onto the global after the preload has run) and records only the timers whose stack has `UpdateService.schedule` in it: `arm` with the delay, `fire`, and `clear`. It changes no delay. The recorder checks that the first check fires between 15 and 20 seconds after it was armed and fails the recording otherwise; the measured delay is not written anywhere, being a timing.

## Steps

A recording is cut into steps at the moments the recorder acts; everything observed between two cuts (states, feed requests, timer events, log lines) belongs to the step before. A step ends 750 ms after its state has settled, which is long after the service's last synchronous log line and its re-arm.

| Step | What starts it | Ends when |
| --- | --- | --- |
| `start` | The app is spawned; the recorder sets `logLevel` | The first-check timer is armed and a first state has been seen |
| `timer` | Nothing: the 15 s timer fires | The background check has settled |
| `manual` | `updates:check`, as the Check for updates button sends it | The check has settled (at once when the answer is already final) |
| `auto-on` | `settings:set updates.auto true` | The timer that arms has been seen |
| `timer-again` | Nothing: the timer `auto-on` armed fires | The background check has settled |
| `install` | `updates:install`, as Restart to update sends it | The app has exited |
| `quit` | The window is closed | The app has exited |

The `by` field of a step says which: requests in `timer` and `timer-again` came from the timer, those in `manual` from Check for updates.

## Normalisation

Rules of this folder, applied before `lib/normalise.mjs`, each reported in `l2/updates/normalisation/<condition>.json` with the paths it changed:

| Rule | What it touches | Why |
| --- | --- | --- |
| `port` | `127.0.0.1:<port>` in any string becomes `127.0.0.1:{port}` | The feed listens on a free port per recording |
| `noCache` | The `noCache` query value, and `noCache=<value>` inside a string, become `<t32>`, only at paths measured to differ | electron-updater adds `Date.now()` in base 32 to every manifest request |
| `transient` | `downloading` at 100 percent is dropped from every recording | Not holdable; see above |

Then `lib/normalise.mjs`: `root` turns the data folder, the scratch folder and this repo's root into `{data}`, `{scratch}` and `{repo}` (the repo's root appears in electron-updater's stack traces), and `ts` turns an ISO time into `<ts>` where the recordings differ (`checkedAt` of `up-to-date`). A recording is written only when every path the three disagree on is covered by a rule and no rule changed a path they agree on. The report lists, per condition, the rules and paths, the sha256 of each recording's transcript (all equal to the file's), and how many `downloading` at 100 percent each recording had.

The feed's `Date` header is switched off at the source rather than normalised.

## Reading a recording

`check.mjs` lists, per refusal reason of `verifyManifest`, the transcripts it appears in, reading the reasons from `src/main/updates/manifest.ts` when it runs. A reason only counts when the state's message and the service's `update verify failed` line both carry the exact text; `the release manifest is not an object` cannot be reached through the engine (its version check throws first), so `not-an-object` carries the verdict of `verifyManifest` called directly on the value the engine would have loaded, and says so.
