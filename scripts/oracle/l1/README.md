# Vectors (l1)

Ticket M0-T03: one JSON file per pure function of the app, each case holding the arguments and either the value the real TypeScript returned or the error it threw. The Rust port runs the same arguments through its own code and must give the same answer. The format is `scripts/oracle/schemas/vector.schema.json` (bundle path `l1/**/*.json`); this file fixes the conventions on top of it, for the agents writing generators and for whoever reads the vectors from Rust.

## Layout

| Path | What |
| --- | --- |
| `targets.mjs` | The targets table of `plan/design/oracle.md` › Vectors as data: per area, every item in the design's words. IPC and Renderer rows are in `core` |
| `check.mjs` | The ticket's three acceptance checks |
| `lib/index.ts` | The API a generator imports |
| `lib/encode.ts` | Value encoding into the schema's wrappers, and back |
| `lib/corpus.ts` | The seeded generator and the byte mutations |
| `lib/grammar.mjs` | The note's decode line, origin refs, id and name patterns; shared with `check.mjs` |
| `<area>/*.gen.ts` | An area's generators (`steam`, `epic`, `battlenet`, `riot`, `core`), one folder per area agent |
| `<area>/targets.mjs` | The area's map from design items to real exports and vector files |
| `example/` | A worked example (`example.dev.ts`, not picked up by `generate.mjs`) and its `targets.mjs` |
| `coverage/` | The coverage tool (to come; see "Coverage") |

In the bundle:

| Path | What |
| --- | --- |
| `l1/<area>/<name>.json` | One vector file per function. `<name>` is the function (`Class.method` for a method) unless the generator names it |
| `l1/<area>/files/<name>/…` | Input files a generator made (`input()`), referenced by `$file`. Never named `*.json` |

## Commands

| Command | What it does |
| --- | --- |
| `node scripts/oracle/generate.mjs l1/<area> --out <scratch>` | Runs the area's generators into a scratch folder: a trial |
| `node scripts/oracle/generate.mjs l1/<area>` | Runs them into the bundle |
| `node scripts/oracle/generate.mjs l1/<area>/<file>` | One generator, `<file>.gen.ts` without the suffix |
| `node scripts/oracle/l1/check.mjs [--area=<area>] [--out <bundle>] [--scratch <dir>] [--keep]` | The acceptance checks, for every area or one. `--scratch` keeps the two runs there |
| `ORACLE_GENERATOR=scripts/oracle/l1/example/example.dev.ts ORACLE_OUT=<scratch> node node_modules/vitest/vitest.mjs run --config scripts/oracle/vitest.config.ts` | The worked example, into a scratch folder only |

A trial into a scratch `--out` still reads its `$file` inputs from the real bundle: `file()` reads from `ORACLE_BUNDLE`, else the default bundle (`..\one-launch-rs\oracle`), never from `--out`. So the recorded `sha256` is always the bundle's. `check.mjs` sets `ORACLE_BUNDLE` to the bundle it checks.

## API

A generator is a vitest file `scripts/oracle/l1/<area>/<topic>.gen.ts`. Its first import is the library, then `../../lib/clock.setup.mjs` if any of its functions reads today's date, then the app's modules. The library imports no app module, so the coverage tool can start before the app code loads.

