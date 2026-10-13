# Battle.net adapter

Code: `src/main/launchers/battlenet/` (`adapter.ts` `BattlenetAdapter`, `config.ts`, `client-log.ts`, `product-state.ts`, `products.ts`, `session.ts`). Tests: `test/battlenet-*.test.ts`. Generic switch flow, backups, recovery: `switching.md`.

## Rules

- The client signs in from **one cached token**: a `REG_BINARY` DPAPI value under `HKCU\Software\Blizzard Entertainment\Battle.net\UnifiedAuth`. It is rewritten at every sign-in and deleted by the client's logout. The value name is stable per account but not derivable, so snapshots store it verbatim.
- **The token is accepted only for the login first in `Client.SavedAccountNames`** of `%APPDATA%\Battle.net\Battle.net.config`. Otherwise the client logs `Deleting registry token because !m_lastEmailUsed.empty()` and shows its password page. So a switch always swaps the token *and* moves the target login first.
- Only those two things are ever written, and only in `runSwitch` and `applyRestore`, after a snapshot. Never write `Client.AutoLogin` (the user's "Keep me logged in"; turning it off deletes the token). Never create `Battle.net.config`. Never touch `Identity`, `EncryptionKey`, `Launch Options`, the per-account `<hex>.config` files, `CachedData.db`, `BrowserCaches\`, or `%ProgramData%\Battle.net`.
- Rewrite the config only when it round-trips byte for byte (Qt JSON: 4-space indent, CRLF, trailing newline, `\/` escapes; `detectLayout`/`serializeConfig`). Writes are atomic.
- Read and write nothing while any `Battle.net.exe` runs: the client writes the config at the very end of shutdown and the token at sign-in.
- The token is decrypted only in `writeRegistry` and `applyRestore`, and is never logged. Plans show byte count and fingerprint (`describeToken`). Backup manifests hold it vault-encrypted in `meta.unifiedAuth` as `[{name, enc}]`.

## Detection (`detectInstall`)

The first candidate folder that holds `Battle.net.exe` wins:

1. The `battlenet.path` setting (Locate; source `user`). If the exe is gone from it, detection falls through and health shows a `chosen-folder` warning.
2. `HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Battle.net` → `InstallLocation`.
3. The quoted exe in `HKLM\SOFTWARE\Classes\battlenet\shell\open\command`.
4. `C:\Program Files (x86)\Battle.net`.

- `HKLM\...\Blizzard Entertainment\Battle.net` holds no path; ignore it.
- `installFromExe` accepts `Battle.net.exe` or `Battle.net Launcher.exe`.
- `startExe` prefers `Battle.net Launcher.exe` (what the shortcuts run; it applies updates first).
- A chosen folder changes only the exe location. Config, logs and token are per-user and do not move.

## Library (`uninstallEntries`, `gamesFrom`)

- `registry.searchTree('HKLM', UNINSTALL_KEY, 'Blizzard Uninstaller')` runs `reg query ...\Uninstall /s /f "Blizzard Uninstaller" /d`, then one `listSubkeyValues` per product, in parallel. An unreadable key is skipped.
- **Never dump the whole Uninstall tree** (`queryTree`). It is about 165 K characters and takes tens of seconds under CPU load, which stalls the status pass.
- Key names are passed through as reg.exe reported them (they may contain `:` and similar), which is why `listSubkeyValues` exists. Reads run under `chcp 65001` and are decoded as UTF-8.
- An entry counts when its `UninstallString` names `Blizzard Uninstaller.exe`. The codename comes from `--uid=`, the name from `DisplayName`, the folder from `InstallLocation`. `battle.net` is dropped, and so are entries with no existing folder.
- `launcherGameId` = codename. `lastPlayedAt` comes from `Games.<codename>.LastPlayed` (unix seconds). The `Games` key lists played products, not installed ones.
- Each product has three names (`PRODUCTS`):

  | Name | Example | Used by |
  | --- | --- | --- |
  | codename | `prometheus` | the adapter |
  | program code | `Pro` | `--exec` |
  | TACT code | `pro` | `battlenet://`, `product.db` |

  Only `prometheus` (Pro/pro) and `hs_beta` (WTCG/hsb) are verified.
- `%ProgramData%\Battle.net\Agent\product.db` (protobuf) is scraped for (codename, TACT, path) strings by `parseProductDb`. It only fills in a TACT code the table lacks, and then the program code is guessed as the TACT code upper-cased. `aggregate.json` is read for health only.
- `needsUpdate` is the client's own verdict: the last `InstallState (<codename>): currentOperation=…` line of the newest client run (`productStates`, `productNeedsUpdate`). `Update` means its Play button reads Update; the refreshed line, about a second after the cached one, also carries `playable=0`. With no client log every product reads up to date.

## Switch (`buildSwitchPlan`, `runSwitch`)

Steps: `close`, `capture`, `backup`, `registry`, `file`, `start`, `wait`, `verify`, `manual`, `recapture`. `inPlace` = the token's owner is the target. `alreadyActive` = `inPlace` and running, and then nothing is touched. Strategy is `remembered` when `inPlace` or a non-stale snapshot exists, else `credentials`. `executable` is always true.

1. **Close** (`shutdown`): a window close for `Battle.net.exe`, then wait up to 30 s for every process to exit. Then a forced kill of the `Battle.net.exe` processes **without their tree**, so a running game survives. Then watch for a self-restart: 1.5 s when the log gained `Shutting down battle.net interface` since the close (the client shut itself down), else 5 s; if one happens, wait for a new log's `main-window` and close again (3 attempts max). `HideOnClose`/`DisplayExitPrompt` in the per-account `<1-8 hex>.config` (the current id's file, else the newest) predict a hang; the plan warns.
2. If the client is running again, stop before reading or writing anything (`startedMeanwhile`).
3. `saveOutgoing` (best effort): store the now-final token for its owner if the fingerprint changed. Unowned tokens are not saved.
4. `takeSnapshot`: the config plus every `UnifiedAuth` value. A token that no account owns gets the snapshot **pinned** (`UNOWNED_SESSION_PIN`), because the next step deletes it and this is its only copy. `restoreBackup` pins its pre-restore snapshot by the same rule.
5. `writeRegistry`:
   - remembered: write the stored value under its recorded name if it differs, and delete every other value.
   - credentials: delete all values, which is what a logout does, so the login page opens.
