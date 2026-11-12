# Assets and copy

Ticket M0-T08: the copy inventory and its map onto the layout sidecars, the style tables, the design tokens, the icons, What's New and the licence, written to `<out>/assets`. What each output file holds is in `bundle/README.md`, which the generator copies into the bundle.

## Layout

| Path | What |
| --- | --- |
| `assets.gen.ts` | The static generator: everything that needs neither the app nor Electron |
| `generate-assets.mjs` | What the generator writes, file by file |
| `source.mjs` | The TypeScript compiler walk over `src/`: strings, JSX elements with their classes, Lucide imports and uses, and the flow of a value to the screen |
| `copy.mjs` | The map of every sidecar text run to a source string or to data |
| `data.mjs` | Where data can come from: the fake launchers' scenarios and fixtures, the simulator, the capture scripts |
| `styles.mjs`, `tokens.mjs`, `icons.mjs` | The style aggregation, the token parse and comparison, the Lucide render |
| `capture.mjs` | The runtime half: the tray PNGs, and tokens and pseudo states from the running app |
| `tray.cjs` | The tray resize, run under `electron.exe` |
| `runtime-files.mjs` | The bundle paths the runtime half writes |
| `check.mjs` | The ticket's acceptance checks |
| `bundle/README.md` | The bundle's `assets/README.md` |

## Commands

| Command | What it does |
| --- | --- |
| `node scripts/oracle/assets/capture.mjs` | Tray PNGs, `runtime.json` and `states.json` into the bundle. `--only=tray` or `--only=app` for one half |
| `node scripts/oracle/generate.mjs assets` | Everything else, from `src/`, the bundle's sidecars, `l2/expected` and `runtime.json` |
| `node scripts/oracle/assets/check.mjs` | The checks, starting the app for the token comparison; `--no-app` compares with `runtime.json` instead; `--skip-verify` leaves out the whole-bundle verify step, which takes many minutes |

Order: `capture.mjs`, then `generate.mjs assets` (it reads `runtime.json` into `tokens.json`), then `check.mjs`. After a new UI capture the generator runs again; after a change to `index.css` or the primitives, the capture too. Both take `--out <folder>`.

Set `ORACLE_SCRATCH` to a folder of your own before `capture.mjs`: the kit empties the slot folders it is given. `check.mjs` defaults it to `..\oracle-scratch\t08` beside the repo.

## What the runtime half controls

- The app is the repo's unpackaged build on the `all-four` fake launchers, a scratch data folder and the oracle clock, at 1280x800, through `../ui/kit.mjs` (`ShotDriver`): its own debug port, `TEMP` inside the scratch folder.
- Tokens are read twice: the custom property on `:root`, and the token applied to a probe element added for the read (`color: var(--x)`, or the Tailwind utility for a radius, shadow or font, since `@theme inline` tokens are inlined and may not exist as properties).
- A primitive is found by what only it has on its page, marked with a data attribute, then read with `CSS.getComputedStyleForNode` after finishing every finite animation and waiting until two reads agree. The pointer is parked and focus dropped first, so the normal state is the resting one.
- The tray script sets its own `userData` in the scratch folder, opens no window and quits; `ELECTRON_RUN_AS_NODE` is removed from its environment.

## How a run is placed

The walk collects every string literal, template and `+` chain, and every JSX text, with its syntactic place. For each it follows where the value can go: through conditionals, `??`, arrays and object maps, variables, returns and calls of local functions, props of local components, up to a JSX child or attribute. A value handed to `aria-*`, `title`, `alt`, `placeholder` of a DOM element stops there.

Each run is tried whole first: an equal string, then a string after `text-transform`, then data by its shape (a fixture value, a time, a count, a path), then a template whose fixed parts sit in the text in order with each slot's value placed in turn, then a join of sentences. A run that cannot be placed alone is tried with the runs that continue it (the next line down, or straight after it on the same line) as one string. Several equal strings are told apart by the rendered elements around the run, innermost first: a string that flows into the source element of one of them wins. Then the launcher the shot names, then the nearest placed neighbour. A template of little more than its slots (two fixed characters or fewer) counts only when its copy slots are shown to flow into it.

Data outranks an equal source string (a fixture's display name `Alt` and the setup guide's demo `Alt`) unless that string is shown to reach an element around the run. What a capture typed or the simulator wrote is looked for only after every copy match failed, because captures wait for on-screen copy by its text.

## Reading the check

`check.mjs` prints one line per check:

1. Every sidecar run is in the map with its own text; every copy run's sources exist in `copy.json` and the cited file holds that string at that line (parsed again with the compiler); the source reproduces the run's text by its match, slots and pieces included; every data run is borne out by its origin (the line holds the value, or the value has the kind's shape). Step titles the same way.
2. Read as plain text, without the compiler, every string of `copy.json` and every source a run, slot, piece or step title cites starts at its cited line and column: JSX text's first characters, or the opening quote or backtick followed by the value's first characters as written (escapes decoded), or a slot's expression where a template starts with one.
3. The Lucide imports in `src/` are counted again from the source, and each SVG is rendered again and compared byte for byte.
4. `tokens.json` agrees with `index.css`, and each token with the page (the app started now, or `runtime.json` with `--no-app`; the line says which ran).
5. The generator is run again into a scratch folder holding copies of its inputs, and every file is compared with the bundle's.
6. `verify.mjs`'s checks (with `--allow-dirty`) have no finding under `assets/` other than "not in the manifest".
