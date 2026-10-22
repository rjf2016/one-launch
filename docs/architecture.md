# Architecture

Windows-only Electron app. Main owns every privileged operation (files, registry, processes, SQLite, DPAPI, network); the renderer is a sandboxed React page that can only `invoke` typed channels. Elsewhere: `switching.md`, `adapters/steam.md`, `adapters/epic.md`, `adapters/battlenet.md`, `renderer.md`, `development.md`, `roadmap.md`, `artwork.md`.

## Process model

- Main `src/main/**`: startup, window, IPC, DB, vault, backups, artwork, adapters, shell-outs.
- Preload `src/preload/index.ts`: exposes `window.oneLaunch.invoke(channel, req)` and `startup(channel)`, the answer to one of the `STARTUP_REQUESTS` it sends the moment the document starts, before the page's scripts are even fetched (the first render reads them: `renderer.md` › Store and data flow); channels outside `IPC_CHANNELS` get `UNKNOWN_CHANNEL`. CommonJS, because `sandbox: true` requires it.
- Renderer `src/renderer/**`: React + Tailwind, no Node, no network, never holds a secret.
- Shared `src/shared/models.ts`, `ipc-contract.ts`: types and constants; imports neither Electron nor Node.

Request/response only; no push channels. The renderer discovers background progress by polling `artwork:status`, whose `revision` moves whenever games or artwork change (`LibraryService.bump`), and `updates:status` (every 60 s from the sidebar, 5 s while Settings is open, 1 s while a check or download runs).

### Hardening

- `contextIsolation`, `sandbox`, `webSecurity` on; `nodeIntegration`, `allowRunningInsecureContent` off; devtools only in dev.
- Navigation to untrusted URLs blocked, webviews refused, `window.open` denied. Rule: `isTrustedRendererUrl` in `src/main/window-guard.ts` (packaged `index.html`, plus the dev server origin in dev). The renderer can ask main to open one of a fixed list of web pages in the system browser (`app:openUrl`: a target name, mapped to its URL in `src/main/ipc/index.ts`; today the SteamGridDB API page). It never sends a URL.
- CSP is a build-time `<meta>` from `electron.vite.config.ts`: `'self'` only, images also `data:`, `blob:`, `onelaunch-art:`, `connect-src 'none'`. No header CSP.
- `session.defaultSession` denies every permission request and check (set in `bootstrap`). The interface uses no permission-gated web API; clipboard writes go through main. Without the handlers Electron grants everything, clipboard reads included.
- Packaged builds flip Electron fuses (`electronFuses` in `electron-builder.yml`): no run-as-Node, no `NODE_OPTIONS`, no `--inspect`, and the app loads only from the integrity-checked `app.asar`. `--remote-debugging-port` is a Chromium switch that no fuse covers, which is what the driver uses.
- No shell: `execFile`/`spawn` with argv arrays and absolute System32 paths. Exception: registry reads run `cmd.exe /d /s /c "chcp 65001>nul & reg.exe ..."` to get UTF-8 output; `utf8RegCommand` refuses `" % ^ & | < > !` and control characters, and registry writes never use `cmd.exe`. Registry names and process image names are validated first.

## Main-process layout

