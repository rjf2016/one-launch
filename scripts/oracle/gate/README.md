# Gate checks

Ticket M0-T12: the proof that the bundle works as a judge. `self-diff.mjs` captures every layer again from this checkout and compares it with the bundle, which must give no difference. `plant.mjs` changes one thing in a scratch copy of the app per layer and shows that the same comparison then finds it. A judge that cannot fail is not a judge.

Neither script writes into the bundle. Both use the layers' own capture commands and one plain comparison of their own (`compare.mjs`), so a blind spot a layer's `check.mjs` shares with its generator does not carry over.

## Layout

| Path | What |
| --- | --- |
| `layers.mjs` | The layers: the capture commands of each, which bundle paths it covers, and what is never captured again |
| `run.mjs` | Runs one capture command into a folder, with its log; seeds a folder from the bundle |
| `compare.mjs` | Compares a captured folder with the bundle, file by file |
| `self-diff.mjs` | Every layer captured again and compared |
| `plant.mjs` | The planted differences |
| `../test/gate-compare.test.mjs` | The comparison's own unit tests |

## Commands

| Command | What it does |
| --- | --- |
| `node scripts/oracle/gate/self-diff.mjs` | Builds the unpackaged app, captures every layer into `<scratch>\fresh`, compares, prints one `PASS` or `FAIL` line per layer. About 45 minutes, half of it the update transcripts; app windows open while it runs |
| `node scripts/oracle/gate/self-diff.mjs --layers=<name>,<name>` | Those layers only, added to what `<scratch>\fresh` already holds. The layers are `schemas`, `vectors`, `tests`, `replay`, `updates`, `ui`, `native`, `assets`, `takeover` |
| `node scripts/oracle/gate/self-diff.mjs --compare-only` | Compares what is there and captures nothing |
| `node scripts/oracle/gate/plant.mjs` | Makes the worktree, runs every plant with its control, removes the worktree. About six minutes; app windows open |
| `node scripts/oracle/gate/plant.mjs --only=<name>,<name>` | Those plants only: `vector`, `platform-order`, `moved-box`, `string`. `--keep` leaves the worktree |

`--out <folder>` names another bundle, `--fresh <folder>` another folder to capture into, `--no-build` skips the build. Exit 0 means every layer was captured and nothing differs (`self-diff.mjs`), or every plant was caught and every control was clean (`plant.mjs`).

## Scratch folder

`ORACLE_GATE_SCRATCH`, by default `..\oracle-scratch\t12` beside this repo: `fresh` (the second capture), `planted` (one folder per plant and phase), `wt` (the worktree, while `plant.mjs` runs), `logs` (one log per capture step), and the two reports, `self-diff-report.json` and `plant-report.json`. Each capture step gets the scratch folder its own tooling uses by default, because a shot shows its data folder's path and a longer path wraps differently.

## What is compared, and how

| Files | Rule |
| --- | --- |
| Everything not named below | Byte for byte |
| `ui/shots/*.layout.json` | Byte for byte, or equal once the runs and elements the capture flagged volatile are masked (`maskVolatile` of the UI kit). The report lists what the mask hid |
| `ui/**/*.png` | Counted, not judged: pixels are not a gate. The report gives how many PNGs hold other pixels and how many pixels |
| `MANIFEST.json`, `perf/` | Not compared: the manifest is the hashes of its own bundle, and timings do not repeat |

A file the capture wrote that the bundle does not have fails. So does a bundle file of a captured layer that the capture did not write, unless `layers.mjs` says why it is never captured again: the seeded inputs (`PIN`, `SCREENSHOTS.md`, `fixtures/`), the repeat records under `ui/repeat` (the status file is built on the bundle's, since a record is the verdict of an earlier comparison), and the hand-written takeover documents.

One step does not read the second capture: the static assets generator. `assets/copy-map.json` and the `observedData` list of `assets/copy.json` quote every text run of the sidecars, the volatile ones too (a backup's name, a clock time, a duration), so they repeat only from the sidecars they were built from. The generator therefore runs on the bundle's own `ui/shots` and `l2/expected`, in `<scratch>\fresh-on-bundle`, beside what the runtime half of the layer captured. What the second capture's sidecars are worth is judged in the `ui` layer; a changed source string is still caught here, as the `string` plant shows.

The performance baseline has no second capture here. Its numbers move from run to run by design; `perf/check.mjs` checks the baseline and `perf/METHOD.md` says how the Rust build is measured against it.

## When a capture step fails

A failed step fails its layer and names its log. Two causes are known and are not differences:

- A replay generator stops with "the recordings do not normalise to one value" at `/final/log/warn/*`: two ids of one recording ended in the same four characters, which is all the app's logger keeps of an id, so the recorder could not name one of them. Run the layer again.
- The test capture stops on a failed adapter test: those tests run real timers with tight budgets and fail on a busy machine. Run the layer again with nothing else running; never beside a capture that starts the app.

## The plants

Each plant is one edit to one file under `src/`, made in a detached worktree of this checkout (`node_modules` is a junction into this tree; the three inputs git ignores are copied). The edit is written, the capture of the affected slice runs from the worktree, and the file is restored. Before each plant the same slice runs on the worktree as committed: that control must differ nowhere, so a difference found afterwards is the plant's.

| Plant | The edit | What must differ |
| --- | --- | --- |
| `vector` | `compareVersions` ranks a release below its own pre-release | `l1/core/compareVersions.json` |
| `platform-order` | The Steam switch writes `RememberPassword` before `AutoLoginUser` | `l2/expected/play-steam.json` and `play-all.json`; and `play-all` replayed through the built app no longer diffs to zero against the bundle |
| `moved-box` | The sidebar links start 8 px lower | The sidecar of the empty-Library shot |
| `string` | One sentence of the empty Library reads differently | The same sidecar, and `assets/copy.json` |

A plant is caught only when every file it names is reported different; the report lists every other file that differed too, so the reach of each edit can be read. Nothing here is committed, and the worktree's `src/` is checked to be clean again after each plant.

## Removing the worktree

`plant.mjs` takes the `node_modules` junction off with a plain `rmdir` before it asks git to remove the worktree. If a run is killed, do the same by hand: never delete the worktree folder recursively while the junction is in it.
