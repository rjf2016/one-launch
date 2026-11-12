# Assets and copy

Ticket M0-T08: what the Electron app says, how it looks, and the files it ships, taken from the source and the running app at the pin. Nothing here is edited: every string is copied as the source holds it.

| Path | What |
| --- | --- |
| `copy.json` | Every user-visible string of `src/`, from a TypeScript compiler walk, with file, line and column |
| `copy-map.json` | Every text run of every layout sidecar under `ui/shots`, placed: the source string it is, or the data it shows |
| `styles.json` | The sidecars' elements grouped by tag and class set, with the styles each group was seen with; the text runs grouped by font and colour |
| `states.json` | 18 primitives under hover, focus, active and disabled, from the running app |
| `renderer.css` | The compiled renderer stylesheet, byte for byte |
| `tokens.json` | The design tokens of `src/renderer/src/index.css`, each compared with the running page |
| `runtime.json` | What the running page gave for each token, as read |
| `icons/` | The Lucide icons, the brand mark, the app `.ico`, the tray PNGs, and `index.json` describing them |
| `whats-new.json`, `whats-new/` | The What's New release entries and the images they show |
| `LICENSE.txt`, `installer-licence-page.txt`, `notices.json` | The licence, the Electron installer's licence page, and what the Rust installer's page must carry |

## copy.json

`strings` holds one record per string:

| Field | Meaning |
| --- | --- |
| `id` | `s` and four digits, stable for this pin; `copy-map.json` cites strings by it |
| `file`, `line`, `col` | The first character of the string's source, 1-based: for JSX text its first non-white-space character, for a literal or template its opening quote or backtick, for a `+` chain the first character of its first operand. A string over several lines is cited at the line it starts on |
| `kind` | `jsx-text`, `jsx-attr` (a string attribute), `literal` (a string or plain template literal), `template` (a template literal with slots), `concat` (a `+` chain of literals and expressions) |
| `text` | The value. JSX text is as the compiler emits it: lines trimmed where they meet a break and joined with one space. A template is written with its slots in braces, `Play as {account.displayName}` |
| `parts`, `slots` | For `template` and `concat`: the fixed pieces in order, and between each pair the slot's expression as written. `parts[0] + value(slots[0]) + parts[1] + …` is the rendered string |
| `context` | Where the string sits: `jsx-text`, `jsx-child`, `attr:<name>`, `prop:<key>`, `var:<name>`, `call:<callee>`, `default:<parameter>`, `return`, `throw` |
| `process` | `renderer`, `main`, `shared` or `preload` |
| `holder` | The declarations it sits in, outermost first (`LAUNCHER_DISPLAY_NAMES.steam`, `SteamAdapter.healthCheck`) |
| `visible` | The walk's own judgement that the string can reach the screen. A string seen on screen is listed whatever this says |
| `observed` | How many sidecar runs (and slots and pieces of runs) cite it |
| `stepTitles` | How many replay step titles cite it |

A string is listed when the walk judges it visible or a run or step title cites it. Not listed: import paths, type positions, object keys, class lists, comparison and `case` operands, index keys, log messages, the fake launchers' own strings (`src/main/launchers/sim/`), and what goes only to `aria-*`, `title`, `alt` or `placeholder` of a DOM element (those reach the accessibility tree, not the text).

`observedData` lists each distinct piece of data the shots show (see below), and `stepTitles` the step titles of the replay expectations (`l2/expected`), each placed the same way a run is.

## copy-map.json

`sidecars` holds, per sidecar, one record per text run, in the sidecar's order (`i` is the run's index, `t` its text). Every run is in exactly one class.

**copy**: `sources` cites the strings by `id`, `file` and `line`. `match` says how the run's text comes from them:

| `match` | Meaning |
| --- | --- |
| `exact` | The text is the string. `whitespace: "collapsed"` when CSS dropped space at the edge of a line or flex item |
| `transform` | `transform: "uppercase"` (CSS `text-transform`), or `"first letter upper-cased in code"` |
| `template` | A template or `+` chain with its slots filled; `slots` gives each slot's `name` (the expression), `value`, and its own class: copy (with its own `match`), data (with `kind` and `origin`), or `empty` |
| `join` | Sentences or array items the code put side by side; `pieces`, each placed on its own, and `separator` |
| `line` | One line of a string that wraps over several runs: `line` is `[n, of]`, `whole` the string all the lines make, `of` how `whole` matches. `joinedWithout: "space"` when the lines meet without a space (a wrapped path) |
| `piece` | One piece of a string the UI draws in several inline runs (a quoted word in bold), with `line`, `whole` and `of` as above |

`how` says how the source was told apart from others with the same text:

