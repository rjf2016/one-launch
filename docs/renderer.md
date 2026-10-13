# Renderer

React 19 + TypeScript in `src/renderer/src`, built by electron-vite. It is sandboxed with no Node access. The only way out is `window.oneLaunch.invoke`, reached through `lib/ipc.ts`. See `architecture.md` for the bridge and IPC, `switching.md` for the job state machine, and `development.md` for the renderer test harness.

## Aesthetic and principles

- Dark only (`color-scheme: dark`), premium game launcher, not an admin tool. Artwork-forward: the Library is a poster wall.
- Motion is subtle: `transition-colors duration-150` on interactive elements, 200 ms `ease-out` for the sidebar width. No bouncy or layout-shifting animation. Add `motion-reduce:transition-none` to anything that moves. The setup guide is the one place with entrance fades and two slow loops (below); all of it is opacity and transform, and none of it runs under reduced motion.
- Light deps only: Tailwind 4 (CSS-first config in `index.css`), `lucide-react` icons, `zustand`. No component, animation, chart or router library. Don't add one.
- Native `<select>` is banned: its OS-drawn popup cannot be themed. Use `Dropdown` (selection) or `MenuButton` (actions).
- Layout must hold from the 960 px minimum window width to fullscreen: no horizontal page scroll, no wrapping button labels (`Button` is `whitespace-nowrap`), no content shift when async text changes length (fixed widths + `truncate`, skeleton rows the same height as the real ones).

## Design tokens (`src/renderer/src/index.css`)

- Colours are CSS variables on `:root`, exposed as Tailwind utilities through `@theme inline` (surfaces, text greys, violet `accent`, the status tones, and one colour per launcher). Use the tokens, never raw hex.
- `faint` and `muted` are tuned to at least 4.5:1 on `bg`, `surface` and `surface-2`. Don't put faint text on `surface-3` or darken these tokens.
- Tone pattern for callouts: `border-<tone>/30 bg-<tone>/10 text-<tone>` (warning = needs the user, danger = failed, accent-soft = in progress, success = done).
- Fonts are Segoe UI (`font-sans`, base 14 px) and Cascadia (`font-mono`) for ids and paths. `text-xs` is for hints and `text-sm` for body text. Cards and dialogs use `rounded-panel` with `shadow-panel`.
- `body` is `user-select: none`; inputs opt back in. Add `select-text` to values the user may want to copy (paths, step detail).
- Scrollbars are custom `::-webkit-scrollbar`. The thumb shows only on the container under the pointer via the `.sb-hover` class from `lib/scrollbarHover.ts`. CSS `:hover` does not work: Chromium doesn't repaint custom scrollbars on a host hover change.

## Shell and navigation

- There is no router: `view` and `accountRoute` in the store select the page. `App.tsx` mounts the global hosts (`ConfirmDialog`, `RecoveryHost`, `SetupGuideHost`, `LaunchHost`) above the views.
- `TitleBar` is a 36 px (`h-9`) drag strip. Main draws the Windows caption buttons over its right end (`titleBarOverlay`). Put nothing interactive in it. Every modal backdrop starts at `top-9` so the window stays draggable. When `app:info` reports `platformSource: 'fake'` it shows a "Fake launchers" `role="status"` badge, so no screenshot of a fake-launcher run can pass for a real one.
- `Sidebar` collapses to icons below 1100 px (`SIDEBAR_NARROW_QUERY`). A manual toggle (Ctrl+B) is stored in `localStorage` until the window crosses the breakpoint. Only the aside width animates. Labels fade in place so nothing reflows. The "Preview mode is on" card shows only when `dryRun === 'true'`.
- `Page` scrolls the whole pane. Its `narrow` prop caps forms at 65 rem, and the Library stays full width. `PageHeader` is sticky.
- Global shortcuts go through `isShortcut` (`lib/shortcuts.ts`): none fires while a modal dialog (`aria-modal`) is up, and Ctrl+1/2/3 and Ctrl+B are also skipped while focus is in an input/textarea/contentEditable. Ctrl+F (Library search) and Ctrl+S (account save) fire from fields.

## Store and data flow (`store/ui.ts`, zustand)

