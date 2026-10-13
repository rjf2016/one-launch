import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  eventsSince,
  lastSignIn,
  lineTime,
  logMark,
  maskReason,
  newestClientLog,
  parseLogEvents,
  readLogSince,
  endedSignedOut,
} from '../src/main/launchers/battlenet/client-log';
import {
  BattlenetConfigError,
  detectLayout,
  maskLogin,
  parseConfig,
  planSavedAccountNames,
  readClientSettings,
  readGames,
  readUserPrefs,
  roundTrips,
  serializeConfig,
} from '../src/main/launchers/battlenet/config';
import { launchCommand, parseAggregate, parseProductDb, parseUninstallEntries, productCodes, PRODUCTS } from '../src/main/launchers/battlenet/products';
import { describeToken, fingerprintOf, parseBlob, serializeBlob, tokenValues } from '../src/main/launchers/battlenet/session';

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', 'battlenet', name), 'utf8');

describe('Battle.net.config', () => {
  const text = fixture('Battle.net.config');

  it('detects the Qt layout and reproduces the real file byte for byte', () => {
    expect(detectLayout(text)).toEqual({ eol: '\r\n', indent: 4, trailingNewline: true, escapeSlashes: true, bom: false });
    expect(roundTrips(text)).toBe(true);
    const { doc, layout } = parseConfig(text);
    expect(serializeConfig(doc, layout)).toBe(text);
    expect(Object.keys(doc)).toEqual(['Client', '0123456789abcdef', 'Games']);
  });

  it('reads the client settings and the Games timestamps', () => {
    const { doc } = parseConfig(text);
    const client = readClientSettings(doc);
    expect(client.autoLogin).toBe('true');
    expect(client.version).toBe('17778');
    expect(client.savedAccountNames).toEqual(['saved1@example.com', 'saved2@example.com', 'saved3@example.com', 'saved4@example.com', 'saved5@example.com']);
    const games = readGames(doc);
    expect(games.size).toBe(23);
    const ow = games.get('prometheus')!;
    expect(ow.serverUid).toBe('prometheus');
    expect(ow.lastPlayedAt).toMatch(/^2026-02-22T03:06:4\dZ$|^\d{4}-\d{2}-\d{2}T/);
    expect(ow.lastInstalledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(games.get('wow')!.lastInstalledAt).toBeNull();
    expect(games.get('battle_net')!.lastPlayedAt).toBeNull();
  });

  it('moves a login to the front of SavedAccountNames and touches nothing else', () => {
    const plan = planSavedAccountNames(text, 'SAVED3@example.com');
    expect(plan.noop).toBe(false);
    expect(plan.after).toEqual(['saved3@example.com', 'saved1@example.com', 'saved2@example.com', 'saved4@example.com', 'saved5@example.com']);
    expect(plan.changes).toEqual([
      {
        where: 'Client.SavedAccountNames',
        before: 's…@example.com, s…@example.com, saved3@example.com, s…@example.com, s…@example.com',
        after: 'saved3@example.com, s…@example.com, s…@example.com, s…@example.com, s…@example.com',
      },
    ]);
    const diff = text.split('\r\n').filter((line, i) => plan.text.split('\r\n')[i] !== line);
    expect(diff).toHaveLength(1);
    expect(diff[0]).toContain('"SavedAccountNames"');
    expect(plan.text.endsWith('\r\n')).toBe(true);
    expect(plan.text).toContain('"C:\\/Users\\/someone\\/Games"');
    expect(roundTrips(plan.text)).toBe(true);
  });

  it('adds a login that is not in the list and is a no-op when it is already first', () => {
    const added = planSavedAccountNames(text, 'new@example.com');
    expect(added.after[0]).toBe('new@example.com');
    expect(added.after).toHaveLength(6);
    const same = planSavedAccountNames(text, 'SAVED1@example.com');
    expect(same.noop).toBe(true);
    expect(same.text).toBe(text);
    expect(same.changes).toEqual([]);
  });

  it('refuses to rewrite a file whose layout it cannot reproduce', () => {
    const odd = text.replace('"AutoLogin": "true"', '"AutoLogin":   "true"');
    expect(roundTrips(odd)).toBe(false);
    expect(() => planSavedAccountNames(odd, 'saved2@example.com')).toThrow(BattlenetConfigError);
    expect(() => parseConfig('{')).toThrow(BattlenetConfigError);
    expect(() => parseConfig('[]')).toThrow(BattlenetConfigError);
  });

  it('reads the per-account close preferences and masks logins', () => {
    expect(readUserPrefs(fixture('0a1b2c3d.config'))).toEqual({ hideOnClose: false, displayExitPrompt: false });
    expect(readUserPrefs('{"User":{"Client":{"HideOnClose":"true"}}}')).toEqual({ hideOnClose: true, displayExitPrompt: null });
    expect(maskLogin('someone@example.com')).toBe('s…@example.com');
    expect(maskLogin('ab')).toBe('ab');
    expect(maskLogin('battletag')).toBe('b…');
  });
});

describe('products', () => {
  it('lists Blizzard products from the Uninstall tree by their --uid, leaving the client out', () => {
    const entries = parseUninstallEntries([
      {
        relative: 'Battle.net',
        values: [
          { name: 'DisplayName', type: 'REG_SZ', data: 'Battle.net' },
          { name: 'InstallLocation', type: 'REG_SZ', data: 'C:\\Program Files (x86)\\Battle.net' },
          {
            name: 'UninstallString',
            type: 'REG_SZ',
            data: '"C:\\ProgramData\\Battle.net\\Agent\\Blizzard Uninstaller.exe" --lang=enUS --uid=battle.net --displayname="Battle.net"',
          },
        ],
      },
      {
        relative: 'Overwatch',
        values: [
          { name: 'DisplayName', type: 'REG_SZ', data: 'Overwatch' },
          { name: 'InstallLocation', type: 'REG_SZ', data: 'C:/Users/someone/Games/Overwatch/' },
          {
            name: 'UninstallString',
            type: 'REG_SZ',
            data: '"C:\\ProgramData\\Battle.net\\Agent\\Blizzard Uninstaller.exe" --lang=enUS --uid=prometheus --displayname="Overwatch"',
          },
        ],
      },
      {
        relative: 'Hearthstone',
        values: [
          { name: 'DisplayName', type: 'REG_SZ', data: 'Hearthstone' },
          { name: 'InstallLocation', type: 'REG_SZ', data: 'D:\\Games\\BattleNet\\Hearthstone' },
          {
            name: 'UninstallString',
            type: 'REG_SZ',
            data: '"C:\\ProgramData\\Battle.net\\Agent\\Blizzard Uninstaller.exe" --lang=enUS --uid=hs_beta --displayname="Hearthstone"',
          },
        ],
      },
      { relative: '{AEB35C6C-B6D4-4AA0-8452-DE699737B5F6}', values: [{ name: 'UninstallString', type: 'REG_SZ', data: 'MsiExec.exe /X{AEB35C6C}' }] },
      { relative: 'Overwatch\\Sub', values: [{ name: 'UninstallString', type: 'REG_SZ', data: '"Blizzard Uninstaller.exe" --uid=nested' }] },
    ]);
    expect(entries.map((e) => [e.key, e.codename, e.name, e.installPath])).toEqual([
      ['Hearthstone', 'hs_beta', 'Hearthstone', 'D:\\Games\\BattleNet\\Hearthstone'],
      ['Overwatch', 'prometheus', 'Overwatch', 'C:\\Users\\someone\\Games\\Overwatch'],
    ]);
  });

  it('pulls codename, TACT code, and install path triples out of product.db', () => {
    const rec = (s: string): Buffer => Buffer.concat([Buffer.from([0x0a, s.length]), Buffer.from(s, 'latin1')]);
    const db = Buffer.concat([
      rec('agent'),
      rec('agent'),
      rec('C:/ProgramData/Battle.net/Agent'),
      Buffer.from([0x12, 0x03, 0x01, 0x02, 0x03]),
      rec('battle.net'),
      rec('bna'),
      rec('C:/Program Files (x86)/Battle.net'),
      rec('hs_beta'),
      rec('hsb'),
      rec('D:/Games/BattleNet/Hearthstone'),
      rec('prometheus'),
      rec('pro'),
      rec('C:/Users/someone/Games/Overwatch'),
      rec('enUS'),
    ]);
    expect(parseProductDb(db)).toEqual([
      { codename: 'hs_beta', tactCode: 'hsb', installPath: 'D:\\Games\\BattleNet\\Hearthstone' },
      { codename: 'prometheus', tactCode: 'pro', installPath: 'C:\\Users\\someone\\Games\\Overwatch' },
    ]);
    expect(parseProductDb(Buffer.from('nothing here'))).toEqual([]);
  });

  it('resolves launch codes from the table and from product.db, and builds both launch forms', () => {
    expect(productCodes('prometheus')).toEqual({ programCode: 'Pro', tactCode: 'pro', name: 'Overwatch', verified: true, steamAppId: '2357570' });
    expect(productCodes('hs_beta', 'hsb')!.programCode).toBe('WTCG');
    expect(productCodes('newgame', 'ngm')).toEqual({ programCode: 'NGM', tactCode: 'ngm', name: 'newgame', verified: false });
    expect(productCodes('newgame')).toBeNull();
    expect(PRODUCTS['wow']!.verified).toBe(false);
    expect(launchCommand(productCodes('prometheus')!, 'uri')).toEqual({ kind: 'uri', url: 'battlenet://game/pro' });
    expect(launchCommand(productCodes('prometheus')!, 'exec')).toEqual({ kind: 'exec', arg: '--exec=launch Pro' });
  });

  it('reads aggregate.json', () => {
    const list = parseAggregate(
      JSON.stringify({
        installed: [
          {
            name: 'Overwatch',
            product_id: 'pro',
            launch_uri: 'battlenet://game/pro',
            icon_path: 'C:/Users/someone/Games/Overwatch/Overwatch Launcher.exe',
            last_played_timestamp: 1771729603000,
          },
          { name: 'Broken' },
        ],
      }),
    );
    expect(list).toEqual([
      {
        name: 'Overwatch',
        tactCode: 'pro',
        launchUri: 'battlenet://game/pro',
        iconPath: 'C:\\Users\\someone\\Games\\Overwatch\\Overwatch Launcher.exe',
        lastPlayedAt: '2026-02-22T03:06:43.000Z',
      },
    ]);
    expect(parseAggregate('not json')).toEqual([]);
  });
});

describe('client log', () => {
  const text = fixture('battle.net-20260913T032048.091643.log');

  it('parses the run: start, sign-in attempt, sign-in with the account id, main window, close, exit', () => {
    const events = parseLogEvents(text);
    expect(events.map((e) => e.kind)).toEqual([
      'started',
      'product-state',
      'sign-in-attempt',
      'sign-in-attempt',
      'main-window',
      'signed-in',
      'close-requested',
      'exit',
    ]);
    expect(events[1]).toEqual({ kind: 'product-state', codename: 'prometheus', operation: 'Update', status: 'New', playable: null });
    expect(events[0]).toEqual({ kind: 'started', build: '2.52.11.17778' });
    expect(lastSignIn(events)).toEqual({ ok: true, accountId: '0a1b2c3d', at: '2026-09-13T03:20:55.149Z' });
    expect(endedSignedOut(events)).toBe(false);
    expect(lineTime('I 2026-09-13 03:20:55.149702 [BNLogin] {Main} x')).toBe('2026-09-13T03:20:55.149Z');
    expect(lineTime('no prefix')).toBeNull();
  });

  it('recognises failures, logouts, and launch requests, and masks reasons', () => {
    const events = parseLogEvents(
      [
        'I 2026-09-13 03:20:52.000000 [LoginController] {Main} Login_QueueUpdate (position=1)',
        'I 2026-09-13 03:20:52.500000 [BNLogin] {Main} BattleNetLogin::DeleteToken(): Deleting registry token because !m_lastEmailUsed.empty()',
        'E 2026-09-13 03:20:53.000000 [BNLogin] {Main} Login failed. error=ERROR_BAD_PASSWORD for someone@example.com token 0123456789abcdef0123',
        'I 2026-09-13 03:21:00.000000 [BNLogin] {Main} Logged into Battle.net successfully. |bnet=1:0:0a1b2c3d|game=2:1:1',
        'I 2026-09-13 03:22:00.000000 [GameLaunchController] {Main} Launch request Pro. isRunning=0 isLaunching=0 supportsMultibox=0',
        'D 2026-09-13 03:25:00.000000 [BNLogin] {Main} BattleNetLogin::Logout() : calling DeleteToken()',
        'I 2026-09-13 03:26:00.000000 [Main] {Main} Auto logout dialog is now signaling application exit',
      ].join('\r\n'),
    );
    expect(events.map((e) => e.kind)).toEqual(['sign-in-attempt', 'sign-in-failed', 'sign-in-failed', 'signed-in', 'launch-request', 'signed-out', 'exit']);
    expect(events[1]).toEqual({ kind: 'sign-in-failed', reason: 'the client discarded the token at start (its login page remembers a different account)' });
    expect(events[2]).toEqual({ kind: 'sign-in-failed', reason: 'ERROR_BAD_PASSWORD for … token …' });
    expect(events[4]).toEqual({ kind: 'launch-request', code: 'Pro' });
    expect(lastSignIn(events)).toEqual({ ok: false, reason: 'signed out' });
    expect(endedSignedOut(events)).toBe(true);
    expect(lastSignIn(events.slice(0, 4))).toEqual({ ok: true, accountId: '0a1b2c3d', at: '2026-09-13T03:21:00.000Z' });
    expect(lastSignIn(events.slice(0, 1))).toBeNull();
    expect(maskReason('x '.repeat(200))).toHaveLength(200);
  });

  describe('log files', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'onelaunch-bnet-log-'));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('picks the newest run by name and reads only what a new run or new bytes add', () => {
      expect(newestClientLog(join(dir, 'missing'))).toBeNull();
      mkdirSync(join(dir, 'Logs'));
      const logs = join(dir, 'Logs');
      writeFileSync(join(logs, 'libcef-20260913T032050.log'), 'x');
      writeFileSync(join(logs, 'battle.net-20260911T165706.655817.log'), text);
      expect(newestClientLog(logs)).toBe(join(logs, 'battle.net-20260911T165706.655817.log'));
      const mark = logMark(logs);
      expect(mark.size).toBe(Buffer.byteLength(text));
      expect(eventsSince(logs, mark)).toEqual([]);
      writeFileSync(
        join(logs, 'battle.net-20260911T165706.655817.log'),
        `${text}I 2026-09-11 17:00:00.000000 [BNLogin] {Main} Logged into Battle.net successfully. |bnet=1:0:ffffffff|game=1\r\n`,
      );
      expect(eventsSince(logs, mark)).toEqual([{ kind: 'signed-in', accountId: 'ffffffff', at: '2026-09-11T17:00:00.000Z' }]);
      writeFileSync(join(logs, 'battle.net-20260913T032048.091643.log'), text);
      expect(newestClientLog(logs)).toBe(join(logs, 'battle.net-20260913T032048.091643.log'));
      expect(eventsSince(logs, mark).map((e) => e.kind)[0]).toBe('started');
      expect(lastSignIn(eventsSince(logs, mark))!).toEqual({ ok: true, accountId: '0a1b2c3d', at: '2026-09-13T03:20:55.149Z' });
    });

    it('reads the end of a log that is larger than one read, so the newest sign-in decides', () => {
      mkdirSync(join(dir, 'Logs'));
      const logs = join(dir, 'Logs');
      const line = (id: string): string => `I 2026-09-13 03:20:55.149702 [BNLogin] {Main} Logged into Battle.net successfully. |bnet=1:0:${id}|game=1\r\n`;
      const filler = 'I 2026-09-13 03:21:00.000000 [Main] {Main} chatter\r\n'.repeat(40);
      writeFileSync(join(logs, 'battle.net-20260913T032048.091643.log'), `${line('0a1b2c3d')}${filler}${line('ffffffff')}`);
      const tail = readLogSince(logs, { file: null, size: 0 }, 200);
      expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(200);
      expect(tail.startsWith('I 2026-09-13')).toBe(true);
      expect(lastSignIn(parseLogEvents(tail))).toMatchObject({ ok: true, accountId: 'ffffffff' });
    });

    it('ignores the short log a --uri / --exec forwarder process leaves behind (seen 2026-09-13)', () => {
      mkdirSync(join(dir, 'Logs'));
      const logs = join(dir, 'Logs');
      writeFileSync(join(logs, 'battle.net-20260913T032048.091643.log'), text);
      writeFileSync(
        join(logs, 'battle.net-20260913T042043.512278.log'),
        [
          'I 2026-09-13 04:20:43.512821 [Main] {Main} Logging started for Battle.net build 2.52.11.17778',
          'I 2026-09-13 04:20:43.514633 [Main] {Main} Command line arguments: {[0]=--uri=battlenet://game/pro}',
          'I 2026-09-13 04:20:43.515434 [Main] {Main} Launched with uri: battlenet://game/pro',
          'I 2026-09-13 04:20:43.515882 [Main] {Main} Opening IPC shared memory. queueName=User:x:Battle.net IPC ShMem mode=client',
          'I 2026-09-13 04:20:43.515951 [Main] {Main} Leaving because another instance of battle.net is running',
        ].join('\r\n'),
      );
      expect(newestClientLog(logs)).toBe(join(logs, 'battle.net-20260913T032048.091643.log'));
      expect(lastSignIn(eventsSince(logs, { file: null, size: 0 }))!.ok).toBe(true);
    });
  });
});

