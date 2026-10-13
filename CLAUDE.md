# One Launch

Windows desktop app (Electron, React + Vite + Tailwind, TypeScript strict, better-sqlite3, DPAPI vault): one front door to the user's Steam, Epic, Battle.net, and Riot Games accounts and installed games. Pick a game, pick an account, play. Private beta; current work is polish, UI tweaks, quality-of-life, and bug fixes.

Docs live in `docs/`; start at `docs/README.md` and read only the file the task needs.

## Standing rules

- Never modify launcher-owned files or registry keys without showing the user a dry-run plan and getting their OK. The only such writes live in the adapters' `runSwitch` / `applyRestore`; don't add others.
- The user performs all real account switches and launches. Never run one, never start or stop a launcher, never touch `%APPDATA%\OneLaunch` (it holds secrets).
- Preview mode (`dryRun`) is OFF by default, so Play switches for real even on a scratch data folder. Against real launchers never call `launch:start` or click Play (`launch:preflight` and `launchers:switchPlan` are read-only). Against fake launchers (`node scripts/drive.mjs <scenario> --fake`) clicking Play is the point.
- Verify in the running app before handing over. `docs/development.md` › "Verifying a change" says what each change class needs; hand the user only the real steps that table names (one real switch, one real update), never a full smoke list.
- Never log, print, or commit secrets, emails, account ids, or session material. Fixtures and docs use placeholders.
- Riot Games: the rules in `docs/adapters/riot.md` come before convenience. Never touch a Riot game process or Vanguard (image names only; no `tasklist`, `taskkill`, WMI or `Get-Process` for anything Riot), never switch while a Riot game runs, never send anything to Riot's servers (the one local exception is the launch request `launchGame` sends the client's own loopback server, rule 4 there), and never export a Riot session.
- Ask before adding a dependency. Phase 6 work that isn't built yet (code signing, onboarding wizard) needs the user's approval first.
- Releases are the user's. Never push a tag, create or publish a GitHub release, or run `npm run release:keygen` / `release:sign`; the signing keys never enter the repo or a session.
- Windows only. Keep the Electron security settings (contextIsolation, sandbox, no node in the renderer, typed IPC only).
- Commit only when the user asks. Build every feature on its own branch cut from `master` and land it through a pull request; never commit to `master` directly.

## Everyday

- `npm run dev`, `npm run build`, `npm test` (must stay green), `npm run typecheck`, `npm run lint`.
- After any dependency change run `npm run notices` (a test fails when the notices are stale).
- Docs: update only when a change makes a doc wrong or adds an invariant or decision a future agent needs. No dates, hashes, or line numbers in docs.