- UI state only. Domain data is never cached in the store, with two exceptions: `launcherStatus`, the last `launchers:status` answer, shown at once on later visits while a fresh one loads; and `updateStatus`, the last `updates:status` answer, shared by the sidebar card and Settings › Updates.
- Views fetch with `useIpcQuery(fetcher, deps)` from `lib/ipc.ts`: `{ data, error, loading, reload }`. It drops stale responses, keeps `data` across reloads (no flash to empty) and clears `error` when a run starts.
- `ipc.invoke` throws `IpcError(code, message)`. Show `message`. Branch only on `code`, never on message text.
- `settingsRevision` / `settingsChanged()`: bump it after any `settings:set` so the Sidebar card re-reads `settings:getAll`.
- Navigation (`setView`, `openAccount`, `newAccount`, `backToAccounts`) goes through `navigate`, which awaits `leaveGuard` (set by account forms while dirty) and clears the guard on success. `setView('accounts')` from a detail page returns to the list.
- `ask(opts)` opens `ConfirmDialog`. If a question is already open it answers `false` straight away.
- Main never pushes to the renderer, so background changes arrive by polling. The Library polls `artwork:status` and reloads when `status.revision` changes. `useUpdateStatus(idleMs)` (`lib/updates.ts`) polls `updates:status` into the store: every second while a check or download runs, else every 60 s from the sidebar and 5 s from Settings. Polling does not back off while the window is hidden.
- Per-viewer UI prefs go in `localStorage` inside try/catch (`sidebar`, `library.sort`). Everything else is a setting in main.

## Launch flow hosting (`components/LaunchHost.tsx`, `LaunchDialog.tsx`)

- `LaunchHost` mounts the dialog above all views. Views only call `openLaunch({ game, initialAccountId })`, and `game: null` means a plain account switch.
- `launchRequest` (the dialog is open) and `activeLaunch` (the job) are separate. The job outlives both the dialog and navigation.
- `LaunchHost` polls `launch:status` every 150 ms while the job is `running`, dialog open or not (an in-memory snapshot over IPC, so the phase list keeps up with the adapter). While the dialog is closed it shows a banner with Show and Dismiss. A `done` banner clears itself after 8 s. Other outcomes stay until dismissed.
- On mount the dialog attaches to a running job, or to a finished job for the same game, and clears any other.
- Escape, the backdrop and X do nothing while the dialog is checking, running or submitting. `submittingRef` blocks a double `launch:start`. A `CONFIRM_REQUIRED` error re-runs the preflight and shows the confirm stage. This is the renderer's only branch on an error code.
- While a job runs the footer offers Stop (`launch:cancel`) and Hide. Stop is left out while the sign-in panel shows, because its Stop waiting does the same; the two share one "Stopping…" state until the job ends.
- Progress is shown as five plain phases from `lib/phases.ts`, with the raw steps behind "Show details". Keep `lib/phases.ts` and `lib/recovery.ts` pure, because they are unit-tested.
- `RecoveryHost` asks once at startup about an interrupted switch. It cannot be dismissed with Escape or the backdrop.

## Setup guide (`components/SetupGuide.tsx`, `SetupGuideSteps.tsx`, `SetupGuideArt.tsx`)

- `SetupGuideHost` asks once at startup and opens the guide for a data folder nobody has set up: `firstRun.dismissed` unset and no account. Settings › General › "Show again" opens it for anyone (`openSetupGuide('settings')` in the store). It is a modal dialog (`z-40`, under the recovery and confirm dialogs), so no shortcut fires behind it, and its backdrop is inert.
- Five steps: Welcome; Your launchers (`launchers:status`, Locate… on each missing row, the installed-game count polled from `artwork:status` and `library:list`, and the artwork sentence); How Play works (three points and a self-playing phase list built from `lib/phases.ts`); Your accounts (what Steam and Battle.net remember, in one import across both, one line naming any installed launcher that keeps no list, plus "Add by hand" toggles); Ready (the summary). The footer only navigates (Back, Skip, Continue); actions live in the step body.
- Every way out writes `firstRun.dismissed` and closes: Skip, Escape, the X, Open Library, Go to Accounts, and "Add a <launcher> account", which opens that launcher's new-account form. A save that fails still closes the guide; it comes back next start. The guide never opens by itself once dismissed or once an account exists, so installs that predate it never see it.
- Each step opens with the focus on its primary action, an sr-only `role="status"` announces "Step n of 5: <name>", and the dialog is named by the step heading (`id="setup-title"`).
- Motion: the card and each step fade in (`guide-card`, `guide-fwd` / `guide-back`), rows rise with a stagger (`guide-rise` plus an inline `animationDelay`), check marks pop, the welcome art swaps the account name on a 5 s loop and rings the Play button, and the phase demo advances on a JS clock (`useLoop`, `lib/motion.ts`). `usePrefersReducedMotion` freezes the loops and the CSS block turns the rest off. A screenshot taken the instant a step mounts catches the entrance mid-fade; scenarios settle for 900 ms first.

