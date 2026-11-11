import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { Aliases, MS, TS, createNormaliser, measureVolatile, normaliseRuns } from '../lib/normalise.mjs';

const vault = {
  encrypt: (plaintext) => Buffer.from(Buffer.from(plaintext, 'utf8').map((b) => b ^ 0x5a)),
  decrypt: (ciphertext) => Buffer.from(ciphertext.map((b) => b ^ 0x5a)).toString('utf8'),
};
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const ROOT = 'D:\\Scratch Space\\onelaunch-drive-AbC123';
const roots = { launchers: `${ROOT}\\launchers`, data: `${ROOT}\\data` };

describe('Aliases', () => {
  test('names accounts and games after what they are', () => {
    const aliases = new Aliases();
    expect(aliases.account(randomUUID(), 'steam', 'user_3')).toBe('@acct:steam:user_3');
    expect(aliases.account(randomUUID(), 'epic', 'main@example.com')).toBe('@acct:epic:main@example.com');
    expect(aliases.game(randomUUID(), 'steam', '252950')).toBe('@game:steam:252950');
    expect(aliases.game(randomUUID(), 'riot', 'valorant.live')).toBe('@game:riot:valorant.live');
  });

  test('numbers jobs in order, and backups in order per launcher', () => {
    const aliases = new Aliases();
    const [first, second] = [randomUUID(), randomUUID()];
    expect(aliases.job(first)).toBe('@job:1');
    expect(aliases.job(second)).toBe('@job:2');
    expect(aliases.job(first)).toBe('@job:1');
    expect(aliases.backup('2026-11-05T19-40-12.345Z', 'steam')).toBe('@backup:steam:1');
    expect(aliases.backup('2026-11-05T19-40-13.001Z', 'epic')).toBe('@backup:epic:1');
    expect(aliases.backup('2026-11-05T19-41-00.000Z', 'steam')).toBe('@backup:steam:2');
    expect(aliases.size).toBe(5);
  });

  test('a custom kind works like the named ones', () => {
    const aliases = new Aliases();
    expect(aliases.sequence('launch', randomUUID())).toBe('@launch:1');
    expect(aliases.named('session', randomUUID(), 'epic', 'alt@example.com')).toBe('@session:epic:alt@example.com');
  });

  test('refuses anything that would make two ids look the same, or one id look like two', () => {
    const aliases = new Aliases();
    const id = randomUUID();
    aliases.account(id, 'steam', 'user_3');
    expect(aliases.account(id, 'steam', 'user_3')).toBe('@acct:steam:user_3');
    expect(() => aliases.account(randomUUID(), 'steam', 'user_3')).toThrow(/already names another id/);
    expect(() => aliases.account(id, 'steam', 'user_1')).toThrow(/already aliased/);
    expect(() => aliases.job(id)).toThrow(/already aliased/);
    aliases.backup('2026-11-05T19-40-12.345Z', 'steam');
    expect(() => aliases.backup('2026-11-05T19-40-12.345Z', 'epic')).toThrow(/already aliased/);
  });

  test('refuses ids too short to replace safely and malformed aliases', () => {
    const aliases = new Aliases();
    expect(() => aliases.job('7')).toThrow(/at least 8 characters/);
    expect(() => aliases.set(randomUUID(), 'job:1')).toThrow(/not an alias/);
    expect(() => aliases.named('acct', randomUUID(), 'steam', '')).toThrow(/non-empty/);
    expect(() => aliases.named('acct', randomUUID())).toThrow(/non-empty/);
  });

  test('replaces whole ids only, the longest first', () => {
    const aliases = new Aliases();
    const id = randomUUID();
    aliases.account(id, 'steam', 'user_3');
    aliases.set(`${id}-extended`, '@x:long');
    expect(aliases.apply(`a ${id} b ${id}-extended c`)).toBe('a @acct:steam:user_3 b @x:long c');
    expect(aliases.apply(`ff${id}`)).toBe(`ff${id}`);
    expect(aliases.apply(`artwork/${id}/grid.jpg`)).toBe('artwork/@acct:steam:user_3/grid.jpg');
    expect(aliases.get(id)).toBe('@acct:steam:user_3');
    expect(aliases.get(randomUUID())).toBeNull();
  });
});

