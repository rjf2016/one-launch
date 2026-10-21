# Development

How to build, test, and smoke-check One Launch, and the conventions the tests and tooling expect.

## Toolchain

- Windows only. The code shells out to `reg.exe`, `cmd.exe`, and Windows PowerShell; the live tests and the app need a real Windows PC.
- Node 24: `engines.node` is `>=24.0.0 <25` and `.npmrc` sets `engine-strict=true`, so `npm install` / `npm ci` stop on another major. CI pins Node 24.
- Electron, electron-vite, React, Tailwind, Zustand, TypeScript (strict, two projects: `tsconfig.node.json` for main/preload/shared/tests, `tsconfig.web.json` for the renderer and `test/renderer`).
- The runtime dependencies are `better-sqlite3` and `electron-updater`. better-sqlite3 loads a Node-API prebuild (`prebuilds/win32-x64.node`), so one binary serves both Vitest (Node) and Electron. `postinstall` runs `electron-builder install-app-deps`; a native toolchain (VS Build Tools, Windows SDK, Python) is installed on the dev PC in case a rebuild is ever needed.
- Everything else, React included, is a dev dependency bundled at build time. Ask the user before adding any dependency.
- No Playwright. Built-app checks use plain Node with the built-in `fetch` and `WebSocket` over CDP.

## Scripts

```powershell
npm run dev              # electron-vite dev with HMR
npm run dev:fake         # the same on a fresh scratch folder against fake launchers, CDP port 9334 open (scripts/dev-fake.mjs)
npm run build            # typecheck + electron-vite build + electron-builder --win --dir --publish never -> dist/win-unpacked
npm run check            # typecheck + lint + the whole test suite: the one command before any hand-over
npm test                 # vitest run (whole suite, must stay green); test:watch for watch mode
npm run typecheck        # tsc --noEmit on both tsconfigs
npm run lint             # eslint . && prettier --check .   (format = prettier --write .)
npm run icon             # renders build/icon.svg -> build/icon.png with Electron
npm run notices          # writes build/THIRD-PARTY-NOTICES.txt and build/license.txt (gitignored); build, build:installer and the workflows run it before electron-builder
npm run build:installer  # as build, but NSIS -> dist/OneLaunch-<version>-setup.exe (plus dist/win-unpacked)
npm run smoke:packaged   # starts dist/win-unpacked/One Launch.exe on a scratch folder and checks it over CDP
npm run release:keygen   # owner only, once: creates the release signing keys (see "Releases")
npm run release:notes    # prints the GitHub release notes rendered from the version's What's New entry (what the release workflow drafts)
npm run release:sign     # owner only, per release: signs a draft release's latest.yml and offers to publish it
```

- `npm run build` fails at the electron-builder step with `EBUSY` while `dist/win-unpacked/One Launch.exe` is running. `npx electron-vite build` alone refreshes `out/`, which is what an unpackaged run uses.
- Never run the installer unattended; installing, uninstalling, and upgrading are the user's to do.

## Environment variables and flags

| Name | Effect |
| --- | --- |
| `--data-dir=<absolute folder>` | Puts every file of the run (DB, logs, artwork, backups, journal) in that folder. Works packaged and unpackaged, wins over `ONELAUNCH_DATA_DIR`. Only the `=` form counts; relative paths, drive or share roots, and two different values are refused with one stderr line and exit code 2 before anything opens. Parsed by `dataDirFromArgv` in `src/main/platform/paths.ts`. |
| `ONELAUNCH_DATA_DIR` | Same redirect, honoured only when unpackaged (`electron.exe` on the repo). Ignored by the packaged exe. |
| `ONELAUNCH_FAKE_LAUNCHERS=<absolute folder>` | Runs against fake launchers seeded from that folder's `scenario.json` (see `test/fake-launchers/README.md`). Unpackaged only; the packaged exe ignores it. A bad value exits 2. Set by `scripts/drive.mjs --fake`; rarely by hand. |
| `ONELAUNCH_UPDATE_FEED=http://127.0.0.1:<port>/`, `ONELAUNCH_UPDATE_KEYS=<spki,...>` | The updater reads that loopback feed, trusts only those Ed25519 keys, caches inside the data folder, and never runs the installer. Unpackaged only; the packaged exe ignores both. A bad value exits 2. Set by `scripts/scenarios/update.mjs`. |
| `ONELAUNCH_LIVE=1` | Un-skips the read-only live tests. |
| `ELECTRON_RENDERER_URL` | Set by electron-vite in dev; makes `isDev` true. |
| `REMOTE_DEBUGGING_PORT` | Read by electron-vite in dev: Electron gets `--remote-debugging-port`. Set by `scripts/dev-fake.mjs`. |

