import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { backupDatabase, DatabaseCorruptError, DatabaseUnavailableError, getSchemaVersion, migrate, openDatabase, type Db } from '../src/main/db';
import { MIGRATIONS, type Migration } from '../src/main/db/migrations';

describe('migrations', () => {
  it('applies all migrations to a fresh database and is idempotent', () => {
    const db = openDatabase(':memory:');
    expect(getSchemaVersion(db)).toBe(0);

    const first = migrate(db);
    expect(first.from).toBe(0);
    expect(first.to).toBe(MIGRATIONS.length);
    expect(first.applied).toHaveLength(MIGRATIONS.length);

    const second = migrate(db);
    expect(second.applied).toHaveLength(0);
    expect(second.from).toBe(MIGRATIONS.length);

    const tables = db
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['accounts', 'games', 'artwork', 'launch_history', 'settings', 'secrets']));
    db.close();
  });

  it('takes any launcher id (reads filter with isLauncherId) and still checks launch results and artwork sources', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const now = new Date().toISOString();
    const insertAccount = db.prepare('INSERT INTO accounts (id, launcher, display_name, login, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
    expect(() => insertAccount.run('a1', 'steam', 'x', 'y', now, now)).not.toThrow();
    expect(() => insertAccount.run('a2', 'riot', 'x', 'y', now, now)).not.toThrow();
    expect(() =>
      db.prepare('INSERT INTO launch_history (id, game_id, account_id, launched_at, result) VALUES (?, ?, ?, ?, ?)').run('h1', 'g1', 'a1', now, 'maybe'),
    ).toThrow(/CHECK/);
    db.prepare('INSERT INTO games (id, launcher, launcher_game_id, name, last_seen_at) VALUES (?, ?, ?, ?, ?)').run('g1', 'riot', 'valorant', 'x', now);
    expect(() => db.prepare('INSERT INTO artwork (game_id, source) VALUES (?, ?)').run('g1', 'imgur')).toThrow(/CHECK/);
    expect(() => db.prepare('INSERT INTO artwork (game_id, source) VALUES (?, ?)').run('g1', 'launcher')).not.toThrow();
    db.close();
  });

  it('rejects non-contiguous migration lists', () => {
    const db = openDatabase(':memory:');
    expect(() => migrate(db, [{ version: 2, name: 'oops', up: 'SELECT 1;' }])).toThrow(/contiguous/);
    db.close();
  });

  it('refuses a damaged file and copies a healthy one with rotation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'onelaunch-db-'));
    try {
      const file = join(dir, 'onelaunch.db');
      const db = openDatabase(file);
      migrate(db);
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('dryRun', 'false');

      const first = await backupDatabase(db, join(dir, 'copies'), 2);
      await new Promise((r) => setTimeout(r, 5));
      await backupDatabase(db, join(dir, 'copies'), 2);
      await new Promise((r) => setTimeout(r, 5));
      const third = await backupDatabase(db, join(dir, 'copies'), 2);
      const names = readdirSync(join(dir, 'copies')).sort();
      expect(names).toHaveLength(2);
      expect(names).not.toContain(basename(first));
      expect(names).toContain(basename(third));
      const copy = openDatabase(third);
      expect(copy.prepare<[], { value: string }>("SELECT value FROM settings WHERE key = 'dryRun'").get()?.value).toBe('false');
      copy.close();
      db.close();

      writeFileSync(join(dir, 'broken.db'), Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(4096, 0x7f)]));
      expect(() => openDatabase(join(dir, 'broken.db'))).toThrow(DatabaseCorruptError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a read-only file as unavailable rather than damaged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'onelaunch-db-'));
    const file = join(dir, 'onelaunch.db');
    try {
      const db = openDatabase(file);
      migrate(db);
      db.close();
      chmodSync(file, 0o444);
      let err: unknown;
      try {
        openDatabase(file);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(DatabaseUnavailableError);
      expect(err).toMatchObject({ code: 'DB_UNAVAILABLE', reason: 'read-only' });
      expect((err as Error).message).not.toMatch(/damaged|move the file/);
    } finally {
      for (const name of readdirSync(dir)) {
        chmodSync(join(dir, name), 0o666);
        rmSync(join(dir, name), { force: true });
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a file held by another connection as unavailable, then opens once it is released', () => {
    const dir = mkdtempSync(join(tmpdir(), 'onelaunch-db-'));
    try {
      const file = join(dir, 'onelaunch.db');
      const holder = openDatabase(file);
      migrate(holder);
      holder.exec('BEGIN IMMEDIATE');
      let err: unknown;
      try {
        openDatabase(file, { busyTimeoutMs: 50 });
      } catch (e) {
        err = e;
      }
      expect(err).toMatchObject({ code: 'DB_UNAVAILABLE', reason: 'locked' });
      expect((err as Error).message).toMatch(/in use by another program/);
      holder.exec('COMMIT');
      const db = openDatabase(file, { busyTimeoutMs: 50 });
      expect(getSchemaVersion(db)).toBeGreaterThan(0);
      db.close();
      holder.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a database written by a newer version', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    db.pragma(`user_version = ${MIGRATIONS.length + 1}`);
    expect(() => migrate(db)).toThrow(/newer version/);
    expect(getSchemaVersion(db)).toBe(MIGRATIONS.length + 1);
    db.close();
  });

  it('rolls back a failed migration and leaves user_version untouched', () => {
    const db = openDatabase(':memory:');
    expect(() =>
      migrate(db, [
        { version: 1, name: 'ok', up: 'CREATE TABLE t (id INTEGER);' },
        { version: 2, name: 'broken', up: 'CREATE TABLE u (id INTEGER); THIS IS NOT SQL;' },
      ]),
    ).toThrow();
    expect(getSchemaVersion(db)).toBe(1);
    const tables = db
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);
    expect(tables).toContain('t');
    expect(tables).not.toContain('u');
    db.close();
  });
});

