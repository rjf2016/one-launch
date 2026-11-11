import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { DEFAULT_OUT, artefactPath, jsonText, parseOut, repoRoot, resolveOut, writeArtefact } from '../lib/out.mjs';

describe('the --out convention', () => {
  test('defaults to the oracle folder of the Rust repo beside this one', () => {
    expect(DEFAULT_OUT).toBe(resolve(repoRoot, '..', 'one-launch-rs', 'oracle'));
    expect(resolveOut([], {})).toBe(DEFAULT_OUT);
  });

  test('takes --out <folder> and --out=<folder>, the flag before the environment', () => {
    const a = join(tmpdir(), 'oracle-a');
    const b = join(tmpdir(), 'oracle-b');
    expect(resolveOut(['fixtures', '--out', a], {})).toBe(a);
    expect(resolveOut([`--out=${a}`, 'fixtures'], {})).toBe(a);
    expect(resolveOut([], { ORACLE_OUT: b })).toBe(b);
    expect(resolveOut(['--out', a], { ORACLE_OUT: b })).toBe(a);
  });

  test('a flag without a folder is an error', () => {
    expect(() => parseOut(['--out'])).toThrow(/needs a folder/);
    expect(() => parseOut(['--out', '--allow-dirty'])).toThrow(/needs a folder/);
    expect(() => parseOut(['--out='])).toThrow(/needs a folder/);
    expect(parseOut(['--allow-dirty'])).toBeNull();
  });

  test('refuses the Electron repo and a drive root', () => {
    expect(() => resolveOut(['--out', join(repoRoot, 'out', 'oracle')], {})).toThrow(/outside the Electron repo/);
    expect(() => resolveOut(['--out', repoRoot], {})).toThrow(/outside the Electron repo/);
    expect(() => resolveOut(['--out', parse(repoRoot).root], {})).toThrow(/drive root/);
  });
});

describe('writeArtefact', () => {
  test('writes JSON with two-space indent and a final newline, bytes and text as given', () => {
    const out = mkdtempSync(join(tmpdir(), 'oracle-out-'));
    try {
      writeArtefact(out, 'l1/steam/a.json', { b: [1, 2], a: null });
      writeArtefact(out, 'raw.bin', Buffer.from([0, 255]));
      writeArtefact(out, 'note.txt', 'as given\r\n');
      expect(readFileSync(join(out, 'l1', 'steam', 'a.json'), 'utf8')).toBe('{\n  "b": [\n    1,\n    2\n  ],\n  "a": null\n}\n');
      expect(readFileSync(join(out, 'raw.bin'))).toEqual(Buffer.from([0, 255]));
      expect(readFileSync(join(out, 'note.txt'), 'utf8')).toBe('as given\r\n');
      expect(jsonText('x')).toBe('"x"\n');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  test('never writes outside the output folder', () => {
    const out = join(tmpdir(), 'oracle-out-guard');
    expect(() => artefactPath(out, '../elsewhere.json')).toThrow(/leaves the output folder/);
    expect(() => artefactPath(out, join(tmpdir(), 'other', 'x.json'))).toThrow(/leaves the output folder/);
    expect(() => artefactPath(out, '.')).toThrow(/leaves the output folder/);
    expect(artefactPath(out, 'l1/a.json')).toBe(join(out, 'l1', 'a.json'));
  });
});