## Views

- **Library** (`views/LibraryView.tsx`): a header with the flash, "Fetching artwork (n)" and Rescan, then a toolbar with search, Filter and Sort. Below it, the Recent strip (hidden while searching or filtering), the `GameCard` poster grid, and `CardMenu` for artwork actions.
- **Accounts** (`views/AccountsView.tsx`): grouped by launcher and ordered by `sortAccounts`: accounts used from One Launch first, then by name. The launch dialog reuses this order.
- **Account detail** (`views/AccountDetailView.tsx`): only the create form autofocuses. Ctrl+S sends the changed fields only. Also holds the password panel, "Switch to this account", `SessionPanel` (Epic, Battle.net, Riot), a collapsed Advanced section, and a two-step delete.
- **Settings** (`views/SettingsView.tsx`): General (ending with the setup guide's "Show again"), Updates, Launchers, Backups and Artwork, then a collapsed Advanced section. The renderer never sends a launcher path: Locate… opens main's file dialog. `setSetting` shows "Could not save the setting: <message>" on failure and always reloads, so the control snaps back.

## Copy conventions

- User-facing names hide internals. `dryRun` is **Preview mode** (off by default; check `=== 'true'`). The vault is **Encryption**. A captured session is a **saved sign-in**. A switch plan is a **Switch preview**. Never show UnifiedAuth, fingerprints, "capture", adapter ids or raw setting keys.
- Write plain second-person sentences with no jargon. A hint is one sentence. UI paths use `›`, as in "Settings › Backups".
- Errors: "Could not <verb> <thing>: <message>" (`text-danger`, `role="alert"` when it appears on its own). A failed job says what state it left behind: put back, needs a manual restore from Settings › Backups, or nothing changed yet.
- Hand-over to the user (2FA, expired session) is calm and explicit, never a failure: the warning-toned `AttentionPanel` with the adapter's title/message, Copy login, Copy password (only if `canCopyPassword`), Stop waiting, and "Waiting up to n more min". Footer: "Waiting for you in the <launcher> window…".
- Strings that claim behaviour (clipboard, what is sent, what delete removes) must match main. Check the service before rewording one.

## Clipboard

- The renderer never receives a secret. Copy calls `accounts:copy { id, field }`. Main decrypts, copies and clears later.
- The flash must read "<Login|Password> copied · clipboard clears in <n>s while One Launch is open". Add " · Windows clipboard history may keep it" for a password when `historyExcluded` is false. `n` comes from `clearAfterMs` in the response. Never hardcode it.

## Accessibility conventions

- Dialogs: `role="dialog"`/`"alertdialog"`, `aria-modal`, `aria-labelledby`, `useFocusTrap` (keeps the focus React's `autoFocus` placed, else focuses the first control; restores focus on close). Put `autoFocus` on the primary action. When that action is disabled until data arrives, `useFocusWhenReady` moves the focus to it once it is enabled (LaunchDialog, ImportAccountsDialog).
- Transient messages use `useFlash` in an **always-mounted** `role="status"` span with `flashClassOf(flash)` (`sr-only` when empty). A live region mounted together with its text isn't announced. The launch dialog speaks through one `sr-only` status line (`jobAnnouncement`), not the repainting phase list.
- Popups (`Dropdown`, `MenuButton`, `CardMenu`) handle arrows, Home, End, Enter, Space, Escape and Tab, return focus to the opener, and are clamped/flipped to the viewport. Never hide a popup with `visibility: hidden` while positioning it: that blocks focus.
- `Toggle` is `role="switch"` with `aria-label`. Icon-only buttons need `aria-label`. Tooltips go in `title` and include the shortcut if there is one.

## Gotchas

- Preview mode: Settings and Sidebar read it as off while settings load. The artwork and tray switches read `!== 'false'` (on unless stored off) and are disabled until settings arrive.
- `useIpcQuery` deps are spread into an effect with `exhaustive-deps` disabled. Pass primitive deps, not fresh objects.
- `LaunchDialog`'s `candidates` is a new array every render. Don't add effects that depend on it without care.
- Jobs live in main, which is why `ErrorBoundary`'s "a running switch continues" is true. Keep job logic out of the renderer.