- `boot.ts`: the entry. It switches on Node's compile cache (`%TEMP%\one-launch-compile-cache`: V8's compiled form of the main bundle and better-sqlite3's modules, worth about 10 ms of a warm start) and then imports `index.ts`, which electron-vite therefore builds as its own chunk.
- `index.ts`: module-scope setup, window, guards, quit/crash handling, `onelaunch-art:` handler, service wiring (settings reach services as thunks read at use time).
- `window-guard.ts`: pure URL, window-placement, close-request and hidden-start rules, Electron-free for tests.
- `tray.ts`: the notification-area icon (Open, Quit), present only while `window.closeToTray` is on.
- `ipc/handle.ts`: `createRegistrar` and the `expect*` validators. `ipc/index.ts`: all handlers.
- `db/index.ts`: open, migrate, copy, DB errors. `db/migrations/index.ts`: numbered migrations.
- `platform/`: `paths.ts` (data dir), `registry.ts` (`reg.exe`), `processes.ts` (list, close, kill, detached spawn), `fs-path.ts` (compare launcher-file paths), `clipboard-private.ts` (write excluded from clipboard history and cloud), `login-item.ts` (Start with Windows), `wiring.ts` (`createPlatform`: the real or fake `LauncherPlatform`, `loginItem` included).
- `services/`: `accounts` (CRUD, case-insensitive uniqueness, password crypto); `vault`, `vault-health`, `secrets` (named secrets), `sessions` (Epic, Battle.net and Riot session snapshots); `settings`; `library` (games + artwork + last launch, `revision`) and `library-scan` (per launcher, failures isolated); `launchers` (`LauncherService`: adapter registry, `guard` around every adapter call mapping unknown errors to `ADAPTER_FAILED`, in-flight tracking for quit); `launch` (the single switch-then-launch job); `switch-journal`, `backup` (see `switching.md`); `clipboard` (clears after 30 s if unchanged); `artwork`, `artwork-url` (see `artwork.md`); `logger`.
- `launchers/`: `types.ts` (adapter contract, error classes), `wait.ts` (abortable waits), `chosen-folder.ts`, `log-read.ts`, `read-file.ts` (size-capped reads of launcher files), one folder per launcher.
- `updates/`: `update-service.ts` (schedule, verify, install at quit; see "Updates"), `manifest.ts` (the signed payload, Ed25519 verify, SHA-512 of a file), `release-keys.ts` (pinned public keys), `availability.ts` (which copies may update), `test-feed.ts`, and `engine.ts`, the only module that imports `electron-updater`, loaded lazily from `index.ts` (vitest cannot construct it, and it stays off the cold-start path).

## Platform helpers (`src/main/platform/`)

- `registry.ts`: `WindowsRegistry`. Reads (`getString`, `getDword`, `listValues`, `queryTree`, `searchTree`, `listSubkeyValues`) run `cmd.exe` with `chcp 65001` (`utf8RegCommand`, verbatim args) so non-ASCII values survive; writes call `reg.exe` directly. Arguments containing cmd metacharacters (`"`, `%`, `&`, `^`, `|`, `<`, `>`, `!`, newline) are refused before spawning. Search large trees with `searchTree` (reg.exe `/f`) rather than a full `/s` dump; a full dump is slow.
- `processes.ts`: `WindowsProcessController`, all of it through Windows PowerShell: `LIST_PROCESS_NAMES_PS` for `runningNames`, `isRunning` and `anyRunning` (one listing a call, about 0.2 s; a caller that checks several things at once takes the whole set from `runningNames`), `LIST_PROCESSES_PS` (UTF-8 output) for paths, `CONTROL_PROCESSES_PS` for close and kill. An image name is letters, digits, `_ . -` and single interior spaces (`Riot Client.exe`); anything else is refused before PowerShell sees it. A refused close or kill raises `ProcessAccessDeniedError` (elevated launcher); it is read from the Windows error code, so it works in every display language.
- **`listProcesses()` opens no process, and must stay that way** (anti-cheat drivers watch who opens a game, `adapters/riot.md`). The script compiles a few lines of C# (`Add-Type`) that ask the kernel for each pid's image path (`NtQuerySystemInformation`, `SystemProcessIdInformation`) and turn the device path into a drive or `\\server\share` path. Never go back to `Get-Process` (`Path` is `MainModule`) or to WMI (`Win32_Process.ExecutablePath`): both ask every process for memory-read access, and WMI returned no path for a process that denied it. Traced: the listing's own processes open nothing outside their own tree for memory-read. To check a change: Process Monitor does not show process opens; the requested access is in an elevated ETW trace of `Microsoft-Windows-Kernel-Audit-API-Calls` (event 5: target pid, desired access; add `Microsoft-Windows-Kernel-Process` for the process starts), and without elevation a process whose DACL denies everything to the user must still be listed with its path.
- **Never run `tasklist`, `taskkill`, or anything else that lists through WMI.** The WMI host then asks every process for memory-read access (`adapters/riot.md` › Processes and launch). `isRunning` takes names from `[System.Diagnostics.Process]::GetProcesses()` (the image name without `.exe`), and an empty list is an error, never "closed". Close and kill compile a C# class that reads the kernel's process table (`NtQuerySystemInformation`, `SystemProcessInformation`) and opens only the processes it ends, asking for `PROCESS_TERMINATE | SYNCHRONIZE`. Traced the same way as the listing: none of the three makes a memory-read request to another process, a close opens no process, and a kill opens each process it ends once (`0x100001`), while one `tasklist` run in the same trace had the WMI host ask every process. PowerShell's own start-up asks the two processes above it for limited query access (`0x1000`) and Defender's service for `SYNCHRONIZE`, whatever the script.
- `close()` posts `WM_CLOSE` to the topmost visible top-level window without an owner, the one `taskkill /IM` picks (compared with it on eight window layouts). A process showing no window gets it on every hidden top-level window without an owner, since the window that quits the process can sit under a later-made one that ignores the message; `taskkill` posts to the topmost one alone (checked on a throwaway that logged every message). The Riot Client's core has one window of its own, which swallows the message on the current build (`adapters/riot.md` › Processes and launch). A process without any such window gets nothing and is no error. A window of an elevated process refuses the message with error 5, which is the `ProcessAccessDeniedError`.
- `kill()` ends children before parents. With the tree it follows a parent id only to a younger process (Windows reuses ids) and never enters One Launch's own chain of processes, so a launcher that started One Launch dies without it. A child that cannot be ended is skipped; only a process with the image name counts as refused.
- A listed path is where the file really is: junctions, links, `subst` drives, and mapped network drives are already followed. Compare it with game folders through `gameWithRunningProcess` (`src/main/launchers/running-game.ts`), which also tries each folder resolved; a plain prefix test misses a game installed through a junction.
- `fs-path.ts`: every path read from a launcher file goes through `normalizeLauncherPath`; compare with `samePath`, deduplicate with `pathKey` and a Set.
- Launcher files are untrusted input: another program or local account can write them. Read them with `readLauncherText` / `readLauncherBytes` (`src/main/launchers/read-file.ts`: 4 MiB, 1 MiB for VDF, more is a `LAUNCHER_FILE` error), keep every parser linear in the file size (no pairwise comparison, no pattern that backtracks along a long line), and skip log lines over `MAX_LOG_LINE_LENGTH`. `test/parse-limits.test.ts` holds the cases.
- `paths.ts`: data folder resolution (above). `clipboard-private.ts`: password copy via PowerShell, excluded from clipboard history.
- `StaticRegistry` and `StaticProcessController` are the test doubles; they live in production source.