The `starting` log line records which source applied (`"dataDirSource":"flag"`, `"env"`, or `"default"`). The real data folder is `%APPDATA%\OneLaunch`; it holds secrets, never touch it.

## Tests

Vitest, `vitest.config.ts`: `test/**/*.test.{ts,tsx}`, `environment: 'node'` by default, `@shared` alias, automatic JSX (no React import needed).

- **Unit tests** sit flat in `test/`, one file per module or adapter. Parsers are tested against sanitised real files in `test/fixtures/<steam|epic|battlenet|riot|steamgriddb>/`.
- **Fixtures**: copy the real file, replace every login, email, id, and user path with a placeholder of the same shape and length, keep everything else byte for byte, and add a parser test for the fields you rely on. `test/fixtures/**/*.real.*` is gitignored (keep unsanitised originals there); fixture `.log` files are tracked explicitly. Prettier ignores `test/fixtures/`.
- **Adapter tests** run each adapter end to end over a temp directory tree with `StaticRegistry` (`src/main/platform/registry.ts`) and `StaticProcessController` (`src/main/platform/processes.ts`). A scripted launcher hooks `StaticProcessController`'s `onStart` to write what the real client would (registry `ActiveUser`, log lines, INI rewrites). These simulators encode the test author's model of each client, so a wrong model still passes.
- **Service tests** use small fakes defined in the test file: `FakeVault` (reversible transform standing in for DPAPI), `KeyedVault` (swappable key), `ScriptedSteam` / `FakeSteam` / `FakeAdapter`, `fakeFetch` (URL-routed responses), and an in-memory SQLite DB.
- **Electron** is mocked with `vi.mock('electron')` in `ipc-handlers`, `ipc-validation`, `preload`, and `paths` tests.
- **Renderer tests** live in `test/renderer/*.test.tsx`:
  - first line `// @vitest-environment jsdom`;
  - first import `./setup` (a `window.matchMedia` stub; the UI store calls it at import time);
  - fake bridge from `./harness`: `installBridge({ channel: handler })` answers `window.oneLaunch.invoke` (and `startup(channel)`, which sends the startup requests through the same fake on its first call) with the real `{ ok, data }` / `{ ok: false, error }` envelope so `lib/ipc.ts` runs unmodified. Throw `BridgeError(code, msg)` for an error envelope; an unhandled channel answers `NO_TEST_HANDLER`; `sent(channel)` / `calls` record traffic; `deferred()` holds a call open; `resetUi()` resets the store and closes the startup window (`prefetchStartup(window.oneLaunch, ms)` opens one in a test); fixtures `account`, `game`, `plan`, `preflight`, `jobStep`, `job`.
  - Uses `@testing-library/react` and `user-event`. jsdom has no layout: clamping, `offsetParent`, the focus trap, scrolling, and `visibility: hidden` focus bugs are only visible in a CDP smoke run.
  - Focus that an effect moves once data arrives (`useFocusWhenReady`) lands a loop turn after the DOM changes: assert it inside `await waitFor(...)`, never synchronously after a `waitFor` that returned the enabled control. Focus after a `user.*` event may be asserted at once.
