import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findSections, readSection, rewriteSection, sectionNames, splitIni } from '../src/main/launchers/epic/ini';
import {
  announcedRestart,
  eventsSince,
  lastSignIn,
  lastSignInInLog,
  logMark,
  maskReason,
  parseLogEvents,
  readLogSince,
  startupFinished,
} from '../src/main/launchers/epic/launcher-log';
import { isLibraryGame, launchUri, parseItemManifest, parseLauncherInstalled } from '../src/main/launchers/epic/manifests';
import { fingerprintOf, parseBlob, planSessionWrite, readSessionFromIni, serializeBlob, sessionBlobFromIni } from '../src/main/launchers/epic/session';

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', 'epic', name), 'utf8');
const ID3 = '33333333333333333333333333333333';

describe('Epic .item manifests', () => {
  it('parses the sanitized Rocket League manifest and normalizes its mixed separators', () => {
    const m = parseItemManifest(fixture('A0000000000000000000000000000001.item'));
    expect(m).toMatchObject({
      installationGuid: 'A0000000000000000000000000000001',
      appName: 'Sugar',
      displayName: 'Rocket League®',
      catalogNamespace: '0000000000000000000000000000000a',
      catalogItemId: '0000000000000000000000000000000b',
      installLocation: 'D:\\Placeholder\\Epic Games\\rocketleague',
      launchExecutable: 'Binaries\\Win64\\Launcher.exe',
      installSize: 42793420249,
      incomplete: false,
      mainGameAppName: 'Sugar',
      categories: ['public', 'games', 'applications'],
    });
    expect(isLibraryGame(m)).toBe(true);
    // Session ids and hashes stay out of the parsed shape.
    expect(JSON.stringify(m)).not.toMatch(/B0000000000000000000000000000002|1111111111111111111111111111111111111111/);
  });

  it('keeps DLC, incomplete installs, and engine installs out of the library', () => {
    const base = fixture('A0000000000000000000000000000001.item');
    expect(isLibraryGame(parseItemManifest(base.replace('"bIsIncompleteInstall": false', '"bIsIncompleteInstall": true')))).toBe(false);
    expect(isLibraryGame(parseItemManifest(base.replace('"MainGameAppName": "Sugar"', '"MainGameAppName": "OtherGame"')))).toBe(false);
    expect(isLibraryGame(parseItemManifest(base.replace('"public",\n\t\t"games",\n\t\t"applications"', '"public",\n\t\t"engines"')))).toBe(false);
    expect(isLibraryGame(parseItemManifest(base.replace('"public",\n\t\t"games",\n\t\t"applications"', '')))).toBe(true);
  });

  it('rejects manifests without an AppName or InstallLocation, and non-JSON', () => {
    expect(() => parseItemManifest('{"DisplayName":"x","InstallLocation":"C:\\\\x"}')).toThrow(/AppName/);
    expect(() => parseItemManifest('{"AppName":"x"}')).toThrow(/InstallLocation/);
    expect(() => parseItemManifest('not json')).toThrow(/JSON/);
  });

  it('parses LauncherInstalled.dat as a cross-check list', () => {
    expect(parseLauncherInstalled(fixture('LauncherInstalled.dat'))).toEqual([
      {
        appName: 'Sugar',
        installLocation: 'D:\\Placeholder\\Epic Games\\rocketleague',
        namespaceId: '0000000000000000000000000000000a',
        itemId: '0000000000000000000000000000000b',
      },
    ]);
    expect(() => parseLauncherInstalled('{}')).toThrow(/InstallationList/);
  });

  it('builds both launch URI forms and falls back to the app name without catalog ids', () => {
    const m = parseItemManifest(fixture('A0000000000000000000000000000001.item'));
    expect(launchUri(m, 'catalog')).toBe(
      'com.epicgames.launcher://apps/0000000000000000000000000000000a%3A0000000000000000000000000000000b%3ASugar?action=launch&silent=true',
    );
    expect(launchUri(m, 'appname')).toBe('com.epicgames.launcher://apps/Sugar?action=launch&silent=true');
    expect(launchUri({ appName: 'Sugar', catalogNamespace: null, catalogItemId: null }, 'catalog')).toBe(
      'com.epicgames.launcher://apps/Sugar?action=launch&silent=true',
    );
  });
});

