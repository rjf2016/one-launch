# Replay scripts and expectations

Layer 2 of the oracle: 22 scripted runs of the Electron app against fake launchers, and what the app did in each. Recorded by a headless harness that composes the app's real adapters, simulators, services and IPC handlers; five of the scripts were also replayed through the built Electron app and diffed to zero (`cross-check.json`).

| Path | What |
| --- | --- |
| `scripts/<name>.json` | The script |
| `expected/<name>.json` | What the app did: the events and the final state, normalised |
| `normalisation/<name>.json` | Which paths differed between the five recordings, and the rule that covered each |
| `cross-check.json` | The five scripts replayed through Electron, and what that comparison could not include |

## Running a script

A run starts from nothing: a fresh data folder, and a fresh copy of the fake-launcher scenario `fake` (`test/fake-launchers/<fake>` in the Electron repo: its `scenario.json` and every entry of its `files`), with the script's `knobs` written beside it as `knobs.json`. Then the app is started on the two folders, in fake-launcher mode.

A start is over, and the next step may act, once the app has done its startup work: the library scan, the artwork lookups the scan queued, and the copy of the database into `backups\db`.

| Step | What it does |
| --- | --- |
| `invoke` | One IPC call, `channel` with `req`. Ids in `req` are aliases. The answer is not recorded, and a refusal is an answer like any other |
| `awaitJob` | Waits until the job is in the state `until` names: every field given must hold, `state` against the job's state, `step` with `status` against that step's status. The app code that reported the state runs on to its next wait first, and the state must still hold then |
| `crash` | The process ends with none of its quit path run. Files stay as they are; the fake platform's memory (registry, process table, simulators' timers) is gone |
| `shutdown` | The app quits: a running switch is aborted and waited for, a copied password is cleared from the clipboard, the database is closed |
| `restart` | A `shutdown` if the app is running, then `knobs` replaces `knobs.json` when the step has one, then a start on the same two folders. The fake platform is built again from the scenario, so its registry and process table are the scenario's, not the last start's |
| `snapshot` | Always the last step. If the app is running it waits for background work and quits as `shutdown` does. The final state is what is on disk then |

## Events

`events` holds the job and platform events of every start in the order they happened, with one `seq` that rises across restarts.

- A `job` event is the job at one change: `job`, `state`, `steps` as `[id, status, title, detail]`, `attention`, `switched`, `handOff`, `backupId`, `restored`, `error`. Only distinct states are kept: a state reported twice in a row is one event. The job as `launch:start` answers it is not an event.
- A `plat` event is one thing the app asked of the machine, named by `op`.

| `op` | Fields |
| --- | --- |
| `proc.start` | `exe` (full path), `args`. A Steam shutdown is a start with `-shutdown` |
| `proc.close` | `exe` (image name), `args: ["<close>"]` |
| `proc.kill` | `exe` (image name), `args: []`, `tree` |
| `reg.set` | `path`, `value`; a binary value is the word `binary`, and its bytes are in `final.registry` |
| `reg.delete` | `path` |
| `file.write` | `path`, and a digest of the content; see "Content digests" |
| `shell.open` | `url` |
| `clip.write`, `clip.clear` | none |
| `riot.launch` | `id` |

Left out: `ipc` events, and the `net.fetch` events of the artwork queue, which is background work with no tie to a switch.

`file.write` is every write that goes through the app's atomic writer: the adapters' launcher files and a snapshot's `manifest.json`. A manifest write has no digest, because the manifest holds its own creation time; what it says is in `final.backups`.

## Comparing

- Job events: the expectation's are a subsequence of the replay's, compared whole. A replay may show states between them.
- Platform events: the same events in the same order.
- The final state: equal.
- `<ts>` stands for any timestamp, in either of the app's spellings (`2026-11-06T16:46:23.000Z`, and with dashes for colons in a snapshot id). No expectation holds a `<ms>`.
- `{launchers}` and `{data}` stand for the two folders, however the path is written: as is, lower-case with forward slashes, or with doubled backslashes.

## Aliases

