<p align="center">
  <img src="./build/icon.png" alt="One Launch logo" width="128">
</p>

# One Launch

One front door to your Steam, Epic Games, Battle.net, and Riot Games accounts and installed games on Windows: pick a game, pick an account, play. One Launch switches the launcher to that account (restarting it when needed) and starts the game through the launcher. The launchers stay installed and keep doing the actual work.

## What it does

- Keeps your accounts per launcher: login, an encrypted password (optional), tags, and notes.
- Shows every installed game across the four launchers, with artwork.
- Switches a launcher to the chosen account and launches the game. Steam uses its own remembered accounts; Epic, Battle.net, and the Riot Client sign in from a saved sign-in One Launch keeps per account. The Riot Client no longer starts a game from its own shortcut's arguments, so for a Riot game One Launch opens the game's page in the client and presses Play for you, through the launch request the client's own Play button sends; turn that off in Settings to press Play yourself.
- Backs up every launcher file it is about to change, and rolls back if a switch fails.
- Has a preview mode (Settings › General, off by default): Play then shows what a switch would do (close the launcher, switch, start it, sign in, launch) without doing it.


## What it needs

Windows 10 or 11, 64-bit, one Windows user profile. Any subset of Steam, Epic Games Launcher, Battle.net, and the Riot Client; a launcher that is not installed is simply shown as not installed.

## Privacy and security

- Everything stays on this PC. There is no account, no sync, no telemetry, and no crash reporting to anyone.
- Network traffic goes to two places, and nothing about your accounts is ever sent to either:
  - Artwork: game names and store ids go to Steam's store search and CDN and, if you add a free API key, to SteamGridDB. Artwork fetching is on by default; the welcome panel on first start says so, and Settings › Artwork turns it off.
  - Updates: One Launch checks its own GitHub releases 15 seconds after it starts and every 6 hours after that, downloads a new version in the background once it has verified the release's signed manifest, and installs it the next time One Launch quits. GitHub sees what it sees for any download: your IP address and the version you run. No per-install identifier is sent. Settings › Updates has the switch (on by default) and a Check for updates button; with the switch off, nothing is contacted unless you press that button. Only a copy installed with "Only for me" updates itself; any other copy says why in Settings › Updates.
- Passwords, saved sign-ins, and the SteamGridDB key are encrypted with Windows DPAPI, bound to your Windows user, and stored in the app's SQLite database. The key for that encryption lives in `%APPDATA%\OneLaunch\chromium\Local State`. Deleting the `chromium` folder, or moving the data to another Windows user or PC, makes every stored secret unreadable; Settings then offers to clear them so you can enter them again. There is no export yet.
- Copying a password puts it on the clipboard for 30 seconds, or until you quit One Launch if that comes first, with the formats that keep it out of Windows clipboard history and cloud clipboard; if that is not possible on your system, One Launch says so.
- Stored passwords are optional. Silent switching never needs them: Steam signs in from its own remembered accounts, and Epic, Battle.net, and the Riot Client from the saved sign-ins One Launch keeps. A stored password only feeds the Copy button when a launcher asks you to sign in.
- Steam automatic sign-in (Settings, off by default): when it is on, the first switch to a Steam account that Steam does not remember starts Steam with `-login <user> <password>` on its command line. That command line is visible to other programs running as your Windows user, and to Windows process auditing, for as long as that Steam process runs; Steam's own `-login` option has the same property. When it is off, One Launch opens Steam's sign-in form, waits for you, and offers to copy the login and password; nothing secret goes on the command line.
- Logs are written to `%APPDATA%\OneLaunch\logs`, rotated, with passwords, tokens, emails, and account ids redacted. They never leave the PC.
- Riot Games: One Launch only restarts the Riot Client with the chosen account's saved sign-in and starts the game the way its own shortcut does. It never touches a Riot game or Vanguard, never contacts Riot's servers, and will not switch while a Riot game is running.
- Found a security problem? Report it privately, as [SECURITY.md](SECURITY.md) describes.

## Data

All data lives under `%APPDATA%\OneLaunch`:

| Path | What |
| --- | --- |
| `onelaunch.db` | accounts, games, settings, encrypted secrets |
| `switch.json` | present only while a switch is running; if One Launch is closed in the middle of one, the next start finds it and offers to restore the snapshot. Holds ids and times, no logins or secrets |
| `artwork/` | cached images |
| `backups/<launcher>/` | snapshots of launcher files taken before each switch (Epic and Riot session files encrypted) |
| `backups/db/` | copies of the database, newest five |
| `logs/` | redacted logs |
| `chromium/` | Electron's profile, including the encryption key (do not delete) |

## Installing the beta

One Launch is a private beta. The installer, `OneLaunch-<version>-setup.exe`, is not code-signed yet, so Windows SmartScreen shows "Windows protected your PC" the first time: choose More info, then Run anyway. When the installer asks who to install for, choose "Only for me": it needs no administrator rights, and it is the only kind of install that updates itself (see Privacy and security). A copy installed for everyone on the PC never updates; run a newer installer over it by hand. Either way a newer installer keeps your data. Uninstalling leaves `%APPDATA%\OneLaunch` (accounts, backups, logs) in place; delete that folder by hand if you want it gone.

Download the installer only from this repository's [Releases](https://github.com/rjf2016/one-launch/releases) page. Because it is not code-signed, its build attestation is the way to check that GitHub's release workflow built it from the tagged source here. With the [GitHub CLI](https://cli.github.com):

```powershell
gh attestation verify OneLaunch-<version>-setup.exe --repo rjf2016/one-launch --signer-workflow rjf2016/one-launch/.github/workflows/release.yml --source-ref refs/tags/v<version> --deny-self-hosted-runners
```

`"One Launch.exe" --data-dir=<absolute folder>` runs the app with all of its data in that folder instead of `%APPDATA%\OneLaunch`, which is how to try a clean first start without touching your real data. A folder it cannot use stops the app with exit code 2 rather than falling back to the real one.

## Development

Node 24 (`engines` in `package.json`, enforced by `.npmrc`). `npm install`, then `npm run dev`. `npm run build` typechecks, bundles, and produces an unpacked build under `dist/win-unpacked`; `npm run build:installer` also produces the NSIS installer under `dist/`; `npm test` runs the unit tests; `npm run smoke:packaged` starts the packaged exe on a scratch data folder and checks that it answers and quits cleanly; `npm run notices` regenerates `THIRD-PARTY-NOTICES.txt` and the installer's licence page after a dependency change (a test fails until you do).

How One Launch works inside (architecture, switching and crash recovery, each launcher's internals, the UI, and the roadmap) is documented in [`docs/`](docs/README.md).

## Licence

MIT, see `LICENSE`. The open-source software One Launch is built with is listed in `THIRD-PARTY-NOTICES.txt`.
