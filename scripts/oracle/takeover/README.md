# Takeover contract and vault fixtures

Ticket M0-T11: the installer and updater contract, the vendored NSIS sources, the portable vault vectors, the machine-local vault fixture and the per-step migration dumps. What they mean to whoever uses them is in the bundle's `takeover/README.md`; this file is about the tooling. The design is the Rust repo's `plan/design/takeover.md`.

## Layout

| Path | What |
| --- | --- |
| `migrations.gen.ts` | The schema after each migration step, and the oldest fixture database after the app migrates a copy of it, into `takeover/migrations/` |
| `nsis.gen.ts` | Copies the NSIS templates (except those named in `HELD_BACK`, recorded by digest in `templates-held-back.json`), `build/installer.nsh` and the two files `dist/` keeps from the earlier build into `takeover/nsis/`, and writes `defines.json` |
| `nsis-plugins.gen.ts` | `takeover/nsis/plugins.json`: every binary of the two NSIS bundles, read from the electron-builder cache on this machine |
| `vault.gen.ts` | `takeover/vault/portable-v10.json`, with what real `safeStorage` does with each blob |
| `fixture-script.gen.ts` | Copies `vault/make-local-fixture.mjs` into the bundle |
| `vault/codec.mjs` | The v10 layout, the throwaway keys, the plaintexts and the failure mutations, shared by the generator and the probe |
| `vault/safestorage-probe.mjs`, `vault/safestorage-probe.cjs` | Runs Electron's `safeStorage` on a throwaway profile: encrypts the plaintexts, decrypts the vectors rebuilt under that profile's key, each failure in a process of its own |
| `vault/profile-key.mjs` | Unwraps a scratch profile's key with DPAPI, in memory, for a folder under the scratch root only |
| `vault/make-local-fixture.mjs` | Writes a machine-local data folder through the real app, or reads one back (`--read`) |
| `coverage.json` | Each sentence or bullet of `takeover.md` and the contract assertions that cover it |
| `check.mjs` | The ticket's acceptance checks |

`contract.md`, `vault/LAYOUT.md`, `nsis/README.md` and `README.md` in the bundle are written by hand, from reading the sources; `check.mjs` measures them.

## Commands

| Command | What it does |
| --- | --- |
| `node scripts/oracle/generate.mjs takeover` | Every generator into the bundle |
| `node scripts/oracle/generate.mjs takeover/migrations` | One of them (`nsis`, `nsis-plugins`, `vault`, `fixture-script`) |
| `node scripts/oracle/takeover/check.mjs` | The checks below. `--skip-app` leaves out everything that starts Electron; `--out <folder>` names another bundle |
| `node scripts/oracle/takeover/check.mjs --units` | The units of `takeover.md` that `coverage.json` must map, one JSON string per line |
| `node scripts/oracle/takeover/vault/make-local-fixture.mjs <folder>` | A machine-local data folder with placeholder secrets; `--read <folder>` starts the app on one and reads it back |

## What check.mjs measures

1. Every assertion of `contract.md` has a check method from its table and (outside section O) a source line; every cited file exists at the pin (`git show <pin>:<path>`, else on disk for `node_modules/` and `dist/`, else in the bundle for `oracle/` paths) and every cited line is within it; every unit of `takeover.md` is in `coverage.json` with contract numbers that exist, and no row of the table is stale.
2. Every valid vector decrypts with `node:crypto` alone, its blob is prefix, nonce, ciphertext and tag, and encrypting its plaintext with its nonce gives the blob again; every failure fails. Unless `--skip-app`, real `safeStorage` is measured again and must give what the file records.
3. Unless `--skip-app`: the bundle's `make-local-fixture.mjs` writes `<scratch>\check-fixture`; every password and named secret in it decrypts with that profile's key to what `fixture.json` says; `--read` through the app passes.
4. Unless `--skip-app`: the `layout` block of `LAYOUT.md`, compared with that folder: where `Local State` is, the JSON path, encoding and prefix of the wrapped key, the start of the DPAPI blob, the key length, the `v10` prefix and the 31-byte overhead of every stored value. Then the folder is removed.
5. The migration, NSIS and fixture-script generators (and `vault.gen.ts` unless `--skip-app`) run twice into the scratch folder; both runs and the bundle are byte-identical.
6. The vendored templates are `node_modules`' minus the held-back ones, byte for byte, each held-back file's recorded size and digest are the installed file's, `build/installer.nsh` is the pin's, the bundle's fixture script is this folder's, and the installed app-builder-lib is the version the pin's lockfile names.
7. `verify.mjs --allow-dirty` has no finding under `takeover/` other than "not in the manifest".

## Scratch folder

`T11_SCRATCH`, by default `..\oracle-scratch\t11` beside this repo, outside both repos and any user profile. The generators and the checks write only there: the migration work files, the `safeStorage` probe profile, the check's fixture folder and the repeat runs, each removed when done. A profile key is unwrapped only for a folder under it, kept in memory and never printed.

## What a capture controls

The vectors use fixed keys and nonces, and the migration dumps sort `sqlite_master` and leave out `rootpage`, so both repeat byte for byte with nothing normalised. The `safeStorage` results are error texts, booleans and exit codes, which repeat too; one of them (`Failed to decrypt: The data is invalid. (0xD)`) is Windows' own message and reads differently on a Windows in another language. `defines.json` uses placeholders for every path and value only a build knows; `nsis/README.md` in the bundle lists them. `plugins.json` depends on the electron-builder cache an earlier packaged build left on the machine.