| Alias | The id of |
| --- | --- |
| `@acct:<launcher>:<login>` | An account |
| `@game:<launcher>:<launcher's game id>` | A library game |
| `@job:<n>` | The nth job started |
| `@backup:<launcher>:<n>` | That launcher's nth snapshot, in the order they were taken. It also stands for the id inside a path or a sentence |
| `@history:<n>` | The nth row of `launch_history` |

## Final state

- `db`: `user_version` and every table. Rows are ordered by their natural key (accounts by launcher and login, games by launcher and game id, settings and secrets by key, sessions and artwork by the alias of their account or game), `launch_history` in the order written. The `window.bounds` setting is left out: only a window writes it. A `*_enc` column is `{ present, plaintextSha256 }`.
- `journal`: `switch.json` as parsed, or `null`.
- `backups`: `db.copies` is the number of database copies in `backups\db`, one per start. Then each launcher's snapshots, oldest first, as their manifests describe them: `id`, `createdAt`, `reason`, `pinned`, `meta`, and per file `relative`, `source`, `existed`, `bytes`, `encrypted` and a digest of the original bytes, decrypted first when the copy is stored encrypted. A value `meta` holds vault-encrypted is shown by its plaintext: a Battle.net snapshot's `unifiedAuth`, which the manifest keeps as a JSON list with each token under `enc`, is that list with `plaintextSha256` in the place of `enc`.
- `launcherFiles`: the four launcher state files the adapters write, where the scenario has them, each with `bytes`, a content digest and `parsed`, the app's own reading of it: `parseLoginUsers` for Steam's `loginusers.vdf`; the remembered session of Epic's `GameUserSettings.ini` with its two blobs as `dataSha256` and `offlineDataSha256`; `readClientSettings` for `Battle.net.config`; `readSession` for the Riot Client's `RiotGamesPrivateSettings.yaml`.
- `registry`: every value of the fake registry at the end, ordered by path, `data` as the fake holds it (a DWORD as `0x…`, binary as hex). Read from the harness; see "Cross-check".
- `log`: the WARN and ERROR lines of `onelaunch.log`, in order, each as written except that an error's `stack` is dropped from the JSON tail, and an id the logger cut to its last four characters is its alias: `[UUID…@job:1]`. One line is never included: `launcher status was slow`, which only says how long a status pass took and comes and goes with the machine's load.

A digest the app keeps under a name of its own (`fingerprint` in a table or in a parsed file) is written `{ "sha256": "…" }`.

## Content digests

Where an expectation says what a file or a stored value holds, it gives one of two digests:

- `sha256`: of the bytes. Used wherever all five recordings had the same bytes.
- `projectionSha256`: of the text after three replacements, used where they did not. First, what a simulator stamps: the value of `last_token_creation_time` and of `original_token_creation_time` in a Riot session file becomes `<ms>` (the fake Riot Client writes the time of day there when it rotates a token). Then the two folders become `{launchers}` and `{data}`, and every known id its alias, as in any other string.

The same holds for a `*_enc` column whose plaintext carries such a stamp, a saved Riot sign-in: it appears under the name without `_enc`, as `{ present, projectionSha256 }`.

## Normalisation

Each `normalisation/<name>.json` lists `volatile`, the paths whose value differed between the five recordings as recorded, and `normalised`, every path a rule changed, with the rule:

| Rule | What it did |
| --- | --- |
| `alias`, `root`, `ts`, `enc` | The oracle's normaliser: an id, a folder, a timestamp, a `*_enc` value |
| `projection` | A `sha256` that differed gave way to `projectionSha256` |
| `enc-projection` | A `*_enc` value whose plaintext differed gave way to its `projectionSha256` |
| `manifest` | A snapshot manifest's write lost its digest |
| `log-id` | An id's tail in a log line became its alias |

`volatileNotNormalised` is empty in every file: nothing differed without a rule. `normalisedNotVolatile` is empty in every file but `unowned`'s, which has one `enc` path: no account of that scenario has a password, so `secret_enc` is null in every row of every recording, and a null is written `{ present: false }`.

The harness's vault salts every value at random, as the app's real vault does, so a ciphertext always counts as a difference between recordings; an expectation never holds one.

`transient` names job states a recording shows or not by chance, because the simulator holds them for less than one poll of the adapter; they are taken out of every recording. `self-update` has the only one.