- **`test/ipc-validation.test.ts`**: every channel must be in `REFUSED` (malformed payloads that must answer `BAD_REQUEST` without reaching any service) or in `NO_PAYLOAD`; a completeness case fails when a channel is missing. Services are recording `Proxy` objects.
- **`test/third-party-notices.test.ts`** runs `scripts/third-party-notices.mjs` and checks what it writes: every shipped package named with its version, no dev dependency, and a licence page that starts with the MIT licence. A new dependency whose tarball has no licence file makes the generator throw; add its text to `WRITTEN_OUT` in the script.
- `src/main/index.ts` (the Electron bootstrap and wiring) cannot be imported by a test; keep pure logic out of it (as with `src/main/window-guard.ts`) so it can be tested.
- No coverage tool, no thresholds.

### Live tests (read-only, never in CI)

`test/steam-live.test.ts`, `epic-live.test.ts`, `battlenet-live.test.ts` build the real adapter against the real install and run detect, scan, remembered accounts, health, and two dry-run plans, then assert nothing was written (file bytes and mtimes, registry values, no snapshot, no session). `riot-live.test.ts` does the read-only part, the session state included (fingerprint digits and an id tail, never a token or the Riot ID), prints the dry-run plan's step titles and warnings, asks `launchGame` only for an id that is not a product (refused before anything starts) with a launch-request stub that throws, so nothing reaches the client's local server, and checks the session file by size and mtime. `test/platform-live.test.ts` checks that registry and process-list output decode without U+FFFD. All print counts only. Run one at a time:

```powershell
$env:ONELAUNCH_LIVE = '1'; npx vitest run test/steam-live.test.ts --reporter=verbose --silent=false
```

## Adding an IPC channel

1. Add it to `IpcContract` and to `IPC_CHANNELS` in `src/shared/ipc-contract.ts` (missing either is a type error, on purpose).
2. Handle it in `src/main/ipc/index.ts` with `handle(...)`; validate the payload there; call `requireIdle()` if it must be refused while a switch runs.
3. Call it from the renderer via `ipc.invoke` (`src/renderer/src/lib/ipc.ts`) or `useIpcQuery`.
4. Add a row to `REFUSED` (or `NO_PAYLOAD`) in `test/ipc-validation.test.ts`.

The preload exposes `window.oneLaunch.invoke` and `startup(channel)` (the answers to the `STARTUP_REQUESTS` it sends at document start) and forwards only names in `IPC_CHANNELS`.

## Verifying a change

Agents verify in the running app before handing over. The user's part is the real switch (adapter write row) or the real update (updater row), and only when that row applies.

| Change class | Mandatory before handing over |
| --- | --- |
| Anything | `npm run check` (typecheck, lint, the whole test suite) |
| Renderer (views, components, store, copy) | a jsdom test for the behaviour, plus `views.mjs` screenshots of the affected view at 1280x800 and 960x600, looked at |
| Launch dialog, `LaunchService`, `LauncherService`, `runSwitch` / `applyRestore`, backups, journal, recovery | `test/pipeline.test.ts`, plus the fake-launcher scenarios that cover the touched path (`play-*`, `rollback`, `stop`, `handover`, `recovery`, `restore`) |
| Adapter read/parse code (detect, scan, remembered accounts, health, plans, log parsers) | the read-only live test for that launcher (below) |
| Adapter write, shutdown, sign-in wait, or file/log format code, or a launcher client update | all of the above, then hand the user one real switch on **that** launcher only: at most five numbered steps, each with where it happens and the expected outcome |
| `scripts/`, CI, packaging | `npm run build` and `npm run smoke:packaged` |
| `src/main/updates/`, the Updates panel or sidebar card, the publish config, the release workflow or scripts | `test/update-*.test.ts`, the `update.mjs` scenario, then `npm run build:installer` and `npm run smoke:packaged`. Only when the install path changed (`engine.ts`, `installAtQuit`, availability, the NSIS config) hand the user one real update: an installed copy of version N takes a published N+1. |

The simulators encode our model of each client; a real client can disagree, which is what the real switch is for. Likewise the loopback feed stubs the installer, so only a real update exercises NSIS.

## Driving the built app