describe('scratch roots', () => {
  const { text } = createNormaliser({ roots });
  const lower = roots.launchers.toLowerCase().replace(/\\/g, '/');
  const doubled = roots.launchers.replace(/\\/g, '\\\\');

  test('raw', () => {
    expect(text(`${roots.launchers}\\steam\\config\\loginusers.vdf`)).toBe('{launchers}\\steam\\config\\loginusers.vdf');
    expect(text(roots.data)).toBe('{data}');
  });

  test('lower-case with forward slashes', () => {
    expect(text(`${lower}/steam/steamapps`)).toBe('{launchers}/steam/steamapps');
  });

  test('VDF-escaped', () => {
    expect(text(`"path"\t\t"${doubled}\\\\steam"`)).toBe('"path"\t\t"{launchers}\\\\steam"');
  });

  test('JSON-escaped, as written and with escaped forward slashes', () => {
    const json = JSON.stringify({ source: `${roots.launchers}\\epic\\GameUserSettings.ini` });
    expect(text(json)).toBe('{"source":"{launchers}\\\\epic\\\\GameUserSettings.ini"}');
    expect(text(roots.launchers.replace(/\\/g, '\\/'))).toBe('{launchers}');
  });

  test('JSON inside JSON', () => {
    const nested = JSON.stringify({ meta: JSON.stringify({ file: `${roots.data}\\switch.json` }) });
    expect(text(nested)).not.toContain('Scratch');
    expect(text(nested)).toContain('{data}');
  });

  test('every occurrence in one string, whatever the drive letter case', () => {
    expect(text(`copy ${roots.data}\\a to d${roots.launchers.slice(1)}\\b`)).toBe('copy {data}\\a to {launchers}\\b');
  });

  test('a folder that only starts with the root is left alone', () => {
    expect(text(`${roots.data}-old\\x`)).toBe(`${roots.data}-old\\x`);
    expect(text(`${roots.data}2\\x`)).toBe(`${roots.data}2\\x`);
  });

  test('the longer of two nested roots wins', () => {
    const nested = createNormaliser({ roots: { scratch: ROOT, data: roots.data } });
    expect(nested.text(`${roots.data}\\logs and ${ROOT}\\other`)).toBe('{data}\\logs and {scratch}\\other');
  });

  test('refuses a root that is not an absolute Windows path, and a badly named one', () => {
    expect(() => createNormaliser({ roots: { data: 'relative\\data' } })).toThrow(/absolute Windows path/);
    expect(() => createNormaliser({ roots: { 'data dir': roots.data } })).toThrow(/letters only/);
  });
});

