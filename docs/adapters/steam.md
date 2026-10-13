# Steam adapter

Code: `src/main/launchers/steam/` (`adapter.ts` = `SteamAdapter`, `loginusers.ts`, `manifests.ts`, `vdf.ts`, `login-log.ts`, `bootstrap-log.ts`). Tests `test/steam-*.test.ts`, fixtures `test/fixtures/steam/`. Generic switch flow, snapshots and recovery: `../switching.md`.

## Rules

- Never store or read a Steam session; only tell Steam which remembered account to use. Never read `%LOCALAPPDATA%\Steam\local.vdf` (token store); session age comes from `loginusers.vdf` `Timestamp`.
- Writes happen only in `runSwitch` and `applyRestore`. Close Steam, snapshot, then write: Steam rewrites `loginusers.vdf` on exit, so a rollback and a restore also need Steam closed.
- Silent switching never needs a password. The password goes on the command line only with `steam.autoLogin` on (default off).
- Never close a Steam nobody confirmed closing. A Steam found running after the close step fails the switch (`startedMeanwhile`); the password retry (which closes Steam) runs only against a Steam this switch started and never mid-update.
- Steam Guard is handed to the user, never worked around.
- Names are sensitive: `parseLoginUsers` registers every account/persona name with `redactAccountNames` (log shows `[ACCOUNT]`); manifest `LastOwner` is never surfaced; fixtures use placeholders.
- Read-only live check: `$env:ONELAUNCH_LIVE='1'; npx vitest run test/steam-live.test.ts --silent=false`.

## Detection

`detectInstall()`, first hit containing `steam.exe` wins:

1. `steam.path` setting (Locate in Settings), source `user`. If `steam.exe` left it, detection falls through and health warns (`chosen-folder`).
2. `HKCU\Software\Valve\Steam\SteamPath` (forward slashes, lowercase; normalised); `SteamExe` refines `exePath`.
3. `HKLM\SOFTWARE\WOW6432Node\Valve\Steam\InstallPath`.
4. `C:\Program Files (x86)\Steam`.

`installFromExe` accepts only a file named `steam.exe`; the IPC handler writes the setting. A chosen folder only moves file lookups: the HKCU values below belong to whichever Steam ran last.

## Library

- Folders: install dir, then each path in `steamapps\libraryfolders.vdf` (block form with `"path"` or pre-2021 flat form; backslashes escaped), deduplicated. Unparsable: warn, scan the main folder only. Folders can be shared with other launchers.
- `steamapps\appmanifest_<appid>.acf` kept when `StateFlags & 4` (observed 6 = installed + update required: test the bit), not in `STEAM_TOOL_APPIDS` (redistributables, Linux runtimes). `needsUpdate` = bit 2; still listed. `installPath` = `steamapps\common\<installdir>`, clamped under `common`.
- Running game: `HKCU\...\Steam\RunningAppID` (0 idle) + `Apps\<id>\Name`; fallback is a process under a game folder.

## Accounts (`<install>\config\loginusers.vdf`)

LF, no BOM, tabs, quoted. `"users" { "<steamid64>" { AccountName, PersonaName, RememberPassword, WantsOfflineMode, SkipOfflineModeWarning, AutoLogin, Timestamp } }`.

- Current clients write `AutoLogin`, older ones `MostRecent`: synonyms everywhere.
- Ids matched by shape `^\d{15,20}$`; blocks without id or `AccountName` skipped. Lookup by SteamID64, then login (case-insensitive).
- Import keys on SteamID64; `sessionMayBeExpired` when `Timestamp` is absent or older than `STALE_SESSION_DAYS` (60). The adapter never sets `launcherUid` on a hand-made account; the plan warns on a mismatch.
- No session capture for Steam.
- UTF-16 or empty file: no `users` block, plan warning, credentials path. Fails closed.

## Switch

Strategy `remembered` when the target block has `RememberPassword=1`, else `credentials`. `executable` is always true.

**Writes (remembered):**
- `loginusers.vdf` via `planAutoLoginRewrite`: every `AutoLogin`/`MostRecent` line `1` for the target, `0` for others; a block with neither gets `AutoLogin`; all other bytes preserved. `writeFileAtomic`, skipped if no-op. Re-read after shutdown (Steam just rewrote it).
- `reg add HKCU\Software\Valve\Steam /v AutoLoginUser /t REG_SZ /d <login> /f` and `/v RememberPassword /t REG_DWORD /d 1 /f` (usually absent on current builds; harmless). Each is re-read after shutdown and written only when it differs, so a switch whose file and values already name the target writes nothing and has nothing to roll back.
- Snapshot: the file + meta `{AutoLoginUser, RememberPassword}`; restore sets or deletes each value. `applyRestore` only writes the current install's `loginusers.vdf`.

