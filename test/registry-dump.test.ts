import { describe, expect, it } from 'vitest';
import { parseRegQueryDump, regExePath, StaticRegistry, utf8RegCommand, WindowsRegistry } from '../src/main/platform/registry';

const regRead = (...args: string[]): string[] => ['/d', '/s', '/c', utf8RegCommand(regExePath(), args)];

// Output shapes captured from reg.exe on the user's machine (2026-09-12, Battle.net survey).
const DUMP =
  '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Battle.net\r\n    DisplayName    REG_SZ    Battle.net\r\n    InstallLocation    REG_SZ    C:\\Program Files (x86)\\Battle.net\r\n\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Overwatch\r\n    DisplayName    REG_SZ    Overwatch\r\n    UninstallString    REG_SZ    "C:\\ProgramData\\Battle.net\\Agent\\Blizzard Uninstaller.exe" --lang=enUS --uid=prometheus --displayname="Overwatch"\r\n\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Overwatch\\Sub\r\n\r\n';
const VALUES =
  '\r\nHKEY_CURRENT_USER\\Software\\Blizzard Entertainment\\Battle.net\\UnifiedAuth\r\n    AA11BB22    REG_BINARY    01000000D08C9DDF0115D1118C7A00C04FC297EB\r\n\r\n';

describe('reg query dumps (Phase 5)', () => {
  it('parses dumps into keys with their values', () => {
    expect(parseRegQueryDump(DUMP)).toEqual([
      {
        key: 'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Battle.net',
        values: [
          { name: 'DisplayName', type: 'REG_SZ', data: 'Battle.net' },
          { name: 'InstallLocation', type: 'REG_SZ', data: 'C:\\Program Files (x86)\\Battle.net' },
        ],
      },
      {
        key: 'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Overwatch',
        values: [
          { name: 'DisplayName', type: 'REG_SZ', data: 'Overwatch' },
          {
            name: 'UninstallString',
            type: 'REG_SZ',
            data: '"C:\\ProgramData\\Battle.net\\Agent\\Blizzard Uninstaller.exe" --lang=enUS --uid=prometheus --displayname="Overwatch"',
          },
        ],
      },
      { key: 'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Overwatch\\Sub', values: [] },
    ]);
    expect(parseRegQueryDump('ERROR: The system was unable to find the specified registry key or value.')).toEqual([]);
  });

  it('lists values, queries trees, and writes REG_BINARY through reg.exe', async () => {
    if (process.platform !== 'win32') return;
    const calls: string[][] = [];
    let stdout = VALUES;
    const reg = new WindowsRegistry(async (_file, args) => {
      calls.push(args);
      return { stdout };
    });
    expect(await reg.listValues('HKCU', 'Software\\Blizzard Entertainment\\Battle.net\\UnifiedAuth')).toEqual([
      { name: 'AA11BB22', type: 'REG_BINARY', data: '01000000D08C9DDF0115D1118C7A00C04FC297EB' },
    ]);
    expect(calls[0]).toEqual(regRead('query', 'HKEY_CURRENT_USER\\Software\\Blizzard Entertainment\\Battle.net\\UnifiedAuth'));
    stdout = DUMP;
    const tree = await reg.queryTree('HKLM', 'SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall');
    expect(calls[1]).toEqual(regRead('query', 'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s'));
    expect(tree.map((t) => t.relative)).toEqual(['Battle.net', 'Overwatch', 'Overwatch\\Sub']);
    await reg.setBinary('HKCU', 'Software\\Blizzard Entertainment\\Battle.net\\UnifiedAuth', 'AA11BB22', '01FF');
    expect(calls[2]).toEqual([
      'add',
      'HKEY_CURRENT_USER\\Software\\Blizzard Entertainment\\Battle.net\\UnifiedAuth',
      '/v',
      'AA11BB22',
      '/t',
      'REG_BINARY',
      '/d',
      '01ff',
      '/f',
    ]);
    await expect(reg.setBinary('HKCU', 'Software\\X', 'v', 'xyz')).rejects.toThrow(/unexpected characters/);
    await expect(reg.setBinary('HKCU', 'Software\\X', 'v', '0')).rejects.toThrow(/unexpected characters/);
  });

  it('searches a tree with reg.exe doing the filtering, and reads a subkey by the name reg.exe reported', async () => {
    if (process.platform !== 'win32') return;
    const SEARCH =
      '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Call of Duty: Modern Warfare II\r\n    UninstallString    REG_SZ    "C:\\ProgramData\\Battle.net\\Agent\\Blizzard Uninstaller.exe" --uid=lazr\r\n\r\nEnd of search: 1 match(es) found.\r\n';
    const calls: string[][] = [];
    let answer: () => { stdout: string } = () => ({ stdout: SEARCH });
    const reg = new WindowsRegistry(async (_file, args) => {
      calls.push(args);
      return answer();
    });
    const UNINSTALL = 'SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
    expect(await reg.searchTree('HKLM', UNINSTALL, 'Blizzard Uninstaller')).toEqual([
      {
        relative: 'Call of Duty: Modern Warfare II',
        values: [{ name: 'UninstallString', type: 'REG_SZ', data: '"C:\\ProgramData\\Battle.net\\Agent\\Blizzard Uninstaller.exe" --uid=lazr' }],
      },
    ]);
    expect(calls[0]).toEqual(regRead('query', `HKEY_LOCAL_MACHINE\\${UNINSTALL}`, '/s', '/f', 'Blizzard Uninstaller', '/d'));

    await reg.listSubkeyValues('HKLM', UNINSTALL, 'Call of Duty: Modern Warfare II');
    expect(calls[1]).toEqual(regRead('query', `HKEY_LOCAL_MACHINE\\${UNINSTALL}\\Call of Duty: Modern Warfare II`));

    // reg.exe exits 1 for "0 matches" as it does for a missing key.
    answer = () => {
      throw Object.assign(new Error('exit 1'), { code: 1 });
    };
    expect(await reg.searchTree('HKLM', UNINSTALL, 'Blizzard Uninstaller')).toEqual([]);

    const before = calls.length;
    await expect(reg.searchTree('HKLM', UNINSTALL, 'a" /s & calc')).rejects.toMatchObject({ code: 'REGISTRY' });
    for (const bad of ['..', '.', 'a\\b', 'a"b', '']) await expect(reg.listSubkeyValues('HKLM', UNINSTALL, bad)).rejects.toMatchObject({ code: 'REGISTRY' });
    for (const bad of ['Tom & Jerry', '100% Orange']) await expect(reg.listSubkeyValues('HKLM', UNINSTALL, bad)).rejects.toMatchObject({ code: 'REGISTRY' });
    expect(calls.length).toBe(before);
  });

  it('the static registry mirrors searchTree and listSubkeyValues', async () => {
    const reg = new StaticRegistry({
      'HKLM\\Software\\Uninstall\\Overwatch\\DisplayName': 'Overwatch',
      'HKLM\\Software\\Uninstall\\Overwatch\\UninstallString': '"C:\\Agent\\Blizzard Uninstaller.exe" --uid=prometheus',
      'HKLM\\Software\\Uninstall\\Other\\UninstallString': 'MsiExec.exe /X{1}',
    });
    expect(await reg.searchTree('HKLM', 'Software\\Uninstall', 'blizzard uninstaller')).toEqual([
      { relative: 'Overwatch', values: [{ name: 'UninstallString', type: 'REG_SZ', data: '"C:\\Agent\\Blizzard Uninstaller.exe" --uid=prometheus' }] },
    ]);
    expect((await reg.listSubkeyValues('HKLM', 'Software\\Uninstall', 'Overwatch')).map((v) => v.name)).toEqual(['DisplayName', 'UninstallString']);
  });

  it('the static registry mirrors listValues, queryTree, and binary values', async () => {
    const reg = new StaticRegistry({ 'HKLM\\Software\\Uninstall\\Overwatch\\DisplayName': 'Overwatch', 'HKLM\\Software\\Uninstall\\Overwatch\\Count': 2 });
    reg.setBinaryValue('HKCU\\Software\\Bnet\\UnifiedAuth\\AA11BB22', '01ff');
    expect(await reg.listValues('HKCU', 'software\\bnet\\unifiedauth')).toEqual([{ name: 'AA11BB22', type: 'REG_BINARY', data: '01FF' }]);
    expect(await reg.listValues('HKCU', 'Software\\Bnet')).toEqual([]);
    expect(await reg.queryTree('HKLM', 'Software\\Uninstall')).toEqual([
      {
        relative: 'Overwatch',
        values: [
          { name: 'DisplayName', type: 'REG_SZ', data: 'Overwatch' },
          { name: 'Count', type: 'REG_DWORD', data: '0x2' },
        ],
      },
    ]);
    expect(await reg.getDword('HKLM', 'Software\\Uninstall\\Overwatch', 'Count')).toBe(2);
    await reg.setBinary('HKCU', 'Software\\Bnet\\UnifiedAuth', 'B1', 'abcd');
    expect(reg.writes).toEqual([{ op: 'set', path: 'HKCU\\Software\\Bnet\\UnifiedAuth\\B1', value: 'binary:2 bytes' }]);
    expect((await reg.listValues('HKCU', 'Software\\Bnet\\UnifiedAuth')).map((v) => v.name).sort()).toEqual(['AA11BB22', 'B1']);
  });
});
