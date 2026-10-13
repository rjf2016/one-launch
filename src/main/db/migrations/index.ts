/**
 * Numbered, forward-only migrations. Each runs once inside a transaction and bumps
 * PRAGMA user_version. Never edit a shipped migration; add a new one.
 */
export interface Migration {
  version: number;
  name: string;
  up: string;
  /**
   * The migration drops and recreates a table that other rows reference. The runner switches foreign keys off around
   * it (a DROP TABLE under foreign_keys=ON cascade-deletes every child row) and checks every reference before the commit.
   */
  foreignKeysOff?: boolean;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial',
    up: `
      CREATE TABLE accounts (
        id            TEXT PRIMARY KEY,
        launcher      TEXT NOT NULL CHECK (launcher IN ('steam', 'epic', 'battlenet')),
        display_name  TEXT NOT NULL,
        login         TEXT NOT NULL,
        secret_enc    BLOB,
        launcher_uid  TEXT,
        tags          TEXT NOT NULL DEFAULT '[]',
        notes         TEXT NOT NULL DEFAULT '',
        last_used_at  TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
      CREATE INDEX idx_accounts_launcher ON accounts (launcher);

      CREATE TABLE games (
        id               TEXT PRIMARY KEY,
        launcher         TEXT NOT NULL CHECK (launcher IN ('steam', 'epic', 'battlenet')),
        launcher_game_id TEXT NOT NULL,
        name             TEXT NOT NULL,
        install_path     TEXT,
        installed        INTEGER NOT NULL DEFAULT 1,
        last_seen_at     TEXT NOT NULL,
        UNIQUE (launcher, launcher_game_id)
      );
      CREATE INDEX idx_games_launcher ON games (launcher);

      CREATE TABLE artwork (
        game_id     TEXT PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
        source      TEXT NOT NULL CHECK (source IN ('steamgriddb', 'steamcdn', 'manual')),
        grid_path   TEXT,
        hero_path   TEXT,
        logo_path   TEXT,
        fetched_at  TEXT
      );

      CREATE TABLE launch_history (
        id          TEXT PRIMARY KEY,
        game_id     TEXT NOT NULL,
        account_id  TEXT NOT NULL,
        launched_at TEXT NOT NULL,
        result      TEXT NOT NULL CHECK (result IN ('ok', 'failed', 'cancelled'))
      );
      CREATE INDEX idx_launch_history_launched_at ON launch_history (launched_at DESC);

      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- Vault-encrypted secrets that are not tied to an account (e.g. the SteamGridDB API key).
      -- value_enc is DPAPI ciphertext produced by Electron safeStorage. Never plaintext.
      CREATE TABLE secrets (
        key        TEXT PRIMARY KEY,
        value_enc  BLOB NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'library_artwork',
    up: `
      ALTER TABLE games ADD COLUMN needs_update INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE games ADD COLUMN last_played_at TEXT;