6. `writeFile`: re-read the config (rewritten at exit) and move or add the target login at the front of the comma-separated, lower-case list.
7. Start: if the client is already running here, throw and roll back. Otherwise record a log mark, spawn `startExe` with no args, and poll up to 90 s.
8. Verify, hand over, recapture (below). The result's `readyAt` is 5 s later (`readyGraceMs`), because earlier launch requests are dropped; only a game launch waits for it, a plain switch returns at once.

On failure after a write, the client is closed first. `applyRestore` then puts back only `configPath()` and exactly the recorded token values, decrypting the token meta before touching anything. After a lost DPAPI key, no Battle.net snapshot restores. `restoreBackup` refuses while the client runs.

## Sign-in confirmation (`client-log.ts`)

- Log: the newest `%LOCALAPPDATA%\Battle.net\Logs\battle.net-<UTC stamp>.log`.
  - `newestClientLog` **skips forwarder logs**: a second `Battle.net.exe --uri=`/`--exec=` writes `IPC ShMem mode=client` or `Leaving because another instance` in its first 4 KB.
  - Timestamps are UTC.
  - Reads are tail reads (newest 8 MB) from a `logMark` `{file, size}`. A new file is a new run, read from 0.
- Events:

  | Log text | Event |
  | --- | --- |
  | `Logged into Battle.net successfully. \|bnet=1:0:<hex>\|` | signed-in; the hex (1-16 digits, lower-cased) is `launcher_uid` |
  | `Deleting registry token`, `Login failed.`, `OnLoginFailed()`, `External Challenge was canceled` | failed (reason masked by `maskReason`) |
  | `Logout() : calling DeleteToken`, `DeleteToken() because !enabled` | signed-out |
  | `InstallState (<codename>): currentOperation=<op> currentOperationStatus=<status> … playable=<0/1>` | product-state (`UpToDate` or `Update`; `playable` is absent on the cached line for some products) |
  | `LaunchBinary: uid=<codename>`, `Operation status changed: opType=Execute … newStatus=Pending agentUid=<codename>`, `InstallState (<codename>): GameLaunching=1` | game-launching |
  | `Operation status changed: opType=Execute … newStatus=On agentUid=<codename>`, `Game is running: <codename>`, `InstallState (<codename>): gameRunning=1` | game-running |
  | `Operation status changed: opType=Execute … newStatus=Off agentUid=<codename>`, `InstallState (<codename>): gameRunning=0` | game-exited |
  | `Launch request <code>. isRunning=` | launch-request (client builds before 2.52.12; not seen since) |