describe('createNormaliser', () => {
  test('aliases ids in values and in keys, and reports where', () => {
    const aliases = new Aliases();
    const account = randomUUID();
    const job = randomUUID();
    aliases.account(account, 'steam', 'user_3');
    aliases.job(job);
    const normaliser = createNormaliser({ aliases });
    const out = normaliser.normalise({ events: [{ k: 'job', job, account: { id: account } }], byAccount: { [account]: { jobs: [job] } } });
    expect(out).toEqual({
      events: [{ k: 'job', job: '@job:1', account: { id: '@acct:steam:user_3' } }],
      byAccount: { '@acct:steam:user_3': { jobs: ['@job:1'] } },
    });
    expect(normaliser.fields()).toEqual([
      { path: '/byAccount/@acct:steam:user_3', rule: 'key' },
      { path: '/byAccount/@acct:steam:user_3/jobs/*', rule: 'alias' },
      { path: '/events/*/account/id', rule: 'alias' },
      { path: '/events/*/job', rule: 'alias' },
    ]);
  });

  test('two keys that normalise to one name are an error, not a silent merge', () => {
    const normaliser = createNormaliser({ roots });
    expect(() => normaliser.normalise({ [roots.data]: 1, [roots.data.toLowerCase()]: 2 })).toThrow(/same name/);
  });

  test('leaves timestamps and timings alone unless their path was measured to vary', () => {
    const value = { startedAt: '2026-11-05T19:30:00.000Z', timing: { signInMs: 2000 }, steps: [{ ms: 12 }] };
    expect(createNormaliser().normalise(value)).toEqual(value);
    const normaliser = createNormaliser({ volatile: ['/startedAt', '/steps/*/ms'] });
    expect(normaliser.normalise(value)).toEqual({ startedAt: TS, timing: { signInMs: 2000 }, steps: [{ ms: MS }] });
    expect(normaliser.fields()).toEqual([
      { path: '/startedAt', rule: 'ts' },
      { path: '/steps/*/ms', rule: 'ms' },
    ]);
  });

  test('replaces each timestamp inside a longer string, in both spellings', () => {
    const normaliser = createNormaliser({ volatile: ['/line', '/file', '/plain'] });
    expect(
      normaliser.normalise({
        line: '2026-11-05T19:30:00.123Z INFO  [main] exit after 2026-11-05T19:29:58Z',
        file: 'backups\\db\\onelaunch-2026-11-05T19-30-00.123Z.db',
        plain: 'no stamp here',
      }),
    ).toEqual({ line: `${TS} INFO  [main] exit after ${TS}`, file: `backups\\db\\onelaunch-${TS}.db`, plain: 'no stamp here' });
  });

  test('a number that varies is only <ms> under a millisecond key', () => {
    const normaliser = createNormaliser({ volatile: ['/pid', '/elapsedMs', '/wait_ms', '/ms', '/items'] });
    expect(normaliser.normalise({ pid: 4242, elapsedMs: 31, wait_ms: 5, ms: 1, items: 3 })).toEqual({
      pid: 4242,
      elapsedMs: MS,
      wait_ms: MS,
      ms: MS,
      items: 3,
    });
  });

  test('projects *_enc values through the vault, and null as absent', () => {
    const normaliser = createNormaliser({ vault });
    const row = { login: 'user_3', secret_enc: vault.encrypt('pw-three'), blob_enc: JSON.parse(JSON.stringify(vault.encrypt('{"v":1}'))), value_enc: null };
    expect(normaliser.normalise({ accounts: [row] })).toEqual({
      accounts: [
        {
          login: 'user_3',
          secret_enc: { present: true, plaintextSha256: sha256('pw-three') },
          blob_enc: { present: true, plaintextSha256: sha256('{"v":1}') },
          value_enc: { present: false, plaintextSha256: null },
        },
      ],
    });
    expect(normaliser.fields().map((field) => field.rule)).toEqual(['enc', 'enc', 'enc']);
  });

  test('an *_enc value needs the vault and must be bytes; bytes anywhere else are refused', () => {
    expect(() => createNormaliser().normalise({ secret_enc: Buffer.from('x') })).toThrow(/needs the harness vault/);
    expect(() => createNormaliser({ vault }).normalise({ secret_enc: 'cGxhaW4=' })).toThrow(/bytes or null/);
    expect(() => createNormaliser({ vault }).normalise({ icon: Buffer.from('x') })).toThrow(/not a JSON value/);
  });

  test('refuses what JSON cannot hold, and drops undefined properties as JSON does', () => {
    expect(() => createNormaliser().normalise({ at: new Date(0) })).toThrow(/not a JSON value/);
    expect(() => createNormaliser().normalise({ n: Number.NaN })).toThrow(/not a JSON number/);
    expect(() => createNormaliser().normalise({ f: () => 1 })).toThrow(/not a JSON value/);
    expect(createNormaliser().normalise({ a: 1, b: undefined })).toEqual({ a: 1 });
  });

  test('does not change its input', () => {
    const input = { path: `${roots.data}\\switch.json`, list: [{ at: '2026-11-05T19:30:00.000Z' }] };
    const before = JSON.stringify(input);
    createNormaliser({ roots, volatile: ['/list/*/at'] }).normalise(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe('measureVolatile', () => {
  test('lists the paths whose values differ, with array positions folded', () => {
    const a = {
      id: 1,
      events: [
        { at: 'x', op: 'close' },
        { at: 'y', op: 'start' },
      ],
      nested: { 'a/b': 1 },
    };
    const b = {
      id: 1,
      events: [
        { at: 'x', op: 'close' },
        { at: 'z', op: 'start' },
      ],
      nested: { 'a/b': 2 },
    };
    expect(measureVolatile([a, b, a])).toEqual({ volatile: ['/events/*/at', '/nested/a~1b'], structural: [] });
  });

  test('reports a differing shape apart from a differing value', () => {
    const a = { list: [1, 2], finishedAt: null, table: { x: 1 }, bytes: Buffer.from('a') };
    const b = { list: [1], finishedAt: 'later', table: { y: 1 }, bytes: Buffer.from('b') };
    expect(measureVolatile([a, b])).toEqual({ volatile: ['/bytes'], structural: ['/finishedAt', '/list', '/table'] });
  });

  test('needs two recordings', () => {
    expect(() => measureVolatile([{}])).toThrow(/at least two/);
  });
});

function recording(seed) {
  const scratch = `D:\\Scratch Space\\onelaunch-drive-${seed}`;
  const account = randomUUID();
  const job = randomUUID();
  const aliases = new Aliases();
  aliases.account(account, 'steam', 'user_3');
  aliases.job(job);
  const stamp = new Date(Date.UTC(2026, 10, 5, 19, 30, seed.length, seed.charCodeAt(0))).toISOString();
  return {
    roots: { launchers: `${scratch}\\launchers`, data: `${scratch}\\data` },
    aliases,
    vault,
    value: {
      events: [
        { seq: 1, k: 'job', job, state: 'running', ms: seed.charCodeAt(1) },
        { seq: 2, k: 'plat', op: 'file.write', path: `${scratch}\\launchers\\steam\\config\\loginusers.vdf` },
      ],
      final: {
        accounts: [{ id: account, created_at: stamp, last_played_at: '2026-11-01T17:50:00.000Z', secret_enc: vault.encrypt('pw-three') }],
        settings: { signInMs: 2000 },
      },
    },
  };
}

describe('normaliseRuns', () => {
  test('recordings that differ only in ids, roots, clock and timings come out identical', () => {
    const result = normaliseRuns([recording('Ab1'), recording('Zy9x'), recording('Qr5')]);
    expect(result.stable).toBe(true);
    expect(result.unexplained).toEqual([]);
    expect(result.structural).toEqual([]);
    expect(result.volatile).toEqual(['/events/*/ms', '/final/accounts/*/created_at']);
    expect(result.value).toEqual({
      events: [
        { seq: 1, k: 'job', job: '@job:1', state: 'running', ms: MS },
        { seq: 2, k: 'plat', op: 'file.write', path: '{launchers}\\steam\\config\\loginusers.vdf' },
      ],
      final: {
        accounts: [
          {
            id: '@acct:steam:user_3',
            created_at: TS,
            last_played_at: '2026-11-01T17:50:00.000Z',
            secret_enc: { present: true, plaintextSha256: sha256('pw-three') },
          },
        ],
        settings: { signInMs: 2000 },
      },
    });
    expect(result.fields).toEqual([
      { path: '/events/*/job', rule: 'alias' },
      { path: '/events/*/ms', rule: 'ms' },
      { path: '/events/*/path', rule: 'root' },
      { path: '/final/accounts/*/created_at', rule: 'ts' },
      { path: '/final/accounts/*/id', rule: 'alias' },
      { path: '/final/accounts/*/secret_enc', rule: 'enc' },
    ]);
  });

  test('a difference no rule explains is reported, never hidden', () => {
    const a = recording('Ab1');
    const b = recording('Zy9');
    a.value.final.settings.port = 9401;
    b.value.final.settings.port = 9577;
    a.value.events[1].op = 'file.write';
    b.value.events[1].op = 'file.delete';
    const result = normaliseRuns([a, b]);
    expect(result.stable).toBe(false);
    expect(result.unexplained).toEqual(['/events/*/op', '/final/settings/port']);
    expect(result.value.final.settings.port).toBe(9401);
  });

  test('an id nobody aliased is a difference, not a pass', () => {
    const a = recording('Ab1');
    const b = recording('Zy9');
    a.value.final.accounts[0].session = randomUUID();
    b.value.final.accounts[0].session = randomUUID();
    expect(normaliseRuns([a, b]).unexplained).toEqual(['/final/accounts/*/session']);
  });

  test('a different number of events is structural', () => {
    const a = recording('Ab1');
    const b = recording('Zy9');
    b.value.events.push({ seq: 3, k: 'plat', op: 'proc.start' });
    const result = normaliseRuns([a, b]);
    expect(result.stable).toBe(false);
    expect(result.structural).toEqual(['/events']);
  });

  test('needs two recordings', () => {
    expect(() => normaliseRuns([recording('Ab1')])).toThrow(/at least two/);
  });
});
