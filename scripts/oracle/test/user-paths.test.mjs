import { describe, expect, test } from 'vitest';
import { createUserPathScanner } from '../lib/user-paths.mjs';

// Built from pieces so this file holds no user folder for the repo's own secret scan to find.
const NAME = ['mor', 'gan', 'f'].join('');
const HOST = ['DESKTOP', '7QK2M'].join('-');
const under = (...parts) => ['C:', 'Users', ...parts].join('\\');
const identity = { username: NAME, host: HOST, folders: [under(NAME), under(NAME, 'AppData', 'Local', 'Temp')] };
const stranger = { username: '', host: '', folders: [] };

const kinds = (scanner, text) => scanner.scanText(text).map((hit) => hit.kind);

describe('user folders by shape', () => {
  const scanner = createUserPathScanner({ identity: stranger });

  test('finds a named user folder however the path is written', () => {
    const other = ['pat', 'ric', 'ia'].join('');
    for (const text of [
      under(other, 'AppData', 'Roaming', 'OneLaunch'),
      under(other).replace(/\\/g, '\\\\'),
      under(other).replace(/\\/g, '\\\\\\\\'),
      under(other).replace(/\\/g, '/'),
      under(other).replace(/\\/g, '\\/'),
      under(other).toLowerCase().replace(/\\/g, '/'),
      `file:///${under(other).replace(/\\/g, '/')}/Desktop`,
      `/c/Users/${other}/AppData`,
      ['D:', 'Documents and Settings', other, 'Application Data'].join('\\'),
    ]) {
      expect(kinds(scanner, `"path": "${text}"`), text.replace(other, '<name>')).toEqual(['user-folder']);
    }
    expect(kinds(scanner, `cwd=/home/${other}/work`)).toEqual(['home-folder']);
    expect(kinds(scanner, `cwd=/Users/${other}/work`)).toEqual(['home-folder']);
  });

  test('lets placeholders through', () => {
    for (const name of ['<user>', '[USER]', '%USERNAME%', '${user}', '{user}', 'someone', 'Placeholder', 'Public', 'Default']) {
      expect(kinds(scanner, `${under(name)}\\AppData\\Local\\Temp`), name).toEqual([]);
    }
    expect(kinds(scanner, 'C:\\Program Files (x86)\\Steam\\config\\loginusers.vdf')).toEqual([]);
    expect(kinds(scanner, 'https://example.com/home/page and src/home/Users.tsx')).toEqual([]);
  });

  test('lets an allowlisted made-up name through, and only that one', () => {
    const allowing = createUserPathScanner({ identity: stranger, allow: new Set(['user_1']) });
    expect(kinds(allowing, under('user_1', 'Games'))).toEqual([]);
    expect(kinds(allowing, under('user_2', 'Games'))).toEqual(['user-folder']);
  });

  test('never reports the name itself', () => {
    const other = ['pat', 'ric', 'ia'].join('');
    const [hit] = scanner.scanText(under(other));
    expect(hit.masked).toBe('p…(8 chars)');
    expect(JSON.stringify(hit)).not.toContain(other);
  });
});

describe("this machine's identity", () => {
  const scanner = createUserPathScanner({ identity });

  test('finds the user name as a word, in any case, but not inside another word', () => {
    expect(kinds(scanner, `owner: ${NAME}`)).toEqual(['user-name']);
    expect(kinds(scanner, `OWNER=${NAME.toUpperCase()};`)).toEqual(['user-name']);
    expect(kinds(scanner, `x${NAME}y`)).toEqual([]);
  });

  test('finds the host name', () => {
    expect(kinds(scanner, `\\\\${HOST}\\share`)).toEqual(['host-name']);
  });

  test('finds the home and temp folders in every spelling', () => {
    const temp = identity.folders[1];
    for (const text of [temp, temp.replace(/\\/g, '\\\\'), temp.toLowerCase().replace(/\\/g, '/'), JSON.stringify(JSON.stringify(temp))]) {
      expect(new Set(kinds(scanner, text))).toEqual(new Set(['user-folder', 'user-name', 'own-folder']));
    }
  });

  test('ignores a generic or very short user name, and a temp folder outside Users', () => {
    const generic = createUserPathScanner({ identity: { username: 'runneradmin', host: 'pc', folders: ['D:\\tmp'] } });
    expect(kinds(generic, 'runneradmin ran it on pc in D:\\tmp')).toEqual([]);
  });
});

describe('scanBytes', () => {
  const scanner = createUserPathScanner({ identity });
  const path = under(NAME, 'AppData', 'Roaming', 'OneLaunch');

  test('finds a path inside a binary file', () => {
    const bytes = Buffer.concat([Buffer.from([0, 1, 2, 0xff, 0xfe]), Buffer.from(path, 'utf8'), Buffer.from([0, 0, 0x89, 0x50])]);
    expect(scanner.scanBytes(bytes).map((hit) => hit.kind)).toContain('user-folder');
  });

  test('finds UTF-16 text at either alignment', () => {
    const wide = Buffer.from(path, 'utf16le');
    expect(scanner.scanBytes(wide).map((hit) => hit.kind)).toContain('user-folder');
    expect(scanner.scanBytes(Buffer.concat([Buffer.from([0x7f]), wide])).map((hit) => hit.kind)).toContain('user-folder');
  });

  test('reports each finding once per file and stays quiet on clean bytes', () => {
    const twice = Buffer.from(`${path}\n${path}\n`, 'utf8');
    expect(scanner.scanBytes(twice).filter((hit) => hit.kind === 'user-folder')).toHaveLength(1);
    expect(scanner.scanBytes(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13]))).toEqual([]);
    expect(scanner.scanBytes(new Uint8Array(0))).toEqual([]);
  });
});