      -- Last failed artwork lookup per game, so a miss is not retried on every start.
      CREATE TABLE artwork_attempts (
        game_id      TEXT PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
        attempted_at TEXT NOT NULL,
        error        TEXT NOT NULL
      );
    `,
  },
  {
    version: 3,
    name: 'launcher_sessions',
    up: `
      -- One remembered-session snapshot per account for launchers that sign in from a session blob
      -- (Epic: the [RememberMe] section of GameUserSettings.ini). blob_enc is vault ciphertext.
      CREATE TABLE launcher_sessions (
        account_id   TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        launcher     TEXT NOT NULL CHECK (launcher IN ('steam', 'epic', 'battlenet')),
        launcher_uid TEXT,
        blob_enc     BLOB NOT NULL,
        fingerprint  TEXT NOT NULL,
        captured_at  TEXT NOT NULL,
        verified_at  TEXT,
        stale_reason TEXT
      );
      CREATE INDEX idx_launcher_sessions_fingerprint ON launcher_sessions (launcher, fingerprint);
    `,
  },
  {
    version: 4,
    name: 'launcher_check_dropped',
    foreignKeysOff: true,
    up: `
      -- The launcher columns lose their CHECK so a launcher can be added without a migration; reads filter with
      -- isLauncherId. SQLite cannot alter a CHECK, so each table is rebuilt and its index recreated.
      CREATE TABLE accounts_new (
        id            TEXT PRIMARY KEY,
        launcher      TEXT NOT NULL,
        display_name  TEXT NOT NULL,
        login         TEXT NOT NULL,
        secret_enc    BLOB,
        launcher_uid  TEXT,
        tags          TEXT NOT NULL DEFAULT '[]',
        notes         TEXT NOT NULL DEFAULT '',
        last_used_at  TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
      INSERT INTO accounts_new (id, launcher, display_name, login, secret_enc, launcher_uid, tags, notes, last_used_at, created_at, updated_at)
        SELECT id, launcher, display_name, login, secret_enc, launcher_uid, tags, notes, last_used_at, created_at, updated_at FROM accounts;
      DROP TABLE accounts;
      ALTER TABLE accounts_new RENAME TO accounts;
      CREATE INDEX idx_accounts_launcher ON accounts (launcher);

      CREATE TABLE games_new (
        id               TEXT PRIMARY KEY,
        launcher         TEXT NOT NULL,
        launcher_game_id TEXT NOT NULL,
        name             TEXT NOT NULL,
        install_path     TEXT,
        installed        INTEGER NOT NULL DEFAULT 1,
        last_seen_at     TEXT NOT NULL,
        needs_update     INTEGER NOT NULL DEFAULT 0,
        last_played_at   TEXT,
        UNIQUE (launcher, launcher_game_id)
      );
      INSERT INTO games_new (id, launcher, launcher_game_id, name, install_path, installed, last_seen_at, needs_update, last_played_at)
        SELECT id, launcher, launcher_game_id, name, install_path, installed, last_seen_at, needs_update, last_played_at FROM games;
      DROP TABLE games;
      ALTER TABLE games_new RENAME TO games;
      CREATE INDEX idx_games_launcher ON games (launcher);

      CREATE TABLE launcher_sessions_new (
        account_id   TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        launcher     TEXT NOT NULL,
        launcher_uid TEXT,
        blob_enc     BLOB NOT NULL,
        fingerprint  TEXT NOT NULL,
        captured_at  TEXT NOT NULL,
        verified_at  TEXT,
        stale_reason TEXT
      );
      INSERT INTO launcher_sessions_new (account_id, launcher, launcher_uid, blob_enc, fingerprint, captured_at, verified_at, stale_reason)
        SELECT account_id, launcher, launcher_uid, blob_enc, fingerprint, captured_at, verified_at, stale_reason FROM launcher_sessions;
      DROP TABLE launcher_sessions;
      ALTER TABLE launcher_sessions_new RENAME TO launcher_sessions;
      CREATE INDEX idx_launcher_sessions_fingerprint ON launcher_sessions (launcher, fingerprint);
    `,
  },
  {
    version: 5,
    name: 'artwork_launcher_source',
    up: `
      -- A launcher's own icon may stand in for a cover (source 'launcher', docs/artwork.md). SQLite cannot alter a
      -- CHECK, so the table is rebuilt. Nothing references artwork, so foreign keys stay on.
      CREATE TABLE artwork_new (
        game_id     TEXT PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
        source      TEXT NOT NULL CHECK (source IN ('steamgriddb', 'steamcdn', 'manual', 'launcher')),
        grid_path   TEXT,
        hero_path   TEXT,
        logo_path   TEXT,
        fetched_at  TEXT
      );
      INSERT INTO artwork_new (game_id, source, grid_path, hero_path, logo_path, fetched_at)
        SELECT game_id, source, grid_path, hero_path, logo_path, fetched_at FROM artwork;
      DROP TABLE artwork;
      ALTER TABLE artwork_new RENAME TO artwork;
    `,
  },
];
