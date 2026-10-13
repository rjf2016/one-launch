import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseVdf, VdfParseError, vdfFlag, vdfInt, vdfObject, vdfString } from '../src/main/launchers/steam/vdf';

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', 'steam', name), 'utf8');

describe('parseVdf', () => {
  it('parses nested blocks with quoted keys and values', () => {
    const root = parseVdf(fixture('loginusers.vdf'));
    const users = vdfObject(root, 'users');
    expect(users).toBeDefined();
    expect(Object.keys(users!)).toHaveLength(4);
    const first = vdfObject(users!, '76561198000000001')!;
    expect(vdfString(first, 'AccountName')).toBe('user_1');
    expect(vdfString(first, 'AutoLogin')).toBe('1');
    expect(vdfInt(first, 'Timestamp')).toBe(1789145779);
  });

  it('unescapes backslashes and quotes but keeps unknown escapes verbatim', () => {
    const root = parseVdf('"a" { "path" "D:\\\\Games\\\\Steam" "q" "say \\"hi\\"" "raw" "C:\\Users\\x" "nl" "a\\nb" }');
    const a = vdfObject(root, 'a')!;
    expect(vdfString(a, 'path')).toBe('D:\\Games\\Steam');
    expect(vdfString(a, 'q')).toBe('say "hi"');
    expect(vdfString(a, 'raw')).toBe('C:\\Users\\x');
    expect(vdfString(a, 'nl')).toBe('a\nb');
  });

  it('handles bare tokens, comments, a BOM, CRLF, #base directives, and platform conditionals', () => {
    const text = '\uFEFF// comment\r\n#base "other.vdf"\r\nroot\r\n{\r\n\tkey value // trailing\r\n\t"cond" "x" [$WIN32]\r\n\tsub { inner 1 }\r\n}\r\n';
    const root = parseVdf(text);
    const r = vdfObject(root, 'root')!;
    expect(vdfString(r, 'key')).toBe('value');
    expect(vdfString(r, 'cond')).toBe('x');
    expect(vdfString(vdfObject(r, 'sub')!, 'inner')).toBe('1');
  });

  it('looks keys up case-insensitively, exact match first', () => {
    const root = parseVdf('"R" { "Name" "exact" "name" "lower" "Flag" "1" }');
    const r = vdfObject(root, 'r')!;
    expect(vdfString(r, 'Name')).toBe('exact');
    expect(vdfString(r, 'NAME')).toBe('exact');
    expect(vdfFlag(r, 'flag')).toBe(true);
    expect(vdfFlag(r, 'missing')).toBe(false);
    expect(vdfInt(r, 'Name')).toBeNull();
  });

  it('does not let a hostile key touch Object.prototype', () => {
    const root = parseVdf('"__proto__" { "polluted" "yes" }');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(vdfString(vdfObject(root, '__proto__')!, 'polluted')).toBe('yes');
  });

  it('reports malformed input with a line number', () => {
    expect(() => parseVdf('"a"\n{\n"b" "c"\n')).toThrow(VdfParseError);
    expect(() => parseVdf('"a"\n{\n"b" "c"\n')).toThrow(/line 2/);
    expect(() => parseVdf('"a" "b" }')).toThrow(/Unexpected "}"/);
    expect(() => parseVdf('"a" { "b" }')).toThrow(/has no value/);
    expect(() => parseVdf('"unterminated')).toThrow(/Unterminated string/);
    expect(() => parseVdf('"a" { { } }')).toThrow(/where a key was expected/);
  });

  it('accepts an empty document', () => {
    expect(Object.keys(parseVdf(''))).toEqual([]);
    expect(Object.keys(parseVdf('// nothing here\n'))).toEqual([]);
  });
});