- Verdicts (`waitForSignIn`):
  - With a known uid: a match, or `wrong-account`.
  - With no uid (imported accounts start without one): an id held by another account is `wrong-account`; any other id is accepted and linked (`linkIfNew`). An unknown Battle.net account is therefore not caught.
  - `wrong-account` rolls back.
- Remembered path: wait 60 s. On `failed` with the target login first (`listReady`, from the file step or the plan's `loginFirst`), mark the snapshot stale. A rejection while the list could not be fixed does not mark it stale.
- **Hand-over** (`waitForManualSignIn`): up to 10 min, with an attention prompt telling the user to click **"Switch account"**. The page opens on the password step of the *last* account, from cookie state One Launch does not touch. Failed attempts are not final. The credentials path polls once and hands over at once. A timeout returns `needsSignIn`; a cancel leaves the client on its login page with no rollback.
- `captureFresh`: after every confirmed sign-in, store the first token whose fingerprint differs from what was written, because the client rotates it at each sign-in. `storeSession` links the uid before saving, so a refused link leaves no row.
- Owner (`currentSession`):
  - while running: the log.
  - when closed: a stored-fingerprint match, else the last run's log unless that run ended signed out.

## Capture and import

- `captureSession` refuses when:
  - there is no token
  - the client is running with no sign-in this run
  - the client is closed and the last run ended in logout
  - another account owns the token
  - the logged uid differs from the linked uid
- Blob: `{v:1, unifiedAuth:{name, hex}}`. `parseBlob` also accepts a legacy v2 and ignores its extras.
- `listRememberedAccounts` returns `SavedAccountNames` logins with an empty uid (it is learned at first sign-in).

## Launch (`launchGame`)

- Default (`battlenet.launch` = `exec`): `"<installDir>\Battle.net.exe" --exec=launch <ProgramCode>` (one argv token). The forwarder hands it to the running client.
- `uri`: `battlenet://game/<tact>` via `shell.openExternal`. In a running client this **only selects the game page**.
- The codename must match `^[A-Za-z0-9_.-]{1,64}$`. An unknown code throws.
- Before anything is sent, the current run's product state is checked: `Update` throws `GameNotPlayableError` ("<game> needs an update before it can start…"), and `playable=0` with another operation the same error ("<game> is not playable right now…"). Its code `GAME_NOT_PLAYABLE` is a refusal (logged at WARN); the job fails with the switch kept ("only the game launch failed").
- The same refusal for a game the current run's log shows launching or running and not ended since (`gameRunning`, the game-exited event closes it): "<game> is already running. Close it, then press Play again." The client drops `--exec` for a game it sees running and logs nothing for it, so without the check the watch below ran its 15 s and the message blamed an update. Seen with Overwatch started from the client's window after its update, the client gone when One Launch started it, and the game's process still up for a third of a second after the command. A game the client has not noticed yet is not caught; the command is then dropped as before.
- After sending, the adapter watches the log for 15 s for a game-launching or game-running event for the codename (`gameStarted`; the pre-2.52.12 `Launch request` line still counts). A confirmed start reads "(Battle.net started the game)". An `--exec` the client did not act on **fails the launch**: for a product it wants to update or repair the client only selects the game page and logs nothing else, so silence means the game did not start. The `uri` form is only annotated, since the link opens the page by design.
- With `Client.GameLaunchWindowBehavior = 2` the client exits after launching, so the next switch usually starts it fresh.

## Client self-update (observed, not yet used by the adapter)

Seen on build 2.53.0, started by a switch through `Battle.net Launcher.exe` (the log's command line is `--from-launcher`). The launcher had already replaced the client's files: the first log line named the new build.

- About 3 s into the run: `Starting [Auto] UPDATE operation for "battle.net".`, then `Operation status changed: opType=Update oldStatus=Off newStatus=On agentUid=battle.net`.
- It ends with `Self-update patch applied: seqn <a> -> <b>`, `Update completed: battle.net`, and `Operation status changed: opType=Update oldStatus=On newStatus=Off agentUid=battle.net`.
- `seqn 22 -> 22` (build 2.52.12) changed nothing. `seqn 22 -> 23` came with `SelfUpdate received by SelfUpdateEventProxy. isCriticalUpdate=true applyUpdateNow=true`: the client then shows its own "update required" prompt, stays signed in, and logs nothing more until the user answers it.
- That operation ran for 12 s and ended 2 s **after** the switch had finished: sign-in was confirmed 8 s into the run, the ready grace ended at 13 s, the prompt came at 15 s. A launch sent in between is the case the `--exec` gotcha below describes; the adapter does not look for these lines.
- The client sat on that prompt, signed in, for over an hour and a half without restarting. A `close()` with the prompt showing was honoured at once: `Game launch sequence canceled` 0.4 s after the message, `Shutting down battle.net interface` 1.3 s after it, and no `Frontend is requesting to close window` line (that one is the frontend's own close button). It did not come back during the 5 s restart watch. The next start through `Battle.net Launcher.exe` wrote its first log line, already naming the new build, under a second after the spawn, and logged no update operation in its first 12 s.
- The client lists itself as a product: `Setting Process Running: true uid=battle.net binaryType=game` and `Operation status changed: opType=Execute oldStatus=Off newStatus=On agentUid=battle.net`. `parseLogEvents` reads the second as a game-running event for `battle.net`. `gameStarted` matches on the game's codename, so nothing is confirmed by it; anything that asks whether *any* game runs must skip `battle.net`.
- `InstallState (): currentOperation=Install …` with an empty codename is logged at start; the parser skips it.
- The cached product line also carries `localVersion=` and `latestVersion=`. They differed for a game the client wanted to update, and its refreshed line a second later held only `background_download_available=1`, with no `playable=`.

## Health (`healthCheck(known?)`)

Checks: `install`, `chosen-folder`, `process`, `uninstall`, `product-db`, `aggregate`, `config` (AutoLogin, round-trip), `token` (count, owner), `prefs`, `log`, `sessions` (stale), `backups`.

- It takes `KnownLauncherState` from the status pass rather than re-detecting.
- It runs the Uninstall search once and feeds `gamesFrom` directly.

## Tried and rejected

- A token swap alone: rejected unless the login is first in the list.
- Swapping the login page's Chromium cookie store: changes only the "Welcome back" email.
- Re-ordering `CachedData.db` `login_cache` rows: no effect.
- `battlenet://` as the default launch: it only selects the page.

## Gotchas

- An elevated client: its window refuses the close, and `ProcessAccessDeniedError` is raised at once, in every display language.
- The restart watch runs on every close (1.5 s after a logged shutdown, else 5 s), and the 5 s ready grace delays every game launch after a start. The one observed close of a client with a pending update (Client self-update, below) brought no self-restart: the watch found nothing, and `Battle.net Launcher.exe` applied the update at the next start.
- The client deletes its older log files at start (`Removing old/extra log file: …`). Copy a log worth keeping before the next start.
- A product the client wants to update swallows `--exec` silently: only `Received IPC Message: IPC_COMMAND` and `Selecting game family by id: <code>` are logged (2026-09-24). The client itself updating (`Self-update patch applied`) at that moment does the same.
- A UTF-16 config fails parsing, and the file step is skipped (fails closed).
- Whether games are children of `Battle.net.exe` is unverified.
- Live read-only check: `$env:ONELAUNCH_LIVE='1'; npx vitest run test/battlenet-live.test.ts`.
- Fixtures (`test/fixtures/battlenet/`) must mask logins and `|bnet=|`/`|game=|` ids, keep the byte layout, and never hold a token.
