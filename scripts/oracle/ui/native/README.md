# Native window captures

Ticket M0-T09, the part an agent may do: seven reference PNGs of states a CDP screenshot cannot see (the real caption buttons, the native file pickers, the message boxes) and one page state that only the packaged exe reaches. They go to `<out>/ui/owner`, with `captures.json` beside them. The owner waived the six rows that Windows or the stock installer draws (the tray menu, the taskbar with the window hidden, the installer pages, SmartScreen, Startup Apps, the uninstaller), and no registry dump is taken on the owner's PC; `waived.mjs` holds both lists and `captures.json` repeats them.

## Layout

| Path | What |
| --- | --- |
| `capture.mjs` | Starts each app, reaches each state, captures, writes the PNGs and `captures.json`; `--repeat` captures again into the scratch folder and compares |
| `waived.mjs` | The rows the owner waived and the file that is not produced |
| `check.mjs` | The acceptance checks over `<out>/ui/owner` |
| `native.mjs` | Node's side of `win.ps1`: one Windows PowerShell call per step |
| `win.ps1` | Win32 through `Add-Type`: the visible top-level windows of one process id, `PrintWindow`, the text of a window's controls (Win32 and UI Automation), and messages posted to a window |
| `pixels.mjs` | Decodes two PNGs and counts the pixels that differ, for `--repeat` |

## Commands

| Command | What it does |
| --- | --- |
| `node scripts/oracle/ui/native/capture.mjs` | All seven shots into the bundle |
| `node scripts/oracle/ui/native/capture.mjs --only=<name>,<name>` | Those shots only; `captures.json` keeps the other entries |
| `node scripts/oracle/ui/native/capture.mjs --repeat` | Captures again into `<scratch>\repeat` and prints, per shot, whether the window title, the text and the size match the bundle's and how many pixels differ |
| `node scripts/oracle/ui/native/capture.mjs --index` | Starts nothing; writes `captures.json` again with the entries it has and the lists of `waived.mjs` |
| `node scripts/oracle/ui/native/check.mjs` | Seven valid, non-blank PNGs; one `captures.json` entry each with the right row, build, title, buttons and size; no path or user name in it; every owner row of `ui/status.json` captured or waived |

Set `ORACLE_SCRATCH` to a folder of your own first; `--out <folder>` names another bundle root. Nothing is built: `out/` and `dist/win-unpacked` must be current. App windows and dialogs open on the desktop while it runs; nothing is clicked or typed on the desktop.

## What a capture controls

- **Which app.** The unpackaged build through `../kit.mjs` (`ShotDriver`: a free debug port, the page checked to belong to the spawned process, a fresh scratch data folder, the all-four fake launchers, the oracle clock), or `dist/win-unpacked/OneLaunch.exe` with `--data-dir=` on a scratch folder for the two rows that need the packaged exe. Every window is found by the process id this run spawned, never by image name or title alone, and every message is refused for a window of another process.
- **Capture.** `PrintWindow` with `PW_RENDERFULLCONTENT`, cropped to the window's DWM frame bounds, saved as 24-bit PNG. Covered windows still capture. Row 131 is a page state, so it is a CDP screenshot at 1280x800 in `en-US` and `UTC`, like the kit's shots.
- **Input.** The page is driven over CDP. A dialog is driven only by messages to its own window: `WM_SETTEXT` to the file-name field and `IDOK` to move a file picker to a folder, `IDCANCEL` to cancel it, `WM_CLOSE` to a message box (which answers its cancel button: Keep running, or OK). The app window is closed with `WM_CLOSE`, the caption button's path.
- **Privacy.** A file picker is moved to `Placeholder files` in the scratch slot (two empty `.exe` files or two flat-colour PNGs, dated 1 January 2026 noon), and every navigation-pane entry that is not a Windows default (Home, Gallery, Desktop, Downloads, Documents, Pictures, Music, Videos, This PC, Network, drives) is deleted from that dialog's tree view with `TVM_DELETEITEM`, which changes nothing outside that dialog. Scratch paths in `captures.json` read `{scratch}`.
- **The crash dialog.** Main gets Node's inspector on a free port (`--inspect`); once `process.pid` there is the spawned id, a `setTimeout` that throws is evaluated, which reaches main's `uncaughtException` handler. Nothing under `src/` changes.
- **The quit prompt.** Epic is held in its sign-in (`reactMs` of ten minutes), the tray setting is off, and no `quitDuringSwitch` knob is set, so main shows the real prompt.

## Reading the output

`captures.json` has one entry per PNG: `row` (the checklist id, `null` for the window chrome), `file`, `capturedBy`, `build`, `how`, `title` (the window title), `text` (for a message box the main instruction and content read through UI Automation and the button labels read from the button windows; for a file picker its buttons and file-type labels), `width` and `height` in pixels. `waived` lists the checklist rows the owner decided not to compare, and `notProduced` the file of ticket M0-T09 that is not taken, each with its reason.

On `--repeat` the titles, text and sizes must match. The pixels matched too when this was written; they could differ if the desktop's theme, scaling or drive labels change, if the owner's pointer rests on the window's caption buttons, or if a dialog is captured while it is the active window (its title text is drawn darker then). The repeat PNGs stay in `<scratch>\repeat` for a look; delete them after.
