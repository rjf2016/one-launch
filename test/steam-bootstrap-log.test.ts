import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapLogMark, bootstrapLogPath, updateInProgress, updatingSince } from '../src/main/launchers/steam/bootstrap-log';

const stamp = (line: string): string => `[2026-09-11 12:56:02] ${line}`;

const PLAIN_START = [
  'Startup - updater built Sep  2 2026 18:32:43',
  'Startup - Steam Client launched with: d:\\games\\steam\\steam.exe',
  'Verifying installation...',
  'Verifying file sizes only',
  'Verification complete',
].map(stamp);

const UPDATE = [
  'Startup - updater built Sep  2 2026 18:32:43',
  'Checking for update on startup',
  'Checking for available updates...',
  'Downloaded new manifest: /steam_client_win64 version 1788652215, installed version 1785799196, existing pending version 0',
  'Downloading update (12,842 of 212,314 KB)...',
  'Download complete.',
  'Found pending update',
  'Installing update...',
  'Extracting package...',
  'Installing update...',
].map(stamp);

const RELAUNCH = ['Update complete, launching Steam...', 'Shutdown', 'Startup - updater built Sep  2 2026 18:32:43', 'Verifying installation...'].map(stamp);

describe('bootstrap_log.txt parsing', () => {
  it('sees no update in a plain start, or when the client only checked and found nothing', () => {
    expect(updateInProgress('')).toBe(false);
    expect(updateInProgress(PLAIN_START.join('\r\n'))).toBe(false);
    const checked = [
      ...PLAIN_START,
      stamp('Background update loop checking for update. . .'),
      stamp('Download skipped: /steam_client_win64 version 1788652215, installed version 1788652215, existing pending version 0'),
      stamp('Nothing to do'),
    ];
    expect(updateInProgress(checked.join('\n'))).toBe(false);
  });

  it('ignores the download a running client makes in the background, and counts the install at the next start', () => {
    const background = [
      ...PLAIN_START,
      stamp('Background update loop checking for update. . .'),
      stamp('Downloaded new manifest: /steam_client_win64 version 1779486452, installed version 1778281814, existing pending version 0'),
      stamp('Downloading update (141 of 269 KB)...'),
      stamp('Download complete.'),
    ];
    expect(updateInProgress(background.join('\r\n'))).toBe(false);
    const nextStart = [
      ...background,
      stamp('Shutdown'),
      stamp('Startup - updater built May  8 2026 15:40:38'),
      stamp('Download complete.'),
      stamp('Found pending update'),
    ];
    expect(updateInProgress(nextStart.join('\r\n'))).toBe(true);
    expect(updateInProgress([...nextStart, stamp('Installing update...'), ...RELAUNCH, stamp('Verification complete')].join('\r\n'))).toBe(false);
  });

  it('reports an update from its first line until the relaunched client has verified itself', () => {
    expect(updateInProgress(UPDATE.slice(0, 4).join('\r\n'))).toBe(true);
    expect(updateInProgress(UPDATE.join('\r\n'))).toBe(true);
    expect(updateInProgress([...UPDATE, ...RELAUNCH].join('\r\n'))).toBe(true);
    expect(updateInProgress([...UPDATE, ...RELAUNCH, stamp('Verification complete')].join('\r\n'))).toBe(false);
  });
});

describe('reading only what the updater appends', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'onelaunch-bootstrap-'));
    file = join(dir, 'bootstrap_log.txt');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('lives under <SteamPath>\\logs', () => {
    expect(bootstrapLogPath('D:\\Games\\Steam')).toBe(join('D:\\Games\\Steam', 'logs', 'bootstrap_log.txt'));
  });

  it('ignores an update from before the mark and copes with a missing file', () => {
    expect(bootstrapLogMark(file)).toBe(0);
    expect(updatingSince(file, 0)).toBe(false);
    writeFileSync(file, `${UPDATE.join('\r\n')}\r\n`);
    const mark = bootstrapLogMark(file);
    expect(updatingSince(file, 0)).toBe(true);
    expect(updatingSince(file, mark)).toBe(false);
    writeFileSync(file, `${stamp('Downloading update (1 of 2 KB)...')}\r\n`, { flag: 'a' });
    expect(updatingSince(file, mark)).toBe(true);
  });
});