```ts
import { adversarial, bundleBytes, bytes, corpus, file, fixture, fromTest, text, vectorFile } from '../lib/index';
import { planAutoLoginRewrite } from '../../../../src/main/launchers/steam/loginusers';

const LOGINUSERS = 'fixtures/launchers/steam/loginusers.vdf';
const TESTS = 'test/steam-files.test.ts';
const original = bundleBytes(LOGINUSERS);

vectorFile({
  area: 'steam',
  function: 'planAutoLoginRewrite',
  source: 'src/main/launchers/steam/loginusers.ts',
  decode: { 0: 'utf8' },
  note: 'arg0 is loginusers.vdf as src/main/launchers/steam/adapter.ts reads it (readFileSync utf8); arg1 is the target SteamID64.',
  call: planAutoLoginRewrite,
  cases: [
    {
      id: 'flip-to-user-3',
      origin: fromTest(TESTS, 'planAutoLoginRewrite', 'flips AutoLogin to the target and clears it everywhere else, touching nothing else'),
      args: [file(LOGINUSERS), '76561198000000003'],
      expect: 'out',
    },
    {
      id: 'mostrecent-crlf',
      origin: fromTest(TESTS, 'planAutoLoginRewrite', 'rewrites MostRecent on older files, adds AutoLogin where neither key exists, and keeps CRLF'),
      args: [text('"users"\r\n{\r\n\t"76561198000000002"\r\n\t{\r\n\t\t"AccountName"\t\t"b"\r\n\t}\r\n}\r\n'), '76561198000000002'],
      expect: 'out',
    },
    { id: 'undefined-target', origin: fixture(LOGINUSERS, 'target left undefined'), args: [file(LOGINUSERS), undefined], expect: 'error' },
    {
      id: 'invalid-utf8-in-name',
      origin: adversarial('utf8-decode', 'a lone 0xFF in an account name; Node gives U+FFFD, Rust must replace it the same way'),
      args: [bytes(Buffer.from(original.toString('latin1').replace('"user_3"', '"user_\xff3"'), 'latin1')), '76561198000000003'],
      expect: 'out',
    },
    ...corpus({ seed: 1, count: 20, from: [{ path: LOGINUSERS }], args: (mutated) => [mutated, '76561198000000003'] }),
  ],
});
```

`example/example.dev.ts` is the same function with every helper in use, and its output passes `check.mjs --area=example`.

`vectorFile(spec)` registers one vitest test that runs every case in order, validates the file against the schema and writes `<out>/l1/<area>/<name>.json`. A generator may call it several times, one per vector file. The spec:

| Field | Meaning |
| --- | --- |
| `area` | `steam`, `epic`, `battlenet`, `riot` or `core` |
| `function` | The exported name; `Class.method` for a method. Must match the area's `targets.mjs` |
| `source` | The module that exports it, `src/…` from the Electron repo root |
| `name` | The file name without `.json`; defaults to `function` |
| `decode` | Per argument position, how the app's caller turns file bytes into what the function takes (see "Byte inputs") |
| `clock` | `true` when a result depends on today's date; the generator must have imported `clock.setup.mjs` |
| `note` | Free text (see "Notes"); the library puts the decode line above it |
| `call` | Called with the decoded arguments of each case. The export itself when the arguments go straight in; otherwise a wrapper, and the note says what it does |
| `cases` | An array, or a function (async allowed) returning one |

A case is `{ id, origin, args, expect? }`. `args` are real JS values and the input helpers below. `expect: 'out'` or `'error'` makes the generator fail when the case does the other thing; set it on every hand-written case, so a bug in a wrapper is never recorded as the app's behaviour. Corpus cases leave it out: either outcome is recorded.

