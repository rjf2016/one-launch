import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gameWithRunningProcess } from '../src/main/launchers/running-game';
import type { InstalledGame } from '../src/shared/models';

const game = (name: string, installPath: string): InstalledGame => ({
  launcher: 'epic',
  launcherGameId: name,
  name,
  installPath,
  libraryPath: join(installPath, '..'),
  sizeOnDiskBytes: null,
  lastPlayedAt: null,
  needsUpdate: false,
});
const proc = (path: string | null, pid = 7): { name: string; pid: number; path: string | null } => ({ name: 'game', pid, path });

let root: string;

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'onelaunch-running-')));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('gameWithRunningProcess', () => {
  it('matches a process under a game folder as the launcher records it, whatever the case', async () => {
    const games = [game('Rocket', 'D:\\Placeholder\\Games\\Rocket'), game('RocketLeague', 'D:\\Placeholder\\Games\\RocketLeague')];
    expect(await gameWithRunningProcess([proc('d:\\placeholder\\games\\rocketleague\\Binaries\\Win64\\RocketLeague.exe')], games)).toBe(games[1]);
    expect(await gameWithRunningProcess([proc('D:\\Placeholder\\Games\\Rocket\\Rocket.exe')], games)).toBe(games[0]);
  });

  it('reports none for a process elsewhere, a process without a path, and a folder that is only a name prefix', async () => {
    const games = [game('Rocket', 'D:\\Placeholder\\Games\\Rocket')];
    expect(await gameWithRunningProcess([proc('C:\\Windows\\notepad.exe'), proc(null, 4)], games)).toBeNull();
    expect(await gameWithRunningProcess([proc('D:\\Placeholder\\Games\\RocketLeague\\RocketLeague.exe')], games)).toBeNull();
    expect(await gameWithRunningProcess([proc('D:\\Placeholder\\Games\\Rocket')], games)).toBeNull();
    expect(await gameWithRunningProcess([], games)).toBeNull();
  });

  it('finds a game installed through a junction, whose processes Windows reports at the real folder', async () => {
    if (process.platform !== 'win32') return;
    const real = join(root, 'Other Drive', 'Rocket');
    const recorded = join(root, 'Library', 'Rocket');
    mkdirSync(join(real, 'Binaries'), { recursive: true });
    mkdirSync(join(root, 'Library'));
    symlinkSync(real, recorded, 'junction');
    const games = [game('Rocket', recorded)];

    expect(await gameWithRunningProcess([proc(join(real, 'Binaries', 'Rocket.exe'))], games)).toBe(games[0]);
    expect(await gameWithRunningProcess([proc(join(recorded, 'Binaries', 'Rocket.exe'))], games)).toBe(games[0]);
    expect(await gameWithRunningProcess([proc(join(root, 'Other Drive', 'Elsewhere', 'x.exe'))], games)).toBeNull();
  });

  it('never resolves a folder that is not a drive path, so a relative one cannot stand for the folder the app runs in', async () => {
    const here = proc(join(process.cwd(), 'node.exe'));
    expect(await gameWithRunningProcess([here], [game('Dot', '.'), game('Empty', ''), game('Up', '..\\..')])).toBeNull();
  });
});
