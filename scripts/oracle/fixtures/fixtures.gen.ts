/**
 * Generates <out>/fixtures from One Launch's own code (the real migrations, services, journal, backup, logger and
 * manifest modules). Run from the one-launch repo root:
 *   node scripts/oracle/generate.mjs fixtures --out <folder>
 * It is a vitest file only so the repo's TypeScript modules load with the @shared alias; it asserts nothing beyond sanity checks.
 * Everything written is a placeholder: logins under example.com, made-up ids, FakeVault (XOR 0x5a) in place of DPAPI.
 */
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'vitest';
import Database from 'better-sqlite3';
import { resolveOut } from '../lib/out.mjs';

const REPO = resolve(import.meta.dirname, '../../..');
const OUT = join(resolveOut(), 'fixtures');
const GENERATED = ['data-folder', 'db', 'journal', 'settings', 'updates', 'dev-only', 'launchers', 'external'];
const SCRATCH = join(tmpdir(), 'one-launch-fixture-gen');

import { MIGRATIONS } from '../../../src/main/db/migrations/index';
import { openDatabase, migrate, backupDatabase } from '../../../src/main/db/index';
import { SettingsService } from '../../../src/main/services/settings';
import { AccountsService } from '../../../src/main/services/accounts';
import { SecretStore } from '../../../src/main/services/secrets';
import { LauncherSessionStore } from '../../../src/main/services/sessions';
import { LibraryService } from '../../../src/main/services/library';
import { SwitchJournal } from '../../../src/main/services/switch-journal';
import { BackupService } from '../../../src/main/services/backup';
import { initLogging, createLogger, redactAccountNames, FileSink, setLogLevel } from '../../../src/main/services/logger';
import { signManifest, verifyManifest, publicKeyOf, keyIdOf } from '../../../src/main/updates/manifest';
import { FakeReport } from '../../../src/main/launchers/sim/report';
import { FakeVault } from '../../../test/helpers/fake-vault';
import { fingerprintOf as epicFp } from '../../../src/main/launchers/epic/session';
import { fingerprintOf as bnetFp } from '../../../src/main/launchers/battlenet/session';
import { fingerprintOf as riotFp } from '../../../src/main/launchers/riot/session';
import { UNOWNED_SESSION_PIN } from '../../../src/main/launchers/epic/adapter';

type Db = InstanceType<typeof Database>;

const vault = new FakeVault();
const PROBE_VALUE = 'one-launch-vault-probe-v1';
const silentLog = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLog;
  },
} as never;

function reset(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

/** Leaves a single-file database behind (no -wal/-shm) so the fixture is one file. */
function closeCompact(db: Db): void {
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.pragma('journal_mode = DELETE');
  db.close();
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
]);
const ICO = Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x10, 0x10, 0x00, 0x00, 0x01, 0x00, 0x20, 0x00, 0x68, 0x04, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00]);

interface Seeded {
  accounts: Record<string, string>;
  games: Record<string, string>;
}

