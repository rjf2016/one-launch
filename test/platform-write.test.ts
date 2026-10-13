import { describe, expect, it } from 'vitest';
import { parseProcessJson, WindowsProcessController } from '../src/main/platform/processes';
import { WindowsRegistry } from '../src/main/platform/registry';

const win = process.platform === 'win32';

/** Records every command instead of running it. */
function recorder(stdout = '') {
  const calls: { file: string; args: string[] }[] = [];
  const exec = async (file: string, args: string[]) => {
    calls.push({ file, args });
    return { stdout };
  };
  return { calls, exec };
}

describe.skipIf(!win)('WindowsRegistry command lines', () => {
  it('issues exactly the documented reg add / reg delete invocations', async () => {
    const { calls, exec } = recorder();
    const reg = new WindowsRegistry(exec);
    await reg.setString('HKCU', 'Software\\Valve\\Steam', 'AutoLoginUser', 'user_3');
    await reg.setDword('HKCU', 'Software\\Valve\\Steam', 'RememberPassword', 1);
    await reg.deleteValue('HKCU', 'Software\\Valve\\Steam', 'RememberPassword');
    expect(calls.map((c) => c.args)).toEqual([
      ['add', 'HKEY_CURRENT_USER\\Software\\Valve\\Steam', '/v', 'AutoLoginUser', '/t', 'REG_SZ', '/d', 'user_3', '/f'],
      ['add', 'HKEY_CURRENT_USER\\Software\\Valve\\Steam', '/v', 'RememberPassword', '/t', 'REG_DWORD', '/d', '1', '/f'],
      ['delete', 'HKEY_CURRENT_USER\\Software\\Valve\\Steam', '/v', 'RememberPassword', '/f'],
    ]);
    expect(calls.every((c) => /System32[\\/]reg\.exe$/i.test(c.file))).toBe(true);
  });

  it('refuses suspicious keys, names, and data before spawning anything', async () => {
    const { calls, exec } = recorder();
    const reg = new WindowsRegistry(exec);
    await expect(reg.setString('HKCU', 'Software\\Valve\\Steam', 'AutoLoginUser', 'a"b')).rejects.toMatchObject({ code: 'REGISTRY' });
    await expect(reg.setString('HKCU', 'Software\\Valve\\Steam', 'Auto/Login', 'x')).rejects.toMatchObject({ code: 'REGISTRY' });
    await expect(reg.setString('HKCU', 'Software\\Valve\\Steam\\..\\x', 'A', 'x')).rejects.toMatchObject({ code: 'REGISTRY' });
    await expect(reg.setDword('HKCU', 'Software\\Valve\\Steam', 'RememberPassword', -1)).rejects.toMatchObject({ code: 'REGISTRY' });
    expect(calls).toEqual([]);
  });

  it('treats a missing value as null on query and as success on delete', async () => {
    const missing = async () => {
      const err = new Error('exit 1') as Error & { code: number };
      err.code = 1;
      throw err;
    };
    const reg = new WindowsRegistry(missing);
    expect(await reg.getString('HKCU', 'Software\\Valve\\Steam', 'Nope')).toBeNull();
    await expect(reg.deleteValue('HKCU', 'Software\\Valve\\Steam', 'Nope')).resolves.toBeUndefined();
  });
});

describe.skipIf(!win)('WindowsProcessController command lines', () => {
  it('starts detached through the injected spawner, without running a command', async () => {
    const { calls, exec } = recorder();
    const spawned: { exe: string; args: readonly string[]; cwd: string | undefined }[] = [];
    const procs = new WindowsProcessController(exec, async (exe, args, opts) => {
      spawned.push({ exe, args, cwd: opts.cwd });
    });
    await procs.start('D:\\Games\\Steam\\steam.exe', ['-shutdown'], { cwd: 'D:\\Games\\Steam' });
    expect(spawned).toEqual([{ exe: 'D:\\Games\\Steam\\steam.exe', args: ['-shutdown'], cwd: 'D:\\Games\\Steam' }]);
    expect(calls).toEqual([]);
  });

  it('start() rejects at once when the executable cannot be started', async () => {
    const procs = new WindowsProcessController();
    await expect(procs.start('D:\\definitely\\missing\\launcher.exe', [], {})).rejects.toThrow(/Could not start/);
  });
});

describe('parseProcessJson', () => {
  it('accepts an array or a single object and drops entries without a name', () => {
    expect(parseProcessJson('[{"Name":"steam","Id":1,"Path":"D:\\\\Games\\\\Steam\\\\steam.exe"},{"Name":"System","Id":4,"Path":null},{"Id":9}]')).toEqual([
      { name: 'steam', pid: 1, path: 'D:\\Games\\Steam\\steam.exe' },
      { name: 'System', pid: 4, path: null },
    ]);
    expect(parseProcessJson('{"Name":"one","Id":2,"Path":"C:\\\\x.exe"}')).toEqual([{ name: 'one', pid: 2, path: 'C:\\x.exe' }]);
    expect(parseProcessJson('')).toEqual([]);
  });
});