describe('INI handling', () => {
  const ini = fixture('GameUserSettings.ini');

  it('splits and rejoins byte for byte, and finds every section in order', () => {
    const layout = splitIni(ini);
    expect(layout.eol).toBe('\r\n');
    expect(layout.trailingNewline).toBe(true);
    expect(
      findSections(layout.lines)
        .map((s) => s.name)
        .slice(0, 5),
    ).toEqual(['Launcher', 'Portal.OSS', '11111111111111111111111111111111_General', 'RememberMe', 'Offline']);
    expect(sectionNames(ini)).toHaveLength(18);
    expect(readSection(ini, 'RememberMe')).toMatchObject({ Enable: 'True' });
    expect(readSection(ini, 'Nope')).toBeNull();
  });

  it('replaces keys in place, removes keys, appends new keys before the trailing blank line, and leaves everything else alone', () => {
    const r = rewriteSection(ini, 'RememberMe', { Enable: 'False', Data: null, Extra: 'x' });
    expect(r.noop).toBe(false);
    expect(r.changes.map((c) => [c.key, c.before === null ? null : c.before.length > 0, c.after])).toEqual([
      ['Enable', true, 'False'],
      ['Data', true, null],
      ['Extra', null, 'x'],
    ]);
    const before = ini.split('\r\n');
    const after = r.text.split('\r\n');
    expect(after.length).toBe(before.length);
    const i = after.indexOf('[RememberMe]');
    expect(after.slice(i, i + 4)).toEqual(['[RememberMe]', 'Enable=False', 'Extra=x', '']);
    // Everything outside the section is untouched.
    expect(after.slice(0, i).join('\n')).toBe(before.slice(0, i).join('\n'));
    expect(after.slice(i + 4).join('\n')).toBe(before.slice(i + 4).join('\n'));
    expect(r.text.endsWith('\r\n')).toBe(true);
  });

  it('creates a missing section at the end and reports a no-op when nothing changes', () => {
    // A new section gets the launcher's own layout: one blank line before it and one after.
    const r = rewriteSection('[A]\r\nx=1\r\n', 'B', { k: 'v' });
    expect(r.text).toBe('[A]\r\nx=1\r\n\r\n[B]\r\nk=v\r\n\r\n');
    expect(rewriteSection('[A]\nx=1\n', 'B', { k: null }).noop).toBe(true);
    expect(rewriteSection('[A]\nx=1\n', 'A', { x: '1' }).noop).toBe(true);
    expect(rewriteSection('', 'A', { x: '1' }).text).toBe('[A]\nx=1\n');
  });
});

