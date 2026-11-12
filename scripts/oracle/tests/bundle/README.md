# Test catalogue and result goldens

Every test of the Electron suite at the pin, and the full result of every adapter call those tests make. Captured by `scripts/oracle/tests/capture.mjs` on the branch `oracle-tooling` of the Electron repo, which runs the whole suite through vitest's JSON reporter with a setup shim that wraps the four adapters. Nothing under `src/` or `test/` was changed to get it.

## Files

| Path | What |
| --- | --- |
| `catalogue.json` | One entry per test, `it.each` expanded; schema `schemas/catalogue.schema.json` |
| `goldens/<id>.json` | Per test that has one: every `preflight`, `switchAccount`, `launchGame` and `restoreBackup` call the test made, in call order, with its full result |
| `capture.json` | The clock the suite ran under, how many runs were compared, and every normalisation rule with the paths it touched |

## Catalogue entries

| Field | Meaning |
| --- | --- |
| `id` | `T-<file>-<hash>`: `<file>` is the path under `test/` without `.test.ts` or `.test.tsx`, with `/` as `.`; `<hash>` is the first 10 hex characters of the sha256 of the UTF-8 JSON text of `[file, suite, name]` (no spaces, as `JSON.stringify` writes it). It depends on nothing else, so it survives a re-run, a reorder and a rebase; renaming the test or moving it to another `describe` gives it a new id |
| `file` | The test file, from the Electron repo root, forward slashes |
| `suite` | The enclosing `describe` titles, outermost first; `[]` for a top-level test |
| `name` | The test's title as vitest reports it, so an `it.each` case carries its formatted arguments |
| `environment` | `jsdom` for a file with a `@vitest-environment jsdom` line (the renderer tests), else `node` |
| `kind` | See below |
| `status` | `passed`, `skipped` or `todo` in the canonical run, which was green; see "Where `status` comes from" |
| `golden` | `tests/goldens/<id>.json` when the test has one, else `null` |
| `waiver` | A proposed waiver (`category`, `reason`) for the owner to approve at the gate, else `null` |

No two tests at the pin share file, suite path and name, so ids are unique. If two ever do, the capture refuses to run rather than number them by position, and the test has to be renamed upstream.

### Kinds

| Kind | Rule |
| --- | --- |
| `adapter-flow` | Every test in the four adapter suites: `test/steam-adapter.test.ts`, `test/epic-adapter.test.ts`, `test/battlenet-adapter.test.ts`, `test/riot-adapter.test.ts`. Each has a golden, also when it made none of the four calls (its `calls` is then `[]`) |
| `renderer` | Runs in jsdom: the React views and dialogs under `test/renderer/` |
| `live` | `test/*-live.test.ts`: reads the real launchers on the machine; skipped unless `ONELAUNCH_LIVE=1`, which the capture never sets |
| `tooling` | Tests of this repo's scripts and test data rather than of the app: the CDP driver (`drive-*`), the secret scan and git hooks (`no-secrets`), the notices script (`third-party-notices`), the fake-launcher scenario folders (`fake-scenario`) |
| `pure` | Calls a function on literal or fixture input and checks what comes back; nothing outlives the call, no folder is written, no timer runs |
| `stateful` | Everything else in `node`: the test builds something that holds state across calls (a database, a temp folder it writes, a service, a simulator, a fake registry or process table, a timer, a mocked module) |

`pure` and `stateful` are decided per file, with named suites of a mostly pure file marked `stateful` (and one suite of a stateful file marked `pure`); the table is in `scripts/oracle/tests/catalogue.mjs`.

A test outside the adapter suites gets a golden too when the shim saw it call an adapter; it keeps its own kind. At the pin these are the `test/pipeline.test.ts` tests that drive a switch through IPC.

### Proposed waiver categories

| Category | Candidates |
| --- | --- |
| `web-only` | Behaviour that exists because the UI is a web page in Electron: the preload bridge (`preload`), the renderer's IPC client and query hook (`use-ipc-query`) |
| `tooling` | Every `tooling` test above: repo scripts and test data that do not ship |
| `native-platform` | The reg.exe and PowerShell layer, once the platform layer is native: the reg.exe and PowerShell output parsers and command lines in `platform`, `platform-write` and `registry-dump`, and the PowerShell private clipboard write (`clipboard-private`). The fakes tested beside them (`StaticRegistry`, `StaticProcessController`) are not candidates |

## Goldens

```json
{
  "id": "T-steam-adapter-…",
  "file": "test/steam-adapter.test.ts",
  "suite": ["SteamAdapter.switchAccount (dry run)"],
  "name": "…",
  "calls": [
    { "launcher": "steam", "method": "switchAccount", "args": [{ "id": "acct-1" }, { "dryRun": true }], "outcome": "returned", "result": {} }
  ]
}
```

