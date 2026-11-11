import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { SCHEMA_NAMES, SCHEMA_SOURCE, schemaFile, schemaFor } from '../lib/bundle.mjs';
import { compileSchema, formatError } from '../lib/json-schema.mjs';

const DIGEST = 'ab'.repeat(32);
const COMMIT = 'c0ffee'.repeat(6) + 'c0ff';

const load = (name) => JSON.parse(readFileSync(join(SCHEMA_SOURCE, schemaFile(name)), 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));
const edit = (value, change) => {
  const copy = clone(value);
  change(copy);
  return copy;
};

const SAMPLES = {
  manifest: {
    valid: [
      {
        pin: { repo: 'owner/one-launch', commit: COMMIT, version: '1.0.0-beta.3' },
        tooling: { branch: 'oracle-tooling', commit: COMMIT, dirty: false },
        files: { PIN: DIGEST, 'fixtures/launchers/riot/2026-10-07T20-51-16_10006_Riot Client.log': DIGEST },
      },
    ],
    invalid: (ok) => [
      edit(ok, (m) => delete m.pin),
      edit(ok, (m) => (m.pin.commit = 'f25111b')),
      edit(ok, (m) => (m.tooling.branch = 'master')),
      edit(ok, (m) => (m.tooling.dirty = 'no')),
      edit(ok, (m) => (m.files = {})),
      edit(ok, (m) => (m.files.PIN = DIGEST.toUpperCase())),
      edit(ok, (m) => (m.files['fixtures\\db\\a.db'] = DIGEST)),
      edit(ok, (m) => (m.files['../outside'] = DIGEST)),
      edit(ok, (m) => (m.files['/rooted'] = DIGEST)),
      edit(ok, (m) => (m.files['a//b'] = DIGEST)),
      edit(ok, (m) => (m.generatedAt = 'today')),
    ],
  },
  vector: {
    valid: [
      {
        function: 'parseLoginUsers',
        source: 'src/main/launchers/steam/files.ts',
        cases: [
          {
            id: 'fixture-loginusers',
            origin: { kind: 'fixture', ref: 'fixtures/launchers/steam/loginusers.vdf' },
            args: [{ $file: 'fixtures/launchers/steam/loginusers.vdf', sha256: DIGEST }],
            out: [{ steamId: '76561198000000001', accountName: 'user_1', mostRecent: true, extra: { nested: [1, null, 'x'] } }],
          },
          {
            id: 'bom-and-crlf',
            origin: { kind: 'adversarial', ref: 'a byte order mark and CRLF line ends' },
            args: [{ $bytes: '77u/Ig0K' }, { $undefined: true }, { $number: 'NaN' }, { $utf16: [55357] }, { $date: '2026-11-01T18:04:12.000Z' }],
            error: { name: 'Error', message: 'Unexpected end of input', code: 'BAD_VDF' },
          },
        ],
      },
    ],
    invalid: (ok) => [
      edit(ok, (v) => (v.cases = [])),
      edit(ok, (v) => (v.source = 'test/steam-files.test.ts')),
      edit(ok, (v) => delete v.cases[0].origin),
      edit(ok, (v) => (v.cases[0].origin.kind = 'guess')),
      edit(ok, (v) => (v.cases[0].id = 'Has Spaces')),
      edit(ok, (v) => delete v.cases[0].out),
      edit(ok, (v) => (v.cases[0].error = { name: 'Error', message: 'both' })),
      edit(ok, (v) => (v.cases[0].args = [{ $file: 'fixtures/launchers/steam/loginusers.vdf' }])),
      edit(ok, (v) => (v.cases[0].args = [{ $bytes: 'not base64!' }])),
      edit(ok, (v) => (v.cases[0].args = [{ $bytes: 'QUJD', extra: 1 }])),
      edit(ok, (v) => (v.cases[0].out = { nested: { $unknown: 1 } })),
      edit(ok, (v) => (v.cases[1].error = { name: 'Error' })),
      edit(ok, (v) => (v.cases[1].args = [{ $number: '1e999' }])),
    ],
  },
  catalogue: {
    valid: [
      {
        entries: [
          {
            id: 'T-steam-adapter.switch.3f2c9b1e',
            file: 'test/steam-adapter.test.ts',
            suite: ['SteamAdapter', 'switchAccount'],
            name: 'rewrites loginusers and sets AutoLoginUser',
            environment: 'node',
            kind: 'adapter-flow',
            status: 'passed',
            golden: 'tests/goldens/steam-adapter/switch.json',
          },
          {
            id: 'T-0412',
            file: 'test/renderer/library.test.tsx',
            suite: [],
            name: 'sorts by last played',
            environment: 'jsdom',
            kind: 'renderer',
            golden: null,
            waiver: { category: 'web-only', reason: 'asserts React rendering detail' },
          },
        ],
      },
      { entries: [] },
    ],
    invalid: (ok) => [
      edit(ok, (c) => delete c.entries[0].id),
      edit(ok, (c) => (c.entries[0].id = '12')),
      edit(ok, (c) => (c.entries[0].kind = 'unit')),
      edit(ok, (c) => (c.entries[0].environment = 'browser')),
      edit(ok, (c) => (c.entries[0].golden = 'goldens/elsewhere.json')),
      edit(ok, (c) => delete c.entries[1].golden),
      edit(ok, (c) => (c.entries[1].waiver = {})),
      edit(ok, (c) => (c.entries[0].file = 'src/main/index.ts')),
      edit(ok, (c) => (c.entries[0].position = 4)),
    ],
  },
  'replay-script': {
    valid: [
      {
        fake: 'all-four',
        knobs: {},
        steps: [
          { op: 'invoke', channel: 'launch:start', req: { accountId: '@acct:steam:user_3', gameId: '@game:steam:252950', confirmClose: true } },
          { op: 'awaitJob', job: '@job:1', until: { step: 'wait', status: 'running' } },
          { op: 'crash' },
          { op: 'restart' },
          { op: 'snapshot' },
        ],
      },
      { fake: 'none', steps: [{ op: 'invoke', channel: 'launchers:status' }, { op: 'restart', knobs: { quitDuringSwitch: 'quit' } }, { op: 'shutdown' }] },
    ],
    invalid: (ok) => [
      edit(ok, (s) => delete s.fake),
      edit(ok, (s) => (s.steps = [])),
      edit(ok, (s) => (s.steps[0].op = 'click')),
      edit(ok, (s) => delete s.steps[0].channel),
      edit(ok, (s) => (s.steps[0].channel = 'Launch Start')),
      edit(ok, (s) => (s.steps[1].job = 'job-1')),
      edit(ok, (s) => (s.steps[1].until = {})),
      edit(ok, (s) => (s.steps[1].afterMs = 500)),
      edit(ok, (s) => (s.steps[2].knobs = {})),
      edit(ok, (s) => (s.sleepMs = 100)),
    ],
  },
  'replay-expectation': {
    valid: [
      {
        events: [
          { seq: 3, k: 'job', job: '@job:1', state: 'running', steps: [['close', 'running', 'Close Steam', '']] },
          { seq: 4, k: 'plat', op: 'proc.close', image: 'steam.exe' },
          { seq: 5, k: 'plat', op: 'file.write', path: '{launchers}\\steam\\config\\loginusers.vdf', sha256: DIGEST },
          { seq: 6, k: 'plat', op: 'reg.set', path: 'HKCU\\Software\\Valve\\Steam\\AutoLoginUser', value: 'user_3' },
          { seq: 7, k: 'ipc', channel: 'launch:status' },
        ],
        final: {
          db: {
            user_version: 5,
            tables: { accounts: [{ id: '@acct:steam:user_3', created_at: '<ts>', secret_enc: { present: true, plaintextSha256: DIGEST } }] },
          },
          journal: null,
          backups: {},
          launcherFiles: {},
          log: { warn: [], error: [] },
        },
      },
    ],
    invalid: (ok) => [
      edit(ok, (e) => delete e.final),
      edit(ok, (e) => delete e.events[0].seq),
      edit(ok, (e) => (e.events[0].seq = 1.5)),
      edit(ok, (e) => delete e.events[0].state),
      edit(ok, (e) => (e.events[0].job = 'a random id')),
      edit(ok, (e) => (e.events[0].steps = [['close', 'running', 'Close Steam']])),
      edit(ok, (e) => delete e.events[1].op),
      edit(ok, (e) => (e.events[2].sha256 = 'abc')),
      edit(ok, (e) => (e.events[1].k = 'Plat')),
      edit(ok, (e) => delete e.final.log.error),
      edit(ok, (e) => (e.final.db.user_version = '5')),
      edit(ok, (e) => (e.final.db.tables.accounts = { rows: [] })),
      edit(ok, (e) => delete e.final.journal),
    ],
  },
  'layout-sidecar': {
    valid: [
      {
        id: 72,
        viewport: [1280, 800],
        dpr: 1,
        locale: 'en-US',
        tz: 'UTC',
        focus: 'button:Close Steam and continue',
        text: [{ t: 'Close Steam and continue', box: [412, 318, 356, 20], font: ['Segoe UI Variable Text', 14, 400, 20.3], color: '#e8eaf0', volatile: false }],
        elements: [
          {
            role: 'button',
            name: 'Close Steam and continue',
            ord: 0,
            box: [400, 310, 380, 36],
            state: { disabled: false, checked: null, expanded: null },
            style: { bg: '#8b5cf6', radius: 8, padding: [8, 14, 8, 14] },
            cls: 'btn btn-primary',
          },
        ],
        scroll: { top: 0 },
      },
    ],
    invalid: (ok) => [
      edit(ok, (s) => delete s.tz),
      edit(ok, (s) => (s.id = 0)),
      edit(ok, (s) => (s.viewport = [1280])),
      edit(ok, (s) => (s.viewport = [1280, 800, 1])),
      edit(ok, (s) => (s.text[0].box = [1, 2, 3])),
      edit(ok, (s) => (s.text[0].box = [1, 2, -3, 4])),
      edit(ok, (s) => (s.text[0].color = 'rgb(232, 234, 240)')),
      edit(ok, (s) => (s.text[0].font = ['Segoe UI', '14px', 400, 20])),
      edit(ok, (s) => delete s.text[0].volatile),
      edit(ok, (s) => (s.elements[0].ord = -1)),
      edit(ok, (s) => (s.elements[0].state.checked = 'yes')),
      edit(ok, (s) => delete s.elements[0].state.disabled),
      edit(ok, (s) => (s.elements[0].box = [])),
      edit(ok, (s) => (s.locale = 'English')),
    ],
  },
  'triage-linkage': {
    valid: [
      {
        rows: [
          { id: 'S11.1-01', decision: 'drop', affects: [] },
          {
            id: 'X-07',
            decision: 'fix',
            affects: [
              { artefact: 'l2/expected/play-steam.json', ids: ['events/4'], how: 'marked' },
              { artefact: 'l1/steam/parseVdf.json', how: 'regenerated' },
            ],
          },
        ],
      },
    ],
    invalid: (ok) => [
      edit(ok, (t) => delete t.rows),
      edit(ok, (t) => (t.rows[0].decision = 'keep')),
      edit(ok, (t) => (t.rows[0].id = 'eleven')),
      edit(ok, (t) => delete t.rows[0].affects),
      edit(ok, (t) => (t.rows[1].affects[0].how = 'ignored')),
      edit(ok, (t) => (t.rows[1].affects[0].ids = [])),
      edit(ok, (t) => (t.rows[1].affects[0].ids = ['events/4', 'events/4'])),
      edit(ok, (t) => (t.rows[1].affects[1].artefact = 'l1\\steam\\parseVdf.json')),
      edit(ok, (t) => delete t.rows[1].affects[1].how),
    ],
  },
};