describe('Epic session blobs', () => {
  const ini = fixture('GameUserSettings.ini');

  it('reads the remembered session with a fingerprint and never echoes the blob in change descriptions', () => {
    const s = readSessionFromIni(ini);
    expect(s.remembered).toBe(true);
    expect(s.enable).toBe('True');
    expect(s.data?.length).toBe(128);
    expect(s.offlineData?.length).toBe(96);
    expect(s.fingerprint).toBe(fingerprintOf(s.data!));
    expect(readSessionFromIni('[RememberMe]\nEnable=False\n').remembered).toBe(false);
    expect(readSessionFromIni('[Launcher]\nx=1\n').fingerprint).toBeNull();

    const blob = sessionBlobFromIni(ini)!;
    expect(parseBlob(serializeBlob(blob))).toEqual(blob);
    expect(() => parseBlob('{"v":2}')).toThrow(/shape/);

    const other = { ...blob, rememberMe: { enable: 'True', data: 'QUJD'.repeat(40) }, offline: null };
    const write = planSessionWrite(ini, other);
    expect(write.noop).toBe(false);
    expect(readSessionFromIni(write.text)).toMatchObject({ remembered: true, data: other.rememberMe.data, offlineData: null });
    const shown = JSON.stringify(write.changes);
    expect(shown).not.toContain(blob.rememberMe.data);
    expect(shown).not.toContain(other.rememberMe.data);
    expect(write.changes.map((c) => c.where)).toEqual(['[RememberMe] Data, line 16', '[Offline] Data, line 19']);
    expect(write.changes[0]!.after).toMatch(/^\(160 characters, fingerprint [0-9a-f]{8}\)$/);
    expect(write.changes[1]!.after).toBe('(removed)');
  });

  it('signs the launcher out by dropping both Data values while keeping Enable=True', () => {
    const write = planSessionWrite(ini, null);
    expect(readSessionFromIni(write.text)).toMatchObject({ remembered: false, enable: 'True', data: null, offlineData: null });
    // Enable is sticky in the launcher: a False left behind by a switch would turn auto sign-in off for good.
    expect(readSessionFromIni(planSessionWrite(ini.replace('Enable=True', 'Enable=False'), null).text).enable).toBe('True');
    const restored = planSessionWrite(ini.replace('Enable=True', 'Enable=False'), sessionBlobFromIni(ini));
    expect(readSessionFromIni(restored.text).enable).toBe('True');
    expect(sectionNames(write.text)).toEqual(sectionNames(ini));
    expect(planSessionWrite(write.text, null).noop).toBe(true);
  });
});

