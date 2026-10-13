import { sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeLauncherPath, samePath } from '../src/main/platform/fs-path';

const j = (...parts: string[]) => parts.join(sep);

describe('normalizeLauncherPath', () => {
  it('unifies mixed separators from Epic manifests', () => {
    expect(normalizeLauncherPath('C:\\Program Files\\Epic Games/rocketleague')).toBe(j('C:', 'Program Files', 'Epic Games', 'rocketleague'));
    expect(normalizeLauncherPath('Binaries/Win64/Launcher.exe')).toBe(j('Binaries', 'Win64', 'Launcher.exe'));
  });

  it('handles forward-slash Steam registry values', () => {
    expect(normalizeLauncherPath('d:/games/steam')).toBe(j('d:', 'games', 'steam'));
  });

  it('unescapes VDF double backslashes', () => {
    expect(normalizeLauncherPath('D:\\\\Games\\\\Steam')).toBe(j('D:', 'Games', 'Steam'));
  });

  it('strips trailing separators but keeps drive roots', () => {
    expect(normalizeLauncherPath('C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\')).toBe(j('C:', 'ProgramData', 'Epic', 'EpicGamesLauncher', 'Data'));
    expect(normalizeLauncherPath('C:\\')).toBe(`C:${sep}`);
  });
});

describe('samePath', () => {
  it('compares case- and separator-insensitively', () => {
    expect(samePath('d:/games/steam', 'D:\\Games\\Steam\\')).toBe(true);
    expect(samePath('D:\\Games\\Steam', 'D:\\Games\\Steam2')).toBe(false);
  });
});