- `calls` holds the calls on real adapter instances (`SteamAdapter`, `EpicAdapter`, `BattlenetAdapter`, `RiotAdapter`), made from the test or from the services it drives, in the order they were made. Hand-written fakes in other tests are not adapters and are not recorded.
- `launcher` is the adapter's `id`. `args` are the arguments as passed, encoded when the call was made.
- `outcome` is `returned` (with `result`), `threw` (with `error`) or `pending`: the promise had not settled when the file's tests ended. One call is `pending` at the pin, the switch in pipeline test 4 whose launcher start is made to hang on purpose.
- `error` is the thrown value: `name`, `message`, and every own enumerable property of the error (`code`, `runningGame`, `path` and so on) and its `cause`, encoded like any value; never the stack. A thrown value that is not an object would be `{"$thrown": <value>}`; none occurs at the pin.
- A result is encoded when its promise settles, so a later change to the object by the test does not show.

### Encoding

Plain JSON values are as they were. Everything JSON drops or cannot carry exactly is an object with one `$` key (the first five as in the vector schema):

| Wrapper | Stands for |
| --- | --- |
| `{"$undefined": true}` | `undefined`, as a property value, an argument or an array item (a hole too) |
| `{"$date": "<ISO>"}` | A `Date`, as `toISOString()` prints it; `null` for an invalid date |
| `{"$bytes": "<base64>"}` | A `Buffer`, typed array or `ArrayBuffer` |
| `{"$number": "NaN"}` | `NaN`, `Infinity`, `-Infinity` or `-0` |
| `{"$utf16": [..]}` | A string holding a lone surrogate, as UTF-16 code units |
| `{"$error": {"name", "message", ..}}` | An `Error` inside a value |
| `{"$function": "<name>"}` | A function (a callback such as `onProgress`); its name only |
| `{"$object": "<class>", "value": {..}}` | An instance of a class that is not `Object` (`AbortSignal` in `args`), with its own enumerable properties |
| `{"$map": [[k, v], ..]}`, `{"$set": [..]}` | A `Map` or `Set`, in insertion order |
| `{"$bigint": "<digits>"}`, `{"$symbol": "<description>"}`, `{"$promise": true}`, `{"$circular": true}` | The rest; none occurs at the pin |

No recorded object has a key starting with `$`; the capture refuses one, so a `$` key is always a wrapper. Key order is the order the app built the object in.

### Placeholders

The suite was run several times (`capture.json` says how many) with `TEMP` on a fresh scratch folder each time, and the goldens are what all runs agree on once these rules are applied (`scripts/oracle/lib/normalise.mjs`). `capture.json` lists every rule with each path it touched and in how many goldens.

| Placeholder | Replaces | When |
| --- | --- | --- |
| `{tmp}`, `{tmpB}`, .. | The test's own temporary folders (`mkdtemp` under `TEMP`), named in the order the calls first mention them, written raw, lower-case with forward slashes, VDF-escaped or JSON-escaped; matching ignores case, so a path the app lower-cased (Steam's install folder) is `{tmp}\steam\…` | Always |
| `{temp}` | `TEMP` itself, where a path names it without a test folder | Always |
| `@acct:<launcher>:<login>` | An account id the services generated (a UUID), wherever it appears | Only where the id differed between runs; a fixed id such as `acct-1` stays |
| `@game:<launcher>:<launcherGameId>` | A game id the library generated | Same |
| `<ts>` | An ISO timestamp (also the `-` form backup ids use) | Only at the paths where the runs differed, as listed in `capture.json`; a path is a JSON pointer with `*` for every array position, so a fixed timestamp at the same pointer is masked too |

`<ms>` exists in the normaliser but nothing measured needed it. To compare a Rust result with a golden, apply the same rules to it: its own temp folder as `{tmp}`, its generated ids as the aliases, `<ts>` at the listed paths.

### Clock

The suite ran under the oracle clock: `Date` starts at `capture.json`'s `clock` (the pin's commit time) in every test file and runs on from there. Timers, file times and SQLite keep real time. Results that depend on today's date (a remembered session's age, a stale flag) are what they were at that instant, so a Rust test sets its clock to the same instant.

## Where `status` comes from

`status` is each test's outcome in a run exactly as `node scripts/oracle/check.mjs` runs the suite: its config and the oracle clock, no shim, `TEMP` as the machine has it. The goldens come from separate runs with the shim and `TEMP` on a scratch folder.

One test's outcome depends on the temp volume rather than the code: `test/no-secrets.test.ts` › `install-git-hooks (postinstall)` › `sets it when the checkout is reached through an 8.3 short path` makes a checkout under `TEMP` and skips itself when that folder has no 8.3 short name. It ran and passed on the capture machine's own `TEMP`, so the catalogue records it `passed`; on a volume without 8.3 names (the scratch folder of the shimmed runs) it is skipped.