describe('launcher log', () => {
  it('extracts sign-in outcomes with the account id, masking token ids in failures', () => {
    const ok = parseLogEvents(fixture('EpicGamesLauncher.log'));
    expect(ok).toEqual([{ kind: 'auto-sign-in' }, { kind: 'signed-in', accountId: ID3, at: '2026-09-11T17:09:08.138Z' }, { kind: 'ready' }]);
    expect(lastSignIn(ok)).toEqual({ ok: true, accountId: ID3, at: '2026-09-11T17:09:08.138Z' });

    const expired = parseLogEvents(fixture('EpicGamesLauncher-expired-then-manual.log'));
    expect(expired.map((e) => e.kind)).toEqual(['auto-sign-in', 'sign-in-failed', 'ready', 'manual-sign-in', 'signed-in', 'exit', 'exit']);
    expect(expired[1]).toEqual({ kind: 'sign-in-failed', reason: "Sorry the refresh token '…' is invalid. Reason: TOKEN_EXPIRED errorcode=18036" });
    expect(lastSignIn(expired.slice(0, 2))).toEqual({ ok: false, reason: "Sorry the refresh token '…' is invalid. Reason: TOKEN_EXPIRED errorcode=18036" });
    expect(lastSignIn(expired)).toEqual({ ok: true, accountId: ID3, at: '2026-09-11T17:08:59.278Z' });
    expect(lastSignIn([{ kind: 'auto-sign-in' }])).toBeNull();
    expect(maskReason('errormessage=x 0123456789abcdef0123456789abcdef y errorpath=z')).toBe('x … y');

    // Seen 2026-09-13: SignOut is logged on every normal shutdown and must not count as a sign-out.
    const shutdown = parseLogEvents(
      [
        `[2026.09.13-00.02.57:351][555]FAccountService::OnLoginComplete - 0 TRUE ${ID3} `,
        '[2026.09.13-00.04.23:616][627]FAccountService::SignOut',
        '[2026.09.13-00.04.23:968][628]LogCore: Engine exit requested (reason: Shutdown)',
        '[2026.09.13-00.04.24:088][628]Application: Restarting C:/Program Files (x86)/Epic Games/Launcher/Portal/Binaries/Win64/EpicGamesUpdater.exe with command: start -epicenv=Prod',
      ].join('\r\n'),
    );
    expect(shutdown.map((e) => e.kind)).toEqual(['signed-in', 'exit', 'restart']);
    expect(lastSignIn(shutdown)).toEqual({ ok: true, accountId: ID3, at: '2026-09-13T00:02:57.351Z' });
    expect(announcedRestart(shutdown)).toBe(true);
    expect(startupFinished(shutdown)).toBe(false);
    expect(startupFinished(ok)).toBe(true);
  });

  describe('reading only what the launcher appends, across log rotation', () => {
    let dir: string;
    let file: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'onelaunch-epiclog-'));
      file = join(dir, 'EpicGamesLauncher.log');
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('reads from the mark within one run and from the start once the launcher started a new log', () => {
      expect(logMark(file)).toEqual({ size: 0, opened: null });
      writeFileSync(file, 'Log file open, 09/11/26 13:08:02\r\n[..]FAccountService::AutoSignIn\r\n');
      const mark = logMark(file);
      expect(mark.opened).toBe('Log file open, 09/11/26 13:08:02');
      expect(readLogSince(file, mark)).toBe('');
      writeFileSync(file, `[..]FAccountService::OnLoginComplete - 0 TRUE ${ID3} \r\n`, { flag: 'a' });
      expect(eventsSince(file, mark)).toEqual([{ kind: 'signed-in', accountId: ID3, at: null }]);
      expect(lastSignInInLog(file)).toEqual({ ok: true, accountId: ID3, at: null });

      // The launcher restarted: same path, new first line, shorter file.
      writeFileSync(
        file,
        'Log file open, 09/11/26 13:09:07\r\n[..]FAccountService::AutoSignIn\r\n[..]FAccountService::OnLoginComplete - 0 FALSE  errormessage=nope\r\n',
      );
      expect(eventsSince(file, mark)).toEqual([{ kind: 'auto-sign-in' }, { kind: 'sign-in-failed', reason: 'nope' }]);
      expect(lastSignInInLog(file)).toEqual({ ok: false, reason: 'nope' });
      rmSync(file);
      expect(eventsSince(file, mark)).toEqual([]);
      expect(lastSignInInLog(file)).toBeNull();
    });

    it('reads the end of a log that is larger than one read, so the newest sign-in decides', () => {
      const head = `Log file open, 09/11/26 13:08:02\r\n[..]FAccountService::OnLoginComplete - 0 TRUE ${'2'.repeat(32)} \r\n`;
      const filler = '[..]LogOnline: Verbose: chatter\r\n'.repeat(40);
      const newest = `[..]FAccountService::OnLoginComplete - 0 TRUE ${ID3} \r\n`;
      writeFileSync(file, `${head}${filler}${newest}`);
      const tail = readLogSince(file, { size: 0, opened: null }, 120);
      expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(120);
      expect(tail.startsWith('[..]')).toBe(true);
      expect(lastSignIn(parseLogEvents(tail))).toEqual({ ok: true, accountId: ID3, at: null });
      // The run is still recognised by its first line, so a mark inside it reads on from the mark.
      const mark = { size: Buffer.byteLength(head) + Buffer.byteLength(filler), opened: 'Log file open, 09/11/26 13:08:02' };
      expect(readLogSince(file, mark, 120)).toBe(newest);
    });
  });
});

describe('ini with a UTF-8 BOM', () => {
  it('sees the first section and keeps the BOM on rewrite', () => {
    const text = '﻿[RememberMe]\r\nEnable=True\r\nData=old\r\n\r\n[Other]\r\nX=1\r\n';
    expect(sectionNames(text)).toEqual(['RememberMe', 'Other']);
    expect(readSection(text, 'RememberMe')).toEqual({ Enable: 'True', Data: 'old' });
    const out = rewriteSection(text, 'RememberMe', { Data: 'new' });
    expect(out.text.startsWith('﻿[RememberMe]')).toBe(true);
    expect(readSection(out.text, 'RememberMe')).toEqual({ Enable: 'True', Data: 'new' });
    expect(readSection(out.text, 'Other')).toEqual({ X: '1' });
  });
});
