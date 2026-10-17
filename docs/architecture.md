# Architecture

Windows-only Electron app. Main owns every privileged operation (files, registry, processes, SQLite, DPAPI, network); the renderer is a sandboxed React page that can only `invoke` typed channels. Elsewhere: `switching.md`, `adapters/steam.md`, `adapters/epic.md`, `adapters/battlenet.md`, `renderer.md`, `development.md`, `roadmap.md`, `artwork.md`.

## Process model

- Main `src/main/**`: startup, window, IPC, DB, vault, backups, artwork, adapters, shell-outs.
- Preload `src/preload/index.ts`: exposes only `window.oneLaunch.invoke(channel, req)`; channels outside `IPC_CHANNELS` get `UNKNOWN_CHANNEL`. CommonJS, because `sandbox: true` requires it.
- Renderer `src/renderer/**`: React + Tailwind, no Node, no network, never holds a secret.
- Shared `src/shared/models.ts`, `ipc-contract.ts`: types and constants; imports neither Electron nor Node.

Request/response only; no push channels. The renderer discovers background progress by polling `artwork:status`, whose `revision` moves whenever games or artwork change (`LibraryService.bump`), and `updates:status` (every 60 s from the sidebar, 5 s while Settings is open, 1 s while a check or download runs).

### Hardening

- `contextIsolation`, `sandbox`, `webSecurity` on; `nodeIntegration`, `allowRunningInsecureContent` off; devtools only in dev.
- Navigation to untrusted URLs blocked, webviews refused, `window.open` denied. Rule: `isTrustedRendererUrl` in `src/main/window-guard.ts` (packaged `index.html`, plus the dev server origin in dev).
- CSP is a build-time `<meta>` from `electron.vite.config.ts`: `'self'` only, images also `data:`, `blob:`, `onelaunch-art:`, `connect-src 'none'`. No header CSP.
- `session.defaultSession` denies every permission request and check (set in `bootstrap`). The interface uses no permission-gated web API; clipboard writes go through main. Without the handlers Electron grants everything, clipboard reads included.
- Packaged builds flip Electron fuses (`electronFuses` in `electron-builder.yml`): no run-as-Node, no `NODE_OPTIONS`, no `--inspect`, and the app loads only from the integrity-checked `app.asar`. `--remote-debugging-port` is a Chromium switch that no fuse covers, which is what the driver uses.
- No shell: `execFile`/`spawn` with argv arrays and absolute System32 paths. Exception: registry reads run `cmd.exe /d /s /c "chcp 65001>nul & reg.exe ..."` to get UTF-8 output; `utf8RegCommand` refuses `" % ^ & | < > !` and control characters, and registry writes never use `cmd.exe`. Registry names and process image names are validated first.

## Main-process layout

- `index.ts`: module-scope setup, window, guards, quit/crash handling, `onelaunch-art:` handler, service wiring (settings reach services as thunks read at use time).
- `window-guard.ts`: pure URL, window-placement and close-request rules, Electron-free for tests.
- `tray.ts`: the notification-area icon (Open, Quit), present only while `window.closeToTray` is on.
- `ipc/handle.ts`: `createRegistrar` and the `expect*` validators. `ipc/index.ts`: all handlers.
- `db/index.ts`: open, migrate, copy, DB errors. `db/migrations/index.ts`: numbered migrations.
- `platform/`: `paths.ts` (data dir), `registry.ts` (`reg.exe`), `processes.ts` (list, close, kill, detached spawn), `fs-path.ts` (compare launcher-file paths), `clipboard-private.ts` (write excluded from clipboard history and cloud).
- `services/`: `accounts` (CRUD, case-insensitive uniqueness, password crypto); `vault`, `vault-health`, `secrets` (named secrets), `sessions` (Epic, Battle.net and Riot session snapshots); `settings`; `library` (games + artwork + last launch, `revision`) and `library-scan` (per launcher, failures isolated); `launchers` (`LauncherService`: adapter registry, `guard` around every adapter call mapping unknown errors to `ADAPTER_FAILED`, in-flight tracking for quit); `launch` (the single switch-then-launch job); `switch-journal`, `backup` (see `switching.md`); `clipboard` (clears after 30 s if unchanged); `artwork`, `artwork-url` (see `artwork.md`); `logger`.
- `launchers/`: `types.ts` (adapter contract, error classes), `wait.ts` (abortable waits), `chosen-folder.ts`, `log-read.ts`, `read-file.ts` (size-capped reads of launcher files), one folder per launcher.
- `updates/`: `update-service.ts` (schedule, verify, install at quit; see "Updates"), `manifest.ts` (the signed payload, Ed25519 verify, SHA-512 of a file), `release-keys.ts` (pinned public keys), `availability.ts` (which copies may update), `test-feed.ts`, and `engine.ts`, the only module that imports `electron-updater`, loaded lazily from `index.ts` (vitest cannot construct it, and it stays off the cold-start path).

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
- The whole tree moves, vault key included, and the single-instance lock follows it, so a scratch run is fully isolated. The one exception is electron-updater's download cache, `%LOCALAPPDATA%\one-launch-updater`, which only an installed copy on the default folder ever uses.

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