What happens per case: the arguments are encoded first, then decoded back into fresh JS values (and through `decode`) for the call, so the function gets exactly what was recorded and cannot change the record by mutating its arguments. A returned promise is awaited. A throw or a rejection is recorded as `error`, never fails the generator. Anything that cannot be encoded (in the arguments, the result or the error's properties) fails the generator with the path, for example `out/users/0/seen: a Map cannot be recorded`.

Inputs:

| Helper | Recorded as | The function gets |
| --- | --- | --- |
| `file(path)` | `{"$file": path, "sha256": …}`; `path` from the bundle root, e.g. `fixtures/launchers/steam/loginusers.vdf` | the file's bytes, then `decode` |
| `bytes(buffer)` | `{"$bytes": base64}`, at most `INLINE_MAX` (64 KiB) | the bytes, then `decode` |
| `text(string, encoding = 'utf8')` | `bytes(Buffer.from(string, encoding))`: a literal lifted from a test, as the file it stands for | as `bytes` |
| `input(area, '<name>/<file>', buffer)` | writes `l1/<area>/files/<name>/<file>` into the output and records it as `$file` | as `file` |
| `bundleBytes(path)` | nothing; returns a bundle file's bytes to build other inputs from | |
| `listBundle(dir)` | nothing; lists the files under a bundle folder | |

Origins: `fixture(path, change?)`, `fromTest(file, ...titles)`, `adversarial(kind, what)`. A corpus case's origin is made by `corpus()`. Each checks its ref's grammar when called.

Corpus: `corpus({ seed, count, from, args, ops?, steps?, encoding?, prefix? })` returns `count` cases with ids `<prefix>-<seed>-<index>` (prefix `corpus`). Case `index` takes its own generator from `seed` and `index`, picks one base from `from` (`{ path, bytes? }`, bytes read from the bundle when left out), applies `steps` (default `[1, 3]`) mutations drawn from `ops` (default all), and passes the result as a `bytes()` input to `args`. Its origin ref is `seed=<seed> index=<index> ops=<applied> from=<base path>`. `encoding` (`utf8` or `utf16le`) keeps line, BOM, astral and surrogate mutations on character boundaries of that encoding. A mutated input over 64 KiB fails the generator, so corpus bases are the small fixtures.

Mutations (`MUTATIONS`, each `(bytes, rng, encoding) => bytes`): `flip` (one bit), `insert` (1 to 4 structural or control bytes), `delete` (1 to 16 bytes), `line-duplicate`, `line-delete`, `line-swap`, `eol` (CRLF to LF, or LF to CRLF when there is no CRLF), `bom` (add or remove), `truncate`, `invalid-utf8` (an overlong, a surrogate, a truncated sequence, a stray continuation, a code point over U+10FFFF), `astral` (an astral character), `lone-surrogate` (as CESU bytes in UTF-8, as one unit in UTF-16LE). `Rng(seed)` (mulberry32: `next()`, `int(n)`, `between(a, b)`, `pick(list)`) and `mutate(bytes, rng, ops, steps, encoding)` are exported for hand-built corpora. Never `Math.random` or `crypto.randomBytes`.

## Encoding

Values are plain JSON except where JSON cannot carry them exactly. Both directions use the same rules, so a Rust reader decodes `args` and `out` the same way.

| JS value | Recorded |
| --- | --- |
| `null`, booleans, finite numbers other than `-0` | as JSON |
| a well-formed string | a JSON string |
| a string with a lone surrogate | `{"$utf16": [code units]}` |
| `undefined`, as a value, an array item or an object property (the key is kept) | `{"$undefined": true}` |
| `NaN`, `Infinity`, `-Infinity`, `-0` | `{"$number": "NaN"}` and so on |
| a valid `Date` | `{"$date": toISOString()}` |
| a `Buffer` or `Uint8Array` | `{"$bytes": base64}`; decodes to a `Buffer` |
| an array | an array; a hole is refused |
| an object whose prototype is `Object.prototype` or `null` | an object, keys in JS enumeration order |

Refused, with the path: `Map`, `Set`, any class instance (including `Error` in a value and every typed array but `Uint8Array`), functions, bigints, symbols, symbol keys, an invalid `Date`, and a key starting with `$`. Project such a value explicitly in `call` (`[...map]`, `Object.fromEntries(map)`, `{ ...instance }`) and say so in the note. An argument that must be such a value is built in `call` from encodable arguments, and the note says how.

Object key order is recorded as JS enumerates it (integer-like keys first, then insertion order). Compare objects as maps unless the function's output is a serialisation, which is then a string anyway.

## Byte inputs and the decode line

Inputs are bytes, never JSON strings, because BOM, CRLF and invalid UTF-8 are behaviour. When a function takes text the app read from a file, every case gives that argument as `file()`, `bytes()`, `text()` or `input()`, and `decode` states how the app's own caller turns the bytes into the string the function gets. Find the caller (`readFileSync(path, 'utf8')`, `readLauncherText`, `buf.toString('utf8')`) and copy what it does; do not strip a BOM the caller keeps.

The library writes the decode as the first line of `note`, and `check.mjs` checks it against every case. Grammar (ABNF):

```
header   = "decode: " decodes [ " clock: " instant ]
decodes  = "none" / decode *( " " decode )
decode   = "arg" index "=" decoder
decoder  = "bytes" / "utf8" / "utf8+strip-bom" / "utf16le" / "utf16le+strip-bom" / "latin1"
index    = "0" / %x31-39 *DIGIT          ; position in args, ascending
instant  = the ORACLE_CLOCK instant as Date.toISOString() prints it
```

Example: `decode: arg0=utf8+strip-bom arg2=bytes clock: 2026-11-06T16:46:23.000Z`. Everything after the first line is free text.

| Decoder | The function gets |
| --- | --- |
| `bytes` | the bytes, as a Node `Buffer` |
| `utf8` | Node's `toString('utf8')`: a leading BOM stays as U+FEFF; each maximal invalid subsequence becomes one U+FFFD (the WHATWG rule, the same as Rust's `String::from_utf8_lossy`) |
| `utf16le` | Node's `toString('utf16le')`: code units as they are, lone surrogates kept, an odd last byte dropped |
| `latin1` | each byte as the code point of the same value |
| `…+strip-bom` | the decoded string with one leading U+FEFF removed |

