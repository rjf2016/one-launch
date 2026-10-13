import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findLoginUser, LoginUsersFormatError, parseLoginUsers, planAutoLoginRewrite } from '../src/main/launchers/steam/loginusers';
import { isFullyInstalled, ManifestFormatError, needsUpdate, parseAppManifest, parseLibraryFolders } from '../src/main/launchers/steam/manifests';

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', 'steam', name), 'utf8');
const j = (...parts: string[]) => parts.join(sep);

describe('parseLoginUsers', () => {
  it('reads every remembered account from the fixture', () => {
    const users = parseLoginUsers(fixture('loginusers.vdf'));
    expect(users).toHaveLength(4);
    expect(users[0]).toEqual({
      steamId64: '76561198000000001',
      accountName: 'user_1',
      personaName: 'Persona One',
      rememberPassword: true,
      mostRecent: true,
      timestamp: 1789145779,
      mostRecentKeys: ['AutoLogin'],
    });
    expect(users.filter((u) => u.mostRecent).map((u) => u.accountName)).toEqual(['user_1']);
    expect(users.every((u) => u.rememberPassword)).toBe(true);
  });

  it('treats MostRecent and AutoLogin as synonyms and skips malformed blocks', () => {
    const text = `"users"
{
\t"76561198000000009"
\t{
\t\t"AccountName"\t\t"old_client"
\t\t"MostRecent"\t\t"1"
\t}
\t"not-a-steamid"
\t{
\t\t"AccountName"\t\t"ignored"
\t}
\t"76561198000000010"
\t{
\t\t"PersonaName"\t\t"no account name"
\t}
}`;
    const users = parseLoginUsers(text);
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ accountName: 'old_client', mostRecent: true, rememberPassword: false, mostRecentKeys: ['MostRecent'], timestamp: null });
  });

  it('rejects a file without a users block', () => {
    expect(() => parseLoginUsers('"nope" { }')).toThrow(LoginUsersFormatError);
  });
});

describe('findLoginUser', () => {
  const users = parseLoginUsers(fixture('loginusers.vdf'));
  it('prefers the SteamID64, then falls back to a case-insensitive login', () => {
    expect(findLoginUser(users, { launcherUid: '76561198000000003', login: 'wrong' })?.accountName).toBe('user_3');
    expect(findLoginUser(users, { launcherUid: null, login: 'USER_2' })?.accountName).toBe('user_2');
    expect(findLoginUser(users, { launcherUid: '76561198000000099', login: 'user_4' })?.accountName).toBe('user_4');
    expect(findLoginUser(users, { launcherUid: null, login: 'nobody' })).toBeNull();
  });
});

describe('planAutoLoginRewrite', () => {
  const original = fixture('loginusers.vdf');

  it('flips AutoLogin to the target and clears it everywhere else, touching nothing else', () => {
    const plan = planAutoLoginRewrite(original, '76561198000000003');
    expect(plan.noop).toBe(false);
    expect(plan.changes).toEqual([
      { line: 10, before: '\t\t"AutoLogin"\t\t"1"', after: '\t\t"AutoLogin"\t\t"0"' },
      { line: 30, before: '\t\t"AutoLogin"\t\t"0"', after: '\t\t"AutoLogin"\t\t"1"' },
    ]);
    const after = parseLoginUsers(plan.text);
    expect(after.filter((u) => u.mostRecent).map((u) => u.steamId64)).toEqual(['76561198000000003']);

    // Every line other than the two flipped ones is byte-identical, and line endings are preserved.
    const before = original.split('\n');
    const next = plan.text.split('\n');
    expect(next).toHaveLength(before.length);
    before.forEach((line, i) => {
      if (i === 9 || i === 29) return;
      expect(next[i]).toBe(line);
    });
    expect(plan.text.includes('\r\n')).toBe(false);
  });

  it('is a no-op when the target is already the only most recent account', () => {
    const plan = planAutoLoginRewrite(original, '76561198000000001');
    expect(plan.noop).toBe(true);
    expect(plan.text).toBe(original);
  });

  it('rewrites MostRecent on older files, adds AutoLogin where neither key exists, and keeps CRLF', () => {
    const text = [
      '"users"',
      '{',
      '\t"76561198000000001"',
      '\t{',
      '\t\t"AccountName"\t\t"a"',
      '\t\t"MostRecent"\t\t"1"',
      '\t}',
      '\t"76561198000000002"',
      '\t{',
      '\t\t"AccountName"\t\t"b"',
      '\t\t"Timestamp"\t\t"1"',
      '\t}',
      '}',
      '',
    ].join('\r\n');
    const plan = planAutoLoginRewrite(text, '76561198000000002');
    expect(plan.changes).toEqual([
      { line: 6, before: '\t\t"MostRecent"\t\t"1"', after: '\t\t"MostRecent"\t\t"0"' },
      { line: 12, before: '', after: '\t\t"AutoLogin"\t\t"1"' },
    ]);
    expect(plan.text.split('\r\n')).toHaveLength(15);
    const after = parseLoginUsers(plan.text);
    expect(after.map((u) => [u.accountName, u.mostRecent])).toEqual([
      ['a', false],
      ['b', true],
    ]);
  });

  it('refuses a target that is not in the file', () => {
    expect(() => planAutoLoginRewrite(original, '76561198000000099')).toThrow(LoginUsersFormatError);
  });
});

describe('parseLibraryFolders', () => {
  it('returns normalized, deduplicated paths from the current format', () => {
    expect(parseLibraryFolders(fixture('libraryfolders.vdf'))).toEqual([j('D:', 'Games', 'Steam'), j('C:', 'Users', 'user_1', 'Games')]);
  });

  it('accepts the pre-2021 flat format and ignores non-numeric keys and duplicates', () => {
    const text =
      '"LibraryFolders"\n{\n\t"TimeNextStatsReport"\t\t"1"\n\t"ContentStatsID"\t\t"2"\n\t"1"\t\t"E:\\\\SteamLibrary"\n\t"2"\t\t"e:/steamlibrary/"\n}\n';
    expect(parseLibraryFolders(text)).toEqual([j('E:', 'SteamLibrary')]);
  });

  it('rejects a file without the expected block', () => {
    expect(() => parseLibraryFolders('"x" {}')).toThrow(ManifestFormatError);
  });
});

describe('parseAppManifest', () => {
  it('reads the fields the library needs and nothing sensitive', () => {
    const m = parseAppManifest(fixture('appmanifest_252950.acf'));
    expect(m).toEqual({
      appId: '252950',
      name: 'Rocket League',
      installDir: 'rocketleague',
      stateFlags: 6,
      lastPlayed: 1785117264,
      sizeOnDisk: 42795878686,
      buildId: '24421949',
    });
    expect(JSON.stringify(m)).not.toContain('76561198000000001');
    expect(isFullyInstalled(m.stateFlags)).toBe(true);
    expect(needsUpdate(m.stateFlags)).toBe(true);
  });

  it('treats StateFlags as a bit field', () => {
    expect(isFullyInstalled(4)).toBe(true);
    expect(isFullyInstalled(1026)).toBe(false);
    expect(needsUpdate(4)).toBe(false);
  });

  it('rejects manifests without appid or installdir', () => {
    expect(() => parseAppManifest('"AppState" { "name" "x" "installdir" "x" }')).toThrow(ManifestFormatError);
    expect(() => parseAppManifest('"AppState" { "appid" "1" "name" "x" }')).toThrow(ManifestFormatError);
    expect(() => parseAppManifest('"Other" { }')).toThrow(ManifestFormatError);
  });
});