const NOW = '2026-01-01T00:00:00.000Z';
const CHILD_TABLES = ['launcher_sessions', 'artwork', 'artwork_attempts'] as const;
const ROW_TABLES = ['accounts', 'games', ...CHILD_TABLES, 'launch_history', 'settings', 'secrets'] as const;

/** A schema-3 database with a row in every table, including every child of accounts and games. */
function seedVersion3(db: Db): Record<string, unknown[]> {
  migrate(db, MIGRATIONS.slice(0, 3));
  db.prepare(
    'INSERT INTO accounts (id, launcher, display_name, login, secret_enc, launcher_uid, tags, notes, last_used_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('a1', 'steam', 'Persona One', 'user_1', Buffer.from('cipher-1'), '76561198000000001', '["main"]', 'a note', NOW, NOW, NOW);
  db.prepare('INSERT INTO accounts (id, launcher, display_name, login, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    'a2',
    'epic',
    'Alt',
    'alt@example.com',
    NOW,
    NOW,
  );
  db.prepare(
    'INSERT INTO launcher_sessions (account_id, launcher, launcher_uid, blob_enc, fingerprint, captured_at, verified_at, stale_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('a2', 'epic', '22222222222222222222222222222222', Buffer.from('session-cipher'), 'fp-1', NOW, NOW, null);
  db.prepare(
    'INSERT INTO games (id, launcher, launcher_game_id, name, install_path, installed, last_seen_at, needs_update, last_played_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('g1', 'steam', '730', 'Game One', 'C:\\Games\\One', 1, NOW, 1, NOW);
  db.prepare('INSERT INTO games (id, launcher, launcher_game_id, name, last_seen_at) VALUES (?, ?, ?, ?, ?)').run('g2', 'epic', 'Sugar', 'Game Two', NOW);
  db.prepare('INSERT INTO artwork (game_id, source, grid_path, fetched_at) VALUES (?, ?, ?, ?)').run('g1', 'steamgriddb', 'g1.jpg', NOW);
  db.prepare('INSERT INTO artwork_attempts (game_id, attempted_at, error) VALUES (?, ?, ?)').run('g2', NOW, 'not found');
  db.prepare('INSERT INTO launch_history (id, game_id, account_id, launched_at, result) VALUES (?, ?, ?, ?, ?)').run('h1', 'g1', 'a1', NOW, 'ok');
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('dryRun', 'false');
  db.prepare('INSERT INTO secrets (key, value_enc, updated_at) VALUES (?, ?, ?)').run('probe', Buffer.from('probe-cipher'), NOW);
  return snapshot(db);
}

function snapshot(db: Db): Record<string, unknown[]> {
  return Object.fromEntries(ROW_TABLES.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]));
}

function count(db: Db, table: string): number {
  return db.prepare<[], { c: number }>(`SELECT count(*) AS c FROM ${table}`).get()?.c ?? -1;
}

function foreignKeysOn(db: Db): boolean {
  return db.pragma('foreign_keys', { simple: true }) === 1;
}

describe('launcher tables rebuild (migration 4)', () => {
  it('keeps every row of every table, the child rows included, and every reference intact', () => {
    const db = openDatabase(':memory:');
    const before = seedVersion3(db);
    for (const table of CHILD_TABLES) expect(count(db, table)).toBe(1);

    const result = migrate(db);
    expect(result).toMatchObject({ from: 3, to: MIGRATIONS.length });
    expect(result.applied).toEqual(['4_launcher_check_dropped', '5_artwork_launcher_source']);
    expect(snapshot(db)).toEqual(before);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(foreignKeysOn(db)).toBe(true);
    db.close();
  });

  it('recreates the indexes, the unique game key, the defaults and the cascades', () => {
    const db = openDatabase(':memory:');
    seedVersion3(db);
    migrate(db);
    const indexes = db
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name")
      .all()
      .map((r) => r.name);
    expect(indexes).toEqual(expect.arrayContaining(['idx_accounts_launcher', 'idx_games_launcher', 'idx_launcher_sessions_fingerprint']));
    expect(() =>
      db.prepare('INSERT INTO games (id, launcher, launcher_game_id, name, last_seen_at) VALUES (?, ?, ?, ?, ?)').run('g3', 'steam', '730', 'Again', NOW),
    ).toThrow(/UNIQUE/);
    db.prepare('INSERT INTO games (id, launcher, launcher_game_id, name, last_seen_at) VALUES (?, ?, ?, ?, ?)').run('g3', 'steam', '440', 'Three', NOW);
    expect(db.prepare("SELECT installed, needs_update, last_played_at FROM games WHERE id = 'g3'").get()).toEqual({
      installed: 1,
      needs_update: 0,
      last_played_at: null,
    });
    expect(db.prepare("SELECT tags, notes FROM accounts WHERE id = 'a2'").get()).toEqual({ tags: '[]', notes: '' });

    db.prepare("DELETE FROM accounts WHERE id = 'a2'").run();
    expect(count(db, 'launcher_sessions')).toBe(0);
    db.prepare("DELETE FROM games WHERE id IN ('g1', 'g2')").run();
    expect(count(db, 'artwork')).toBe(0);
    expect(count(db, 'artwork_attempts')).toBe(0);
    expect(() => db.prepare('INSERT INTO artwork_attempts (game_id, attempted_at, error) VALUES (?, ?, ?)').run('missing', NOW, 'x')).toThrow(/FOREIGN KEY/);
    db.close();
  });

  it('accepts a fourth launcher in accounts, games and launcher_sessions afterwards', () => {
    const db = openDatabase(':memory:');
    seedVersion3(db);
    migrate(db);
    db.prepare('INSERT INTO accounts (id, launcher, display_name, login, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      'a3',
      'riot',
      'Riot One',
      'riot_1',
      NOW,
      NOW,
    );
    db.prepare('INSERT INTO games (id, launcher, launcher_game_id, name, last_seen_at) VALUES (?, ?, ?, ?, ?)').run(
      'g3',
      'riot',
      'valorant.live',
      'VALORANT',
      NOW,
    );
    db.prepare('INSERT INTO launcher_sessions (account_id, launcher, blob_enc, fingerprint, captured_at) VALUES (?, ?, ?, ?, ?)').run(
      'a3',
      'riot',
      Buffer.from('x'),
      'fp-3',
      NOW,
    );
    expect(db.prepare<[], { launcher: string }>("SELECT launcher FROM launcher_sessions WHERE account_id = 'a3'").get()?.launcher).toBe('riot');
    db.close();
  });
});

describe('migrations that switch foreign keys off', () => {
  const parentChild: Migration = {
    version: 1,
    name: 'parent_child',
    up: `
      CREATE TABLE parent (id INTEGER PRIMARY KEY);
      CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id) ON DELETE CASCADE);
      INSERT INTO parent VALUES (1);
      INSERT INTO child VALUES (1, 1);
    `,
  };

  it('rebuilds a parent without cascading into its children, and leaves foreign keys on', () => {
    const db = openDatabase(':memory:');
    migrate(db, [
      parentChild,
      {
        version: 2,
        name: 'rebuild',
        foreignKeysOff: true,
        up: 'CREATE TABLE p2 (id INTEGER PRIMARY KEY); INSERT INTO p2 SELECT id FROM parent; DROP TABLE parent; ALTER TABLE p2 RENAME TO parent;',
      },
    ]);
    expect(count(db, 'child')).toBe(1);
    expect(foreignKeysOn(db)).toBe(true);
    db.prepare('DELETE FROM parent').run();
    expect(count(db, 'child')).toBe(0);
    db.close();
  });

  it('rolls back a rebuild that leaves a child without its parent', () => {
    const db = openDatabase(':memory:');
    expect(() =>
      migrate(db, [parentChild, { version: 2, name: 'orphans', foreignKeysOff: true, up: 'DROP TABLE parent; CREATE TABLE parent (id INTEGER PRIMARY KEY);' }]),
    ).toThrow(/missing parent/);
    expect(getSchemaVersion(db)).toBe(1);
    expect(count(db, 'parent')).toBe(1);
    expect(count(db, 'child')).toBe(1);
    expect(foreignKeysOn(db)).toBe(true);
    db.close();
  });

  it('switches foreign keys back on after a failed rebuild', () => {
    const db = openDatabase(':memory:');
    expect(() => migrate(db, [parentChild, { version: 2, name: 'broken', foreignKeysOff: true, up: 'THIS IS NOT SQL;' }])).toThrow();
    expect(getSchemaVersion(db)).toBe(1);
    expect(foreignKeysOn(db)).toBe(true);
    db.close();
  });

  it('refuses a rebuild when foreign keys cannot be switched off', () => {
    const db = openDatabase(':memory:');
    migrate(db, [parentChild]);
    const rebuild = { version: 2, name: 'rebuild', foreignKeysOff: true, up: 'DROP TABLE parent; CREATE TABLE parent (id INTEGER PRIMARY KEY);' };
    expect(() => db.transaction(() => migrate(db, [parentChild, rebuild]))()).toThrow(/could not be switched off/);
    expect(getSchemaVersion(db)).toBe(1);
    expect(count(db, 'child')).toBe(1);
    expect(foreignKeysOn(db)).toBe(true);
    db.close();
  });
});