## IPC contract

- `IpcContract` in `src/shared/ipc-contract.ts`; a compile-time assertion fails if `IPC_CHANNELS` misses a key. New channel = contract entry + `IPC_CHANNELS` + handler + a malformed-payload row in `test/ipc-validation.test.ts`.
- Envelope `{ ok: true, data } | { ok: false, error: { code, message } }`. The registrar checks the sender first (`UNTRUSTED_SENDER` unless the frame is the app's own page), catches every throw, keeps an `IpcRequestError.code` or any string `code`, else `INTERNAL`, and logs `ipc <channel> failed`. `src/renderer/src/lib/ipc.ts` rethrows as typed errors.
- Payloads are untrusted: handlers validate with `expectObject`, `expectString(max)`, `expectOneOf`, etc., throwing `BAD_REQUEST` before any service runs. Limits: constants atop `ipc/index.ts`, `ACCOUNT_LIMITS`.
- `requireIdle()`: handlers that change accounts, sessions, launcher paths, or launcher files answer `BUSY` during a switch (the launcher is closed and its files mid-rewrite).
- Main never accepts a filesystem path from the renderer; image and launcher-exe pickers are main's native dialogs.

## Vault and secrets

- `SafeStorageVault` = Electron `safeStorage` = DPAPI for the current Windows user. `encrypt` throws `VAULT_UNAVAILABLE` rather than store plaintext; any decrypt failure is `VAULT_UNREADABLE`.
- Encrypted: `accounts.secret_enc`, `secrets.value_enc` (SteamGridDB key, a diagnostics value, the vault probe), `launcher_sessions.blob_enc`, Epic settings files and Riot session files in backups (`.enc`), Battle.net token bytes in backup manifests.
- Ciphertext never crosses IPC: public column lists exclude it, `accounts:copy` decrypts in main, `vault:getSecret` returns only `diagnostics.roundtrip`, the renderer can set/delete only `RENDERER_SECRET_KEYS`. Decrypt at the moment of use.
- The key is `os_crypt` in `<dataDir>\chromium\Local State`. Deleting or restoring that folder, or another Windows user, loses every secret. Chromium writes the file some seconds after the key is first used, so a crash within the first ~10 s of a data folder's first session loses whatever that session encrypted (the fake seed, in a driver run).
- `VaultHealth.ensureProbe()` stores a constant under `vault.probe` once; `status().readable` is false when it no longer decrypts to it. Only main writes the probe (any other value reads as a lost key).
- `vault:reset` clears passwords, sessions, and named secrets, then stores a new probe. Encrypted backup files stay on disk, unreadable.
- No master-password mode; keep the `Vault` interface small so one can be added.

## Data directory

Default `%APPDATA%\OneLaunch` (`userData`; `sessionData` is `chromium\`). `configureAppPaths` runs before `ready`:

- `--data-dir=<absolute folder>`, any build, `=` form only, not a drive root, no conflicting repeats. A bad flag throws `DataDirFlagError` and exits with code 2 before touching anything.
- `ONELAUNCH_DATA_DIR`, unpackaged only; the flag wins. Packaged builds use a flag because a session-wide env var would silently redirect every start.
- `ONELAUNCH_FAKE_LAUNCHERS=<absolute scenario folder>`, unpackaged only and ignored by the packaged exe: `createPlatform` (`src/main/platform/wiring.ts`) then builds the adapters on `StaticRegistry`, a `SimProcessController` with the launcher simulators (`src/main/launchers/sim/`), path roots inside that folder, short timings, a fixture `fetch`, and clipboard recorders, and seeds accounts from `scenario.json` once. The `starting` log line records `platformSource`, `app:info` reports it, and the title bar shows a "Fake launchers" badge. Everything the fake platform was asked to do is written to `<dataDir>\fake-platform.json`. A value that names no usable folder exits 2, like a bad `--data-dir=`.
- `ONELAUNCH_UPDATE_FEED=http://127.0.0.1:<port>/` and `ONELAUNCH_UPDATE_KEYS=<spki,...>`, unpackaged only and ignored by the packaged exe: the updater reads a loopback generic feed trusted with those keys, keeps its cache in `<dataDir>\update-cache`, and never runs the installer (it logs `update install (test feed, installer not run)`). Anything but an `http://127.0.0.1` address or Ed25519 keys exits 2.
- The whole tree moves, vault key included, and the single-instance lock follows it, so a scratch run is fully isolated. The exceptions are electron-updater's download cache, `%LOCALAPPDATA%\one-launch-updater`, which only an installed copy on the default folder ever uses, and Node's compile cache, `%TEMP%\one-launch-compile-cache` (`boot.ts`): compiled code and nothing else, shared by every copy and refreshed when its source changes.

```
onelaunch.db (+wal, shm)       SQLite
switch.json                    switch journal, only during or after an interrupted switch
artwork\<game uuid>\           grid|hero|logo.<jpg|png|webp>
backups\<launcher>\<id>\       manifest.json + launcher file copies
backups\db\onelaunch-<iso>.db  newest 5 DB copies
logs\onelaunch(.1-.5).log      1 MiB rotation
chromium\                      Chromium profile; holds the vault key. Not disposable.
```

## Database

`better-sqlite3`, synchronous, one connection in main.

- Tables: `accounts`; `games` (unique `launcher, launcher_game_id`; never deleted, only `installed = 0`, so ids stay stable); `artwork`, `artwork_attempts`; `launch_history` (no FKs, no pruning); `settings`; `secrets`; `launcher_sessions` (cascades from `accounts`). Account uniqueness is enforced in `AccountsService`, not by index.
- Migrations: `MIGRATIONS`, contiguous from 1, version in `PRAGMA user_version`, each in its own transaction with the bump. A newer `user_version` is refused (`DB_TOO_NEW`). Never edit a shipped migration; append.
- A migration that drops and recreates a table other rows reference (SQLite cannot alter a CHECK) sets `foreignKeysOff`. Under `foreign_keys=ON` the `DROP TABLE` would cascade-delete every child row, and the pragma is a no-op inside a transaction, so the runner switches foreign keys off around the transaction, refuses the migration if they stay on, and runs `foreign_key_check` before the commit so an orphaned row rolls the migration back.
- The `launcher` columns of `accounts`, `games` and `launcher_sessions` carry no CHECK; reads filter unknown ids with `isLauncherId`, so a new launcher needs no migration.
- `openDatabase`: `busy_timeout` 5 s, WAL, `synchronous=NORMAL`, `foreign_keys=ON`, `quick_check`, then a rolled-back page write, because a read-only WAL file only fails on a real write.
- `DB_CORRUPT` only for a failed `quick_check` or `SQLITE_CORRUPT*`/`SQLITE_NOTADB` (user restores a copy or moves the file aside). Everything else is `DB_UNAVAILABLE` with `locked`, `read-only`, or `cannot-open` (nothing to restore). Both surface in the startup error box.
- 250 ms after first show, `backupDatabase` copies the DB (online backup API) into `backups\db`, keeping 5. Copies hold ciphertext, so they only help the same user with the same `chromium` folder.

## Settings

Strings in `settings`; `getBool` treats `true`/`1` as true. Keys: `SETTING_KEYS`. `settings:set` refuses `MAIN_ONLY_SETTING_KEYS` and validates per key; `settings:getAll` returns all.

| Key | Default | Behaviour |
| --- | --- | --- |
| `dryRun` | off | Preview mode: a launch returns the plan, changes nothing. |
| `steam.autoLogin` | off | On puts the stored password on Steam's command line. |
| `artwork.autoFetch` | on | See `artwork.md`. |
| `backups.keep` | 20 | Snapshots per launcher (1..200), applied at the next snapshot. |
| `logLevel` | `info` | Applied at once; dev always starts at `debug`. |
| `<launcher>.path` | unset | Main-only; the located install folder whose exe the app runs, written only by `launchers:locate`. |
| `window.bounds` | unset | Main-only; off-screen placements are dropped. |
| `window.closeToTray` | on | Closing the window hides it and the app stays in the tray (icon with Open and Quit). Off: closing quits, asking first during a switch. Applied at once through `onSettingChanged`. |
| `updates.auto` | on | Checks 15 s after start, then every 6 h, downloads a verified update, and installs it at the next quit. Off: no update traffic unless the user clicks "Check for updates", and a downloaded update waits for "Restart to update". Applied at once through `onSettingChanged`; turning it off cancels a background download. |
| `whatsNew.enabled` | on | The What's New card after an update (`renderer.md` › What's New). Off: the card never opens, and the running version is still recorded as seen. |
| `whatsNew.lastSeen` | unset | The newest version whose What's New the user saw. Must be a version string. Main writes the running version on a brand-new DB (a fresh install has nothing to announce); the renderer writes it when the card closes. Unset on a folder from before the feature, which the renderer reads as older than every entry. |

## Updates

`UpdateService` over electron-updater's `NsisUpdater`, feed `github` `rjf2016/one-launch`, set in code. Standing rules:

- **Only installed per-user copies on the default data folder update.** `updateAvailability` requires a packaged exe, `dataDirSource` `default`, `Uninstall One Launch.exe` beside the exe, and electron-builder's `HKCU\Software\<GUID>` `InstallLocation` equal to the exe's folder (the GUID is UUIDv5 of the `appId`, recomputed in `test/update-availability.test.ts`). Anything else is `unavailable` with a reason, so `--data-dir=` smoke runs and `dist\win-unpacked` never touch the real install. An all-users install is refused because its silent update would need administrator rights.
- **Nothing unsigned runs.** `autoDownload` is off. A release is downloaded only when `verifyManifest` accepts the Ed25519 signature in its `latest.yml` (`signature`, `keyId`) over `one-launch-update-v1`, version, file name, SHA-512 and size, from a key in `RELEASE_KEYS`; an empty list refuses everything. It also refuses more or fewer than one file, `isAdminRightsRequired`, and web-installer `packages`. The verify and the `downloadUpdate()` call happen in one synchronous step, and no check runs once an update is ready, so no later manifest can swap in. Main hashes the downloaded file itself, and hashes it again right before starting it.
- **Main starts the installer, never electron-updater.** `autoInstallOnAppQuit` is always false. `installAtQuit` runs from the app `quit` event, after `will-quit` has closed the DB, because the NSIS `--updated` script kills a still-running app after about 2 s. It installs after "Restart to update" (`updates:install`: relaunches afterwards; `BUSY` during a switch, `NOT_READY` without a verified download), or at a normal quit while `updates.auto` is on. It never installs after `session-end`, after an uncaught exception, or on a non-zero exit.
- **No identifier leaves the PC.** electron-updater would send a per-install UUID (`x-user-staging-id`, stored in `.updaterId`); `engine.ts` replaces it with `SHARED_STAGING_ID`, which every copy sends, so no `.updaterId` file is written. `allowPrerelease` is forced off (electron-updater turns it on for a `-beta` version), so GitHub's `releases/latest` decides, and betas ship as normal releases.
- **Failures are WARN.** Offline, HTTP errors, refused signatures, and electron-updater's own `error` event (mapped by its logger adapter) never log at ERROR; `describeUpdateError` turns them into the text Settings shows.
- When code signing (A12) lands, electron-builder writes `publisherName` into `app-update.yml` and electron-updater's Authenticode check runs as well.

## Logging and redaction

- `logs\onelaunch.log`, synchronous appends, 1 MiB × 5 rotation, write failures swallowed. Console mirror in dev only.
- Every message and metadata value passes `redactString`; `redactValue` also blanks sensitive keys (password, token, secret, auth, cookie, session, `data`, ...). Text rules mask `key=value` secrets, INI `Data=`, the password after `-login <user>`, JWTs, emails, SteamID64s, the user name in a `C:\Users\<name>` path (`[USER]`), long token-like runs.
- Redaction runs synchronously in main on text a launcher file or the update feed can supply, so every pattern must stay linear on a long run of one kind of character; `test/logger.test.ts` times them.
- A message stays on one line (CR and LF are escaped), and message and metadata are each clipped to 8 KiB after redaction, never before. A line that cannot be redacted is replaced by a placeholder, never written as it came.
- Account names are masked by value (`[ACCOUNT]`) via `redactAccountNames`, fed by `toAccount` and Steam's `loginusers.vdf` parser. Any new reader of logins or display names must feed it. Names over 256 characters are ignored.
- Never put a secret in an error message; the registrar logs them, and a failed switch's message and step details reach the renderer unredacted. `WindowsRegistry` therefore reports a failed write by exit code and stderr, never by Node's `err.message`, which holds the command line and so the data.

## Startup invariants

Before `ready`: data paths (exit 2 on a bad flag), single-instance lock (a second instance makes the first show and focus its window, then exits), register `onelaunch-art` as privileged, create folders, open the log.

Before `ready` too: `Menu.setApplicationMenu(null)`, so Electron never builds the default menu. Main's static imports stay lean on purpose, because the module is evaluated before Chromium launches the GPU process (Performance targets): the launcher simulators are a chunk `createPlatform` imports only for a fake run, and `node:https` and `node:child_process` load on their first use (a Riot launch, a registry read, a process check, a private clipboard write).

`bootstrap`: open + migrate DB; settings (a brand-new DB records the running version as seen for What's New, so only an upgraded data folder opens the card); `createPlatform` (real, or fake as above); the permission handlers and the `onelaunch-art` protocol handler; **the window**; then, with nothing yielding until the end of `bootstrap`, the vault and probe (an unreadable vault is logged, startup continues), services and adapters, the fake seed, if any, `SwitchRecoveryService.load()` before anything can start a switch, and `registerIpcHandlers`. The window goes up before the services so its renderer process starts and loads the page while main builds them; because that stretch never awaits, no IPC message (the preload's startup requests included), `ready-to-show` or `did-finish-load` can be dispatched before the handlers exist, which `startup-timing.mjs` checks as `ipcMs <= didFinishLoadMs`. The window is created hidden at the saved normal bounds, maximized if it was, and shown before the page loads, so it is on screen in its background colour at once and the renderer's first frame is already at the final size; `rememberBounds` is attached right after. `index.html` carries a CSS-only boot surface (title strip, and the mark after 250 ms) that React's first commit replaces. `ready-to-show` only times the first paint and gates the deferred work: the tray icon, scan, artwork, DB copy, and `updates.start()` (availability, then the first check 15 s later) start 250 ms after it. A throw in `bootstrap` shows an error box naming the log and data folder, then exits 1 (after the window step, over a briefly visible window). A crashed renderer reloads once; a second loss within 60 s stays down.

Start with Windows: `autostart:set` writes, through `app.setLoginItemSettings`, the HKCU `...\CurrentVersion\Run` value `OneLaunch` (`LOGIN_ITEM_NAME`) as the exe plus `--start-hidden` (`START_HIDDEN_FLAG`); no elevation, and it is the entry Settings › Apps › Startup and Task Manager list. `autostart:status` reports `executableWillLaunchAtLogin`, so an entry disabled in Task Manager reads as off; the exe path it asks about goes quoted, because Electron parses that option as a command line and an unquoted `...\One Launch\One Launch.exe` ends at the space (`openAtLogin` is useless here: it only reads the value named by the AppUserModelId). Only the copy updates accept may register (`loginItemAvailable`, which is `perUserInstall` in `updates/availability.ts`, worked out once per run): a dev run would register Electron's exe, a `--data-dir=` scratch run must never become the copy that starts at sign-in, a copy that was never installed has no uninstaller to remove its entry, and an all-users install's uninstaller reaches only one account's HKCU; otherwise `available` is false and `autostart:set` is `UNAVAILABLE`. A fake-launcher run gets an in-memory login item. With the flag and `window.closeToTray` on (`startHidden` in `window-guard.ts`), the window is created at the saved bounds but never shown: the saved maximize waits for the first `showMainWindow` (`maximize()` would show it), `rememberBounds` keeps storing it, and `windowShownMs` stays null until that show. The deferred block still runs off `ready-to-show`, which a hidden window fires; if the tray icon could not be created there the window is shown, since nothing else could reach it. The crash dialog's Relaunch drops the flag. The uninstaller's `customUnInstall` (`build/installer.nsh`) deletes the `Run` and `StartupApproved\Run` values, skipped under `${isUpdated}` because an update runs the old uninstaller, and so does any install over an existing copy, possibly into another folder. So `customInstall` deletes both when the `Run` value names another exe (it starts with the quoted exe path, as Electron writes it) or the install is for all users. It never rewrites the value: antivirus blocks an installer that writes a `Run` key, so a reinstall into another folder turns Start with Windows off.

## Quit invariants

- With `window.closeToTray` on (the default) closing the window only hides it, switch or no switch; the app ends through the tray's Quit, a logoff, or the crash dialog. A tray icon that could not be created is logged at WARN and closing then quits as if the setting were off. `closeRequestAction` in `window-guard.ts` is the rule.
- With it off, closing during a switch asks Keep running / Quit anyway; quitting calls `launch.stop()` and waits up to 10 s. The prompt shows the window first, because a quit from the tray reaches it hidden.
- `before-quit` (all paths but `app.exit`) runs one cleanup, capped at 2 s: stop the switch; `updates.stop()`; `artwork.stop()`; `launchers.closing()` and wait up to 1.5 s for in-flight adapter work; clear a copied secret if unchanged.
- `will-quit` closes the DB, so anything that touches it must be stopped or awaited before. After `closing()` adapter failures log at debug.
- `quit`, the last event, starts a pending update installer (see "Updates"); it must stay synchronous and must not touch the DB.
- Logoff (`session-end`) skips the prompt and runs the cleanup. `uncaughtException` offers Relaunch via a normal quit; `unhandledRejection` only logs. A killed switch leaves `switch.json` for the next start.

## Performance targets

- Cold start to interactive under 1 s, ceiling 2 s, counted from process creation (`process.getCreationTime()`). `app:info` reports `windowShownMs` and `didFinishLoadMs`; `processToNodeMs` is the part before any app code runs (Windows loading the exe, Chromium, an antivirus scan of a new exe), which the app cannot shorten. One `startup` INFO line per start holds every mark (app code, main module evaluated, ready, database, vault, IPC, window created and shown, first paint, page loaded); `scripts/scenarios/startup-timing.mjs` prints them for the packaged exe together with the renderer's own `performance.mark`s (`src/renderer/src/lib/startup.ts`: module, prefetched, render, first commit, library data, library frame) and paint entries, for a first start on an empty folder and two warm starts on the same folder. Run it five times after a build, discard the first, compare medians.
- The first frame waits for the GPU process, which Chromium launches just before `ready`, right after main's module has been evaluated, and which needs about 200 ms (its own start, EGL and Direct3D initialisation, a first raster) before any frame can be presented; the renderer's first commit is in long before. So every millisecond of main's module evaluation moves the first paint, while renderer-side work before the first commit does not.
- Library scan of ~100 games under 500 ms; the library renders at once with placeholders.
- Each registry read or process check is a child process (a read is `cmd` + `chcp` + `reg`); keep them off hot paths like `launchers:status`.
- Fully functional offline apart from artwork and update checks.