Hard rule: **Preview mode (`dryRun`) is OFF by default, including in a fresh scratch folder.** Against real launchers (a run without `--fake`) never call `launch:start`, never click Play, never press Restore; `launch:preflight` and `launchers:switchPlan` are read-only. Never start or stop a launcher. Against fake launchers all of that is the point.

`scripts/app-driver.mjs` drives the app over CDP with plain Node: every `invoke` goes through the real preload and IPC, and every run gets a fresh `mkdtemp` scratch folder passed as `--data-dir=`, deleted afterwards unless `--keep` or something failed. The scenarios, the driver API, the flags, `agent-browser` for an interactive look and the gotchas are all in `.claude/skills/run-one-launch/SKILL.md`; read it before driving.

```powershell
npx electron-vite build                                                     # unpackaged runs use out/
node scripts/drive.mjs scripts/scenarios/views.mjs --shots=<folder>          # screenshots of every view
node scripts/drive.mjs scripts/scenarios/play-all.mjs --fake --shots=<folder> # Play on each fake launcher
npm run smoke:packaged                                                       # the packaged exe (scripts/smoke-packaged.mjs -> scenarios/packaged-smoke.mjs)
```

- `drive.mjs` imports only a `.mjs` file that resolves to directly inside `scripts/scenarios/`, and the driver starts only `node_modules/electron/dist/electron.exe` or `dist/win-unpacked/One Launch.exe` (there is no `--exe`). `.claude/settings.local.json` (each developer's own, gitignored) pre-approves `node scripts/drive.mjs scripts/scenarios/*` on the strength of that, so keep both rules (`test/drive-refusals.test.ts`). An ad hoc scenario is a gitignored `scripts/scenarios/adhoc-*.mjs`. The same file pre-approves `npm run check`, `npm run lint` and `npm test` but no `npx` wildcard: `eslint`, `prettier` and `vitest` take config and plugin flags that run code.
- The runner closes the window itself and checks that the app exits with code 0 and that **the log has no ERROR line**, unless the scenario did. Keep that check; a failure there is a product bug first.
- `packaged-smoke.mjs` refuses an exe whose `app.asar` lacks the text `--data-dir=` (an older build would open the real data folder), reads only, and on a PC with launchers starts real artwork downloads into the scratch folder. The packaged exe never enters fake mode (`--packaged` refuses `--fake`); never point `--data-dir` under `%APPDATA%`.
- Synthetic `el.click()` has no pointer position, so context menus land at 0,0 in screenshots; `window.close()` is fired without awaiting and raced against the child's exit.

## Packaging and CI

- `electron.vite.config.ts`: main unminified (readable stacks in the log), preload CommonJS (sandbox), production CSP injected as a meta tag.
- `electron-builder.yml`: NSIS only, per-user, licence page `build/license.txt`, `build/THIRD-PARTY-NOTICES.txt` beside the exe (both written by `npm run notices` and gitignored), only the `better-sqlite3` win32-x64 prebuild (unpacked from the asar), `deleteAppDataOnUninstall: false` (keep it false: user data must survive uninstall), Electron fuses (`architecture.md` › Hardening), `publish` to GitHub `rjf2016/one-launch` as a draft. The publish block is what writes `dist/latest.yml` and `resources/app-update.yml` (the latter for NSIS builds only). Builds are unsigned.
- Every electron-builder call passes `--publish never`. Without it electron-builder publishes implicitly on any CI run and fails for want of a token; only the release workflow makes a release, and only as a draft.
- `.github/workflows/ci.yml`, job `check` on `windows-latest`, Node 24, read-only token, pushes to master/main and PRs: `npm ci`, `node node_modules/electron/install.js` (Electron ships no install script; without this step the first import of the package downloads the binary inside a vitest worker), typecheck, lint, `npx vitest run`, `npx electron-vite build`, the `play-all`, `first-run` and `update` scenarios, `npm run notices`, `npx electron-builder --win nsis --publish never`, a file check (exe, better-sqlite3 prebuild, notices, installer, `latest.yml`, an `app-update.yml` naming the repo), `node scripts/smoke-packaged.mjs`, then uploads the installer as artifact `OneLaunch-setup` (14 days).
- `.github/workflows/release.yml` runs on a pushed `v*` tag; see "Releases". Its actions are pinned to commit SHAs and it installs without a dependency cache.
- The CI runner has no launchers, so the smoke step exercises the not-installed paths and the quit sequence on a slower machine. Two rules follow: a normal state or an expected refusal (a launcher that is not installed, a running launcher, preview mode, a game that needs an update: `REFUSAL_CODES` in `src/main/services/refusals.ts`) must not log at ERROR, and work still running at quit must not log at ERROR. Any ERROR line fails the job; fix the product, not the check.
- Live tests never run in CI; `scripts/` is not linted by ESLint (Prettier still checks it).

## Releases

Installed copies update from this repo's GitHub releases (the repo is public for that; a private repo would need a token inside every copy). A release stays a draft until the owner signs and publishes it. Agents never push tags, create or publish releases, or run `release:keygen` / `release:sign`.

Once: in PowerShell or Windows Terminal (the passphrase prompt needs a real console; Git Bash is not one), `npm run release:keygen -- <folder outside the repo>` writes the primary and backup Ed25519 keys as passphrase-encrypted PEM files and pins their public halves in `src/main/updates/release-keys.ts`; commit that file. `*.pem` is gitignored. The backup lives offline, apart from the primary, and signs only if the primary is lost or leaked; the release it signs should also drop the old key from `release-keys.ts`.

Per release:

1. Bump `version` in `package.json` on a branch, add the release's entry to `src/shared/whats-new-releases.ts` (it is both the What's New card that opens once after the update and the GitHub release's notes, so every release needs one; its image, if any, goes in `src/renderer/src/assets/whats-new/`; preview the card from Settings › Advanced › Developer in a dev run and the notes with `npm run release:notes`), and merge it through a PR.
2. Tag the merge commit `v<version>` and push the tag. The release workflow checks that the tag matches the version and is on master, renders the release notes from the version's entry (no entry: it stops there, before the build), runs the CI checks and scenarios, builds the installer, attests its build provenance, and creates a draft release with those notes, the installer, its `.blockmap`, and `latest.yml`.
3. `npm run release:sign -- v<version> --key=<primary .pem>` downloads the draft's installer and `latest.yml`, refuses unless they describe the same file, signs what it measured, uploads the signed `latest.yml`, downloads it again to verify it, and offers to publish.

- Copies see a release only once it is published: drafts are invisible to `releases/latest`. Publishing is the rollout; there is no staged rollout.
- Fix forward: a bad release is replaced by a higher version. `allowDowngrade` is off, and deleting a release only stops new downloads.
- Every copy refuses an unsigned `latest.yml`, a key missing from `RELEASE_KEYS`, and an installer that does not match ("Could not verify the update").
- `1.0.0-beta.1` has no updater, so its users install the next version by hand once. electron-updater's first differential download from a version with no published release logs a WARN and falls back to a full download.
- Anyone can check an installer's provenance with `gh attestation verify <installer> --repo rjf2016/one-launch`.

## Lint and formatting

- ESLint: recommended rules, not type-aware; `react-hooks` for renderer code; `_`-prefixed unused vars allowed; inline `type` imports enforced.
- Prettier: `printWidth` 160, single quotes, trailing commas, LF. Markdown is not checked.

## App icon

`build/icon.svg` is the master; `build/icon-mono.svg` is the single-colour mark, inlined as `BrandMark` in the title bar. `npm run icon` renders `build/icon.png`, which electron-builder turns into the exe's `.ico`. The purple disc fills the whole canvas and the white mark takes about 85% of it: Windows draws taskbar icons edge to edge, so a transparent margin makes the icon read smaller than its neighbours, and a dark tile on the dark taskbar reads as nothing at all. Judging the icon in the taskbar needs an install: Windows takes a window's taskbar icon from the Start Menu shortcut that carries the same AppUserModelID (`dev.onelaunch.app`, set in `index.ts`), so an unpackaged run and the `dist` exe both show the installed copy's icon.
