import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterEach, describe, expect, test } from 'vitest';
import { PASSING, compareFile, compareTrees, jsonDifferences } from '../gate/compare.mjs';
import { jsonText } from '../lib/out.mjs';

const made = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'oracle-gate-'));
  made.push(root);
  for (const [rel, data] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), typeof data === 'string' || data instanceof Uint8Array ? data : jsonText(data));
  }
  return root;
}

const bytes = (value) => Buffer.from(typeof value === 'string' ? value : jsonText(value));

function png(width, height, pixel) {
  const chunk = (type, body) => {
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, 'latin1');
    body.copy(out, 8);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) Buffer.from(pixel(x, y)).copy(rows, y * (1 + width * 3) + 1 + x * 3);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const run = (t, box, volatile = false) => ({ t, box, font: ['Segoe UI', 14, 400, 20], color: '#e8eaf0', volatile });
const sidecar = (text, elements = []) => ({ id: 13, viewport: [1280, 800], dpr: 1, locale: 'en-US', tz: 'UTC', focus: null, text, elements });
const SIDECAR = 'ui/shots/013-library-no-games.layout.json';

describe('jsonDifferences', () => {
  test('equal values differ nowhere', () => {
    expect(jsonDifferences({ a: [1, { b: null }] }, { a: [1, { b: null }] })).toEqual({ total: 0, first: [] });
  });

  test('a changed leaf, a missing key, another length and another key order are each one difference', () => {
    expect(jsonDifferences({ a: 1 }, { a: 2 }).first).toEqual([{ at: '/a', reference: '1', candidate: '2' }]);
    expect(jsonDifferences({ a: 1, b: 2 }, { a: 1 }).first).toEqual([{ at: '/b', reference: '2', candidate: 'absent' }]);
    expect(jsonDifferences([1, 2], [1]).first).toEqual([{ at: '/length', reference: '2', candidate: '1' }]);
    expect(jsonDifferences({ a: 1, b: 2 }, { b: 2, a: 1 }).first).toEqual([{ at: '/(key order)', reference: '["a","b"]', candidate: '["b","a"]' }]);
  });

  test('two events that swapped places are found at both places', () => {
    const events = [
      { seq: 1, op: 'reg.set', path: 'AutoLoginUser' },
      { seq: 2, op: 'reg.set', path: 'RememberPassword' },
    ];
    const swapped = [
      { seq: 1, op: 'reg.set', path: 'RememberPassword' },
      { seq: 2, op: 'reg.set', path: 'AutoLoginUser' },
    ];
    expect(jsonDifferences({ events }, { events: swapped }).first.map((item) => item.at)).toEqual(['/events/0/path', '/events/1/path']);
  });

  test('the count goes past the listed ones', () => {
    const found = jsonDifferences([1, 2, 3, 4], [5, 6, 7, 8], 2);
    expect(found.total).toBe(4);
    expect(found.first).toHaveLength(2);
  });
});

