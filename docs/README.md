# One Launch docs

One Launch is a Windows desktop app that is the single front door to a user's PC games and game accounts: **pick a game, pick an account, play.** It keeps many accounts per launcher (Steam, Epic Games, Battle.net, Riot Games), switches the launcher to the chosen account (closing, rewriting its files or registry values, restarting it, confirming the sign-in), and starts the game through the launcher. It does not replace the launchers; it orchestrates them.

Stack: Electron, React + Vite + Tailwind, TypeScript (strict), better-sqlite3, secrets encrypted with DPAPI via Electron `safeStorage`, electron-updater. A private beta; the version is in `package.json`.

## Principles (in priority order)

1. **Local-only security.** Nothing about accounts leaves the PC. No backend, telemetry, or third-party crash reporting. The only outbound traffic is artwork lookups (game names and store ids) and update checks against the project's GitHub releases (no identifiers; GitHub sees the app version and the IP address).
2. **Performance.** Cold start to interactive UI under ~1 s (ceiling 2 s); library renders instantly with placeholders; no heavy UI libraries.
3. **Sleek UI.** Dark, artwork-forward, premium game launcher feel, not an admin tool.
4. **Best-effort launcher compatibility.** Launcher internals are undocumented and change. A broken adapter never takes down the app, and every write to launcher state is backed up and reversible.
5. **Don't pigeonhole.** Personal tool first, public release later: typed, tested, nothing hardcoded to one user's machine.

In scope: accounts (login, optional encrypted password, tags, notes), switching and launching, a library of **installed** games across the four launchers, artwork. Out of scope: handling 2FA (the user completes it; the app must never fail or hang because a prompt appeared), owned-but-not-installed games, macOS/Linux, cloud sync, telemetry.

## Where to read

Read only what the task needs.

| File | Read when |
| --- | --- |
| `architecture.md` | Main-process work: services, IPC, vault, database, settings, data folder, updates, startup/quit |
| `switching.md` | Anything touching a switch, launch job, backups, restore, or crash recovery |
| `adapters/steam.md`, `adapters/epic.md`, `adapters/battlenet.md` | Touching that adapter or debugging a switch; the launcher's internals as observed on a real machine |
| `adapters/riot.md` | Any Riot Games work: its rules (ban risk) come first, then the Riot Client’s internals as observed on a real machine, the switch, the launch, the icon artwork, the fake client, and what is still unknown |
| `renderer.md` | UI work: views, store, conventions, copy |
| `artwork.md` | Artwork fetching and caching (with the updater in `architecture.md` › Updates, the only network code) |
| `development.md` | Commands, tests, smoke runs against the built app, packaging, CI, releases |
| `roadmap.md` | Standing product decisions and the open work items |

The shared types in `src/shared/models.ts` and `src/shared/ipc-contract.ts` are the source of truth for the renderer/main API; the docs don't repeat them.

## Keeping these docs useful

- Describe how things work now. No dates, commit hashes, line numbers, changelogs, or progress logs; git history already has those.
- Update a doc only when a change makes it wrong or adds an invariant, gotcha, or decision a future agent needs. Routine features and fixes need no doc edit.
- When a roadmap item is done, delete it from `roadmap.md`; don't mark it done.
