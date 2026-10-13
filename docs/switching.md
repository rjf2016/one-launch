# Switching and launching

How a switch-then-launch job runs, the rules every adapter follows, backups, and crash recovery. Launcher-specific files, keys, log lines, and timings live in `adapters/steam.md`, `adapters/epic.md`, `adapters/battlenet.md`, `adapters/riot.md`.

Key files: `src/main/launchers/types.ts` (contract), `src/main/services/launchers.ts` (`LauncherService`), `src/main/services/launch.ts` (`LaunchService`), `src/main/services/backup.ts`, `src/main/services/switch-journal.ts`, `src/main/services/sessions.ts`, `src/main/launchers/wait.ts`, and each adapter's `runSwitch` in `src/main/launchers/<id>/adapter.ts`.

## Invariants (do not break)

1. **Only `runSwitch` and `applyRestore` write launcher-owned files or registry values.** Everything else (plans, preflight, health, status, listing) is read-only.
2. **Snapshot before the first write.** `takeSnapshot` runs after the launcher is closed and before any write. `opts.onBackup(id)` puts the id in the journal on disk before the first write. Epic, Battle.net and Riot call it from `takeSnapshot`; Steam calls it just before its first write, so a Steam switch that writes nothing leaves no recovery prompt.
3. **Atomic writes.** Launcher files go through `writeFileAtomic` / `writeFilesAtomic` (temp file in the same folder, then rename; all temps are written before the first rename). The journal also calls `fsync`.
4. **Nothing is read or written against a running launcher** (launchers rewrite their files on exit). After the close and again at the start step the switch re-checks the process list. A launcher that something else started fails the switch: nothing changes before the writes, and after them it rolls back.
5. **Never close a launcher without consent.** A real switch that would close a running launcher that is not `alreadyActive` throws `CONFIRM_REQUIRED` unless `confirmClose` is set. This is checked in the dialog's preflight, in `LaunchService.start`, and at the top of `runSwitch`.
6. **A failure after the first write rolls back.** The adapter closes the launcher (with no signal, so this cannot be interrupted), restores the snapshot, and leaves the launcher closed: `restored: true`, or `restored: false` with both errors.
7. **2FA or a sign-in form never fails a switch.** It hands over to the user; a timeout gives `needsSignIn` with no rollback.
8. **One job at a time.** IPC handlers that change accounts, sessions, backups, or launcher paths call `requireIdle()` (`src/main/ipc/index.ts`) and get `BUSY` while a job runs.
9. **Secrets.** `AccountRef` never carries a password. `getPassword()` and session blobs are decrypted only at the moment of use and never logged. The journal holds ids only.

## Adapter contract (`LauncherAdapter`, `types.ts`)

