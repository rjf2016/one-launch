# UI capture kit

Ticket M0-T07: a PNG and a layout sidecar for every reachable row of the bundle's `SCREENSHOTS.md`, written to `<out>/ui/shots`, and one status file that says what became of all 174 rows. It runs the repo's own unpackaged build on fake launchers and a scratch data folder, never anything else.

## Layout

| Path | What |
| --- | --- |
| `capture.mjs` | Runs one area's sessions and writes its shots; `--repeat` captures again and compares |
| `status.mjs` | Writes `ui/status.json` from the checklist, the area files and what is in `ui/shots` |
| `check.mjs` | The ticket's four acceptance checks |
| `kit.mjs` | `ShotDriver` (the repo's driver on a fixed scratch folder, on the oracle clock) and `Session` (what an area file is handed) |
| `sidecar.mjs` | Builds a sidecar from `DOMSnapshot.captureSnapshot` and `Accessibility.getFullAXTree` |
| `main-preload.cjs` | Loaded into the app's main process for a capture: the clock, and the holds |
| `rows.mjs`, `png.mjs` | The checklist's rows, areas, sizes and file names; PNG size and colour count |
| `scenarios/<name>/scenario.json` | Fake-launcher folders only the captures need |
| `../../scenarios/oracle-shots-<area>.mjs` | One file per area: its sessions and its notes on rows |

The areas are `shell-library` (rows 1 to 29), `accounts` (30 to 65), `launch` (66 to 100), `dialogs` (101 to 120) and `settings` (121 to 163). Rows 164 to 174 are the owner's.

## Commands

| Command | What it does |
| --- | --- |
| `node scripts/oracle/ui/capture.mjs <area>` | Builds the app, runs every session of the area, writes its shots and sidecars into the bundle |
| `node scripts/oracle/ui/capture.mjs <area> --only=<session>,<session>` | Those sessions only |
| `node scripts/oracle/ui/capture.mjs <area> --repeat` | Captures again into the scratch folder, compares each sidecar with the bundle's and records the verdict in `ui/repeat/<area>.json` |
| `node scripts/oracle/ui/status.mjs` | Writes `ui/status.json` |
| `node scripts/oracle/ui/check.mjs [--area=<area>]` | The four checks, over everything or one area |

`--no-build` skips the build, `--out <folder>` names another bundle root (it needs a copy of `SCREENSHOTS.md`). App windows open while a capture runs. Two areas can run at once: each has its own scratch folder, `<scratch>\ui-<area>`.

Order: capture, look at every PNG, capture with `--repeat`, `status.mjs`, `check.mjs`, then seal the bundle as `../README.md` says. A sidecar captured again after its repeat needs the repeat again; the check says so.

## What a capture controls

- **Clock.** Main and the page both start at `ORACLE_CLOCK` (`../lib/clock.mjs`) and run on at the real rate, across restarts within a session too. Main gets it from `main-preload.cjs` through `NODE_OPTIONS=--require`, the page from the same function injected over CDP before a reload. Each sidecar and `ui/status.json` record the instant.
- **Locale and timezone.** `en-US` and `UTC`, in the page by CDP and in main by `TZ`.
- **Size.** Device metrics of 1280x800 at scale 1, and 960x600 for the rows the checklist marks; the window itself is never resized. Row 9 is the 960x600 shot only.
- **Scratch folder.** `ORACLE_SCRATCH`, by default `..\oracle-scratch` beside the repo, outside any user profile. A session always uses the same folder, so a path on screen is the same on every capture. `TEMP` and `TMP` point inside it.
- **Painting.** Chromium switches keep a covered window painting, and the page is told it has focus, so a capture does not depend on what is in front.
- **Pointer.** Parked on the title bar before every shot unless the shot says `keepPointer`.
- **Motion.** Before a shot: fonts loaded, images in view decoded, finite animations and transitions finished, endless ones paused at their start (their names go in the sidecar's `paused`), and nothing changed across two passes. A shot whose page changed between the snapshot and the PNG is taken again.

## An area file

```js
export const area = 'accounts';
export const rows = {
  36: { how: 'fault injected in main: accounts:list answers with an error envelope' },
  65: { skipped: 'why it cannot be reached without editing src/' },
  40: { owner: 'why it needs the owner' },
};
export const sessions = [{ name: 'list', fake: 'all-four', async run(s) { await s.shot(30); } }];
```

A row with no note has to end up captured. `how` is for a row that needed a stall or a fault, and says what was held.

A session is one fresh scratch folder and one app. Its fields:

| Field | Meaning |
| --- | --- |
| `name` | For `--only` and the log |
| `fake` | A folder name (`test/fake-launchers` first, then `scenarios/` here), or `{ from, change(scenario) }` to edit a copy of that folder's `scenario.json`. Default `all-four` |
| `knobs` | The `knobs.json` object: `{ knobs, processes, timing, quitDuringSwitch }` |
| `env` | Extra environment for the app |
| `holds` | Holds in place before the app starts |
| `readyText` | Text the page shows once loaded. Default `Library` |
| `settle: false` | Do not wait for the startup scan and the artwork queue |
| `before(s)`, `after(s)` | Around the whole session, for a loopback feed (`s.d.env` can still be set in `before`) |
| `prepare(s)` | After the scratch folders exist and before the app starts: plant files in `s.d.dataDir` or `s.d.launchersDir` |
| `run(s)` | The steps |

`s.d` is the driver (`click`, `focus`, `type`, `key`, `waitFor`, `invoke`, `evaluate`, `waitForJob`, `reload`, `killHard`, `launcherPath`). What `Session` adds:

| Call | Meaning |
| --- | --- |
| `s.shot(id, { volatile, aged, keepPointer })` | The row's PNG and sidecar at each size it asks for. The file name comes from the checklist |
| `s.hold(name)`, `s.release(name)` | Hold an IPC channel's answer in main (`'launch:preflight'`), or `'fetch'` for the body of every fetched response |
| `s.fail(channel, { code, message })`, `s.mend(channel)` | Answer the channel with that error envelope, the handler not run |
| `s.d.reload({ bundle: false })` | Reload with the page's script blocked: the boot surface |
| `s.freezeIntervals(true)` | The page's `setInterval` callbacks stop firing, so a self-playing demo stays on its first step |
| `s.hover(target)`, `s.mouseClick(target, { button })`, `s.pointer(x, y)`, `s.wheel(x, y, deltaY)` | Real pointer input; `target` is what `d.click` takes |
| `s.idle()` | The startup scan and the artwork queue are done |
| `s.stop()`, `s.restart({ knobs })` | End the app cleanly; start it again on the same folders and the same clock |
| `s.settle()` | What a shot does before it captures |

`d.click` presses by script, so it never hovers; use `s.mouseClick` where the pointer has to be there (a context menu, a hover state).

## Sidecars

One per PNG, valid against `layout-sidecar.schema.json`, with one text run and one element per line.

- `text`: every inline text box that is visible, in document order, as rendered (after `text-transform`, line by line). A run inside something with opacity 0, hidden, or clipped away by a scroll container or the viewport is left out. Text typed into a field is not a text run; it is the element's `value`.
- `elements`: every interactive element, every landmark, heading, dialog, menu, list and status, every `svg` and `img` (role `image`), and every box that paints a background, border, shadow or outline (role `generic`). `ord` counts within the same role and name, in document order.
- `style` holds only what is set: `bg`, `bgImage`, `color`, `border` and `borderColor`, `radius`, `padding`, `shadow`, `outline`, `opacity` (with every ancestor's applied), and `font` on interactive elements. An absent key is the initial value. Colours are `#rrggbb`, or `#rrggbbaa` when not opaque, also inside gradients and shadows.

Fields the schema does not know (it allows them and checks none): `name`, `clock`, `paused` and `scroll` at the top; `opacity`, `tracking` and `deco` on a text run; `tag`, `value`, `placeholder`, `desc` (the tooltip) and `volatile` on an element; `selected`, `pressed`, `current`, `busy` and `invalid` in `state`.

## Text that depends on time

- A text run is `volatile` when it holds a clock time, a timestamp-shaped id, a duration in milliseconds, or a path under the scratch folder; a shot can add patterns of its own. An element whose name, value or tooltip holds one is marked the same way.
- A relative time is not volatile: under the oracle clock "just now" and "3 months ago" are the same on every capture. A shot refuses a relative time in seconds or minutes ("2 minutes ago"), because the next capture would read another number. Take the shot within a minute of the event, or start a new session; `aged: true` lets one through and marks the run volatile.
- `--repeat` compares a second, independent capture with the bundle's sidecar: `identical` is byte for byte; `volatile` is identical once the text and horizontal extent of volatile runs and the names of volatile elements are masked; anything else fails.

## Holding a state

Nothing under `src/` is changed for a capture. `main-preload.cjs` wraps `ipcMain.handle` and the body readers of `Response`, and looks for marker files in the session's control folder (`ORACLE_UI_CONTROL`): `hold-<name>` makes a call wait before its handler runs, `fail-<channel>` holds the error envelope to answer with. The kit refuses to go on when the preload did not reach `ipcMain`.

A held state is a real one: the page is waiting for an answer that has not come. A fault is not: the envelope is written by the capture, so its row's note says so and the message is one the handler could give.