Rules: an argument with a decode entry is `$bytes` or `$file` in every case; a top-level `$bytes` or `$file` argument always has one (`bytes` when the function takes bytes). Bytes nested inside an object argument are passed as a `Buffer` and need no entry. Arguments that are not file text (an id, a path, an in-memory string) are plain values and have no entry.

## Input files

An input over 64 KiB (`INLINE_MAX`) must be a file: `bytes()` refuses it. A file the bundle already has (`fixtures/**`, which holds every file of `E\test\fixtures` under `fixtures/launchers/<launcher>/` and `fixtures/external/steamgriddb/`) is referenced with `file()`. A file the generator makes is written with `input(area, '<vector name>/<file>', bytes)` to `l1/<area>/files/<vector name>/<file>`; the prefix keeps two generators of one area from writing the same path. Never give an input a `.json` name: every `l1/**/*.json` is validated as a vector file. Bytes that are not in the bundle and are small (a literal lifted from a test, a cut of a fixture) are inline `$bytes`, with the origin naming where they came from.

## Ids

`^[a-z0-9][a-z0-9._-]*$`, unique in the file, stable across runs, and saying what the case is: `fixture-loginusers`, `crlf-literal`, `cap-depth-at`, `cap-depth-over`, `adv-astral-length`. Derive an id from the case, never from its position; the one exception is the corpus, `corpus-<seed>-<index>`, whose position is its identity. Renaming an id breaks every Rust test that names it.

## Origins

Every case names where it came from. `check.mjs` checks that the source is real.

| Kind | `ref` | Checked |
| --- | --- | --- |
| `fixture` | `<path>` or `<path> \| <what was changed>`. The path is from the bundle root (`fixtures/…`, `l1/<area>/files/…`) or the Electron repo root (`test/fixtures/…`) | the file exists in the bundle or the repo |
| `test` | `<test file> > <title> [> <title>…]` and optionally ` \| <what was changed>`: the describe titles and the test title as written in the source (a template title as written, `%s` and all) | the file exists under `test/` and every title is in it |
| `corpus` | `seed=<n> index=<n> …` (written by `corpus()`) | the grammar |
| `adversarial` | `<class>: <what differs between JS and Rust>` | the class is one of the list below and the text is there |

A case whose bytes come from a fixture but whose point is a JS-versus-Rust difference is `adversarial`, and its text names the fixture.

Adversarial classes: `unicode-digit` (`\d`), `unicode-space` (`\s`, `trim`), `word-boundary` (`\b`), `utf16-length` (`.length`, `slice`, `padStart` count code units, astral characters count two), `parseint` (`parseInt` and `Number()` leniency: leading spaces, trailing junk, `0x`, `+`, empty), `lone-surrogate` (in strings and in JSON), `locale-compare` (`localeCompare`, `Intl.Collator`, `sensitivity: 'base'`), `utf8-decode` (replacement of invalid bytes), `case-mapping` (`toLowerCase` on non-ASCII, `İ`, `ß`), `number` (float formatting, `toFixed`, rounding), `json` (`JSON.parse` duplicates, `__proto__`, big numbers), `date` (`Date.parse` leniency, time zones), `regex` (other regex semantics: `lastIndex`, `u` and `v` flags, lookbehind), `sort` (sort stability and comparator contracts), `other`.

## Notes

