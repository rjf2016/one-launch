# Oracle tooling

Captures the reference bundle the Rust rewrite is judged against. Lives only on the branch `oracle-tooling`, which never merges and never ships. The design is in the Rust repo at `plan/design/oracle.md`; this file says how the tooling here is laid out and the conventions every generator follows.

Nothing in this folder runs under `npm run check`: `scripts/` is eslint-ignored and outside the main vitest include. Prettier does check it.

## Output folder

Every script writes under one folder, the bundle root:

- `--out <folder>` or `--out=<folder>`;
- else the `ORACLE_OUT` environment variable (how `generate.mjs` passes it to a generator);
- else `..\one-launch-rs\oracle`.

`lib/out.mjs` resolves it (`resolveOut`) and writes into it (`writeArtefact`: JSON as two-space indent with a final newline, bytes and text as given). It refuses a folder inside this repo and a drive root. Paths inside the bundle are always written with forward slashes, from the bundle root.

## Commands

| Command | What it does |
| --- | --- |
| `node scripts/oracle/generate.mjs <name>` | Runs the generators under `scripts/oracle/<name>/` (or the one file `<name>.gen.ts`) |
| `node scripts/oracle/emit-schemas.mjs` | Copies `schemas/*.schema.json` into `<out>/schemas` |
| `node scripts/oracle/manifest.mjs` | Writes `<out>/MANIFEST.json`: the pin from `<out>/PIN`, this branch's commit, a sha256 per file |
| `node scripts/oracle/verify.mjs` | Checks the bundle; exits 0 only when every check passes |
| `npx vitest run --config scripts/oracle/vitest.config.ts` | The tooling's own unit tests |

Order after any capture: generate, then `emit-schemas`, then `manifest` (from a committed tree), then `verify`.

`manifest.mjs` refuses an uncommitted tree. `--allow-dirty` writes the manifest anyway with `tooling.dirty: true`, and `verify.mjs` then fails unless it gets the same flag; a bundle is only finished when it verifies without it.

## Generators

A generator is a vitest file named `*.gen.ts`, so the app's TypeScript loads with the `@shared` alias. It runs only through `generate.mjs`; a bare run of the vitest config runs the unit tests in `test/` and never a generator. A generator takes its folder from `resolveOut()` and writes with `writeArtefact`. It never changes anything under `src/`.

`fixtures/fixtures.gen.ts` is the fixture generator that seeded `<out>/fixtures`. Its ids, timestamps and throwaway update key differ on every run, so running it into the bundle replaces the seeded fixtures; pass a scratch `--out` to try it.

## Schemas

One per artefact kind, in `schemas/`. `lib/bundle.mjs` maps bundle paths to them:

| Schema | Files |
| --- | --- |
| `manifest` | `MANIFEST.json` |
| `vector` | `l1/**/*.json` |
| `catalogue` | `tests/catalogue.json` |
| `replay-script` | `l2/scripts/*.json` |
| `replay-expectation` | `l2/expected/*.json` |
| `layout-sidecar` | `ui/**/*.layout.json` |
| `triage-linkage` | `triage-linkage.json` |

Every other file is hashed and scanned but has no schema. The schemas are JSON Schema 2020-12, restricted to the keywords `lib/json-schema.mjs` implements; it refuses any other keyword, so a schema cannot lean on a check that does not run. A schema change is a change to the judge: the bundle copy must be re-emitted and every artefact of that kind must still validate.

## Normaliser

`lib/normalise.mjs` makes two recordings of the same script compare equal without hiding a real difference:

- ids become aliases (`Aliases`): `@acct:steam:user_3`, `@game:steam:252950`, `@job:1`, `@backup:steam:1`. The recorder registers each id; an id nobody registered stays as it is and shows up as a difference.
- scratch roots become `{launchers}`, `{data}` however the path is written: raw, lower-case with forward slashes, VDF-escaped, JSON-escaped.
- `*_enc` values become `{present, plaintextSha256}` through the harness vault.
- timestamps become `<ts>` and millisecond values `<ms>`, only at the paths that were measured to differ between recordings (`measureVolatile`). A fixed timestamp or timing is never replaced.

`normaliseRuns(runs)` does all of it for several recordings of one script and returns the normalised value, the fields each rule touched, and what still differs (`unexplained`, `structural`). A recording is only usable when `stable` is true. Paths are JSON pointers with `*` for an array position.

## Verify

`verify.mjs` fails on any of:

- a bundle schema that is missing, extra, or not byte-identical to `schemas/` here;
- an artefact that does not fit its schema, a `$file` or golden that is not in the bundle, a repeated id, events whose `seq` does not rise, a script without its expectation, a shot under `ui/shots` without its sidecar;
- a file whose sha256 is not the manifest's, a file the manifest does not list, a listed file that is gone, a pin that is not the one in `PIN`;
- anything the repo's secret scan (`scripts/hooks/no-secrets.mjs`) finds in a text file. A 64-character hex value passes only when it is the sha256 of a bundle file or sits in a `sha256` field of a schema-checked artefact;
- a user folder anywhere, in file names, text, binary files (also as UTF-16) and the text of every layout sidecar: a non-placeholder name under `Users`, or this machine's user name, host name, home or temp folder. A PNG cannot be scanned, so its sidecar text stands in for it and captures must run with `TEMP` on a neutral folder.

Findings show the file, the rule and a masked value, never the value.

`bundle.allow` lists what the secret scan lets through in the bundle on top of `scripts/hooks/no-secrets.allow`, as fingerprints (the first 16 hex characters of the value's sha256), so the value is never copied into this repo. Add one only for a placeholder or a generated id, under a comment saying what it is.