`clock` is the instant the recording's clock started at. Steam judges a remembered session by its age, so the warnings of a switch plan depend on the date; plans are IPC answers and no expectation holds one.

## The scripts

Each is the headless reading of the driver scenario of the same name (`scripts/scenarios/<name>.mjs`): the IPC calls its clicks make, with a gate where the scenario watches the dialog.

| Script | What it runs |
| --- | --- |
| `play-all` | Play on a non-current account on each of the four launchers, in one session |
| `play-steam`, `play-epic`, `play-battlenet` | One such Play each |
| `play-riot` | Play with "Start Riot games for you" off (the hand-over to Play), then on, back to the first account from the sign-in saved a moment before |
| `already-active` | Steam already runs as the account: the job goes straight to the launch, twice, the second as a one-click Play |
| `elevated` | Steam cannot be closed: refused before anything changed |
| `game-running` | Battle.net's game already runs: the switch counts, the launch is refused |
| `needs-update` | Battle.net and the Riot Client want to update the game: the switch counts, the launch is refused; a second try goes straight to the refusal |
| `handover` | Steam asks for the sign-in: both copies, "Stop waiting", then the wait running out; then Epic, where the user signs in by hand |
| `import` | Accounts imported from what Steam and Battle.net remember |
| `preview` | Preview mode refuses `launch:start`; turned off, the switch runs |
| `recovery` | Two crashes mid sign-in: the first restored from its snapshot at the next start, the second left as it is |
| `restore` | A snapshot restore refused while Steam runs, and done after a restart |
| `riot-stay-signed-in` | A first sign-in by hand without "Stay signed in", then a switch away |
| `rollback` | Steam never comes back after the writes: the snapshot is put back |
| `self-update` | Steam updates itself before it signs in |
| `stop` | Stop while Steam closes, after it was started again, and after the sign-in was confirmed |
| `unowned` | A sign-in no account owns: the snapshots are pinned, and one is restored |
| `wrong-account` | Epic signs in as another account's id: rolled back; after a restart, as an id nobody holds: adopted |
| `quit-during-switch` | Stop during the sign-in; after a restart, the quit itself during the sign-in |
| `first-run` | A PC with no launcher: the reads of the setup guide, the guide dismissed, a second start |

Where a script departs from its scenario:

- `stop`: the scenario sleeps until the fake Steam has finished signing in before its third switch. The script restarts instead, with knobs under which Steam is already running as that account.
- `quit-during-switch`: the scenario's "Keep running" answer and its quit both go through a native prompt. The script has the first switch stopped from the dialog, as the scenario then does, and the second ended by `shutdown`, which is the quit without the prompt: the log line names the reason `quit`, not `quit confirmed during a switch`.
- `already-active`: the window hiding to the tray and the second start that brings it back are window behaviour and not replayed.
- `first-run`: the guide itself is interface. The script is the reads behind it and the one setting it stores.

## Cross-check

`cross-check.json` records the replay of `play-all`, `rollback`, `handover`, `recovery` and `quit-during-switch` through the built Electron app (unpackaged, fake launchers, a scratch data folder, the recording hooks on), compared with their expectations by the rules above with no difference. Stored secrets were compared like everything else: the comparison read the scratch profile's vault, so a `plaintextSha256` from Electron's DPAPI vault had to equal the harness's.

What an Electron run cannot show is left out, and the file lists it per script:

- `final.registry`, in all five: the fake registry lives in the app's memory. It comes from the harness, which runs the same adapters and simulators.
- A `projectionSha256` on a `file.write`, in none of the five: the app's own trace carries the digest of the bytes only.

## What the schemas do not say

- A script cannot state what an invoke is answered with, so a read-only script (`first-run`, the reads in the others) is checked by its final state and its log lines only.
- `until` is checked as `state`, or `step` with `status`; the schema allows any name there.
- `final.registry`, `backups.db`, `projectionSha256` and the `{ sha256 }` form are allowed by the expectation schema and not described by it.
- The schema has no place for the fields of a job event beyond `job`, `state` and `steps`, nor for those of a platform event beyond `op` and `sha256`; they are compared all the same.