describe('session blobs', () => {
  it('keeps REG_BINARY values only, fingerprints them, and round-trips the stored shape', () => {
    const values = tokenValues([
      { name: 'AA11BB22', type: 'REG_BINARY', data: '01000000D08C9DDF' },
      { name: 'Stray', type: 'REG_SZ', data: 'text' },
      { name: 'Odd', type: 'REG_BINARY', data: 'abc' },
    ]);
    expect(values).toEqual([{ name: 'AA11BB22', hex: '01000000d08c9ddf' }]);
    const fp = fingerprintOf('01000000D08C9DDF');
    expect(fp).toBe(fingerprintOf('01000000d08c9ddf'));
    expect(fp).toHaveLength(64);
    const json = serializeBlob({ v: 1, unifiedAuth: values[0]! });
    expect(parseBlob(json)).toEqual({ v: 1, unifiedAuth: { name: 'AA11BB22', hex: '01000000d08c9ddf' } });
    expect(parseBlob('{"v":2,"unifiedAuth":{"name":"AA11BB22","hex":"01FF"},"cookies":"abcd"}')).toEqual({
      v: 1,
      unifiedAuth: { name: 'AA11BB22', hex: '01ff' },
    });
    expect(() => parseBlob('{"v":1}')).toThrow(/unexpected shape/);
    expect(() => parseBlob('{"v":1,"unifiedAuth":{"name":"x","hex":"zz"}}')).toThrow(/unexpected shape/);
    expect(describeToken(values[0]!)).toBe(`(8 bytes, fingerprint ${fp.slice(0, 8)})`);
    expect(describeToken(null)).toBe('(absent)');
  });
});
