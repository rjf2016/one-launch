# Test catalogue and result goldens

Ticket M0-T02: `tests/catalogue.json` in the bundle, one entry per test of the suite with `it.each` expanded, and `tests/goldens/<id>.json`, the full result of every adapter call each adapter-flow test makes. What the catalogue and goldens mean to whoever reads them from Rust is in `bundle/README.md`, which the capture copies into the bundle as `tests/README.md`; this file is about the tooling.

## Layout

| Path | What |
| --- | --- |
| `vitest.config.ts` | The repo's own `vitest.config.ts` with two setup files: the oracle clock (`../lib/clock.setup.mjs`) and the recorder |
| `recorder.setup.ts` | The shim: mocks the four adapter modules with their own exports, wrapped; notes the running test; writes the file's calls when its tests end |
| `recorder.mjs` | Wraps `preflight`, `switchAccount`, `launchGame` and `restoreBackup` on each adapter's prototype and keeps the calls |
| `encode.mjs` | The lossless encoding of arguments, results and errors (the `$` wrappers in `bundle/README.md`) |
| `catalogue.mjs` | Ids, kinds, environments and proposed waivers, from what the JSON reporter lists |
| `capture.mjs` | Runs the suite several times, builds the catalogue and the goldens, and writes them into the bundle |
| `check.mjs` | The ticket's acceptance checks, against a fresh capture |
| `bundle/README.md` | The bundle's `tests/README.md` |

## Commands

| Command | What it does |
| --- | --- |
| `node scripts/oracle/tests/capture.mjs` | Runs the whole suite three times with the shim and once as `check.mjs` runs it (the canonical run), then writes `tests/catalogue.json`, `tests/goldens/`, `tests/capture.json` and `tests/README.md` into the bundle. `--runs=<n>` for n runs (two at least), `--out <folder>` for another bundle |
| `node scripts/oracle/tests/check.mjs` | Captures again into the scratch folder (three runs with the shim, one without), then prints one `PASS` or `FAIL` line per check and exits 0 only when all pass |

Set `ORACLE_SCRATCH` first; the runs go under `<ORACLE_SCRATCH>\tests` (by default `..\oracle-scratch\tests` beside this repo), which is emptied before and deleted after a run that passes. A capture takes about half a minute on an idle machine, the check under a minute.

## What a capture controls

- The suite is the repo's own: the same include, environment and timeout as `npm run check`, under the oracle clock, so all of it is green (two Steam tests are red under the real clock).
- Each shimmed run gets a fresh, empty `TEMP` and `TMP` under the scratch folder, so the tests' temporary folders are never in a user profile and can be named as roots.
- The catalogue's `status` comes from the canonical run instead: `../check.vitest.config.ts`, no shim, `TEMP` as inherited, which is exactly what `check.mjs` runs. It records nothing, so none of its paths can reach the bundle. One test differs between the two: the `no-secrets` 8.3 short-path test, which skips itself where `TEMP` has no 8.3 names (the scratch folder) and passes on this machine's own `TEMP`.
- `ONELAUNCH_LIVE` is removed from the environment of every run: the five `*-live` files skip themselves and read nothing of the real launchers. They are catalogued as `live`, `skipped`, from what the reporter says.
- A run that is not green stops the capture with the failing tests named, and its folder stays in the scratch folder. Nothing is retried: on a busy machine the adapter suites' tight real-timer budgets can fail, so run the capture again when the machine is quieter.

## The shim

`recorder.setup.ts` mocks `src/main/launchers/{steam,epic,battlenet,riot}/adapter` with a factory that loads the real module (`importOriginal`) and wraps four methods on the class's prototype in place, so every module that imports an adapter gets the same class, only instrumented. The factory runs when a test file first imports an adapter, after the file's own mocks, and never loads an adapter into a file that does not.

- A call is noted when it is made (the running test, from a `beforeEach` in the setup file; the adapter's `id`; the encoded arguments) and its result or error when it settles.
- The caller gets the very promise the adapter returned: the recorder only adds its own `then` beside it, so no `await` of the test takes an extra tick, and a rejection still reaches the test. A method that throws synchronously is recorded and rethrown.
- A value the encoder cannot carry becomes an `$unencodable` marker rather than an exception in the test, and the capture then refuses to write.
- The file's calls are written in its last `afterAll`, so a call still pending then is recorded as `pending`.

`check.mjs` runs the suite once without the shim (`../check.vitest.config.ts`) on a scratch `TEMP` and compares every test's status and the pass and skip counts with the shimmed runs, like with like. It also checks every catalogue status against a fresh canonical run and prints the canonical totals.

## Adapter-flow, and which tests get a golden

Every test in the four `*-adapter.test.ts` suites is `adapter-flow` and has a golden, also one that made none of the four calls (its `calls` is `[]`). Any other test in which the shim saw a call has a golden too and keeps its own kind; at the pin that is seven of the eight `pipeline.test.ts` tests (`4b` only edits the journal). No other file reaches an adapter method.

## Ids

`T-<file>-<hash>`, the hash the first 10 hex characters of the sha256 of `JSON.stringify([file, suite, name])`. Position plays no part. Two tests with the same file, suite path and name would get the same id; none exist at the pin, and the capture refuses to write if two ever do, rather than tell them apart by order.

## Stability

Goldens are what three runs agree on after `../lib/normalise.mjs` (`normaliseRuns`), test by test. The capture supplies only what the normaliser needs:

- roots: per run, `{temp}` is that run's `TEMP` and `{tmp}`, `{tmpB}`, .. the test folders under it its calls name, in the order of first mention;
- aliases: an account or game id at the same place in the same call that differs between runs (a UUID the services generated) is registered as `@acct:<launcher>:<login>` or `@game:<launcher>:<launcherGameId>`. An id that does not differ (`acct-1`) is left alone;
- `<ts>` comes from the normaliser's own measurement: only the paths that differed.

A test whose runs still differ anywhere (`unexplained` or `structural`) stops the capture with the paths. `tests/capture.json` lists every rule that changed something, with its paths and the number of goldens. How to read a golden, the encoding and every placeholder are in `bundle/README.md`.