`bootstrap`: open + migrate DB; settings (a brand-new DB records the running version as seen for What's New, so only an upgraded data folder opens the card); vault and probe (an unreadable vault is logged, startup continues); `createPlatform` (real, or fake as above); services and adapters; the fake seed, if any; `SwitchRecoveryService.load()` before anything can start a switch; protocol handler; `registerIpcHandlers` before the window exists; window. The window is created hidden at the saved normal bounds, maximized if it was, and shown before the page loads, so it is on screen in its background colour at once and the renderer's first frame is already at the final size; `rememberBounds` is attached right after. `index.html` carries a CSS-only boot surface (title strip, and the mark after 250 ms) that React's first commit replaces. `ready-to-show` only times the first paint and gates the deferred work: the tray icon, scan, artwork, DB copy, and `updates.start()` (availability, then the first check 15 s later) start 250 ms after it. A throw in `bootstrap` shows an error box naming the log and data folder, then exits 1. A crashed renderer reloads once; a second loss within 60 s stays down.

## Quit invariants

- With `window.closeToTray` on (the default) closing the window only hides it, switch or no switch; the app ends through the tray's Quit, a logoff, or the crash dialog. A tray icon that could not be created is logged at WARN and closing then quits as if the setting were off. `closeRequestAction` in `window-guard.ts` is the rule.
- With it off, closing during a switch asks Keep running / Quit anyway; quitting calls `launch.stop()` and waits up to 10 s. The prompt shows the window first, because a quit from the tray reaches it hidden.
- `before-quit` (all paths but `app.exit`) runs one cleanup, capped at 2 s: stop the switch; `updates.stop()`; `artwork.stop()`; `launchers.closing()` and wait up to 1.5 s for in-flight adapter work; clear a copied secret if unchanged.
- `will-quit` closes the DB, so anything that touches it must be stopped or awaited before. After `closing()` adapter failures log at debug.
- `quit`, the last event, starts a pending update installer (see "Updates"); it must stay synchronous and must not touch the DB.
- Logoff (`session-end`) skips the prompt and runs the cleanup. `uncaughtException` offers Relaunch via a normal quit; `unhandledRejection` only logs. A killed switch leaves `switch.json` for the next start.

## Performance targets

- Cold start to interactive under 1 s, ceiling 2 s, counted from process creation (`process.getCreationTime()`). `app:info` reports `windowShownMs` and `didFinishLoadMs`; `processToNodeMs` is the part before any app code runs (Windows loading the exe, Chromium, an antivirus scan of a new exe), which the app cannot shorten. One `startup` INFO line per start holds every mark; `scripts/scenarios/startup-timing.mjs` prints them for the packaged exe.
- Library scan of ~100 games under 500 ms; the library renders at once with placeholders.
- Each registry read or process check is a child process (a read is `cmd` + `chcp` + `reg`); keep them off hot paths like `launchers:status`.
- Fully functional offline apart from artwork and update checks.
