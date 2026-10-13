import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  classifyReason,
  latestOutcome,
  loginLogMark,
  loginLogPath,
  outcomeSince,
  parseLoginStates,
  readLoginLogSince,
} from '../src/main/launchers/steam/login-log';

const SAMPLE = [
  '[2026-09-12 15:00:43] Client version: 1788652215',
  '[2026-09-12 15:00:43] [ None ] Starting login',
  '[2026-09-12 15:00:43] [ None ] SetLoginState: WaitingForNetwork - OK',
  '[2026-09-12 15:00:43] [ WaitingForNetwork ] SetLoginState: WaitingForServerResponse - OK',
  '[2026-09-12 15:00:45] [ WaitingForServerResponse ] Received logon failure response',
  '[2026-09-12 15:00:45] [ WaitingForServerResponse ] SetLoginState: WaitingForCredentials - Account Logon Denied',
  '[2026-09-12 15:00:45] [ WaitingForCredentials ] UI Request: connect',
].join('\r\n');

describe('steamui_login.txt parsing', () => {
  it('extracts state transitions with their reason', () => {
    expect(parseLoginStates(SAMPLE)).toEqual([
      { state: 'WaitingForNetwork', reason: 'OK' },
      { state: 'WaitingForServerResponse', reason: 'OK' },
      { state: 'WaitingForCredentials', reason: 'Account Logon Denied' },
    ]);
  });

  it('reports the last decisive state, or null while Steam is still working', () => {
    expect(latestOutcome(parseLoginStates(SAMPLE))).toEqual({ kind: 'credentials', reason: 'Account Logon Denied', cause: 'guard-email' });
    expect(latestOutcome(parseLoginStates(`${SAMPLE}\n[x] [ WaitingForLibraryReady ] SetLoginState: Success - OK`))).toEqual({ kind: 'success' });
    expect(latestOutcome(parseLoginStates('[x] [ None ] SetLoginState: WaitingForNetwork - OK'))).toBeNull();
    expect(latestOutcome([])).toBeNull();
  });

  it("maps Steam's reason wording to what the user has to do", () => {
    expect(classifyReason('OK')).toBe('none');
    expect(classifyReason('')).toBe('none');
    expect(classifyReason('Account Logon Denied')).toBe('guard-email');
    expect(classifyReason('Account Login Denied Need Two Factor')).toBe('guard-mobile');
    expect(classifyReason('Two Factor Code Mismatch')).toBe('guard-mobile');
    expect(classifyReason('Invalid Password')).toBe('password');
    expect(classifyReason('License expired')).toBe('expired');
    expect(classifyReason('Rate Limit Exceeded')).toBe('rate-limit');
    expect(classifyReason('Service Unavailable')).toBe('other');
  });
});

describe('reading only what Steam appends', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'onelaunch-loginlog-'));
    file = join(dir, 'steamui_login.txt');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('lives under <SteamPath>\\logs', () => {
    expect(loginLogPath('D:\\Games\\Steam')).toBe(join('D:\\Games\\Steam', 'logs', 'steamui_login.txt'));
  });

  it('ignores history before the mark and sees lines added after it', () => {
    writeFileSync(file, `${SAMPLE}\n`);
    const mark = loginLogMark(file);
    expect(outcomeSince(file, mark)).toBeNull();
    writeFileSync(file, '[x] [ WaitingForLibraryReady ] SetLoginState: Success - OK\n', { flag: 'a' });
    expect(readLoginLogSince(file, mark)).toContain('Success - OK');
    expect(outcomeSince(file, mark)).toEqual({ kind: 'success' });
  });

  it('reads the end of a log that is larger than one read, not its start', () => {
    const old = '[x] [ WaitingForServerResponse ] SetLoginState: WaitingForCredentials - Invalid Password\n';
    const filler = '[x] [ None ] Starting login\n'.repeat(40);
    writeFileSync(file, `${old}${filler}[x] [ WaitingForLibraryReady ] SetLoginState: Success - OK\n`);
    expect(outcomeSince(file, 0)).toEqual({ kind: 'success' });
    const tail = readLoginLogSince(file, 0, 100);
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(100);
    expect(tail).not.toContain('Invalid Password');
    expect(tail.endsWith('SetLoginState: Success - OK\n')).toBe(true);
    // The clipped read starts in the middle of a line; that partial line is dropped.
    expect(tail.startsWith('[x] ')).toBe(true);
    // More than one read's worth appended since the mark: still the newest lines.
    expect(readLoginLogSince(file, old.length, 100)).toBe(tail);
  });

  it('copes with a missing file and with a log that was rotated', () => {
    expect(loginLogMark(file)).toBe(0);
    expect(outcomeSince(file, 0)).toBeNull();
    writeFileSync(file, `${SAMPLE}\n`);
    const mark = loginLogMark(file);
    writeFileSync(file, '[x] [ WaitingForServerResponse ] SetLoginState: WaitingForCredentials - Invalid Password\n');
    expect(outcomeSince(file, mark)).toEqual({ kind: 'credentials', reason: 'Invalid Password', cause: 'password' });
  });
});