describe('compareFile', () => {
  test('the same bytes are identical, other bytes of the same JSON are different', () => {
    expect(compareFile('l1/core/a.json', bytes({ a: 1 }), bytes({ a: 1 })).verdict).toBe('identical');
    expect(compareFile('l1/core/a.json', bytes({ a: 1 }), bytes('{"a":1}')).verdict).toBe('different');
  });

  test('a changed value in a vector is different and says where', () => {
    const result = compareFile('l1/core/compareVersions.json', bytes({ cases: [{ id: 'x', out: 1 }] }), bytes({ cases: [{ id: 'x', out: -1 }] }));
    expect(result).toEqual({ verdict: 'different', total: 1, first: [{ at: '/cases/0/out', reference: '1', candidate: '-1' }] });
  });

  test('a text file says the first line that differs', () => {
    const result = compareFile('takeover/nsis/templates/installer.nsi', bytes('a\nb\nc\n'), bytes('a\nB\nc\n'));
    expect(result.first).toEqual([{ at: 'line 2', reference: '"b"', candidate: '"B"' }]);
  });

  test('a sidecar that differs only in what the capture flagged volatile passes, and what was hidden is kept', () => {
    const reference = sidecar([run('Library', [16, 20, 60, 20]), run('Passed in 3 ms', [16, 60, 96, 20], true)]);
    const candidate = sidecar([run('Library', [16, 20, 60, 20]), run('Passed in 11 ms', [16, 60, 103, 20], true)]);
    const result = compareFile(SIDECAR, bytes(reference), bytes(candidate));
    expect(result.verdict).toBe('volatile');
    expect(result.hidden.first.map((item) => item.at)).toEqual(['/text/1/t', '/text/1/box/2']);
  });

  test('a volatile run that moved down is different', () => {
    const reference = sidecar([run('Passed in 3 ms', [16, 60, 96, 20], true)]);
    const candidate = sidecar([run('Passed in 3 ms', [16, 68, 96, 20], true)]);
    expect(compareFile(SIDECAR, bytes(reference), bytes(candidate))).toMatchObject({ verdict: 'different', first: [{ at: '/text/0/box/1' }] });
  });

  test('a moved box and a changed string in a sidecar are different', () => {
    const element = (box) => ({ role: 'link', name: 'Accounts', ord: 0, box, state: {}, style: {}, cls: 'nav' });
    const moved = compareFile(SIDECAR, bytes(sidecar([], [element([8, 52, 208, 40])])), bytes(sidecar([], [element([8, 60, 208, 40])])));
    expect(moved).toMatchObject({ verdict: 'different', total: 1, first: [{ at: '/elements/0/box/1', reference: '52', candidate: '60' }] });
    const worded = compareFile(SIDECAR, bytes(sidecar([run('after a scan.', [0, 0, 80, 20])])), bytes(sidecar([run('after a rescan.', [0, 0, 80, 20])])));
    expect(worded).toMatchObject({ verdict: 'different', first: [{ at: '/text/0/t' }] });
  });

  test('a shot is counted in pixels, never judged; a PNG outside ui/ is judged by its bytes', () => {
    const grey = png(4, 2, () => [40, 40, 40]);
    const dotted = png(4, 2, (x, y) => (x === 3 && y === 1 ? [255, 0, 0] : [40, 40, 40]));
    expect(compareFile('ui/shots/013-library-no-games.png', grey, dotted)).toEqual({ verdict: 'pixels', pixels: 1, box: [3, 1, 3, 1] });
    expect(PASSING.has('pixels')).toBe(true);
    expect(compareFile('assets/icons/tray/tray-16.png', grey, dotted).verdict).toBe('different');
    expect(
      compareFile(
        'ui/shots/013-library-no-games.png',
        grey,
        png(2, 2, () => [40, 40, 40]),
      ).verdict,
    ).toBe('different');
  });

  test('the manifest and the timings are not compared', () => {
    expect(compareFile('MANIFEST.json', bytes({ a: 1 }), bytes({ a: 2 })).verdict).toBe('not compared');
    expect(compareFile('perf/baseline.json', bytes({ a: 1 }), bytes({ a: 2 })).verdict).toBe('not compared');
  });
});

describe('compareTrees', () => {
  test('every captured file gets a verdict; a file only the capture has is extra; one only the bundle has is listed', () => {
    const reference = tree({ 'l1/a.json': { a: 1 }, 'l1/b.json': { b: 1 }, PIN: 'pin\n', 'takeover/contract.md': 'by hand\n' });
    const candidate = tree({ 'l1/a.json': { a: 1 }, 'l1/b.json': { b: 2 }, 'l1/c.json': { c: 1 }, PIN: 'pin\n' });
    const { results, notProduced } = compareTrees(reference, candidate, { skip: (path) => path === 'PIN' });
    expect(results.map((result) => `${result.path} ${result.verdict}`)).toEqual(['l1/a.json identical', 'l1/b.json different', 'l1/c.json extra']);
    expect(notProduced).toEqual(['PIN', 'takeover/contract.md']);
    expect(results.filter((result) => !PASSING.has(result.verdict))).toHaveLength(2);
  });
});