**Already active:** file and `AutoLoginUser` name the target and, if Steam runs, `signedInAs` holds (`ActiveUser` = target SteamID3 and the whole login log's last decisive line is not `WaitingForCredentials`). Nothing closed or written.

**Fast path:** `steam.exe -shutdown` (30 s, then a forced kill of `steam.exe` and its tree, 5 s), running check, snapshot, writes, plain start, process wait 60 s, confirm.

**`-login` path** (credentials strategy, or expired-session retry):
- Setting off: `steam.exe -login <login>`. With Steam fully exited this opens an empty sign-in form (name not prefilled); verify is skipped and the user gets the hand-over at once.
- Setting on + password stored: `-login <login> <password>`. Fetched via `opts.getPassword` inside `startSignIn` only, never logged, but visible on `steam.exe`'s command line to same-user processes while that Steam runs.
- `-login` leaves "Remember me" on: one time per account per PC, then the fast path.
- With no known id, `verifyIdentity` checks `ActiveUser` against the block Steam wrote for that login.

## Confirming sign-in

`waitForSignIn` polls every 500 ms:

- `HKCU\Software\Valve\Steam\ActiveProcess\ActiveUser` (DWORD) = SteamID64 - 76561197960265728. Not cleared on exit: a value equal to the pre-start one counts only with a `Success` log line since the mark. With no known id, any new non-zero value counts.
- `<install>\logs\steamui_login.txt`: `[<time>] [ <phase> ] SetLoginState: <State> - <reason>`. Last `Success` or `WaitingForCredentials` wins. `classifyReason`: `Account Logon Denied` -> `guard-email`; `Need Two Factor` -> `guard-mobile`; `Invalid Password` -> `password`; `License expired` -> `expired`; rate limit -> `rate-limit`; `OK` -> `none`. Two-factor and invalid-password wordings are unobserved.
- Marks: log size at switch start and right before each spawn; reads cover only appended text (tail at most 512 KB; shrunk file read from 0). Steam rotates at ~512 KB to `steamui_login.previous.txt`. Only `signedInAs` reads the whole log.
- Budgets: 60 s (`signInMs`) after a plain start, 120 s (`guardMs`) after `-login`.
- Self-update: updates apply at start before the UI, so the login log is silent. `bootstrap-log.ts` reads `logs\bootstrap_log.txt` since its mark: `Downloaded new manifest`/`Downloading update`/`Found pending update`/`Installing update`/`Extracting package`/`Update complete, launching Steam` = updating; `Verification complete` = settled; lines after `Background update loop` ignored until the next `Startup - updater built`. While updating and `steam.exe` runs, the deadline becomes now + budget, capped at 15 min (`updateMs`). Timeout while updating returns `updating: true` (no retry).
- Readiness: if the switch started Steam, it waits up to 5 s (`readyGraceMs`) for `Success` before returning, since `ActiveUser` can name the account before the library loads. Abort here still returns ok.

## Hand-over

- Remembered, not signed in: retry with password only if `withPassword`, Steam was started by this switch, cause not in `NEEDS_USER` (`guard-email`, `guard-mobile`, `rate-limit`), and not updating. A `password` cause after `-login` throws (rollback if modified).
- Otherwise `waitForManualSignIn`: `LaunchAttention` from `attentionFor` (Copy login, Copy password when stored), polls `ActiveUser` up to 10 min, then continues to the game.
- Timeout = `needsSignIn`, stop = `cancelled`; neither rolls back (writes are correct, Steam is on its form).
- A PC new to an account gets `Account Logon Denied` (email Guard, on by default) and an empty form. The user signs in once with "Remember me" and the code.

## Launch and health

- `launchGame`: id `^\d+$`, `shell.openExternal('steam://rungameid/<appid>')`.
- `healthCheck(known?)`: `install` (absent forces `absent`), `chosen-folder`, `process`, `loginusers`, `most-recent-key` (none or several marked = warn), `registry` (`AutoLoginUser` absent or disagreeing = warn), `libraries`, `games`, `backups`. Status = worst check.

## Tried and rejected

- Reading `local.vdf` for session validity (credential store).
- Extending the sign-in budget on any log silence (hides real stalls); only a detected self-update extends it.
- Closing a Steam that appeared mid-switch, or retrying against it (kills games without consent).
- Password on the command line by default; it is opt-in.
- Automating Steam Guard.
- `ActiveProcess\pid` for "is running" (goes stale); `isRunning` reads the process list.

## Gotchas

- `ActiveUser` alone never proves a fresh sign-in.
- `RememberPassword=1` means a session was saved once; tokens expire (`License expired`), so a remembered switch can land on the form.
- `signedInAs` trusts `ActiveUser` when the log is silent, so a Steam heading for its form can briefly look already active; the launch then queues behind the form. No wrong account results.
- Registry reads use `reg.exe` under `chcp 65001`, so non-ASCII values survive; exit 1 = missing = null.
- Elevated Steam ignoring `-shutdown`: the forced kill fails with `ProcessAccessDeniedError` after 30 s.
- Changed `bootstrap_log.txt` wording silently falls back to the fixed budgets.
- A game update Steam has scheduled for later (`content_log.txt`: `Update Required … (Update delayed for n secs)`) runs first when One Launch launches the game, as Steam's own Play button would. The manifest's `StateFlags` gets the update bit only once Steam is running and has asked the backend, so a Library scan taken while Steam is closed cannot show the badge.
- `An error occurred while launching this game: Corrupt update files` is Steam's own staged-file validation (`content_log.txt`: `Validation: … chunks corrupt`, `update canceled : Staged file validation failed`); Resume re-verifies and commits. Nothing One Launch writes is near `steamapps\downloading`.
- Rewriter tests are byte-exact: fixtures keep line endings and indentation, with all ids and names replaced.