/** The realistic data folder: every table populated the way the app populates it. */
function seedRealistic(dbPath: string, dataDir: string): Seeded {
  const db = openDatabase(dbPath);
  migrate(db);
  const settings = new SettingsService(db);
  const accounts = new AccountsService(db, vault);
  const secrets = new SecretStore(db, vault);
  const sessions = new LauncherSessionStore(db, vault);
  const library = new LibraryService(db);

  // settings (the app seeds whatsNew.lastSeen on a brand-new DB; the rest are what a user who changed things would have)
  settings.set('whatsNew.lastSeen', '1.0.0-beta.3');
  settings.set('firstRun.dismissed', 'true');
  settings.set('window.bounds', JSON.stringify({ x: 120, y: 80, width: 1400, height: 860, maximized: false }));
  settings.set('backups.keep', '50');
  settings.set('steam.autoLogin', 'false');
  settings.set('riot.pressPlay', 'true');
  settings.set('logLevel', 'debug');
  settings.set('steam.path', 'D:\\Games\\Steam');

  // secrets
  secrets.set('vault.probe', PROBE_VALUE);
  secrets.set('steamgriddb.apiKey', 'placeholderplaceholderplaceholder0000');
  secrets.set('diagnostics.roundtrip', 'roundtrip-ok');

  // accounts (same placeholders as test/fake-launchers/all-four/scenario.json)
  const a: Record<string, string> = {};
  const mk = (
    launcher: string,
    displayName: string,
    login: string,
    launcherUid: string | null,
    password: string | null,
    tags: string[] = [],
    notes = '',
  ): string => accounts.create({ launcher: launcher as never, displayName, login, launcherUid, password, tags, notes }).id;
  a.steam1 = mk('steam', 'Persona One', 'user_1', '76561198000000001', null, ['main'], 'Main Steam account.');
  a.steam3 = mk('steam', 'Persona Three', 'user_3', '76561198000000003', 'pw-three', ['alt', 'smurf']);
  a.epicMain = mk('epic', 'Main', 'main@example.com', '33333333333333333333333333333333', null);
  a.epicAlt = mk('epic', 'Alt', 'alt@example.com', '22222222222222222222222222222222', null, ['alt']);
  a.epicNew = mk('epic', 'New', 'new@example.com', null, 'pw-new', [], 'Created by hand, never signed in through One Launch yet.');
  a.bnetMain = mk('battlenet', 'Main', 'saved1@example.com', '0a1b2c3d', null);
  a.bnetAlt = mk('battlenet', 'Alt', 'saved3@example.com', '0b2c3d4e', null);
  a.riotMain = mk('riot', 'Riot Main', 'riot_main', '11111111-1111-4111-8111-111111111111', null);
  a.riotAlt = mk('riot', 'Riot Alt', 'riot_alt', '33333333-3333-4333-8333-333333333333', 'pw-alt', ['ranked']);
  accounts.touchLastUsed(a.steam1, new Date('2026-11-01T18:04:12.000Z'));
  accounts.touchLastUsed(a.riotMain, new Date('2026-11-03T20:11:40.000Z'));

  // sessions (blobs are placeholders of the real shape; FakeVault stands in for DPAPI)
  const epicData = 'YmxvYi1mb3ItYWx0LWJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYg==';
  sessions.save({
    accountId: a.epicAlt,
    launcher: 'epic',
    launcherUid: '22222222222222222222222222222222',
    blob: JSON.stringify({ v: 1, rememberMe: { enable: 'True', data: epicData }, offline: null }),
    fingerprint: epicFp(epicData),
  });
  sessions.markVerified(a.epicAlt);
  const bnetHex = '01000000d08c9ddf0002abababababababababababababababababababababababababababababababababababababab';
  sessions.save({
    accountId: a.bnetAlt,
    launcher: 'battlenet',
    launcherUid: '0b2c3d4e',
    blob: JSON.stringify({ v: 1, unifiedAuth: { name: 'B1B1B1B1', hex: bnetHex } }),
    fingerprint: bnetFp(bnetHex),
  });
  sessions.markStale(a.bnetAlt, 'Deleting registry token');
  const riotFile = readFileSync(join(REPO, 'test/fixtures/riot/RiotGamesPrivateSettings.yaml'), 'utf8');
  sessions.save({
    accountId: a.riotMain,
    launcher: 'riot',
    launcherUid: '11111111-1111-4111-8111-111111111111',
    blob: JSON.stringify({ v: 1, file: riotFile }),
    fingerprint: riotFp('placeholder-refresh-token-for-riot-main-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
  });

  // games: a sync per launcher, as the scan does; one Steam game later disappears (installed = 0)
  const now = '2026-11-05T19:30:00.000Z';
  library.sync('steam', [
    {
      launcher: 'steam',
      launcherGameId: '252950',
      name: 'Rocket League',
      installPath: 'D:\\Games\\Steam\\steamapps\\common\\rocketleague',
      libraryPath: 'D:\\Games\\Steam',
      sizeOnDiskBytes: 21_474_836_480,
      lastPlayedAt: '2026-11-01T17:50:00.000Z',
      needsUpdate: false,
    },
    {
      launcher: 'steam',
      launcherGameId: '730',
      name: 'Counter-Strike 2',
      installPath: 'D:\\Games\\Steam\\steamapps\\common\\Counter-Strike Global Offensive',
      libraryPath: 'D:\\Games\\Steam',
      sizeOnDiskBytes: 36_000_000_000,
      lastPlayedAt: null,
      needsUpdate: true,
    },
    {
      launcher: 'steam',
      launcherGameId: '1091500',
      name: 'Cyberpunk 2077',
      installPath: 'E:\\SteamLibrary\\steamapps\\common\\Cyberpunk 2077',
      libraryPath: 'E:\\SteamLibrary',
      sizeOnDiskBytes: 70_000_000_000,
      lastPlayedAt: '2026-09-12T21:00:00.000Z',
      needsUpdate: false,
    },
  ] as never);
  library.sync('steam', [
    {
      launcher: 'steam',
      launcherGameId: '252950',
      name: 'Rocket League',
      installPath: 'D:\\Games\\Steam\\steamapps\\common\\rocketleague',
      libraryPath: 'D:\\Games\\Steam',
      sizeOnDiskBytes: 21_474_836_480,
      lastPlayedAt: '2026-11-01T17:50:00.000Z',
      needsUpdate: false,
    },
    {
      launcher: 'steam',
      launcherGameId: '730',
      name: 'Counter-Strike 2',
      installPath: 'D:\\Games\\Steam\\steamapps\\common\\Counter-Strike Global Offensive',
      libraryPath: 'D:\\Games\\Steam',
      sizeOnDiskBytes: 36_000_000_000,
      lastPlayedAt: null,
      needsUpdate: true,
    },
  ] as never);
  library.sync('epic', [
    {
      launcher: 'epic',
      launcherGameId: 'Sugar',
      name: 'Rocket League®',
      installPath: 'D:\\Games\\Epic Games\\rocketleague',
      libraryPath: 'D:\\Games\\Epic Games',
      sizeOnDiskBytes: 22_000_000_000,
      lastPlayedAt: null,
      needsUpdate: false,
    },
    {
      launcher: 'epic',
      launcherGameId: 'Fortnite',
      name: 'Fortnite',
      installPath: 'D:\\Games\\Epic Games\\Fortnite',
      libraryPath: 'D:\\Games\\Epic Games',
      sizeOnDiskBytes: 90_000_000_000,
      lastPlayedAt: null,
      needsUpdate: false,
    },
  ] as never);
  library.sync('battlenet', [
    {
      launcher: 'battlenet',
      launcherGameId: 'prometheus',
      name: 'Overwatch',
      installPath: 'C:\\Program Files (x86)\\Overwatch',
      libraryPath: 'C:\\Program Files (x86)',
      sizeOnDiskBytes: null,
      lastPlayedAt: '2026-10-30T22:15:03.000Z',
      needsUpdate: true,
    },
    {
      launcher: 'battlenet',
      launcherGameId: 'hs_beta',
      name: 'Hearthstone',
      installPath: 'C:\\Program Files (x86)\\Hearthstone',
      libraryPath: 'C:\\Program Files (x86)',
      sizeOnDiskBytes: null,
      lastPlayedAt: null,
      needsUpdate: false,
    },
  ] as never);
  library.sync('riot', [
    {
      launcher: 'riot',
      launcherGameId: 'valorant.live',
      name: 'VALORANT',
      installPath: 'D:\\Riot Games\\VALORANT\\live',
      libraryPath: 'D:\\Riot Games',
      sizeOnDiskBytes: null,
      lastPlayedAt: '2026-11-03T20:12:00.000Z',
      needsUpdate: false,
    },
    {
      launcher: 'riot',
      launcherGameId: 'league_of_legends.live',
      name: 'League of Legends',
      installPath: 'D:\\Riot Games\\League of Legends',
      libraryPath: 'D:\\Riot Games',
      sizeOnDiskBytes: null,
      lastPlayedAt: null,
      needsUpdate: false,
    },
  ] as never);
  const g: Record<string, string> = {};
  for (const row of db.prepare('SELECT id, launcher_game_id FROM games').all() as { id: string; launcher_game_id: string }[]) g[row.launcher_game_id] = row.id;

  // artwork rows and files, as the artwork service leaves them
  const artworkDir = join(dataDir, 'artwork');
  const art = (gameId: string, source: string, kinds: Record<string, [string, Buffer]>, fetchedAt: string): void => {
    mkdirSync(join(artworkDir, gameId), { recursive: true });
    const paths: Record<string, string | null> = { grid: null, hero: null, logo: null };
    for (const [kind, [ext, bytes]] of Object.entries(kinds)) {
      writeFileSync(join(artworkDir, gameId, `${kind}.${ext}`), bytes);
      paths[kind] = `${gameId}/${kind}.${ext}`;
    }
    db.prepare('INSERT INTO artwork (game_id, source, grid_path, hero_path, logo_path, fetched_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      gameId,
      source,
      paths.grid,
      paths.hero,
      paths.logo,
      fetchedAt,
    );
  };
  art(g['252950']!, 'steamcdn', { grid: ['jpg', JPEG], hero: ['jpg', JPEG], logo: ['png', PNG] }, '2026-11-05T19:30:04.000Z');
  art(g['730']!, 'steamcdn', { grid: ['jpg', JPEG], hero: ['jpg', JPEG] }, '2026-11-05T19:30:05.000Z');
  art(g['Sugar']!, 'steamgriddb', { grid: ['png', PNG] }, '2026-11-05T19:30:07.000Z');
  art(g['prometheus']!, 'manual', { grid: ['webp', Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1')] }, '2026-10-02T10:00:00.000Z');
  art(g['valorant.live']!, 'launcher', { grid: ['ico', ICO] }, '2026-11-05T19:30:09.000Z');
  db.prepare('INSERT INTO artwork_attempts (game_id, attempted_at, error) VALUES (?, ?, ?)').run(
    g['valorant.live']!,
    '2026-11-05T19:30:09.000Z',
    'No cover found online; showing the game’s own icon',
  );
  db.prepare('INSERT INTO artwork_attempts (game_id, attempted_at, error) VALUES (?, ?, ?)').run(
    g['hs_beta']!,
    '2026-11-05T19:30:10.000Z',
    'No match on Steam (searched "Hearthstone")',
  );

  // launch history: one row per job that had a game; ok / failed / cancelled
  const hist = db.prepare('INSERT INTO launch_history (id, game_id, account_id, launched_at, result) VALUES (?, ?, ?, ?, ?)');
  hist.run(randomUUID(), g['252950']!, a.steam1, '2026-10-20T19:00:00.000Z', 'ok');
  hist.run(randomUUID(), g['252950']!, a.steam3, '2026-10-25T20:30:00.000Z', 'ok');
  hist.run(randomUUID(), g['252950']!, a.steam1, '2026-11-01T18:04:12.000Z', 'ok');
  hist.run(randomUUID(), g['730']!, a.steam1, '2026-10-28T21:00:00.000Z', 'failed');
  hist.run(randomUUID(), g['prometheus']!, a.bnetMain, '2026-10-30T22:15:03.000Z', 'ok');
  hist.run(randomUUID(), g['prometheus']!, a.bnetAlt, '2026-10-31T09:00:00.000Z', 'cancelled');
  hist.run(randomUUID(), g['valorant.live']!, a.riotMain, '2026-11-03T20:11:40.000Z', 'ok');
  hist.run(randomUUID(), g['Sugar']!, a.epicAlt, '2026-10-05T12:00:00.000Z', 'ok');

  closeCompact(db);
  return { accounts: a, games: g };
}

function seedV1(dbPath: string): void {
  const db = openDatabase(dbPath);
  migrate(db, MIGRATIONS.slice(0, 1));
  const now = '2026-01-10T12:00:00.000Z';
  const acc = db.prepare(
    'INSERT INTO accounts (id, launcher, display_name, login, secret_enc, launcher_uid, tags, notes, last_used_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  acc.run(randomUUID(), 'steam', 'Persona One', 'user_1', null, '76561198000000001', '["main"]', '', null, now, now);
  acc.run(randomUUID(), 'steam', 'Persona Three', 'user_3', vault.encrypt('pw-three'), '76561198000000003', '[]', 'notes', now, now, now);
  acc.run(randomUUID(), 'epic', 'Main', 'main@example.com', null, null, '[]', '', null, now, now);
  const gameId = randomUUID();
  db.prepare('INSERT INTO games (id, launcher, launcher_game_id, name, install_path, installed, last_seen_at) VALUES (?, ?, ?, ?, ?, 1, ?)').run(
    gameId,
    'steam',
    '252950',
    'Rocket League',
    'C:\\Program Files (x86)\\Steam\\steamapps\\common\\rocketleague',
    now,
  );
  db.prepare('INSERT INTO artwork (game_id, source, grid_path, hero_path, logo_path, fetched_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    gameId,
    'steamcdn',
    `${gameId}/grid.jpg`,
    null,
    null,
    now,
  );
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('dryRun', 'true');
  db.prepare('INSERT INTO secrets (key, value_enc, updated_at) VALUES (?, ?, ?)').run(
    'steamgriddb.apiKey',
    vault.encrypt('placeholderplaceholderplaceholder0000'),
    now,
  );
  closeCompact(db);
}

function seedEmpty(dbPath: string): void {
  const db = openDatabase(dbPath);
  migrate(db);
  closeCompact(db);
}

function seedLarge(dbPath: string): void {
  const db = openDatabase(dbPath);
  migrate(db);
  const launchers = ['steam', 'epic', 'battlenet', 'riot'];
  const now = '2026-11-05T19:30:00.000Z';
  const ins = db.transaction(() => {
    const acc = db.prepare(
      'INSERT INTO accounts (id, launcher, display_name, login, secret_enc, launcher_uid, tags, notes, last_used_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const accountIds: string[] = [];
    for (let i = 0; i < 200; i++) {
      const id = randomUUID();
      accountIds.push(id);
      const launcher = launchers[i % 4]!;
      acc.run(
        id,
        launcher,
        `Account ${String(i + 1).padStart(3, '0')}`,
        `user${i + 1}@example.com`,
        i % 3 === 0 ? vault.encrypt(`pw-${i}`) : null,
        launcher === 'steam' ? `7656119800${String(i).padStart(7, '0')}` : null,
        JSON.stringify(i % 5 === 0 ? ['alt'] : []),
        '',
        null,
        now,
        now,
      );
    }
    const game = db.prepare(
      'INSERT INTO games (id, launcher, launcher_game_id, name, install_path, installed, last_seen_at, needs_update, last_played_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const art = db.prepare('INSERT INTO artwork (game_id, source, grid_path, hero_path, logo_path, fetched_at) VALUES (?, ?, ?, ?, ?, ?)');
    const gameIds: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const id = randomUUID();
      gameIds.push(id);
      const launcher = launchers[i % 4]!;
      game.run(
        id,
        launcher,
        `game-${i}`,
        `Game ${String(i + 1).padStart(4, '0')}`,
        `D:\\Games\\${launcher}\\game-${i}`,
        i % 20 === 0 ? 0 : 1,
        now,
        i % 50 === 0 ? 1 : 0,
        i % 3 === 0 ? now : null,
      );
      if (i % 2 === 0) art.run(id, 'steamcdn', `${id}/grid.jpg`, `${id}/hero.jpg`, null, now);
    }
    const hist = db.prepare('INSERT INTO launch_history (id, game_id, account_id, launched_at, result) VALUES (?, ?, ?, ?, ?)');
    for (let i = 0; i < 10_000; i++) {
      const t = new Date(Date.UTC(2026, 0, 1) + i * 3_600_000).toISOString();
      hist.run(randomUUID(), gameIds[i % 1000]!, accountIds[i % 200]!, t, i % 17 === 0 ? 'failed' : i % 29 === 0 ? 'cancelled' : 'ok');
    }
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('whatsNew.lastSeen', '1.0.0-beta.3');
  });
  ins();
  closeCompact(db);
}

function journalFixtures(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const file = join(SCRATCH, 'journal', 'switch.json');
  mkdirSync(join(SCRATCH, 'journal'), { recursive: true });
  const journal = new SwitchJournal(file, silentLog);
  const jobId = randomUUID();
  const accountId = randomUUID();
  journal.begin({ jobId, launcher: 'steam', accountId });
  journal.update({ stepId: 'close' });
  cpSync(file, join(dir, 'switch-before-writes.json'));
  journal.update({ backupId: '2026-11-05T19-40-12.345Z', stepId: 'file' });
  cpSync(file, join(dir, 'switch-writing.json'));
  journal.update({ stepId: 'wait' });
  cpSync(file, join(dir, 'switch-signing-in.json'));
  journal.update({ rollbackFailed: true });
  cpSync(file, join(dir, 'switch-rollback-failed.json'));
  journal.clear(jobId);
  writeFileSync(join(dir, 'switch.json.unreadable'), '{"version":1,"jobId":"not valid json', 'utf8');
}

function backupFixtures(backupsDir: string): string {
  const src = join(SCRATCH, 'launcher-files');
  reset(src);
  const steamSrc = join(src, 'steam', 'config', 'loginusers.vdf');
  const epicSrc = join(src, 'epic', 'GameUserSettings.ini');
  const bnetSrc = join(src, 'battlenet', 'Battle.net.config');
  const riotSrc = join(src, 'riot', 'RiotGamesPrivateSettings.yaml');
  for (const [dest, from] of [
    [steamSrc, 'test/fixtures/steam/loginusers.vdf'],
    [epicSrc, 'test/fixtures/epic/GameUserSettings.ini'],
    [bnetSrc, 'test/fixtures/battlenet/Battle.net.config'],
    [riotSrc, 'test/fixtures/riot/RiotGamesPrivateSettings.yaml'],
  ] as const) {
    mkdirSync(join(dest, '..'), { recursive: true });
    cpSync(join(REPO, from), dest);
  }
  const backups = new BackupService(backupsDir, { keep: () => 20, vault });
  const ids: string[] = [];
  const bnetToken = Buffer.from(vault.encrypt('01000000d08c9ddf0001abababababababababababababababababababababababababababababababababababababab')).toString(
    'base64',
  );
  ids.push(
    backups.snapshot({
      launcher: 'steam',
      reason: 'switch to Persona Three',
      files: [{ source: steamSrc, relative: 'config/loginusers.vdf' }],
      meta: { AutoLoginUser: 'user_1', RememberPassword: null },
    }).id,
  );
  ids.push(
    backups.snapshot({
      launcher: 'steam',
      reason: `Before restoring ${ids[0]}`,
      files: [{ source: steamSrc, relative: 'config/loginusers.vdf' }],
      meta: { AutoLoginUser: 'user_3', RememberPassword: 1 },
      protect: ids[0],
    }).id,
  );
  ids.push(
    backups.snapshot({
      launcher: 'epic',
      reason: 'switch to Alt',
      files: [
        { source: epicSrc, relative: 'Config/Windows/GameUserSettings.ini', sensitive: true },
        { source: join(src, 'epic', 'WindowsEditor', 'GameUserSettings.ini'), relative: 'Config/WindowsEditor/GameUserSettings.ini', sensitive: true },
      ],
    }).id,
  );
  ids.push(
    backups.snapshot({
      launcher: 'epic',
      reason: 'switch to Main',
      files: [{ source: epicSrc, relative: 'Config/Windows/GameUserSettings.ini', sensitive: true }],
      pinned: UNOWNED_SESSION_PIN,
    }).id,
  );
  ids.push(
    backups.snapshot({
      launcher: 'battlenet',
      reason: 'switch to Alt',
      files: [{ source: bnetSrc, relative: 'Battle.net.config' }],
      meta: { unifiedAuth: JSON.stringify([{ name: 'AA11BB22', enc: bnetToken }]) },
    }).id,
  );
  ids.push(
    backups.snapshot({
      launcher: 'riot',
      reason: 'switch to Riot Alt',
      files: [{ source: riotSrc, relative: 'Data/RiotGamesPrivateSettings.yaml', sensitive: true }],
    }).id,
  );

  // The manifests record where each file was read from; replace the scratch paths with the paths a real PC would show.
  const placeholders: [string, string][] = [
    [steamSrc, 'C:\\Program Files (x86)\\Steam\\config\\loginusers.vdf'],
    [epicSrc, 'C:\\Users\\<user>\\AppData\\Local\\EpicGamesLauncher\\Saved\\Config\\Windows\\GameUserSettings.ini'],
    [
      join(src, 'epic', 'WindowsEditor', 'GameUserSettings.ini'),
      'C:\\Users\\<user>\\AppData\\Local\\EpicGamesLauncher\\Saved\\Config\\WindowsEditor\\GameUserSettings.ini',
    ],
    [bnetSrc, 'C:\\Users\\<user>\\AppData\\Roaming\\Battle.net\\Battle.net.config'],
    [riotSrc, 'C:\\Users\\<user>\\AppData\\Local\\Riot Games\\Riot Client\\Data\\RiotGamesPrivateSettings.yaml'],
  ];
  for (const launcher of ['steam', 'epic', 'battlenet', 'riot']) {
    for (const id of readdirSync(join(backupsDir, launcher))) {
      const manifestPath = join(backupsDir, launcher, id, 'manifest.json');
      let text = readFileSync(manifestPath, 'utf8');
      for (const [from, to] of placeholders) text = text.split(JSON.stringify(from).slice(1, -1)).join(JSON.stringify(to).slice(1, -1));
      writeFileSync(manifestPath, text);
    }
  }
  return ids[0]!;
}

async function dbCopy(realisticDb: string, backupsDir: string): Promise<void> {
  const db = new Database(realisticDb);
  await backupDatabase(db, join(backupsDir, 'db'), 5);
  db.close();
}

function logFixtures(logsDir: string): void {
  mkdirSync(logsDir, { recursive: true });
  initLogging({ dir: logsDir, level: 'debug', console: false });
  redactAccountNames(['Persona One', 'Persona Three']);
  const log = createLogger('main');
  log.info('starting', {
    version: '1.0.0-beta.3',
    electron: '44.7.0',
    dev: false,
    dataDir: 'C:\\Users\\someone\\AppData\\Roaming\\OneLaunch',
    dataDirSource: 'default',
    platformSource: 'real',
  });
  log.info('database migrated', { from: 4, to: 5, applied: ['artwork_launcher_source'] });
  log.info('vault', { available: true, backend: 'dpapi', readable: true });
  log.info('startup', {
    creationEpochMs: 1762371000000,
    processToNodeMs: 180,
    moduleLoadedMs: 260,
    readyMs: 290,
    dbMs: 310,
    vaultMs: 330,
    ipcMs: 360,
    windowCreatedMs: 350,
    windowShownMs: 352,
    readyToShowMs: 640,
    didFinishLoadMs: 610,
  });
  log.child('scan').debug('scanned launcher', { launcher: 'steam', added: 0, updated: 3, removed: 0 });
  log.child('artwork').info('artwork queued', { queued: 2 });
  log.child('ipc').info('account created', { id: '11111111-2222-4333-8444-555555555555', launcher: 'steam', hasSecret: true });
  log.child('steam').warn('sign-in needs the user', { reason: 'Account Logon Denied', account: 'Persona One', login: 'user_1', email: 'someone@example.com' });
  log.child('ipc').error('ipc launchers:switchPlan failed', {
    code: 'NOT_INSTALLED',
    message:
      'Steam is not installed. Command was: steam.exe -login user_1 hunter2 and token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
  });
  log.child('launch').info('launch job accepted', {
    jobId: '66666666-7777-4888-8999-000000000000',
    accountId: '11111111-2222-4333-8444-555555555555',
    gameId: null,
    confirmClose: false,
    instant: false,
    direct: false,
  });
  log.info('window hidden to the tray');
  log.info('exit');
  setLogLevel('info');

  // rotation naming, with a tiny cap so the files appear
  const rotDir = join(logsDir, '..', 'logs-rotation-example');
  mkdirSync(rotDir, { recursive: true });
  const sink = new FileSink({ dir: rotDir, name: 'onelaunch', maxBytes: 160, keep: 5 });
  for (let i = 0; i < 12; i++) sink.write(`2026-11-05T19:30:0${i % 10}.000Z INFO  [main] rotation sample line ${i}\n`);
}

function settingsFixtures(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const defaults = {
    _note:
      'Effective value when the key is unset in the settings table, and the code that applies the default. Values are strings in the table; booleans are the strings "true"/"false" (getBool also accepts "1").',
    dryRun: { default: 'false', appliedBy: 'settings.getBool("dryRun", false) in src/main/services/launch.ts' },
    logLevel: { default: 'info', appliedBy: 'initLogging level (dev builds always start at debug) in src/main/index.ts' },
    'artwork.autoFetch': { default: 'true', appliedBy: 'settings.getBool("artwork.autoFetch", true) in src/main/index.ts' },
    'backups.keep': { default: '20', appliedBy: 'settings.getInt("backups.keep", DEFAULT_BACKUPS_TO_KEEP) in src/main/index.ts' },
    'epic.launchUri': { default: 'catalog', appliedBy: 'launchUriForm thunk in src/main/index.ts' },
    'battlenet.launch': { default: 'exec', appliedBy: 'launchForm thunk in src/main/index.ts' },
    'steam.autoLogin': { default: 'false', appliedBy: 'settings.getBool("steam.autoLogin", false) in src/main/index.ts' },
    'riot.pressPlay': { default: 'true', appliedBy: 'settings.getBool("riot.pressPlay", true) in src/main/index.ts' },
    'play.hideToTray': { default: 'true', appliedBy: 'settings.getBool("play.hideToTray", true) in src/main/index.ts' },
    'steam.path': { default: null, appliedBy: 'main-only; unset means automatic detection' },
    'epic.path': { default: null, appliedBy: 'main-only; unset means automatic detection' },
    'battlenet.path': { default: null, appliedBy: 'main-only; unset means automatic detection' },
    'riot.path': { default: null, appliedBy: 'main-only; unset means automatic detection' },
    'window.bounds': { default: null, appliedBy: 'main-only; unset means 1280x800 at the OS default position, not maximized' },
    'window.closeToTray': { default: 'true', appliedBy: 'settings.getBool("window.closeToTray", true) in src/main/index.ts' },
    'firstRun.dismissed': { default: null, appliedBy: 'renderer: the setup guide opens when unset and no account exists' },
    'updates.auto': { default: 'true', appliedBy: 'settings.getBool("updates.auto", true) in src/main/index.ts' },
    'whatsNew.enabled': { default: 'true', appliedBy: 'renderer reads !== "false"' },
    'whatsNew.lastSeen': {
      default: null,
      appliedBy: 'main writes the running version on a brand-new DB (seedWhatsNewSeen); unset on an older folder reads as older than every entry',
    },
  };
  writeFileSync(join(dir, 'settings-defaults.json'), JSON.stringify(defaults, null, 2));
  const nonDefaults = {
    _note: 'Every key at a non-default value, exactly as stored (key -> value string). This is also the shape settings:getAll returns.',
    dryRun: 'true',
    logLevel: 'debug',
    'artwork.autoFetch': 'false',
    'backups.keep': '100',
    'epic.launchUri': 'appname',
    'battlenet.launch': 'uri',
    'steam.autoLogin': 'true',
    'riot.pressPlay': 'false',
    'play.hideToTray': 'false',
    'steam.path': 'D:\\Games\\Steam',
    'epic.path': 'D:\\Games\\Epic Games\\Launcher',
    'battlenet.path': 'D:\\Games\\Battle.net',
    'riot.path': 'D:\\Riot Games\\Riot Client',
    'window.bounds': JSON.stringify({ x: 2560, y: 0, width: 1920, height: 1040, maximized: true }),
    'window.closeToTray': 'false',
    'firstRun.dismissed': 'true',
    'updates.auto': 'false',
    'whatsNew.enabled': 'false',
    'whatsNew.lastSeen': '1.0.0-beta.2',
  };
  writeFileSync(join(dir, 'settings-non-defaults.json'), JSON.stringify(nonDefaults, null, 2));
  const bounds = {
    _note:
      'Values of the window.bounds setting. Width and height are clamped to at least 960x600 when read; a placement whose title bar is not on a connected display is dropped (src/main/window-guard.ts placementFrom).',
    normal: JSON.stringify({ x: 120, y: 80, width: 1400, height: 860, maximized: false }),
    maximizedWithNormalBounds: JSON.stringify({ x: 120, y: 80, width: 1400, height: 860, maximized: true }),
    offScreenDroppedOnRead: JSON.stringify({ x: -5000, y: -5000, width: 1280, height: 800, maximized: false }),
    tooSmallClampedOnRead: JSON.stringify({ x: 0, y: 0, width: 300, height: 200, maximized: false }),
    malformedIgnored: '{not json',
  };
  writeFileSync(join(dir, 'window-bounds-examples.json'), JSON.stringify(bounds, null, 2));
  const local = {
    _note: 'Renderer localStorage (per Chromium profile under <dataDir>\\chromium, never read by main). Both are read inside try/catch and may be absent.',
    sidebar: { values: ['expanded', 'collapsed'], absentMeans: 'follow the window width: collapsed below 1100 px, expanded above' },
    'library.sort': { values: ['name', 'lastPlayed'], absentMeans: 'lastPlayed' },
  };
  writeFileSync(join(dir, 'localStorage.json'), JSON.stringify(local, null, 2));
}

function updateFixtures(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const { privateKey } = generateKeyPairSync('ed25519');
  const installer = Buffer.from('placeholder installer bytes, not a real executable');
  const version = '1.0.0-beta.4';
  const file = { url: `OneLaunch-${version}-setup.exe`, sha512: createHash('sha512').update(installer).digest('base64'), size: installer.length };
  const { keyId, signature } = signManifest(version, file, privateKey);
  const spki = publicKeyOf(privateKey);
  const lines = [
    `version: ${version}`,
    'files:',
    `  - url: ${file.url}`,
    `    sha512: ${file.sha512}`,
    `    size: ${file.size}`,
    `path: ${file.url}`,
    `sha512: ${file.sha512}`,
    "releaseDate: '2026-11-20T00:00:00.000Z'",
    `signature: '${signature}'`,
    `keyId: '${keyId}'`,
    '',
  ];
  writeFileSync(join(dir, 'latest.yml'), lines.join('\n'));
  writeFileSync(join(dir, 'latest-unsigned.yml'), lines.slice(0, 8).join('\n') + '\n');
  const check = verifyManifest(
    { version, files: [{ url: file.url, sha512: file.sha512, size: file.size }], path: file.url, sha512: file.sha512, signature, keyId },
    [{ id: keyIdOf(spki), spki }],
  );
  if (!check.ok) throw new Error(`fixture manifest does not verify: ${check.reason}`);
  writeFileSync(
    join(dir, 'README-keys.json'),
    JSON.stringify(
      {
        _note:
          'latest.yml above is signed with a THROWAWAY Ed25519 key generated while making these fixtures. It is not one of the pinned release keys; verifyManifest accepts it only when this key is in the trusted list. Payload signed: "one-launch-update-v1\\n<version>\\n<url>\\n<sha512>\\n<size>\\n". keyId = first 16 hex of sha256(SPKI DER).',
        throwawayPublicKeySpkiBase64: spki,
        keyId,
        pinnedReleaseKeyIds: ['616ad3e53aac3ce4', '35f13c45c6049dbe'],
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(dir, 'app-update.yml'),
    ['provider: github', 'owner: rjf2016', 'repo: one-launch', 'releaseType: draft', 'updaterCacheDirName: one-launch-updater', ''].join('\n'),
  );
  writeFileSync(join(dir, 'dev-app-update.yml'), ['provider: generic', 'url: http://127.0.0.1:9000/', 'updaterCacheDirName: update-cache', ''].join('\n'));
}

function devOnlyFixtures(dir: string): void {
  mkdirSync(dir, { recursive: true });
  cpSync(join(REPO, 'test/fake-launchers'), join(dir, 'fake-launchers'), { recursive: true });
  const reportDir = join(SCRATCH, 'report');
  reset(reportDir);
  const report = new FakeReport();
  report.attach(reportDir);
  report.processEvent({ kind: 'close', exe: '<close>', args: ['steam.exe'] });
  report.processEvent({ kind: 'kill', exe: '<kill>', args: ['steam.exe'] });
  report.registryWrite({ op: 'set', path: 'HKCU\\Software\\Valve\\Steam\\AutoLoginUser', value: 'user_3' });
  report.registryWrite({ op: 'delete', path: 'HKCU\\Software\\Blizzard Entertainment\\Battle.net\\UnifiedAuth\\AA11BB22' });
  report.processEvent({ kind: 'start', exe: 'D:\\scratch\\steam\\steam.exe', args: [] });
  report.opened('steam://rungameid/252950');
  report.fetched('https://store.steampowered.com/api/storesearch/?term=Rocket+League&l=english&cc=US');
  report.clipboardWrite();
  report.riotLaunchRequest('valorant.live');
  cpSync(join(reportDir, 'fake-platform.json'), join(dir, 'fake-platform.json'));
  writeFileSync(
    join(dir, 'knobs.json'),
    JSON.stringify(
      {
        _note:
          'Merged over scenario.json by the simulators: processes shallow-merged, knobs.<launcher> shallow-merged, timing.<launcher> merged over SIM_TIMING then the scenario, quitDuringSwitch overrides. Everything else ignored.',
        processes: { table: [{ name: 'VALORANT-Win64-Shipping', pid: 1, path: null }] },
        knobs: { steam: { expiredSessions: ['76561198000000003'] }, riot: { rejected: ['33333333-3333-4333-8333-333333333333'], pressPlayFails: true } },
        timing: { steam: { signInMs: 2000 } },
        quitDuringSwitch: 'quit',
      },
      null,
      2,
    ),
  );
}

test('generate fixtures', async () => {
  reset(SCRATCH);
  mkdirSync(OUT, { recursive: true });
  for (const entry of GENERATED) rmSync(join(OUT, entry), { recursive: true, force: true });

  // 1. realistic data folder
  const data = join(OUT, 'data-folder');
  for (const sub of ['artwork', 'backups', 'logs']) mkdirSync(join(data, sub), { recursive: true });
  const dbPath = join(data, 'onelaunch.db');
  const seeded = seedRealistic(dbPath, data);
  backupFixtures(join(data, 'backups'));
  // the copy the app takes 250 ms after every first show, newest 5 kept: two starts' worth here
  await dbCopy(dbPath, join(data, 'backups'));
  await dbCopy(dbPath, join(data, 'backups'));
  logFixtures(join(data, 'logs'));
  // a journal as left by a crash mid sign-in, naming a real snapshot and account of this folder
  const journal = new SwitchJournal(join(data, 'switch.json'), silentLog);
  journal.begin({ jobId: randomUUID(), launcher: 'steam', accountId: seeded.accounts.steam3! });
  const steamSnapshots = readdirSync(join(data, 'backups', 'steam')).sort();
  journal.update({ backupId: steamSnapshots[0]!, stepId: 'wait' });
  mkdirSync(join(data, 'chromium'), { recursive: true });
  writeFileSync(
    join(data, 'chromium', 'README.txt'),
    'Chromium profile folder. In a real data folder it holds "Local State" with the DPAPI-wrapped os_crypt key that safeStorage uses; deleting it loses every secret. Not reproduced here.\n',
  );

  // 2. database variants
  const dbs = join(OUT, 'db');
  mkdirSync(dbs, { recursive: true });
  seedEmpty(join(dbs, 'onelaunch-empty-v5.db'));
  seedV1(join(dbs, 'onelaunch-v1-oldest.db'));
  seedLarge(join(dbs, 'onelaunch-large-v5.db'));

  // 3. journal variants, settings, updates, dev-only
  journalFixtures(join(OUT, 'journal'));
  settingsFixtures(join(OUT, 'settings'));
  updateFixtures(join(OUT, 'updates'));
  devOnlyFixtures(join(OUT, 'dev-only'));

  // 4. launcher-owned files and external API responses, copied from the sanitised test fixtures
  for (const launcher of ['steam', 'epic', 'battlenet', 'riot'])
    cpSync(join(REPO, 'test/fixtures', launcher), join(OUT, 'launchers', launcher), { recursive: true });
  cpSync(join(REPO, 'test/fixtures/steamgriddb'), join(OUT, 'external', 'steamgriddb'), { recursive: true });

  // sanity: every DB opens clean at its version
  for (const [file, version] of [
    [dbPath, 5],
    [join(dbs, 'onelaunch-empty-v5.db'), 5],
    [join(dbs, 'onelaunch-v1-oldest.db'), 1],
    [join(dbs, 'onelaunch-large-v5.db'), 5],
  ] as const) {
    const db = new Database(file, { readonly: true });
    const check = db.pragma('quick_check', { simple: true });
    const uv = db.pragma('user_version', { simple: true });
    db.close();
    if (check !== 'ok' || uv !== version) throw new Error(`${file}: quick_check=${check} user_version=${uv}`);
  }
  for (const stray of readdirSync(OUT, { recursive: true }) as string[]) {
    if (stray.endsWith('-wal') || stray.endsWith('-shm') || stray.endsWith('.tmp')) throw new Error(`stray file ${stray}`);
  }
});
