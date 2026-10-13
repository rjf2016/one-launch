# Epic Games Launcher adapter

Code: `src/main/launchers/epic/` (`adapter.ts` = `EpicAdapter`). Tests: `test/epic-*.test.ts`, fixtures `test/fixtures/epic/`. Generic switch flow, backups, recovery: `../switching.md`.

Epic has no account list and no sign-in flag. The launcher signs in from an opaque, Epic-encrypted blob in `[RememberMe] Data` of `GameUserSettings.ini`. One Launch stores one blob per account; a switch swaps it in, restarts the launcher, and confirms the sign-in from the launcher log.

## Rules

- The only launcher files written are `GameUserSettings.ini`, and only `[RememberMe]` and `[Offline]`. No registry writes. Every other byte (per-account `[<id>_*]` sections, line endings, BOM, order) is preserved by `ini.ts`.
- Never write `[RememberMe] Enable=False`. It is a sticky launcher preference: the launcher never turns it back on, and auto sign-in stays off for good. Signing out means removing `Data` and keeping `Enable=True`.
- Never create `GameUserSettings.ini`. A file with only the two sections loses every per-account setting and the launcher does not auto-sign-in from it. A missing file blocks the switch (`plan.executable = false`).
- Never write the file while the launcher runs: it rewrites the file on state changes and on exit, and ignores what is written under it. While it runs, its log (not the file) decides who is signed in.
- Session blobs are bearer credentials: vault-encrypted in `launcher_sessions`, decrypted only inside `writeSession`, never logged or sent to the renderer. UI and plans show a SHA-256 fingerprint (first 8 hex).
- Read-only live check: `$env:ONELAUNCH_LIVE='1'; npx vitest run test/epic-live.test.ts`. Fixtures: keep CRLF and tabs, replace every 32-hex id and blob.

## Detection

`detectInstall()`, first hit wins; each candidate must contain `Portal\Binaries\Win64\EpicGamesLauncher.exe`:

1. The folder chosen with Locate in Settings (`epic.path`, via `deps.installDir`). Source `user`. If the exe is gone, the ladder continues and health shows a `chosen-folder` warning.
2. `HKLM\SOFTWARE\WOW6432Node\...\Uninstall\{AEB35C6C-B6D4-4AA0-8452-DE699737B5F6}` `InstallLocation` + `\Launcher`.
3. Default value of `HKLM\SOFTWARE\Classes\com.epicgames.launcher\shell\open\command`: first quoted token, four folders up.
4. `C:\Program Files (x86)\Epic Games\Launcher`.

- Only the 32-bit registry view is read. Per-user and Store installs must be located by the user.
- `installFromExe(path)` (for `launchers:locate`): name must be `EpicGamesLauncher.exe`; install dir is four levels up, so a `Win32` pick resolves to the Win64 exe.
- A chosen folder only changes where the exe starts from, not where settings, log, or manifests are read.

## Library

