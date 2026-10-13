import { realpathSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { basename } from 'node:path';
import {
  CONTROL_PROCESSES_PS,
  LIST_PROCESS_NAMES_PS,
  LIST_PROCESSES_PS,
  parseProcessControlResult,
  parseProcessJson,
  parseProcessNames,
  processNameOf,
  StaticProcessController,
  WindowsProcessController,
} from '../src/main/platform/processes';
import { parseDword, parseRegQueryDump, parseRegQueryOutput, regExePath, StaticRegistry, utf8RegCommand, WindowsRegistry } from '../src/main/platform/registry';

/** The argv of a registry read: reg.exe behind `chcp 65001` in one cmd.exe. */
const regRead = (...args: string[]): string[] => ['/d', '/s', '/c', utf8RegCommand(regExePath(), args)];

// Output shapes captured from reg.exe on the user's machine (2026-09-11).
const REG_SZ = '\r\nHKEY_CURRENT_USER\\Software\\Valve\\Steam\r\n    SteamPath    REG_SZ    d:/games/steam\r\n\r\n';
const REG_DWORD = '\r\nHKEY_CURRENT_USER\\Software\\Valve\\Steam\\ActiveProcess\r\n    pid    REG_DWORD    0x1520\r\n\r\n';
const REG_SPACES = '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Foo\r\n    Install Path    REG_SZ    C:\\Program Files (x86)\\Foo Bar\r\n\r\n';
const REG_EMPTY = '\r\nHKEY_CURRENT_USER\\Software\\Valve\\Steam\r\n    Language    REG_SZ    \r\n\r\n';
const REG_EMPTY_NO_TRAIL = '\r\nHKEY_CURRENT_USER\\Software\\Valve\\Steam\r\n    Language    REG_SZ\r\n\r\n';

describe('parseRegQueryOutput', () => {
  it('extracts type and data for the requested value, case-insensitively', () => {
    expect(parseRegQueryOutput(REG_SZ, 'steampath')).toEqual({ type: 'REG_SZ', data: 'd:/games/steam' });
    expect(parseRegQueryOutput(REG_DWORD, 'pid')).toEqual({ type: 'REG_DWORD', data: '0x1520' });
    expect(parseRegQueryOutput(REG_SPACES, 'Install Path')).toEqual({ type: 'REG_SZ', data: 'C:\\Program Files (x86)\\Foo Bar' });
  });

  it('returns empty data for an empty REG_SZ and null for a value that is not in the output', () => {
    expect(parseRegQueryOutput(REG_EMPTY, 'Language')).toEqual({ type: 'REG_SZ', data: '' });
    expect(parseRegQueryOutput(REG_EMPTY_NO_TRAIL, 'Language')).toEqual({ type: 'REG_SZ', data: '' });
    expect(parseRegQueryOutput(REG_SZ, 'SteamExe')).toBeNull();
    expect(parseRegQueryOutput('ERROR: The system was unable to find the specified registry key or value.', 'x')).toBeNull();
  });
});

describe('parseDword', () => {
  it('reads hex and decimal', () => {
    expect(parseDword('0x1520')).toBe(0x1520);
    expect(parseDword('1')).toBe(1);
    expect(parseDword('nope')).toBeNull();
  });
});

describe('parseProcessNames', () => {
  it('reads one name per line and matches an image name without its ".exe", whatever the case', () => {
    const names = parseProcessNames('﻿Idle\r\nSystem\r\nSteam\r\nsteamwebhelper\r\nBattle.net\r\n\r\n');
    expect([...names]).toEqual(['idle', 'system', 'steam', 'steamwebhelper', 'battle.net']);
    expect(names.has(processNameOf('steam.exe'))).toBe(true);
    expect(names.has(processNameOf('Battle.net.EXE'))).toBe(true);
    expect(names.has(processNameOf('EpicGamesLauncher.exe'))).toBe(false);
    expect(parseProcessNames('steamwebhelper\n').has(processNameOf('steam.exe'))).toBe(false);
    expect(parseProcessNames('').size).toBe(0);
  });
});

describe('parseProcessControlResult', () => {
  it('reads the counts and refuses anything else', () => {
    expect(parseProcessControlResult('{"found":2,"signalled":1,"denied":0,"failed":0,"error":0}\r\n')).toEqual({
      found: 2,
      signalled: 1,
      denied: 0,
      failed: 0,
      error: 0,
    });
    for (const bad of [
      '',
      'True',
      '[]',
      '{"found":1}',
      '{"found":"1","signalled":0,"denied":0,"failed":0,"error":0}',
      '{"found":-1,"signalled":0,"denied":0,"failed":0,"error":0}',
    ]) {
      expect(() => parseProcessControlResult(bad)).toThrow();
    }
  });
});

describe('static fakes', () => {
  it('behave like the real readers for tests', async () => {
    const reg = new StaticRegistry({ 'HKCU\\Software\\Valve\\Steam\\SteamPath': 'd:/games/steam', 'HKCU\\Software\\Valve\\Steam\\RememberPassword': 1 });
    expect(await reg.getString('HKCU', 'software\\valve\\steam', 'steampath')).toBe('d:/games/steam');
    expect(await reg.getDword('HKCU', 'Software\\Valve\\Steam', 'RememberPassword')).toBe(1);
    expect(await reg.getString('HKCU', 'Software\\Valve\\Steam', 'RememberPassword')).toBeNull();
    reg.delete('HKCU\\Software\\Valve\\Steam\\SteamPath');
    expect(await reg.getString('HKCU', 'Software\\Valve\\Steam', 'SteamPath')).toBeNull();

    const procs = new StaticProcessController();
    expect(await procs.isRunning('steam.exe')).toBe(false);
    procs.setRunning('Steam.exe', true);
    expect(await procs.isRunning('steam.exe')).toBe(true);
    procs.processes = [{ name: 'VALORANT-Win64-Shipping', pid: 1, path: null }];
    expect(await procs.runningNames()).toEqual(new Set(['steam', 'valorant-win64-shipping']));
  });
});

describe('Phase 4 additions', () => {
  const DEFAULT_VALUE =
    '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Classes\\com.epicgames.launcher\\shell\\open\\command\r\n    (Default)    REG_SZ    "C:\\Program Files (x86)\\Epic Games\\Launcher\\Portal\\Binaries\\Win64\\EpicGamesLauncher.exe" %1\r\n\r\n';

  it('reads a key default value with /ve and accepts MSI product-code keys', async () => {
    expect(parseRegQueryOutput(DEFAULT_VALUE, '(Default)')).toEqual({
      type: 'REG_SZ',
      data: '"C:\\Program Files (x86)\\Epic Games\\Launcher\\Portal\\Binaries\\Win64\\EpicGamesLauncher.exe" %1',
    });
    const calls: string[][] = [];
    const reg = new WindowsRegistry(async (_file, args) => {
      calls.push(args);
      return { stdout: DEFAULT_VALUE };
    });
    if (process.platform !== 'win32') return;
    expect(await reg.getString('HKLM', 'SOFTWARE\\Classes\\com.epicgames.launcher\\shell\\open\\command', '')).toMatch(/EpicGamesLauncher\.exe" %1$/);
    expect(calls[0]).toEqual(regRead('query', 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Classes\\com.epicgames.launcher\\shell\\open\\command', '/ve'));
    await reg.getString(
      'HKLM',
      'SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{AEB35C6C-B6D4-4AA0-8452-DE699737B5F6}',
      'InstallLocation',
    );
    expect(calls[1]![3]).toContain('{AEB35C6C-B6D4-4AA0-8452-DE699737B5F6}" "/v" "InstallLocation"');
    await expect(reg.getString('HKLM', 'SOFTWARE\\..\\Bad', '')).rejects.toThrow(/unexpected characters/);
  });

  it('the fake close() ends the process after the polls a shutdown takes', async () => {
    const fake = new StaticProcessController(['EpicGamesLauncher.exe']);
    fake.shutdownPolls = 1;
    await fake.close('EpicGamesLauncher.exe');
    expect(fake.events).toEqual([{ kind: 'close', exe: 'EpicGamesLauncher.exe', args: [] }]);
    expect(await fake.isRunning('EpicGamesLauncher.exe')).toBe(false);
  });
});

describe('isRunning, close and kill without WMI (S2)', () => {
  const win = process.platform === 'win32';
  const result = (over: Partial<Record<'found' | 'signalled' | 'denied' | 'failed' | 'error', number>> = {}): { stdout: string } => ({
    stdout: `${JSON.stringify({ found: 1, signalled: 1, denied: 0, failed: 0, error: 0, ...over })}\r\n`,
  });

  it('runs nothing that lists through WMI, and asks a process only for the right to end it', () => {
    for (const script of [LIST_PROCESS_NAMES_PS, CONTROL_PROCESSES_PS]) {
      expect(script).not.toMatch(/tasklist|taskkill|Win32_Process|Get-CimInstance|Get-WmiObject|wmic|Get-Process|MainModule/i);
    }
    expect(LIST_PROCESS_NAMES_PS).toContain('[System.Diagnostics.Process]::GetProcesses()');
    expect(LIST_PROCESS_NAMES_PS).not.toMatch(/Add-Type|OpenProcess/);
    expect(CONTROL_PROCESSES_PS.match(/OpenProcess\(/g)).toHaveLength(2);
    expect(CONTROL_PROCESSES_PS).toContain('OpenProcess(ProcessTerminate | Synchronize, false, targets[i].Pid)');
    expect(CONTROL_PROCESSES_PS).toContain('const uint ProcessTerminate = 0x0001;');
    expect(CONTROL_PROCESSES_PS).toContain('const uint Synchronize = 0x00100000;');
  });

  it.skipIf(!win)('isRunning() and anyRunning() read the names PowerShell lists, one listing a call, and an empty list is an error, not "closed"', async () => {
    const calls: { file: string; args: string[] }[] = [];
    let stdout = 'Idle\r\nSystem\r\nsteam\r\nsteamwebhelper\r\nRiot Client\r\n';
    const procs = new WindowsProcessController(async (file, args) => {
      calls.push({ file, args });
      return { stdout };
    });
    expect(await procs.isRunning('steam.exe')).toBe(true);
    expect(await procs.isRunning('Steam.exe')).toBe(true);
    expect(await procs.isRunning('Battle.net.exe')).toBe(false);
    expect(await procs.isRunning('Riot Client.exe')).toBe(true);
    expect(await procs.isRunning('RiotClientServices.exe')).toBe(false);
    expect(calls.every((c) => /WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i.test(c.file))).toBe(true);
    expect(calls[0]!.args).toEqual(['-NoProfile', '-NonInteractive', '-Command', LIST_PROCESS_NAMES_PS]);
    // A game's every image name in one listing; no name, no listing.
    expect(await procs.anyRunning(['VALORANT.exe', 'VALORANT-Win64-Shipping.exe', 'Riot Client.exe'])).toBe(true);
    expect(await procs.anyRunning(['VALORANT.exe', 'VALORANT-Win64-Shipping.exe'])).toBe(false);
    expect(await procs.anyRunning([])).toBe(false);
    expect(await procs.runningNames()).toEqual(new Set(['idle', 'system', 'steam', 'steamwebhelper', 'riot client']));
    expect(calls).toHaveLength(8);
    stdout = '\r\n';
    await expect(procs.isRunning('steam.exe')).rejects.toThrow('Could not list the running processes (PowerShell printed no names)');
    await expect(procs.anyRunning(['steam.exe', 'Riot Client.exe'])).rejects.toThrow('Could not list the running processes (PowerShell printed no names)');
    for (const bad of ['bad  name.exe', ' lead.exe', 'trail.exe ', "it's.exe", '$env.exe', 'a;b.exe']) {
      await expect(procs.isRunning(bad)).rejects.toThrow(/unexpected image name/);
      await expect(procs.anyRunning(['steam.exe', bad])).rejects.toThrow(/unexpected image name/);
    }
    expect(calls).toHaveLength(10);
  });

  it.skipIf(!win)('close() and kill() name the image and the tree choice in the one call they add to the script', async () => {
    const scripts: string[] = [];
    const procs = new WindowsProcessController(async (_file, args) => {
      scripts.push(args.at(-1)!);
      return result();
    });
    await procs.close('EpicGamesLauncher.exe');
    await procs.kill('steam.exe');
    await procs.kill('Battle.net.exe', { tree: false });
    await procs.close('Riot Client.exe');
    expect(scripts.every((s) => s.startsWith(CONTROL_PROCESSES_PS))).toBe(true);
    expect(scripts.map((s) => s.slice(CONTROL_PROCESSES_PS.length))).toEqual([
      "[OneLaunchProcessControl]::Close('EpicGamesLauncher.exe')",
      "[OneLaunchProcessControl]::Kill('steam.exe', $true)",
      "[OneLaunchProcessControl]::Kill('Battle.net.exe', $false)",
      "[OneLaunchProcessControl]::Close('Riot Client.exe')",
    ]);
    await expect(procs.close("x'; calc; '.exe")).rejects.toThrow(/unexpected image name/);
    await expect(procs.kill('steam.exe; rd /s')).rejects.toThrow(/unexpected image name/);
    await expect(procs.kill("Riot Client.exe') ; Kill('steam.exe")).rejects.toThrow(/unexpected image name/);
    expect(scripts).toHaveLength(4);
  });

  it.skipIf(!win)('a process that is not there, or has no window, is not an error', async () => {
    let next = result({ found: 0, signalled: 0 });
    const procs = new WindowsProcessController(async () => next);
    await expect(procs.close('EpicGamesLauncher.exe')).resolves.toBeUndefined();
    await expect(procs.kill('EpicGamesLauncher.exe')).resolves.toBeUndefined();
    next = result({ found: 3, signalled: 0 });
    await expect(procs.close('EpicGamesLauncher.exe')).resolves.toBeUndefined();
  });

  it.skipIf(!win)('names elevation when Windows refuses, whatever the display language, instead of waiting out the timeout', async () => {
    const procs = new WindowsProcessController(async () => result({ found: 2, signalled: 1, denied: 1 }));
    await expect(procs.close('Battle.net.exe')).rejects.toMatchObject({
      code: 'PROCESS_ACCESS_DENIED',
      message: expect.stringMatching(/^Windows would not let One Launch close Battle\.net\.exe\. It is most likely running as administrator/),
    });
    await expect(procs.kill('Battle.net.exe', { tree: false })).rejects.toMatchObject({ code: 'PROCESS_ACCESS_DENIED' });
  });

  it.skipIf(!win)('reports a failure without the script, which Node puts into the error message', async () => {
    let failure: Record<string, unknown> | null = { code: 1, stderr: 'Add-Type : Cannot add type.\r\n    + CategoryInfo : InvalidData\r\n' };
    let stdout = '';
    const procs = new WindowsProcessController(async (file, args) => {
      if (failure) throw Object.assign(new Error(`Command failed: ${file} ${args.join(' ')}`), failure);
      return { stdout };
    });
    const message = async (run: () => Promise<unknown>): Promise<string> => ((await run().catch((e: unknown) => e)) as Error).message;

    expect(await message(() => procs.close('steam.exe'))).toBe(
      'Could not close steam.exe (exit code 1: Add-Type : Cannot add type. + CategoryInfo : InvalidData)',
    );
    expect(await message(() => procs.isRunning('steam.exe'))).toBe(
      'Could not list the running processes (exit code 1: Add-Type : Cannot add type. + CategoryInfo : InvalidData)',
    );
    failure = { code: null, killed: true, signal: 'SIGTERM' };
    expect(await message(() => procs.kill('steam.exe'))).toBe('Could not end steam.exe (PowerShell timed out)');
    failure = null;
    expect(await message(() => procs.kill('steam.exe'))).toBe('Could not end steam.exe (PowerShell printed no result)');
    stdout = result({ found: 1, signalled: 0, failed: 1, error: 1450 }).stdout;
    expect(await message(() => procs.kill('steam.exe'))).toBe('Could not end steam.exe (Windows error 1450)');
  });

  it.skipIf(!win)(
    'really lists this process by name, and really closes and kills nothing when no process has the name',
    async () => {
      const procs = new WindowsProcessController();
      expect(await procs.isRunning(basename(process.execPath))).toBe(true);
      expect(await procs.isRunning('onelaunch-no-such-image.exe')).toBe(false);
      await expect(procs.close('onelaunch-no-such-image.exe')).resolves.toBeUndefined();
      await expect(procs.kill('onelaunch-no-such-image.exe')).resolves.toBeUndefined();
      await expect(procs.kill('onelaunch-no-such-image.exe', { tree: false })).resolves.toBeUndefined();
    },
    60_000,
  );
});

describe('output encoding (B5)', () => {
  // What reg.exe prints under code page 65001, once the default exec has decoded it as UTF-8.
  const STEAM_PATH = '\r\nHKEY_CURRENT_USER\\Software\\Valve\\Steam\r\n    SteamPath    REG_SZ    d:/spiele/jürgen/steam\r\n\r\n';
  const UNINSTALL =
    '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Overwatch\r\n    DisplayName    REG_SZ    Overwatch™\r\n    InstallLocation    REG_SZ    D:\\Игры\\Łukasz\\ゲーム\\Overwatch\r\n\r\n';

  it('builds one cmd.exe line that switches the console to UTF-8 and then runs reg.exe', () => {
    expect(utf8RegCommand('C:\\WINDOWS\\System32\\reg.exe', ['query', 'HKEY_CURRENT_USER\\Software\\Valve\\Steam', '/v', 'SteamPath'])).toBe(
      '"chcp 65001>nul & "C:\\WINDOWS\\System32\\reg.exe" "query" "HKEY_CURRENT_USER\\Software\\Valve\\Steam" "/v" "SteamPath""',
    );
  });

  it('refuses anything cmd.exe would expand or interpret inside the quotes', () => {
    for (const bad of ['a"b', '%APPDATA%', 'a&b', 'a^b', 'a|b', 'a<b', 'a>b', 'a!b', 'a\nb']) {
      expect(() => utf8RegCommand('reg.exe', ['query', bad])).toThrow(/unexpected characters/);
    }
    expect(() => utf8RegCommand('C:\\evil & calc\\reg.exe', ['query', 'HKEY_CURRENT_USER\\Software'])).toThrow(/unexpected characters/);
  });

  it('keeps non-ASCII paths whole from the output to the parsed value', () => {
    expect(parseRegQueryOutput(STEAM_PATH, 'SteamPath')).toEqual({ type: 'REG_SZ', data: 'd:/spiele/jürgen/steam' });
    expect(parseRegQueryDump(UNINSTALL)[0]!.values).toEqual([
      { name: 'DisplayName', type: 'REG_SZ', data: 'Overwatch™' },
      { name: 'InstallLocation', type: 'REG_SZ', data: 'D:\\Игры\\Łukasz\\ゲーム\\Overwatch' },
    ]);
    expect(parseProcessJson('\uFEFF[{"Name":"Overwatch","Id":7,"Path":"D:\\\\Игры\\\\Łukasz\\\\Overwatch.exe"}]')).toEqual([
      { name: 'Overwatch', pid: 7, path: 'D:\\Игры\\Łukasz\\Overwatch.exe' },
    ]);
  });

  it('sends every registry read through that line, verbatim, and leaves writes on reg.exe itself', async () => {
    if (process.platform !== 'win32') return;
    const calls: { file: string; args: string[]; verbatim: boolean }[] = [];
    const reg = new WindowsRegistry(async (file, args, opts) => {
      calls.push({ file, args, verbatim: opts?.verbatim === true });
      return { stdout: STEAM_PATH };
    });
    expect(await reg.getString('HKCU', 'Software\\Valve\\Steam', 'SteamPath')).toBe('d:/spiele/jürgen/steam');
    await reg.getDword('HKCU', 'Software\\Valve\\Steam', 'RememberPassword');
    await reg.listValues('HKCU', 'Software\\Valve\\Steam');
    await reg.queryTree('HKCU', 'Software\\Valve\\Steam');
    await reg.setString('HKCU', 'Software\\Valve\\Steam', 'AutoLoginUser', '100% & done');
    expect(calls.slice(0, 4).every((c) => /System32[\\/]cmd\.exe$/i.test(c.file) && c.verbatim && c.args[3]!.startsWith('"chcp 65001>nul & "'))).toBe(true);
    expect(calls[4]).toMatchObject({ file: regExePath(), verbatim: false });
    expect(calls[4]!.args).toContain('100% & done');
  });

  it('reports a failed registry write without its command line, which holds the data (H1)', async () => {
    if (process.platform !== 'win32') return;
    const KEY = 'Software\\Blizzard Entertainment\\Battle.net\\UnifiedAuth';
    let failure: Record<string, unknown> = { code: 1, stderr: 'ERROR: Access is denied.\r\n' };
    const reg = new WindowsRegistry(async (file, args) => {
      throw Object.assign(new Error(`Command failed: ${file} ${args.join(' ')}\n${String(failure['stderr'] ?? '')}`), failure);
    });
    const message = async (): Promise<string> => ((await reg.setBinary('HKCU', KEY, 'AA11BB22', 'DEADBEEF00112233').catch((e: unknown) => e)) as Error).message;

    expect(await message()).toBe(`reg add failed for HKCU\\${KEY}\\AA11BB22: exit code 1: ERROR: Access is denied.`);
    failure = { code: 1, stderr: 'ERROR: Invalid syntax near /d deadbeef00112233\r\n' };
    expect(await message()).toBe(`reg add failed for HKCU\\${KEY}\\AA11BB22: exit code 1`);
    failure = { code: null, killed: true, signal: 'SIGTERM' };
    expect(await message()).toBe(`reg add failed for HKCU\\${KEY}\\AA11BB22: reg.exe timed out`);
    failure = { code: 'ENOENT' };
    expect(await message()).toBe(`reg add failed for HKCU\\${KEY}\\AA11BB22: ENOENT`);

    failure = { code: 5, stderr: 'ERROR: Access is denied.\r\n' };
    await expect(reg.deleteValue('HKCU', KEY, 'AA11BB22')).rejects.toThrow(
      `reg delete failed for HKCU\\${KEY}\\AA11BB22: exit code 5: ERROR: Access is denied.`,
    );
    await expect(reg.deleteValue('HKCU', KEY, 'AA11BB22')).rejects.not.toThrow(/Command failed/);
  });

  it('asks PowerShell for UTF-8 before it lists the processes', async () => {
    if (process.platform !== 'win32') return;
    const calls: string[][] = [];
    const procs = new WindowsProcessController(async (_file, args) => {
      calls.push(args);
      return { stdout: '[]' };
    });
    await procs.listProcesses();
    expect(calls[0]!.at(-1)).toBe(LIST_PROCESSES_PS);
    expect(LIST_PROCESSES_PS).toMatch(/^\[Console\]::OutputEncoding = New-Object System\.Text\.UTF8Encoding \$false\n/);
  });
});

describe('process listing without opening a process (S1)', () => {
  it('uses nothing that opens a process', () => {
    expect(LIST_PROCESSES_PS).not.toMatch(/Get-Process|MainModule|OpenProcess|Win32_Process|Get-CimInstance|Get-WmiObject/i);
    expect(LIST_PROCESSES_PS).toContain('[System.Diagnostics.Process]::GetProcesses()');
  });

  it('names this very process, with the path its file really has', async () => {
    if (process.platform !== 'win32') return;
    const listed = await new WindowsProcessController().listProcesses();
    const self = listed.find((p) => p.pid === process.pid);
    expect(self?.path?.toLowerCase()).toBe(realpathSync.native(process.execPath).toLowerCase());
    expect(listed.length).toBeGreaterThan(10);
    expect(listed.filter((p) => p.path !== null).every((p) => /^(?:[A-Za-z]:\\|\\\\)[^?�]+$/.test(p.path!))).toBe(true);
  }, 30_000);

  it('reports a failure without the script, which Node puts into the error message', async () => {
    if (process.platform !== 'win32') return;
    let failure: Record<string, unknown> = { code: 1, stderr: 'Add-Type : Cannot add type.\r\n    + CategoryInfo : InvalidData\r\n' };
    const procs = new WindowsProcessController(async (file, args) => {
      throw Object.assign(new Error(`Command failed: ${file} ${args.join(' ')}`), failure);
    });
    const message = async (): Promise<string> => ((await procs.listProcesses().catch((e: unknown) => e)) as Error).message;

    expect(await message()).toBe('Could not list the running processes (exit code 1: Add-Type : Cannot add type. + CategoryInfo : InvalidData)');
    failure = { code: null, killed: true, signal: 'SIGTERM' };
    expect(await message()).toBe('Could not list the running processes (PowerShell timed out)');
    failure = { code: 'ENOENT' };
    expect(await message()).toBe('Could not list the running processes (ENOENT)');
  });
});
