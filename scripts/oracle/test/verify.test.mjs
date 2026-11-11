import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { MANIFEST, SCHEMA_SOURCE, buildManifest } from '../lib/bundle.mjs';
import { jsonText } from '../lib/out.mjs';
import { fingerprint, verifyBundle } from '../verify.mjs';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const COMMIT = 'c0ffee'.repeat(6) + 'c0ff';
const TOOLING = { branch: 'oracle-tooling', commit: COMMIT, dirty: false };
const PLANTED_HEX = sha256('a planted value');
const PLANTED_ID = [PLANTED_HEX.slice(0, 8), PLANTED_HEX.slice(8, 12), PLANTED_HEX.slice(12, 16), PLANTED_HEX.slice(16, 20), PLANTED_HEX.slice(20, 32)].join(
  '-',
);
// Built from pieces so this file holds no user folder for the repo's own secret scan to find.
const NAME = ['mor', 'gan', 'f'].join('');
const USER_FOLDER = ['C:', 'Users', NAME, 'AppData', 'Roaming', 'OneLaunch'].join('\\');
const stranger = { username: '', host: '', folders: [] };

const made = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeBundle(files = {}) {
  const out = mkdtempSync(join(tmpdir(), 'oracle-verify-'));
  made.push(out);
  const bundle = {
    out,
    write(rel, data) {
      const target = join(out, rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, typeof data === 'string' || data instanceof Uint8Array ? data : jsonText(data));
      return bundle;
    },
    remove(rel) {
      rmSync(join(out, rel));
      return bundle;
    },
    seal(change = (manifest) => manifest) {
      rmSync(join(out, MANIFEST), { force: true });
      return bundle.write(MANIFEST, change(buildManifest(out, TOOLING)));
    },
    verify(options = {}) {
      const allowFile = join(out, '..', `${out.split(/[\\/]/).pop()}.allow`);
      made.push(allowFile);
      writeFileSync(allowFile, (options.allow ?? []).join('\n'));
      return verifyBundle({
        out,
        identity: options.identity ?? stranger,
        repoAllow: new Set(),
        bundleAllow: allowFile,
        allowDirty: options.allowDirty ?? false,
      });
    },
  };
  bundle.write('PIN', `repo = owner/one-launch\ncommit = ${COMMIT}\nversion = 1.0.0-beta.3\ndescribes = a commit that does not exist\n`);
  bundle.write('SCREENSHOTS.md', '# Shots\n');
  bundle.write('fixtures/launchers/steam/loginusers.vdf', '"users"\r\n{\r\n}\r\n');
  bundle.write('fixtures/db/onelaunch-empty-v5.db', Buffer.from([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0, 1, 2, 3, 0xff]));
  cpSync(SCHEMA_SOURCE, join(out, 'schemas'), { recursive: true });
  for (const [rel, data] of Object.entries(files)) bundle.write(rel, data);
  return bundle.seal();
}

const failed = (result) => result.checks.filter((check) => !check.ok).map((check) => check.name);
const problems = (result, name) => result.checks.find((check) => check.name === name).problems;

const VDF = 'fixtures/launchers/steam/loginusers.vdf';
const vector = (args) => ({
  function: 'parseLoginUsers',
  source: 'src/main/launchers/steam/files.ts',
  cases: [{ id: 'fixture', origin: { kind: 'fixture', ref: VDF }, args, out: [] }],
});
const expectation = (seqs = [1, 2]) => ({
  events: seqs.map((seq) => ({ seq, k: 'plat', op: 'proc.close', image: 'steam.exe' })),
  final: { db: { user_version: 5, tables: {} }, journal: null, backups: {}, launcherFiles: {}, log: { warn: [], error: [] } },
});
const script = { fake: 'all-four', steps: [{ op: 'snapshot' }] };
const sidecar = (text) => ({ id: 72, viewport: [1280, 800], dpr: 1, locale: 'en-US', tz: 'UTC', focus: null, text, elements: [] });
const run = (t) => ({ t, box: [0, 0, 10, 10], font: ['Segoe UI', 14, 400, 20], color: '#e8eaf0', volatile: false });
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);

