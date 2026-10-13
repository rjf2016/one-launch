import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { MIGRATIONS, type Migration } from './migrations';

export type Db = Database.Database;

export interface MigrationResult {
  from: number;
  to: number;
  applied: string[];
}

/** SQLite found damage in the file. Nothing is written to it; the user restores a copy from backups/db. */
export class DatabaseCorruptError extends Error {
  readonly code = 'DB_CORRUPT';
  constructor(detail: string) {
    super(
      `The One Launch database is damaged (${detail}). Restore a copy from the backups\\db folder in the data directory, or move the file aside to start over.`,
    );
    this.name = 'DatabaseCorruptError';
  }
}

export type DatabaseUnavailableReason = 'locked' | 'read-only' | 'cannot-open';

/** The file is fine but cannot be used right now (held by another program, read-only, or unopenable). Nothing should be restored or moved. */
export class DatabaseUnavailableError extends Error {
  readonly code = 'DB_UNAVAILABLE';
  constructor(
    readonly reason: DatabaseUnavailableReason,
    detail: string,
  ) {
    super(
      reason === 'locked'
        ? `The One Launch database is in use by another program (${detail}). Close anything that has it open, such as a second One Launch, a database viewer, or a backup tool, and try again.`
        : reason === 'read-only'
          ? `The One Launch database is read-only (${detail}). Check the permissions on the data folder and the file, then try again.`
          : `The One Launch database could not be opened (${detail}). Check that the data folder exists and is writable.`,
    );
    this.name = 'DatabaseUnavailableError';
  }
}

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

export interface OpenDatabaseOptions {
  /** How long a write lock held by another connection is waited for before the open fails as `locked`. */
  busyTimeoutMs?: number;
}

function sqliteCode(err: unknown): string {
  return err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string' ? (err as { code: string }).code : '';
}

function classifyOpenError(err: unknown): Error {
  const code = sqliteCode(err);
  const detail = err instanceof Error ? err.message : String(err);
  if (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED')) return new DatabaseUnavailableError('locked', detail);
  if (code.startsWith('SQLITE_READONLY')) return new DatabaseUnavailableError('read-only', detail);
  if (code.startsWith('SQLITE_CORRUPT') || code === 'SQLITE_NOTADB') return new DatabaseCorruptError(detail);
  return new DatabaseUnavailableError('cannot-open', detail);
}

export function openDatabase(file: string, opts: OpenDatabaseOptions = {}): Db {
  let db: Db;
  try {
    db = new Database(file);
  } catch (err) {
    throw classifyOpenError(err);
  }
  try {
    db.pragma(`busy_timeout = ${Math.max(0, Math.floor(opts.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS))}`);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
    const check = db.pragma('quick_check', { simple: true });
    if (check !== 'ok') throw new DatabaseCorruptError(String(check));
    // A rolled-back page write proves the file is ours to use: a lock held elsewhere fails as busy, a read-only file as read-only.
    db.exec('BEGIN IMMEDIATE');
    try {
      db.pragma(`user_version = ${getSchemaVersion(db)}`);
    } finally {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* the write error is the one that matters */
      }
    }
  } catch (err) {
    db.close();
    if (err instanceof DatabaseCorruptError) throw err;
    throw classifyOpenError(err);
  }
  return db;
}

/** Copies the live database with SQLite's online backup API into `dir`, keeping the newest `keep` copies. */
export async function backupDatabase(db: Db, dir: string, keep: number): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `onelaunch-${new Date().toISOString().replace(/:/g, '-')}.db`);
  await db.backup(dest);
  const copies = readdirSync(dir)
    .filter((name) => /^onelaunch-.*\.db$/.test(name))
    .sort()
    .reverse();
  for (const name of copies.slice(Math.max(1, keep))) rmSync(join(dir, name), { force: true });
  return dest;
}

export function getSchemaVersion(db: Db): number {
  return db.pragma('user_version', { simple: true }) as number;
}

/** The database was written by a newer One Launch than this one; running against it could corrupt it. */
export class DatabaseTooNewError extends Error {
  readonly code = 'DB_TOO_NEW';
  constructor(
    readonly found: number,
    readonly supported: number,
  ) {
    super(
      `This database was created by a newer version of One Launch (schema ${found}; this version supports up to ${supported}). Update One Launch, or restore an older copy of the database.`,
    );
    this.name = 'DatabaseTooNewError';
  }
}

/** Applies every migration newer than the current user_version, each in its own transaction. Refuses a database from a newer version. */
export function migrate(db: Db, migrations: readonly Migration[] = MIGRATIONS): MigrationResult {
  validateMigrations(migrations);
  const from = getSchemaVersion(db);
  const supported = migrations[migrations.length - 1]?.version ?? 0;
  if (from > supported) throw new DatabaseTooNewError(from, supported);
  const applied: string[] = [];
  for (const m of migrations) {
    if (m.version <= from) continue;
    if (m.foreignKeysOff) applyWithForeignKeysOff(db, m);
    else apply(db, m);
    applied.push(`${m.version}_${m.name}`);
  }
  return { from, to: getSchemaVersion(db), applied };
}

function apply(db: Db, m: Migration, beforeCommit: () => void = () => undefined): void {
  db.transaction(() => {
    db.exec(m.up);
    beforeCommit();
    db.pragma(`user_version = ${m.version}`);
  })();
}

/**
 * A rebuild drops a table other rows reference, which under foreign_keys=ON cascade-deletes every child row. The pragma
 * is a no-op inside a transaction, so it is switched around the transaction, and every reference is checked before the
 * commit so a rebuild that orphaned a row rolls back.
 */
function applyWithForeignKeysOff(db: Db, m: Migration): void {
  const label = `${m.version}_${m.name}`;
  db.pragma('foreign_keys = OFF');
  try {
    if (db.pragma('foreign_keys', { simple: true }) !== 0) {
      throw new Error(`Migration ${label} rebuilds tables, but foreign keys could not be switched off (is migrate() inside a transaction?)`);
    }
    apply(db, m, () => {
      const orphans = db.pragma('foreign_key_check') as unknown[];
      if (orphans.length > 0) throw new Error(`Migration ${label} left ${orphans.length} row(s) pointing at a missing parent`);
    });
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function validateMigrations(migrations: readonly Migration[]): void {
  let expected = 1;
  for (const m of migrations) {
    if (m.version !== expected) {
      throw new Error(`Migrations must be contiguous from 1; found version ${m.version}, expected ${expected}`);
    }
    if (!Number.isInteger(m.version) || !m.name || !m.up.trim()) {
      throw new Error(`Malformed migration at version ${m.version}`);
    }
    expected++;
  }
}