- Read-only: `detectInstall`, `chosenInstallDir`, `installFromExe`, `isRunning`, `runningGame`, `listInstalledGames`, `listRememberedAccounts`, `healthCheck(known?)` (`known` passes on the install and running state the caller already has; each registry read or process check is a child process).
- `shutdown({ signal })`: graceful, then force kill. An aborted signal throws `SwitchAbortedError`.
- `preflight(account, forGame?)`: `plan` (its start step for the game a launch follows with, when one is named), `launcherRunning`, `runningGame`, `alreadyActive`, and `closeMessage` (the adapter's own sentence, shown as is).
- `switchAccount(account, opts)`: with `dryRun: true` it returns a `SwitchPlan` (every file, value, and process touched, secrets masked) and writes nothing; with `dryRun: false` it runs `runSwitch` and returns a `SwitchResult` (`ok`, `needsSignIn`, `cancelled`, `backupId`, `restored` where `null` means nothing was modified, `error`, `steps`, `readyAt`: from when the launcher the switch started takes a game launch, or `null`, and `startedWithGame`: the game the launcher was started with its own launch arguments for, or `null`).
- `SwitchOptions`: `confirmClose`, `onProgress(steps)` (the full list on every change), `onBackup(id)`, `onAttention(a | null)`, `signal`, `getPassword`, `game` (the game a launch follows the switch with; Riot starts the client with its launch arguments).
- `launchGame(game, { signal, startedBySwitch })` returns `{ command, handOff? }`; `startedBySwitch` says the switch started the launcher with this game's own arguments (`startedWithGame`), so Riot sends nothing and only confirms. Battle.net and Riot watch for a reaction afterwards (the client's log; Riot also the game's process name) and refuse beforehand with `GAME_NOT_PLAYABLE` when the client wants to update the game first. `handOff` is what the user must still do in the launcher window when the launcher only opened the game's page (Riot: press Play); `LaunchService` puts it on the job, and the dialog then ends "Switched to" with that sentence instead of "Launched as". Riot presses Play itself when `riot.pressPlay` is on, the default (`adapters/riot.md` › Launch), so `handOff` comes only when it is off or the request did not take. `gameIcon?(game)`: the launcher's own icon file for a game, Riot only (`artwork.md`).
- `restoreBackup(id)`: refuses with `LAUNCHER_RUNNING` while the launcher runs, takes a "Before restoring `<id>`" snapshot (`protect: id`), then `applyRestore`.
- `sessionState?` and `captureSession?`: Epic, Battle.net and Riot only.
- Refusals before anything is touched **throw** (`CONFIRM_REQUIRED`, `SWITCH_BLOCKED`, `GAME_RUNNING`, `NOT_INSTALLED`, `LAUNCHER_FILE`). Anything after the switch has started **returns** `ok: false` with the rollback state.
- `AccountDirectory.setLauncherUid` fails closed (`DuplicateAccountError` propagates), and `storeSession` links the uid before saving, so nothing is stored under an id another account holds.

## Isolation: `LauncherService`

- The only way into the adapters. Every call goes through `guard(id, op, fn)`: it counts in-flight work (`track`) and rethrows as `AdapterError` (`"<Launcher>: <reason>"`), keeping the inner `code`.
- `NOT_INSTALLED` is logged at debug, since a missing launcher is normal. An expected refusal, one whose code is in `REFUSAL_CODES` (`src/main/services/refusals.ts`: the launcher is running, preview mode, confirmation needed, an elevated launcher, a game that needs an update, a Riot game running…), is logged at WARN here, in `LaunchService`, in the IPC wrapper, and by an adapter that had not written anything yet. Everything else is logged at ERROR, or at debug after `closing()`, because at quit the database closes under calls still in flight. An ERROR line therefore always means something unexpected.
- `status()` bypasses `guard`. Each launcher's pass has its own try/catch, and a throw becomes `attention` on that row only.
- At quit, `closing()` and `whenIdle(1.5 s)` let a status pass or scan finish before `will-quit` closes the database.

## The launch job (`LaunchService`)

**Preflight** (`launch:preflight`) is read-only. It calls the adapter's preflight, then adds:
- `dryRun`: `settings.getBool('dryRun', false)`.
- `needsConfirmation` = `launcherRunning && !alreadyActive`. `closeMessage` is sent only when confirmation is needed.
- `blocked`: the plan's first warning when `plan.executable` is false. In practice only Epic or Riot with no settings file, so the dialog's blocked stage offers Back and nothing else.

**`start({accountId, gameId|null, confirmClose})`**: refuses with `BUSY` (busy or closing) or `DRY_RUN`. It sets `starting` synchronously *before* awaiting the preflight, so two concurrent starts cannot both pass. It rejects a game and account from different launchers, and when `confirmClose` is false checks the preflight again (throwing `CONFIRM_REQUIRED`, which sends the dialog to its confirm stage); the dialog's own preflight answers that check when it is for the same account and under 10 s old, so the usual Play pays for one plan here, not two. Each preflight answers one start. Then it creates the job with a fresh `AbortController`, runs `run()` in the background, and returns a snapshot. `gameId: null` means switch only.

**`run()`**:
- Begins the journal, then calls `launchers.switch()`. `onProgress` replaces `job.steps` (plus the game's `launch` step); `onAttention` sets `job.attention`.
- Clears the journal as soon as the switch settles, before the game launch, so a crash during the launch never offers to undo a finished switch.
- `!ok` ends the job `cancelled`, `needs-sign-in`, or `failed`.
- `ok` sets `switched = true`. When a game follows and the result names a `readyAt` (the launcher the switch started takes a launch only from then on; Battle.net drops earlier requests), the launch step waits for it; a switch without a game never does. If the signal has aborted by then, the game launch is skipped and the job ends `cancelled`; otherwise `launchGame` runs, with `startedBySwitch` when the result's `startedWithGame` is the job's game, and the job ends `done`. The switch gets the job's game as `SwitchOptions.game`, and the dialog's preflight names it so the plan's start step is the real one.
- A throw (a refusal, or `launchGame` failing) ends the job `failed`.
- One `launch_history` row per job with a game (`needs-sign-in` counts as `failed`). Only the newest 20 finished jobs stay in memory; `launch:status` for an older one is `NOT_FOUND`.

**Steps and phases:** the adapters' step ids are `close`, `capture`, `backup`, `file`, `registry…`, `start`, `wait`, `verify`, `login`, `manual`, `recapture`, and `LaunchService` adds `launch`. `src/renderer/src/lib/phases.ts` folds them into five phases. A new step id must be added there (otherwise it falls into "Switch") and, if it runs after the writes, to `AFTER_WRITES` in the journal.

**Renderer:** `LaunchHost.tsx` polls `launch:status` every 150 ms while `running`. `LaunchDialog.tsx` picks the outcome sentence from `state`, `switched`, and `restored`. See the renderer doc.

**Cancel and quit:** `cancel(jobId)` aborts only the current running job. At quit, "Quit anyway" calls `stop()` (sets `closing`, aborts), then `whenIdle(10 s)`. Logoff (`session-end`) does the same without a prompt. A switch that outlives the wait leaves its journal behind.

## Cancellation semantics

The abort reaches every wait through `src/main/launchers/wait.ts`:
- `sleep(ms, signal)` resolves early on abort and never rejects.
- `waitUntil(cond, {timeoutMs, pollMs, signal})` returns true or false, and throws `SwitchAbortedError` on abort. `runSwitch` turns that into a cancelled result; it never reaches the renderer.

Use these helpers, not private timers, for any new wait. What an abort does depends on where the switch is (tracked by `launcherStarted`, `stopIfAborted`, and the `catch` in `runSwitch`):

1. **Before any write:** the switch stops with `cancelled` and `restored: null`: "Nothing had been changed."
2. **After the writes, before the launcher starts:** `stopIfAborted()` in front of the start throws. The launcher is still closed, so the snapshot is restored: `cancelled`, `restored: true`.
3. **After the launcher was started:** the wait ends, the writes stand, and the launcher finishes signing in by itself: `cancelled`, `restored: null`. Rolling back here would mean a close of up to 40 s that cannot be interrupted, which would defeat quit.
4. **After sign-in was confirmed** (capture, or the wait for `readyAt`): `ok: true`, and `LaunchService` skips the game launch.

In the UI, the launch dialog's Stop and the sign-in panel's Stop waiting both call `launch:cancel`, so any of these can be reached while the dialog is open. Quit reaches them too.

## Hand-over (the launcher needs the user)

- Triggers: Steam Guard, a rate limit, an expired or rejected session, the credentials path (no usable saved sign-in), a Battle.net password page, or the Riot Client's login page.
- The adapter calls `onAttention` with a `LaunchAttention` (`title`, `message`, `reason`, `canCopyPassword`, `until`) and polls for up to `manualSignInMs` (10 min). The dialog offers Copy login, Copy password, and Stop waiting. During the manual wait a failed attempt is not final.
- A timeout gives `needsSignIn`: nothing is rolled back and the user finishes in the launcher.
- Steam's `-login <user>` opens its form. A password goes on the command line only when `steam.autoLogin` is on, and if Steam rejects it the switch fails (with rollback) rather than handing over.

## Wrong account and adoption

- Epic and Battle.net confirm a sign-in from the launcher's log, which gives an opaque account id; Riot takes the verdict from the log and the id from the session file.
  - The account already has a launcher uid: another id means `wrong-account`.
  - The account has no uid, and the logged id belongs to another One Launch account: `wrong-account`. The error names that account.
  - The account has no uid, and no account owns the logged id: it is **adopted**. `linkIfNew` sets the uid and the step detail says "Linked to … account …1234". A manual sign-in as a stranger's account therefore gets linked. This is shown to the user, not refused.
- A `wrong-account` result throws, so it fails the switch and rolls back.
- Steam checks identity (`verifyIdentity`) only on the credentials path for an account with no known SteamID, by cross-checking `loginusers.vdf`.

## Session capture (Epic, Battle.net, Riot)

- `LauncherSessionStore` (`sessions.ts`) keeps one vault-encrypted blob per account in `launcher_sessions`, plus `fingerprint`, `launcher_uid`, `verified_at`, and `stale_reason`. Reads never select the ciphertext column. Only `decrypt()` returns the blob.
- In a switch, `capture` saves the **outgoing** account's session once the launcher is closed. It is best effort: a failure costs a manual sign-in later, never the switch. `recapture` stores the **incoming** account's fresh blob after sign-in and marks it verified. Only a session the launcher explicitly refused is marked stale; a network failure is not.
- Strategy: `remembered` when a non-stale snapshot exists (or the session is already in place), else `credentials`.
- **Unowned sign-ins:** when the closed launcher remembers a session no One Launch account owns, the switch replaces it and can store it for no one. The pre-switch snapshot (and a restore's "before restoring" snapshot) is then **pinned** (`holdsUnownedSession()`), and the plan warns about it. Restoring that snapshot brings the sign-in back.

## Preview mode (`dryRun` setting)

OFF unless stored as `true`, so Play switches for real on a new install. When it is on, the dialog shows the plan (with "Turn preview off and play now") and `launch:start` refuses with `DRY_RUN`. The plan itself (`launchers:switchPlan`) is always available and read-only.

## Backups (`BackupService`)

- Layout: `<dataDir>\backups\<launcher>\<id>\manifest.json` plus the copied files. `<id>` is the ISO time with `:` as `-` (plus `-2`… on a collision), so ids sort chronologically; an id without that shape is never joined onto a path.
- Manifest: `version: 1`, `launcher`, `createdAt`, `reason`, `files[{relative, source, existed, bytes, sha256, encrypted?}]`, `meta` (registry values; `null` = absent), optional `pinned` reason. `sensitive` files (Epic's settings) are stored as vault ciphertext at `<relative>.enc`.
- Retention: each `snapshot()` prunes to the newest `backups.keep` ordinary snapshots (default 20) plus the newest 10 pinned ones (`PINNED_BACKUPS_TO_KEEP`), never the `protect` id.
- `restore(launcher, id, targets)` refuses a `source` that is not one of the adapter's current target paths (such as a moved install), a snapshot from another launcher, and a malformed one. It verifies every hash and decrypts every file before the first write, then writes them all atomically. Files with `existed: false` are left alone. The adapter's `applyRestore` then puts `meta` back.
- Entry points: Settings › Backups, the recovery prompt, and a switch's rollback, all through the adapter. A successful `backups:restore` also settles a pending recovery for that launcher.

## Switch journal and crash recovery (`switch-journal.ts`)

- `SwitchJournal` keeps `<dataDir>\switch.json` (`version`, `jobId`, `launcher`, `accountId`, `startedAt`, `updatedAt`, `backupId`, `stepId`, `rollbackFailed`). It is written with temp file, `fsync`, rename, and is a file so that it survives a broken database. Errors are logged and swallowed; the journal never stops a switch.
- `begin` runs before the adapter call, `update` on `onBackup` and on each running-step change, and `clear(jobId)` when the switch settles (only if the file still belongs to that job). The file is kept when the rollback failed (`rollbackFailed: true`) or the adapter threw after a snapshot existed.
- `SwitchRecoveryService.load()` runs once at startup, before `LaunchService` exists. An unparsable file is renamed `switch.json.unreadable`; `backupId: null` is dropped (nothing was written); anything else becomes the pending recovery.
- `recovery:get` gives `phase` (`rollback-failed`; `signing-in` when `stepId` is in `AFTER_WRITES`; else `writing`) and `snapshotAvailable`. A non-null `backupId` does not prove a write: Epic, Battle.net and Riot report the snapshot when it is taken, and all their writes can turn out to be no-ops.
- `recovery:restore` goes through `requireIdle()`, then `LauncherService.restoreBackup`. It fails while the launcher runs, and the prompt stays. `recovery:dismiss` deletes the file. The UI is `RecoveryDialog.tsx`.
- There is one file, so a switch on another launcher overwrites a `rollbackFailed` entry. The snapshot stays in Settings › Backups.