describe('verifyBundle', () => {
  test('a sealed bundle passes every check', () => {
    const result = makeBundle().verify();
    expect(result.checks.map((check) => check.name)).toEqual(['schemas', 'artefacts', 'manifest', 'secrets', 'user paths']);
    expect(failed(result)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test('a bundle with one artefact of every kind passes', () => {
    const bundle = makeBundle({
      'l1/steam/parseLoginUsers.json': vector([{ $file: VDF, sha256: sha256('"users"\r\n{\r\n}\r\n') }]),
      'tests/catalogue.json': {
        entries: [
          {
            id: 'T-1',
            file: 'test/steam-adapter.test.ts',
            suite: [],
            name: 'switches',
            environment: 'node',
            kind: 'adapter-flow',
            golden: 'tests/goldens/steam/switch.json',
          },
        ],
      },
      'tests/goldens/steam/switch.json': [{ method: 'switchAccount', result: { ok: true } }],
      'l2/scripts/play-steam.json': script,
      'l2/expected/play-steam.json': expectation(),
      'ui/shots/072-confirm-close.png': PNG,
      'ui/shots/072-confirm-close.layout.json': sidecar([run('Close Steam and continue')]),
      'triage-linkage.json': { rows: [{ id: 'X-07', decision: 'fix', affects: [{ artefact: 'l2/expected/play-steam.json', how: 'marked' }] }] },
    });
    const result = bundle.verify();
    expect(result.checks.flatMap((check) => check.problems)).toEqual([]);
    expect(result.checks.find((check) => check.name === 'artefacts').summary).toBe('7 valid against their schema, 13 without one');
  });

  describe('manifest', () => {
    test('a changed file', () => {
      const result = makeBundle().write(VDF, '"users"\n{\n}\n').verify();
      expect(failed(result)).toEqual(['manifest']);
      expect(problems(result, 'manifest')).toEqual([`${VDF}: sha256 is not the manifest's`]);
    });

    test('a file added after sealing, and one removed', () => {
      const result = makeBundle().write('fixtures/extra.txt', 'x').remove('SCREENSHOTS.md').verify();
      expect(problems(result, 'manifest')).toEqual(['fixtures/extra.txt: not in the manifest', 'SCREENSHOTS.md: in the manifest, not in the bundle']);
    });

    test('no manifest at all', () => {
      const result = makeBundle().remove(MANIFEST).verify();
      expect(problems(result, 'manifest')).toEqual([`${MANIFEST} is missing; run manifest.mjs`]);
    });

    test('a pin that is not the one in PIN', () => {
      const result = makeBundle()
        .seal((manifest) => ({ ...manifest, pin: { ...manifest.pin, commit: 'd'.repeat(40) } }))
        .verify();
      expect(problems(result, 'manifest')).toEqual(['pin.commit is not what PIN says']);
    });

    test('written from uncommitted tooling: refused, unless asked for', () => {
      const bundle = makeBundle().seal((manifest) => ({ ...manifest, tooling: { ...TOOLING, dirty: true } }));
      expect(problems(bundle.verify(), 'manifest')).toEqual(['written from an uncommitted tooling tree; commit the tooling and run manifest.mjs again']);
      expect(bundle.verify({ allowDirty: true }).ok).toBe(true);
    });

    test('a manifest that does not fit its schema', () => {
      const result = makeBundle()
        .seal((manifest) => ({ ...manifest, tooling: { ...TOOLING, branch: 'master' } }))
        .verify();
      expect(problems(result, 'artefacts')).toEqual([`${MANIFEST}: /tooling/branch expected exactly "oracle-tooling"`]);
      expect(failed(result)).toEqual(['artefacts']);
    });
  });

  describe('schemas', () => {
    test('a bundle schema that drifted from the tooling', () => {
      const bundle = makeBundle();
      const edited = readFileSync(join(bundle.out, 'schemas/vector.schema.json'), 'utf8').replace('"minItems": 1', '"minItems": 0');
      const result = bundle.write('schemas/vector.schema.json', edited).seal().verify();
      expect(failed(result)).toEqual(['schemas']);
      expect(problems(result, 'schemas')).toEqual(["schemas/vector.schema.json differs from the tooling's schema; run emit-schemas.mjs"]);
    });

    test('a missing schema and a stray one', () => {
      const result = makeBundle().remove('schemas/catalogue.schema.json').write('schemas/extra.schema.json', {}).seal().verify();
      expect(problems(result, 'schemas')).toEqual([
        'schemas/catalogue.schema.json is missing from the bundle; run emit-schemas.mjs',
        'schemas/extra.schema.json: not a schema the tooling has',
      ]);
    });
  });

  describe('artefacts', () => {
    test('a vector that does not fit the schema names the place', () => {
      const broken = vector([]);
      delete broken.cases[0].origin;
      const result = makeBundle({ 'l1/steam/parseLoginUsers.json': broken }).verify();
      expect(failed(result)).toEqual(['artefacts']);
      expect(problems(result, 'artefacts')).toEqual(['l1/steam/parseLoginUsers.json: /cases/0 missing "origin"']);
    });

    test('an artefact that is not JSON, or starts with a byte order mark', () => {
      const result = makeBundle({ 'l1/a.json': '{"function":', 'l1/b.json': `\ufeff${JSON.stringify(vector([]))}` }).verify();
      expect(problems(result, 'artefacts')).toHaveLength(2);
      expect(problems(result, 'artefacts')[1]).toBe('l1/b.json: starts with a byte order mark');
    });

    test('a $file that is not in the bundle, or has another hash', () => {
      const missing = makeBundle({ 'l1/x.json': vector([{ $file: 'fixtures/nowhere.vdf', sha256: sha256('x') }]) }).verify();
      expect(problems(missing, 'artefacts')).toEqual(['l1/x.json: $file fixtures/nowhere.vdf is not in the bundle']);
      const stale = makeBundle({ 'l1/x.json': vector([{ $file: VDF, sha256: sha256('an older copy') }]) }).verify();
      expect(problems(stale, 'artefacts')).toEqual([`l1/x.json: $file ${VDF} has another sha256`]);
    });

    test('case ids and catalogue ids used twice', () => {
      const twice = vector([]);
      twice.cases.push({ ...twice.cases[0] });
      const entry = { id: 'T-1', file: 'test/a.test.ts', suite: [], name: 'a', environment: 'node', kind: 'pure', golden: null };
      const result = makeBundle({
        'l1/x.json': twice,
        'tests/catalogue.json': { entries: [entry, { ...entry, name: 'b', golden: 'tests/goldens/b.json' }] },
      }).verify();
      expect(problems(result, 'artefacts')).toEqual([
        'l1/x.json: case id fixture is used twice',
        'tests/catalogue.json: id T-1 is used twice',
        'tests/catalogue.json: T-1 names a golden that is not in the bundle',
      ]);
    });

    test('a script without its expectation, and events out of order', () => {
      const result = makeBundle({ 'l2/scripts/stop.json': script, 'l2/scripts/play.json': script, 'l2/expected/play.json': expectation([4, 4, 3]) }).verify();
      expect(problems(result, 'artefacts')).toEqual([
        'l2/expected/play.json: events/1 seq does not rise',
        'l2/expected/play.json: events/2 seq does not rise',
        'l2/scripts/stop.json: no expectation at l2/expected/stop.json',
      ]);
    });

    test('a shot without a sidecar, a sidecar without a shot, an expectation without a script', () => {
      const result = makeBundle({ 'ui/shots/001-a.png': PNG, 'ui/shots/002-b.layout.json': sidecar([]), 'l2/expected/lost.json': expectation() }).verify();
      expect(problems(result, 'artefacts')).toEqual([
        'l2/expected/lost.json: no script at l2/scripts/lost.json',
        'ui/shots/002-b.layout.json: no shot at ui/shots/002-b.png',
        'ui/shots/001-a.png: no layout sidecar beside it',
      ]);
    });

    test('a triage row that names an artefact the bundle does not have', () => {
      const row = { id: 'X-07', decision: 'drop', affects: [{ artefact: 'l1/steam/gone.json', how: 'regenerated' }] };
      const result = makeBundle({ 'triage-linkage.json': { rows: [row, row] } }).verify();
      expect(problems(result, 'artefacts')).toEqual([
        'triage-linkage.json: row X-07 appears twice',
        'triage-linkage.json: X-07 names l1/steam/gone.json, which is not in the bundle',
        'triage-linkage.json: X-07 names l1/steam/gone.json, which is not in the bundle',
      ]);
    });
  });

  describe('secrets', () => {
    test('an id that is not a placeholder fails, masked', () => {
      const result = makeBundle({ 'tests/goldens/a.json': { accountId: PLANTED_ID } }).verify();
      expect(failed(result)).toEqual(['secrets']);
      expect(problems(result, 'secrets')).toEqual([`tests/goldens/a.json:2  uuid  ${PLANTED_ID.slice(0, 4)}…${PLANTED_ID.slice(-2)}`]);
      expect(JSON.stringify(result)).not.toContain(PLANTED_ID);
    });

    test('an id in a file name fails too, and no message spells the name out', () => {
      const result = makeBundle({ [`fixtures/artwork/${PLANTED_ID}/grid.jpg`]: PNG }).verify();
      const masked = `${PLANTED_ID.slice(0, 4)}…${PLANTED_ID.slice(-2)}`;
      const shown = `fixtures/artwork/${PLANTED_ID[0]}…(36 chars)/grid.jpg`;
      expect(problems(result, 'secrets')).toEqual([`MANIFEST.json:15  uuid  ${masked}`, `${shown}: its name  uuid  ${masked}`]);
      expect(JSON.stringify(result)).not.toContain(PLANTED_ID);
      const renamed = makeBundle().write(`fixtures/artwork/${PLANTED_ID}/grid.jpg`, PNG).verify();
      expect(problems(renamed, 'manifest')).toEqual([`${shown}: not in the manifest`]);
      expect(JSON.stringify(renamed)).not.toContain(PLANTED_ID);
    });

    test('its fingerprint in the bundle allowlist lets it through', () => {
      const bundle = makeBundle({ 'tests/goldens/a.json': { accountId: PLANTED_ID } });
      expect(bundle.verify({ allow: ['# a made-up id', fingerprint(PLANTED_ID)] }).ok).toBe(true);
      expect(bundle.verify({ allow: [fingerprint('another value')] }).ok).toBe(false);
    });

    test('a 64-character hex value fails unless it is the hash of a bundle file or sits in a digest field', () => {
      const digest = sha256('"users"\r\n{\r\n}\r\n');
      const fine = makeBundle({
        'fixtures/backup/manifest.json': { files: [{ relative: 'config/loginusers.vdf', sha256: digest }] },
        'notes.txt': `loginusers is ${digest}\n`,
        'l2/scripts/play.json': script,
        'l2/expected/play.json': { ...expectation(), events: [{ seq: 1, k: 'plat', op: 'file.write', path: '{launchers}\\a', sha256: PLANTED_HEX }] },
      }).verify();
      expect(failed(fine)).toEqual([]);
      const leaked = makeBundle({ 'notes.txt': `session ${PLANTED_HEX}\n` }).verify();
      expect(problems(leaked, 'secrets')).toEqual([`notes.txt:1  hex64  ${PLANTED_HEX.slice(0, 4)}…${PLANTED_HEX.slice(-2)}`]);
    });

    test('an email outside the placeholder domains fails; binary files are not line-scanned', () => {
      const address = ['someone', ['mail', 'provider', 'net'].join('.')].join('@');
      const result = makeBundle({
        'fixtures/a.log': `login ${address}\n`,
        'fixtures/b.db': Buffer.concat([Buffer.from([0, 1]), Buffer.from(address)]),
      }).verify();
      expect(problems(result, 'secrets')).toHaveLength(1);
      expect(problems(result, 'secrets')[0]).toMatch(/^fixtures\/a\.log:1 {2}email {2}/);
    });
  });

  describe('user paths', () => {
    test('a user folder in a text file, in a binary file and in a file name', () => {
      const result = makeBundle({
        'fixtures/a.log': `dataDir ${USER_FOLDER}\n`,
        'fixtures/b.db': Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(USER_FOLDER, 'utf16le')]),
        [`fixtures/${NAME}/c.txt`]: 'x',
      }).verify({ identity: { username: NAME, host: '', folders: [] } });
      expect(failed(result)).toEqual(['secrets', 'user paths']);
      expect(problems(result, 'user paths')).toEqual([
        'MANIFEST.json  user-name  m…(7 chars)',
        'fixtures/a.log  user-folder  m…(7 chars)',
        'fixtures/a.log  user-name  m…(7 chars)',
        'fixtures/b.db  user-folder  m…(7 chars)',
        'fixtures/b.db  user-name  m…(7 chars)',
        'fixtures/m…(7 chars)/c.txt: its name  user-name  m…(7 chars)',
      ]);
    });

    test('placeholder user folders pass', () => {
      const result = makeBundle({
        'fixtures/a.json': { source: 'C:\\Users\\<user>\\AppData\\Local\\EpicGamesLauncher', log: 'C:/Users/Placeholder/AppData' },
      }).verify();
      expect(failed(result)).toEqual([]);
    });

    test('text shown in a shot is checked through its sidecar', () => {
      const result = makeBundle({
        'ui/shots/150-advanced.png': PNG,
        'ui/shots/150-advanced.layout.json': sidecar([run(`Data folder: ${USER_FOLDER}`)]),
      }).verify();
      expect(problems(result, 'user paths')).toContain('ui/shots/150-advanced.layout.json: text in the shot  user-folder  m…(7 chars)');
    });
  });
});
