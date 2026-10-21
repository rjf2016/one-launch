# Roadmap

## Status

- Phases 1-5 (foundation, accounts + Steam, library + artwork, Epic, Battle.net) are built and accepted on real launchers.
- A private beta for a few friends (the version is in `package.json`). It is not 1.0: 1.0 waits for signing (A12).
- Phase 6 (release readiness) is only partly approved. Built so far: the setup guide (five steps over the Library on a new install, opened again from Settings › General), and the release plumbing: NSIS installer with a licence page, `--data-dir=` override, `npm run smoke:packaged`, derived `THIRD-PARTY-NOTICES.txt`, `engines` + `engine-strict`, and CI that builds the installer, runs the packaged smoke test and uploads the installer. Also built: the updater (GitHub Releases, Ed25519-signed manifests, a draft-then-sign release workflow).
- Riot Games support: the adapter switches accounts and restores snapshots (close, save the outgoing sign-in, snapshot, the account's whole saved file or the client's own signed-out state, start, confirm from the log and the file, hand-over, rollback), refuses while a Riot game runs, hands the client a game the way its shortcut does and, since the client only opens the game's page (Riot has turned auto-launch off), presses Play for the user through the launch request the client's own Play button sends (`riot.pressPlay`, on by default; off, the dialog hands over to Play), reads "needs update" from the log's patch state, and shows the product's own icon while no cover is found online. The user's real switch (A to B to A) and a real launch with the press on (VALORANT started without pressing Play) both worked. The rules and findings are in `adapters/riot.md`.

## Standing decisions (do not re-open)

- **Riot Games: the lowest ban risk wins.** The hard rules in `adapters/riot.md` come before convenience: nothing touches a Riot game or Vanguard, no switch runs while a Riot game does, nothing is sent to Riot's servers, and sessions never leave the PC. Riot is not asked to approve the feature.
- **Riot games start without the user's Play.** Once the client has opened the game's page, One Launch sends the client's local server the launch request its own Play button sends, on by default (`riot.pressPlay`). Weighed by ban risk first: the request is invisible to Vanguard and the same work for the client as a click; synthetic input to the client's window was refused as fragile and worse-looking. The one exception to rule 4 in `adapters/riot.md`, scoped there.
- **Riot Games is on by default, with no notice or opt-in**, like the other launchers. Beta testers say One Launch already shows too many warnings and that this lowers their confidence in it. Do not add warning or notice copy; say what the user must do, at the moment they must do it.
- **Unsigned builds.** Code signing is deferred, so SmartScreen shows "unknown publisher". The candidates are Azure Artifact Signing and SignPath Foundation.
- **Update channel.** `electron-updater` reading this repo's GitHub releases, which is why the repo is public (no token in the app). Every `latest.yml` must carry an Ed25519 signature from a key pinned in `src/main/updates/release-keys.ts`; the private keys are the owner's, offline, behind a passphrase, never a CI secret. CI builds only drafts; the owner signs and publishes. One channel: betas ship as normal releases. `updates.auto` is on by default, and off means no update traffic unless asked. Only per-user installs update. A ready update shows as a card in the sidebar.
- **Artwork is on by default, with no consent question.** The setup guide's launchers step says what is sent and Settings › Artwork turns it off. Game names and store ids are not sensitive. Never add a consent gate.
- **Preview mode (`dryRun`) is off by default.** It was a development aid. In smoke runs, never call `launch:start` or click Play, even with a scratch data folder.
- **Silent switching never needs a stored password.** Passing the password to Steam with `-login` is opt-in (`steam.autoLogin`, off by default), because the command line is visible to other processes. With it off, Steam starts with `-login <name>` and hands over, offering Copy login and Copy password. The user dislikes any flow that makes people feel they must hand over credentials.
- **Wrong-account policy.** Suppose the account has no launcher id and the signed-in launcher id already belongs to another One Launch account. Then the switch rolls back as `wrong-account` and the error names that account. An id that belongs to nobody is linked and shown ("Linked to … account …1234"). `setLauncherUid` fails closed.
- **A launcher started by something else during a switch fails the switch, and One Launch never closes it.** Closing it could kill a running game.
- **Abort semantics.** Before any write, the switch just stops. After the writes but before the launcher restarts, the snapshot is restored. Once the launcher has started, the writes stand.
- **Unowned sessions are kept, not adopted.** The snapshot is pinned outside `backups.keep`, with a limit of 10 pinned per launcher.
- **Launcher paths come only from main's own file dialog**, never from the renderer.
- **`--data-dir=` refuses a bad value (exit 2) instead of falling back**, so a test run can never reach the real `%APPDATA%\OneLaunch`.
- **The installer is assisted, not one-click**, and has a licence page. `deleteAppDataOnUninstall` stays false.
- **No new dependencies without approval.** Only jsdom and Testing Library were pre-approved.
- **The user has one PC, running Windows 11 Home, with no VM or Sandbox.** Installer checks run under their own account after backing up the data folder. The CI runner is the only machine without launchers. Keep the smoke test's "no ERROR line" check, and treat a failure there as a product bug first.
- **Real launcher switches, Restore, and anything touching `%APPDATA%\OneLaunch` are the user's steps.** Agents stay read-only against real launchers, and do their switching against the fake launchers (`node scripts/drive.mjs <scenario> --fake`). The user runs a real switch only when `docs/development.md` › "Verifying a change" says so.
- **The test doubles and the launcher simulators ship in the bundle.** `StaticRegistry`, `StaticProcessController`, and `src/main/launchers/sim/` are the fake platform an unpackaged run gets with `ONELAUNCH_FAKE_LAUNCHERS`; the packaged exe ignores the variable. Do not move them to `test/`. The simulators encode our model of each client, so a passing fake run never replaces the real switch the table asks for.