`note` is required. After the decode line the library writes, it says, in this order and only what applies:

- for each decoded argument, the caller whose decode it copies (`src/main/launchers/steam/adapter.ts readFileSync utf8`);
- what `call` does beyond calling the export with the arguments: a constructor run, an argument built, a result projected. The Rust test must do the same;
- global state the function reads or changes (the logger's redaction list, `process.env`, a module-level cache) and what the generator set;
- that the clock is on and why, when `clock` is set;
- known gaps: a branch no pure input reaches, a cap not reachable within the inline or file limits.

## Errors

A case that threw records `error`: `name` (the error's `name`, inherited or own), `message` exactly (several are shown to the user verbatim), then every own enumerable property other than `name`, `message` and `stack` (`code`, `line`, `path` and the like), encoded like any value. `stack` is never recorded; `cause` is non-enumerable and is not recorded. A thrown value that is not an `Error` is recorded as `{ "name": "(not an Error)", "message": "", "value": … }`. The Rust side maps `name` to its own error type, and must match `message` and every extra property.

## Size caps

The parsers cap what they accept and must stay linear. For every limit a function itself enforces (a nesting depth, an item count, a string length, a byte size), the vector has a case exactly at the limit and one a single unit over it, in the unit the code measures: `.length` is UTF-16 code units, so add a case where an astral character straddles the limit; bytes are bytes; items are items. Name them `cap-<what>-at` and `cap-<what>-over`. A cap enforced by an I/O caller and not by the function (`readLauncherBytes`, the log tail sizes) is not the function's; say in the note that the function relies on it. A cap input over 64 KiB is an `input()` file.

## Paths, clock and determinism

- Cases run in declared order; nothing in a vector may depend on the run. No timestamps, no random values, no absolute scratch or user path. The bundle scan rejects a `C:\Users\<name>` path unless the name is a placeholder (`someone`, `placeholder`, `public`, `default`, or one starting with `<`, `%`, `$`, `{` or `[`), and this machine's user name, host name, home and temp folders anywhere. For a path argument use neutral roots the fixtures use: `C:\Program Files (x86)\Steam`, `D:\Games\Steam`, `E:\SteamLibrary`, `C:\Users\someone\AppData\Roaming\OneLaunch`, `C:\Users\<user>\AppData\Local\…`. Never `os.tmpdir()`, `os.homedir()`, `process.cwd()`, `__dirname` or the repo path.
- A function that reads `process.env` gets neutral values set by the generator before the call, and the note says which.
- Clock: prefer passing an explicit `now` where the function takes one. A function that reads today's date runs with `clock: true` and `import '../../lib/clock.setup.mjs'` after the library import; the decode line then carries `clock: <ORACLE_CLOCK>`. The oracle clock starts at that instant and runs on, so a result that depends on the current time finer than a few seconds is not repeatable; pass `now`, or project the result to what is stable, and say so.
- Secrets: placeholders only (`user_1`, `placeholder-password-1`, `@example.com`). A 64-character hex value passes the bundle scan only as a `sha256` of a bundle file or in a `sha256` field.

## Area targets

Each area agent writes `scripts/oracle/l1/<area>/targets.mjs`:

```js
export default [
  {
    item: 'parseVdf and getters',
    exports: [
      { export: 'parseVdf', source: 'src/main/launchers/steam/vdf.ts', vector: 'l1/steam/parseVdf.json' },
      { export: 'vdfGet', source: 'src/main/launchers/steam/vdf.ts', vector: 'l1/steam/vdfGet.json' },
    ],
  },
];
```

- `item` is the item's text exactly as `targets.mjs` beside this README has it; every item of the area appears once.
- `exports` lists one or more real exports: `export` is the name (`Class.method` for a method), `source` its module, `vector` the bundle path of the file holding its cases. A vector file belongs to one export. Its `function` and `source` must equal `export` and `source`.
- An item that is not one function (`PRODUCTS`, "window-guard truth tables", "token blobs v1 and v2", the IPC matrix, "sort comparators") maps to the exports that implement it; a constant is a vector whose `call` takes no argument and returns it.

## Check

`check.mjs` prints one PASS or FAIL line per check, with every problem under it, and exits 0 only when all three pass. An area with no `targets.mjs`, no generator or no vector file yet is reported as missing.

1. Every target has a vector: every item of the area is mapped, every mapped export is found in its source module (an `export function`, `const`, `class`, `enum` or export list; for `Class.method`, the class and the method), and its vector file is in the bundle, valid against the schema, with `function` and `source` matching, at least one case, and a decode line that fits every case. Vector files no `targets.mjs` names are listed in the summary.
2. Two runs are byte-identical and match the bundle: the area's generators run twice into two fresh scratch folders (`ORACLE_BUNDLE` set to the checked bundle, so `$file` inputs read the real fixtures), and every file under `l1/<area>/` must be the same in both runs and in the bundle. A file only in the bundle (left over from an earlier run) fails it; delete it. A generator that writes outside `l1/<area>/` fails it.
3. Every case names a real origin, as the table under "Origins" says.

## Coverage

`node scripts/oracle/l1/coverage/run.mjs <area> [--only=<generator>,<generator>] [--out <folder>] [--scratch <dir>] [--keep]` runs the area's generators under V8 block coverage and writes `<out>/l1/coverage/<area>.md` (a Markdown file, never `.json`, so it is not read as a vector). `--out` defaults to the bundle like every other command; pass a scratch folder while you work, and the coordinator writes the bundle copy. `--only` takes generator files relative to the area folder (`--only=ipc.gen.ts`). The vectors of a coverage run go to a scratch folder and are thrown away, so the bundle's vectors are never touched; `$file` inputs are read as in any run. A run takes a second or two per area.

How it works:

- `coverage/vitest.config.ts` is the generators' config plus one setup file, `coverage/setup.mjs`, which starts `Profiler.startPreciseCoverage` (call counts, block detail) through `node:inspector` before the generator file and the app's modules load, and dumps the counts and the executed source of every `src/` module after the file's tests.
- vitest runs each module as transformed JavaScript with an inline source map. The tool reads that map, parses the TypeScript source with the `typescript` package, and finds every place V8 counts on its own: each function, each arm of `if`/`else`, `?:`, `case`, a `catch` or `finally`, a loop body, the right side of `&&`, `||`, `??` (and their assignments), and an `if` without `else` whose condition was never false. The count of a block is V8's count at the block's first token in the executed code; counts of several generator files add up.
- Per export of the area's `targets.mjs` (and per vector file the run wrote that no `targets.mjs` names yet), the report gives the function's range, the number of blocks and how many never ran, then each top-level never-run block as `src/…:line:col-line:col`, its kind (`if arm`, `else arm`, `if never false`, `?: true arm`, `case`, `catch`, `loop body`, `nested function`, `&& right side`, with `, a throw` when the arm is a throw), and the first line of its source. Below it, every function of the same module the export calls, directly or through another helper, with its own blocks, or `never entered`. A helper that is itself a target export is reported under its own name.

Limits, stated in the report where they apply:

- Default parameters have no counter in V8; they are listed as not measured. A default that calls a function shows up through that function.
- A block is measured only when the executed code has its first token where the source map points (within a few characters, `undefined` may be `void 0`, a string may change quotes); otherwise it is listed as not measured, never guessed.
- Line coverage of statements that follow a `return` or `throw` inside the same arm is not listed separately; the arm is the unit.
- A value export (`PRODUCTS`) has no code of its own; a target whose module no generator of the run loaded says so.

How to use it: after your cases pass `check.mjs`, run the tool for your area, add cases for what it lists, and run it again. A block no pure input can reach stays: name it in the vector file's note as a gap (`gap: <file:line:col> <kind>, <why>`). Those gaps go into the gate report. The profiler starts in the setup file, before the generator and the app's modules load, so a generator needs nothing for coverage.

## Reading vectors from Rust

For each case: decode `args` by the table under "Encoding" (a `$file` is read from the bundle and its sha256 checked); apply the decode line to the arguments it names; do what the note says `call` does; run the port. When the case has `out`, the result, encoded by the same table, must equal it (objects as maps). When it has `error`, the port must fail with the matching error, the exact `message` and every extra property. `clock` on the decode line sets the port's clock to that instant.