- Dir: `HKLM\SOFTWARE\WOW6432Node\Epic Games\EpicGamesLauncher` `AppDataPath` + `\Manifests`, else `%ProgramData%\Epic\EpicGamesLauncher\Data\Manifests`. Only `<32-hex>.item` JSON files count; unreadable ones are skipped.
- Paths in `.item` mix `\` and `/`; always `normalizeLauncherPath`.
- `isLibraryGame`: complete, not a DLC (`MainGameAppName` != `AppName`), `AppCategories` empty or containing `games`.
- `launcherGameId = AppName`; `lastPlayedAt` always null (Epic records no time).
- `%ProgramData%\Epic\UnrealEngineLauncher\LauncherInstalled.dat`: health cross-check only.
- Running game: any process under a game's `InstallLocation`.
- `steam-ids.ts`: `AppName` -> Steam app id for games delisted on Steam, for artwork.

## Files read

- Settings: `%LOCALAPPDATA%\EpicGamesLauncher\Saved\Config\{Windows,WindowsEditor}\GameUserSettings.ini`. The launcher can move to `WindowsEditor` and stay. `settingsPaths()` sorts newest first (within 2 s, `WindowsEditor` wins); the newest is read, every existing one is backed up and written.
- `readIni()` refuses UTF-16 or NUL bytes (`LauncherFileError`): Unreal turns a config UTF-16 once a non-ASCII character lands in it, and a rewrite would corrupt it.
- Log: `%LOCALAPPDATA%\EpicGamesLauncher\Saved\Logs\EpicGamesLauncher.log`, new file per launcher start (old one becomes `EpicGamesLauncher-backup-*.log`); first line `Log file open, <date>` identifies the run. Reads are 8 MB tail reads so the newest sign-in decides.

## Session format

- Stored blob (`session.ts`): `{v: 1, rememberMe: {enable, data}, offline: {data} | null}`, JSON, vault-encrypted by `LauncherSessionStore`. `fingerprint = sha256(rememberMe.data)`.
- `[Offline] Data` is swapped with it as part of the same session. `webcache_*` and `Saved\Data` do not hold the sign-in.
- The launcher rotates the blob, so the outgoing session is re-captured on every switch.
- The 32-hex id in the log is the Epic account id (it also names the `[<id>_*]` sections) and becomes the account's `launcher_uid`.

## Who owns the session on disk

`currentSession()`: while running, the account whose `launcher_uid` matches the log's last successful sign-in (the file can hold a session the launcher is not using). While closed: a stored snapshot with the same fingerprint, else the log's last sign-in if the INI mtime is at or after that sign-in (`diskCurrent`).

## Switch

`buildSwitchPlan` / `runSwitch`. Steps: `close`, `capture`, `backup`, `file`, `start`, `wait`, `verify`, `manual`, `recapture`.

- `inPlace`: the owner is the target and (running, or the file remembers a session). `alreadyActive` = `inPlace` and running: nothing changes.
- Strategy `remembered` when `inPlace` or a non-stale snapshot is stored; else `credentials` (sign the file out, user signs in once).
- Order: close (confirmed) -> stop if the launcher is running again (something else started it; nothing written) -> `saveOutgoing` (best effort, One Launch owner only, only if `diskCurrent` and changed) -> backup (`sensitive: true`) -> `writeSession` (atomic, every settings file) -> fail and roll back if the launcher is running now -> start the exe with no arguments -> confirm from the log; the result's `readyAt` is 2 s later, and only a game launch waits for it.
- A remembered session no account owns is never saved as a snapshot; the backup holding it is pinned (`UNOWNED_SESSION_PIN`) so pruning keeps it. Decided after the close, since the launcher rewrites its session on exit. `restoreBackup` pins its pre-restore snapshot by the same rule and refuses while the launcher runs.
- Rollback closes the launcher first, then restores only the two settings-file paths.

## Sign-in confirmation

`launcher-log.ts` `parseLogEvents`:

```
FAccountService::AutoSignIn                           auto-sign-in
FAccountService::SignIn (exchange code)               manual-sign-in
FAccountService::OnLoginComplete - 0 TRUE <32-hex>    signed-in
FAccountService::OnLoginComplete - 0 FALSE  errormessage=... Reason: TOKEN_EXPIRED ...   sign-in-failed
LogInit: AllCheckComplete                             ready
Application: Restarting ... EpicGamesUpdater.exe      restart
LogCore: Engine exit requested / Log file closed      exit
```

- `FAccountService::SignOut` appears on every normal shutdown and says nothing about the remembered session; it is ignored.
- Failure reasons pass through `maskReason` (drops any 32-hex value and `errorpath=` onward).
- Only lines after a `logMark` taken before the start count (whole file if the log was replaced).
- On TRUE with a known expected uid: match = `signed-in`, else `wrong-account` (rolls back). With no uid yet: an id another account holds is `wrong-account`; any other id is accepted and linked (`linkIfNew`), so signing in as an unknown Epic account is not caught.
- Remembered waits 45 s; credentials polls once, then goes to the manual step.
- `storeSession` links the uid before saving, so a refused (duplicate) link leaves no session row.

## Hand-over

- A FALSE reason matching `isSessionRejection` (an allow-list of token wordings; only `TOKEN_EXPIRED` is confirmed) marks the snapshot stale. Service or network failures do not, since a false stale mark forces a needless manual sign-in.
- `waitForManualSignIn`: up to 10 min with a `sign-in` attention (cause `new`/`expired`/`other`). FALSE lines are not final here.
- On success `captureFresh(15 s)` stores the blob once it differs from what One Launch wrote, and `markVerified` (clears `stale_reason`); otherwise it is saved at the next switch.
- Timeout returns `needsSignIn` with the launcher left on its sign-in page. A cancel after the launcher started does not roll back.

## Shutdown

`shutdown()`: a window close (no shutdown flag exists; "minimise to tray" defeats it), wait 20 s, then a forced kill of the launcher and its tree. The launcher may hand off to `EpicGamesUpdater.exe` and restart. Watch for that 45 s if the log announced a restart, 1.5 s after a clean unannounced exit, else 8 s. A restarted launcher is allowed to log `AllCheckComplete`, then closed again gracefully, up to 3 attempts. Killing it mid-start can delete `GameUserSettings.ini`.

- Elevated launcher: its window refuses the close -> `ProcessAccessDeniedError` at once, in every display language.
- A hand-off without a restart (observed on build 20.3.0): the launcher staged a self-update during its run (`LogSelfUpdateService: Launcher is out of date`, `Stage of update started`, `Installer complete. Success:1`), and on the window close logged `Application: Restarting …EpicGamesUpdater.exe with command: start …` and exited. The updater's own log (`Saved\Logs\EpicGamesUpdater-<stamp>.log`) shows it starting a Windows service with `-ForcedRestart` and finishing in 5 s. The launcher did not come back: the 45 s watch ran out, and One Launch started it itself, as the new build. The close step took 54 s in all (`roadmap.md`, B24).

## Launch

`launchGame`: id must match `^[A-Za-z0-9_.-]{1,128}$`. `launchUri` builds, via `shell.openExternal`:

- `epic.launchUri = catalog` (default, the form the launcher writes into its own shortcuts): `com.epicgames.launcher://apps/<CatalogNamespace>%3A<CatalogItemId>%3A<AppName>?action=launch&silent=true`
- `appname`, or when catalog ids are unknown: `com.epicgames.launcher://apps/<AppName>?action=launch&silent=true`

Only `AppName` is percent-encoded; the catalog ids are used as read from the manifest.

## Health check

`healthCheck(known?)` reuses the status pass's install and running state when given. Rows: `install`, `chosen-folder`, `process`, `manifests`, `launcher-installed`, `settings` (warns if `Enable` is not `True`), `log` (warns if the last sign-in failed), `sessions` (warns if any stale), `backups`.

## Tried and rejected

Sign-out via `Enable=False`; recreating a missing settings file; force-killing a self-restarting launcher; trusting the file's fingerprint for ownership while running (launched a game under the wrong account); treating `SignOut` log lines as a sign-out; marking stale on every FALSE; writing only `Config\Windows`. Reasons are in the sections above.

## Quirks

- The launcher sometimes relaunches itself (e.g. `-AllowSoftwareRendering`), so the process One Launch started is not always the one that stays.
- Log timestamps are UTC; a `LogTimes=Local` config would break `diskCurrent`.
- `listRememberedAccounts` lists ids from `[<id>_*]` sections. The launcher records no login name, so an unlinked id cannot be imported.
