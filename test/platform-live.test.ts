/**
 * Read-only check of the real reg.exe and PowerShell output decoding on this PC. Skipped unless ONELAUNCH_LIVE=1:
 *
 *     $env:ONELAUNCH_LIVE = '1'; npx vitest run test/platform-live.test.ts
 *
 * Reads the three Uninstall trees and the process list through the production classes and prints
 * counts only. A value that came through in the wrong code page shows up as U+FFFD, or, for the
 * direct reg.exe call, as fewer non-ASCII values than the UTF-8 read finds.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { WindowsProcessController } from '../src/main/platform/processes';
import { regExePath, WindowsRegistry, type RegistryHive } from '../src/main/platform/registry';

const live = process.platform === 'win32' && process.env['ONELAUNCH_LIVE'] === '1';

const UNINSTALL_ROOTS: [RegistryHive, string][] = [
  ['HKLM', 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'],
  ['HKLM', 'SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'],
  ['HKCU', 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'],
];
const HIVES: Record<RegistryHive, string> = { HKLM: 'HKEY_LOCAL_MACHINE', HKCU: 'HKEY_CURRENT_USER' };

// eslint-disable-next-line no-control-regex -- "not ASCII" is the point
const nonAscii = (s: string): boolean => /[^\x00-\x7f]/.test(s);

describe.skipIf(!live)('reg.exe and PowerShell output against the real machine (read-only)', () => {
  it('decodes every value without a replacement character and keeps what the OEM code page would lose', async () => {
    const registry = new WindowsRegistry();
    let values = 0;
    let keptNonAscii = 0;
    let replaced = 0;
    let direct = 0;
    for (const [hive, key] of UNINSTALL_ROOTS) {
      for (const dump of await registry.queryTree(hive, key)) {
        for (const v of [{ data: dump.relative }, ...dump.values]) {
          values++;
          if (nonAscii(v.data)) keptNonAscii++;
          if (v.data.includes('�')) replaced++;
        }
      }
      const { stdout } = await promisify(execFile)(regExePath(), ['query', `${HIVES[hive]}\\${key}`, '/s'], {
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'latin1',
      }).catch(() => ({ stdout: '' }));
      direct += stdout.split(/\r?\n/).filter(nonAscii).length;
    }

    const processes = await new WindowsProcessController().listProcesses();
    const paths = processes.filter((p) => p.path !== null);

    console.log(
      [
        '',
        `Uninstall trees: ${values} keys and values, ${keptNonAscii} with non-ASCII text, ${replaced} with U+FFFD`,
        `Same trees from reg.exe without the code page switch: ${direct} lines with a byte above 0x7f`,
        `Processes: ${processes.length}, ${paths.length} with a path, ${paths.filter((p) => nonAscii(p.path!)).length} non-ASCII, ${paths.filter((p) => p.path!.includes('�') || p.path!.includes('?')).length} damaged`,
        '',
      ].join('\n'),
    );

    expect(replaced).toBe(0);
    expect(processes.length).toBeGreaterThan(0);
    expect(paths.every((p) => !p.path!.includes('�') && !p.path!.includes('?'))).toBe(true);
  }, 60_000);
});