## Open work

### Release (Phase 6)

- **A12**: code signing. Signing config in `electron-builder.yml` plus a CI secret. **Needs user approval** and a signing-route choice.
- **Adapter versioning**: ship adapter fixes independently. Pairs with C6.
- **Updates for all-users installs.** Refused today (`all-users-install`), because the silent update would stop at a UAC prompt. Needs a prompt the user asked for, not one at quit.
- **Unverified by hand**: uninstall, upgrade in place with the app running, and a real update (an installed copy taking a published, signed release).

### Riot Games (wanted before the production launch)

Rules, observed internals, and open questions: `adapters/riot.md`.

- **R12 remainder**: the user's look at the Library tile that shows a Riot game's own icon (the icon artwork counts as done only when they find the tiles good). The real switch and the real launch with the press on are done.

### Should fix before 1.0

- **B22** (Battle.net part): Battle.net still waits its full 5 s restart watch after every clean shutdown. Shortening it needs a real client log of an update restart first. One such close is now observed (`adapters/battlenet.md` › Client self-update): with a pending client update the client exited cleanly in about a second, did not come back on its own, and the launcher applied the update at the next start. One observation, with the prompt showing; a close during the update's download is not observed.
- **B23 follow-up**: "adopt as a new account" for an unowned session. **Needs product answers from the user** (naming, silent vs offered).
- **B24**: Epic's close step waited the full 45 s `restartSettleMs` after the launcher handed off to `EpicGamesUpdater.exe`, which only applied the staged self-update (5 s, its own log) and never relaunched the launcher (`adapters/epic.md` › Shutdown). Watch the updater instead (its process, or its log's `Application finished`) and give a relaunch a few seconds after that, rather than a fixed 45 s. Observed once each: a hand-off with a relaunch and one without.
- **B19 remainder**: the Battle.net rule "a token is accepted only for the first saved login" exists only in the test simulator. Recheck it only if the client changes.

### Later (C)

- **C2**: `launch_history` hygiene. Add an index on `(game_id, result, launched_at)`, cap rows per game, and handle deleted accounts, which have no FK.
- **C3**: after a lost DPAPI key, encrypted backup snapshots cannot be decrypted. List them and offer to delete them, and mention backups in the vault-reset copy.
- **C4**: move `artwork/` and `logs/` from roaming `%APPDATA%` to `%LOCALAPPDATA%`. Never move `chromium/`, because that orphans the vault key.
- **C5**: account export and a master-password vault mode, since DPAPI binds secrets to one Windows user. Riot sessions are never exported (`adapters/riot.md`).
- **C6**: record which launcher build each adapter was validated against. Health checks should assert positive facts and warn when a format changes.
- **C7**: a CSP response header (the CSP is only a `<meta>` tag today).
- **C9**: Epic writes the session into both the `Windows` and `WindowsEditor` settings files, but the launcher reads only the newest. Write only that one, or clear the other.
- **C10**: launch latency follow-ups, each needing one real switch or launch: end Epic's 2 s grace at `AllCheckComplete`; let Steam's preflight trust `RunningAppID` 0; a long-lived process-watch helper instead of one PowerShell per poll (an architecture change); the Riot client's local quit endpoint as a clean close (a second local endpoint under rule 4 of `adapters/riot.md`).
- **C11**: install size. A fresh install is 372 MiB, 98.8% of it the Electron runtime. Shipping only the en-US locale (-48 MiB) and dropping `dxcompiler.dll` and `dxil.dll` (-26 MiB) both ran on a stripped scratch copy; nothing is changed yet. `electronLanguages: [en-US]` in `electron-builder.yml` is the supported one-liner; the DLLs need an `afterPack` hook that deletes them from `appOutDir`, and `npm run smoke:packaged` must stay green.

### Minor (D)

- `settings:getAll` returns the main-only `window.bounds`.
- There is no `did-fail-load` handler.
- Dead surface: `Dropdown` `dense`, `LauncherDot` `className`, `AppInfo.logDir` and `AppInfo.chrome` (never rendered), and the `app:ping` and `launchers:games` channels (never called).
- Battle.net `plan.executable` is always `true`, so `blocked` is dead code for Battle.net.
- The account page's signed-in-as row still grows on load while the launcher runs: its hint arrives with the session query (the Saved sign-in row above it reserves its line).

## Out of scope / future ideas

- Automating two-factor authentication (the user completes 2FA prompts; the app must never hang on one).
- Owned-but-not-installed games (needs per-launcher auth/API work).
- macOS and Linux (realistically Steam only, and only if there is demand).
- Cloud sync, online accounts, telemetry and analytics.
- A favourite account per game, and quick-launch pairs in the system tray.
- Playtime tracking per account.
- Adapter auto-diagnosis: diff the launcher's file layout against the documented one when a switch fails.