| `how` | Meaning |
| --- | --- |
| `unique` | One source string fits |
| `anchor` | Several fit; one of them is shown, by the flow analysis, to reach the source element of a rendered element around the run (`anchor` names it). Source elements are matched to rendered ones by tag and the classes the source always gives them |
| `slot-flow` | (a slot) the string is shown to flow into that slot's expression |
| `flow` | Of equal templates, the one more of whose slots are shown to be filled from what is on screen |
| `launcher` | The same string in each launcher's adapter; the launcher the run or the shot names decides |
| `neighbour` | Nothing around the run told them apart; the nearest run placed in one of the candidates' files decides, and the closest line in it. `neighbour` is that run's index |
| `ipc`, `main` | (a slot) a main-process string in a renderer or main template; the flow analysis does not cross IPC or a thrown error, so the slot is placed by its text alone |
| `first` | Templates of different shapes fit equally; the first in source order is cited, and only it, since the slots found fit it alone |
| `open` | Still more than one; all are listed in `sources`, first the one the order of the source puts first |
| `sentences` | A `join` of sentences |

**data**: `kind` and `origin` say what the run shows and where it comes from; `what` says it in words. `equalsCopy` counts source strings with the same text that no element around the run was shown to render.

| `kind` | Origin |
| --- | --- |
| `fixture` | A value the fake launchers hold: `origin.file` and `line` in `test/fake-launchers/*/scenario.json`, `test/fixtures/**` or a capture-only scenario. `tailOf` when the run is the end of an id that long; `masked` when the app shows a value of that line as `…` |
| `capture-input` | Typed, chosen or injected by the capture (an error envelope it planted): `scripts/scenarios/oracle-shots-*.mjs` |
| `launcher-output` | What the simulator in `src/main/launchers/sim/` writes |
| `path` | A path under the capture's scratch folder |
| `clock` | A time or date the app formatted, or a snapshot id; under the oracle clock (`origin.clock`) in `en-US` and `UTC` |
| `relative-time` | `Intl.RelativeTimeFormat` of a stored time against the oracle clock |
| `date` | A date in the source (`origin.value` at `file`, `line`) formatted in `en-US` |
| `count` | A number the app computed |
| `version` | The app version (`package.json`) or a runtime version |
| `fingerprint` | A short hash the app computed from a stored session |
| `marker` | A list or disclosure marker Chromium draws (`▸ `, `• `, `1. `) |

`counts` at the top gives the totals by class, match, `how` and data kind; `judgementCalls` counts the runs placed by `neighbour`, `launcher`, `first` or left `open`.

## styles.json and states.json

`styles.json` `signatures`: one entry per tag and set of classes (`signature` is the tag and the sorted classes), how often it was seen and in how many shots, under which roles, and each distinct `style` record (the sidecar's `style` field) with its count. `text`: each combination of font, colour, letter spacing and decoration the text runs used. `compiledCss` names the built file `renderer.css` was copied from, with its sha256. Hover, focus and disabled rules are in `renderer.css`.

`states.json` `primitives`: for each, the page it was found on, its classes and label, `normal` (the computed styles listed in `properties`, colours as `#rrggbb(aa)`), and per state what changes from normal and how the state was made: `CSS.forcePseudoState` for hover, focus, focus-visible, focus-within and active (active is forced with hover, as a press is), the `disabled` attribute set and removed for disabled. Transitions are finished before a style is read.

## tokens.json

Each token: `name`, `kind` (`color`, `font`, `radius`, `shadow`), `value` as written, `line` in `index.css`, `where` (`:root` or `@theme inline`), and the parsed form (`hex`, `families`, `px`, `layers`). `runtime` is the running page's: `custom` (the custom property as the page holds it, which Tailwind may have minified or left out), `computed` (the token applied to a probe element, read with `getComputedStyle`), `via` (which property of which probe), `equal`, and `how` the two were compared, since the browser writes each in its own notation. `themeAliases` are the `@theme inline` names that only point at a `:root` colour. `body` and `focusVisible` are the base rules.

## icons/

- `lucide/<Name>.svg`: each Lucide icon the app imports, named as imported, rendered with `react-dom/server` from the installed `lucide-react` with no props, so the package defaults hold (24 px box, stroke width 2, `currentColor`). The app sets size and stroke with classes and props at each use.
- `index.json` `lucide.icons`: per icon its file, its Lucide class (which also names the icon an import is an alias of), the imports, every use (`element` with its props as written, or `value` where it is passed as a component), and the sizes and stroke widths the uses set. A size of `none on the element` means a parent sets it (`[&>svg]:size-4`) or the 24 px default holds.
- `brand-mark.svg`: `BrandMark` rendered with no class; the same shape as `build-icon-mono.svg`. `build-icon.svg`: the app icon's source.
- `app.ico`: the `.ico` an earlier packaged build left (`dist/.icon-ico/icon.ico`); `index.json` gives its sha256 and its images.
- `tray/tray-<px>.png`: the tray icon as `src/main/tray.ts` makes it, `build/icon.png` resized by Electron's `nativeImage` to `max(16, round(16 × scale factor))` px, for every scale factor Windows offers from 100 % to 500 % in 25 % steps. `tray/tray.json` lists them.

## whats-new.json

`releases` is `WHATS_NEW` of `src/shared/whats-new-releases.ts` as data, newest first; `images` the files they show, copied into `whats-new/`. The card shows `date` formatted as `dateFormat` says.

## Licence and notices

`LICENSE.txt` is the repository's licence. `installer-licence-page.txt` is the licence page the Electron installer shows. `notices.json` says what the Rust installer's notices page must carry: the MIT text and the install location only. The npm, Electron and Chromium notices are specific to the Electron build.