// ajv is not a dependency of this repo; when another package happens to bring it, it serves as a second opinion.
const ajv = await import('ajv/dist/2020.js').then(
  (mod) => new (typeof mod.default === 'function' ? mod.default : mod.default.default)({ strict: false, strictSchema: true, allErrors: true }),
  () => null,
);

describe('the oracle schemas', () => {
  test('one schema file per artefact kind, and nothing else', () => {
    expect(readdirSync(SCHEMA_SOURCE).sort()).toEqual(SCHEMA_NAMES.map(schemaFile).sort());
    expect(Object.keys(SAMPLES).sort()).toEqual([...SCHEMA_NAMES].sort());
  });

  test.each(SCHEMA_NAMES)('%s compiles, declares its dialect and describes itself', (name) => {
    const schema = load(name);
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.title).toEqual(expect.any(String));
    expect(schema.description).toEqual(expect.any(String));
    expect(() => compileSchema(schema)).not.toThrow();
  });

  test.each(SCHEMA_NAMES)('%s accepts the documented shape', (name) => {
    const validate = compileSchema(load(name));
    for (const sample of SAMPLES[name].valid) expect(validate(sample).map(formatError)).toEqual([]);
  });

  test.each(SCHEMA_NAMES)('%s refuses each broken variant', (name) => {
    const validate = compileSchema(load(name));
    const broken = SAMPLES[name].invalid(SAMPLES[name].valid[0]);
    expect(broken.length).toBeGreaterThan(5);
    broken.forEach((sample, i) => expect(validate(sample).length, `variant ${i} of ${name} was accepted`).toBeGreaterThan(0));
  });

  test.skipIf(ajv === null).each(SCHEMA_NAMES)('%s: a full JSON Schema validator agrees on every sample', (name) => {
    const reference = ajv.compile(load(name));
    const validate = compileSchema(load(name));
    const samples = [...SAMPLES[name].valid, ...SAMPLES[name].invalid(SAMPLES[name].valid[0])];
    samples.forEach((sample, i) => expect(validate(sample).length === 0, `sample ${i} of ${name}`).toBe(reference(sample)));
  });
});

describe('schemaFor', () => {
  test('maps bundle paths to their artefact kind', () => {
    expect(schemaFor('MANIFEST.json')).toBe('manifest');
    expect(schemaFor('l1/steam/parseVdf.json')).toBe('vector');
    expect(schemaFor('tests/catalogue.json')).toBe('catalogue');
    expect(schemaFor('l2/scripts/play-all.json')).toBe('replay-script');
    expect(schemaFor('l2/expected/play-all.json')).toBe('replay-expectation');
    expect(schemaFor('ui/shots/072-confirm-close.layout.json')).toBe('layout-sidecar');
    expect(schemaFor('triage-linkage.json')).toBe('triage-linkage');
  });

  test('leaves everything else without a schema', () => {
    for (const path of ['PIN', 'SCREENSHOTS.md', 'fixtures/settings/settings-defaults.json', 'schemas/vector.schema.json', 'tests/goldens/steam/switch.json'])
      expect(schemaFor(path)).toBeNull();
    for (const path of ['l2/updates/up-to-date.json', 'ui/shots/072-confirm-close.png', 'fixtures/MANIFEST.json', 'l1/steam/README.md'])
      expect(schemaFor(path)).toBeNull();
  });
});
