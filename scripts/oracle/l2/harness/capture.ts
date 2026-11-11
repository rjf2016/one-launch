import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Content, LAUNCHER_FILES, projectLog, sha256, wrapDigests } from './project';

export const LAUNCHERS = ['steam', 'epic', 'battlenet', 'riot'] as const;

/** Rows the window writes and no replay can: where the window was on screen. */
const WINDOW_SETTINGS: ReadonlySet<string> = new Set(['window.bounds']);

export interface Ids {
  /** Registers a snapshot id in the order snapshots were taken; a known one keeps its alias. */
  backup(id: string, launcher: string): void;
  history(id: string): void;
  aliasOf(id: string): string | null;
}

type Row = Record<string, unknown>;

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// Rows in an order that does not depend on the ids: by their natural key, and the history in the order it was written.
const ROW_ORDER: Readonly<Record<string, (row: Row, ids: Ids) => string>> = {
  accounts: (row) => `${String(row['launcher'])}\u0000${String(row['login'])}`,
  games: (row) => `${String(row['launcher'])}\u0000${String(row['launcher_game_id'])}`,
  settings: (row) => String(row['key']),
  secrets: (row) => String(row['key']),
  launcher_sessions: (row, ids) => ids.aliasOf(String(row['account_id'])) ?? String(row['account_id']),
  artwork: (row, ids) => ids.aliasOf(String(row['game_id'])) ?? String(row['game_id']),
  artwork_attempts: (row, ids) => ids.aliasOf(String(row['game_id'])) ?? String(row['game_id']),
};

export function readDb(dataDir: string, ids: Ids): { user_version: number; tables: Record<string, Row[]> } {
  const db = new Database(join(dataDir, 'onelaunch.db'), { readonly: true, fileMustExist: true });
  try {
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]
    ).map((t) => t.name);
    const tables: Record<string, Row[]> = {};
    for (const name of names) {
      let rows = db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all() as Row[];
      if (name === 'settings') rows = rows.filter((row) => !WINDOW_SETTINGS.has(String(row['key'])));
      if (name === 'launch_history') for (const row of rows) ids.history(String(row['id']));
      const order = ROW_ORDER[name];
      if (order)
        rows = rows
          .map((row) => ({ row, key: order(row, ids) }))
          .sort((a, b) => byText(a.key, b.key))
          .map((entry) => entry.row);
      tables[name] = rows.map((row) => wrapDigests(row) as Row);
    }
    return { user_version: db.pragma('user_version', { simple: true }) as number, tables };
  } finally {
    db.close();
  }
}

export function readJournal(dataDir: string): unknown {
  const file = join(dataDir, 'switch.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as unknown) : null;
}

interface ManifestFile {
  relative: string;
  source: string;
  existed: boolean;
  bytes: number;
  encrypted?: boolean;
}

/**
 * Every launcher's snapshots, oldest first, as their manifests describe them. A file's digest is of its original
 * bytes: a copy stored vault-encrypted is decrypted first, since the ciphertext depends on the vault.
 */
export function readBackups(dataDir: string, ids: Ids, decrypt: (ciphertext: Buffer) => string): Record<string, unknown> {
  const root = join(dataDir, 'backups');
  const copies = existsSync(join(root, 'db')) ? readdirSync(join(root, 'db')).filter((name) => /^onelaunch-.*\.db$/.test(name)).length : 0;
  const out: Record<string, unknown> = { db: { copies } };
  for (const launcher of LAUNCHERS) {
    const dir = join(root, launcher);
    const snapshots: unknown[] = [];
    const names = existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort()
      : [];
    for (const id of names) {
      const manifestFile = join(dir, id, 'manifest.json');
      if (!existsSync(manifestFile)) {
        snapshots.push({ id, manifest: null });
        continue;
      }
      ids.backup(id, launcher);
      const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as {
        createdAt: string;
        reason: string;
        pinned?: string;
        meta: unknown;
        files: ManifestFile[];
      };
      snapshots.push({
        id,
        createdAt: manifest.createdAt,
        reason: manifest.reason,
        pinned: manifest.pinned ?? null,
        meta: projectMeta(manifest.meta, decrypt),
        files: manifest.files.map((f) => {
          const entry = { relative: f.relative, source: f.source, existed: f.existed, bytes: f.bytes, encrypted: f.encrypted === true };
          if (!f.existed) return entry;
          const stored = readFileSync(join(dir, id, ...f.relative.split(/[\\/]/)) + (f.encrypted ? '.enc' : ''));
          return { ...entry, content: new Content(f.encrypted ? Buffer.from(decrypt(stored), 'base64') : stored) };
        }),
      });
    }
    out[launcher] = snapshots;
  }
  return out;
}

/** A value a snapshot keeps vault-encrypted beside its files (Battle.net's registry tokens, as a JSON list with each token under `enc`) is shown by the digest of its plaintext. */
function projectMeta(meta: unknown, decrypt: (ciphertext: Buffer) => string): unknown {
  if (meta === null || typeof meta !== 'object') return meta;
  return Object.fromEntries(
    Object.entries(meta).map(([key, value]) => {
      if (typeof value !== 'string' || !value.startsWith('[')) return [key, value];
      let list: unknown;
      try {
        list = JSON.parse(value);
      } catch {
        return [key, value];
      }
      if (!Array.isArray(list) || !list.every((item) => item !== null && typeof item === 'object' && typeof (item as { enc?: unknown }).enc === 'string'))
        return [key, value];
      return [
        key,
        (list as ({ enc: string } & Record<string, unknown>)[]).map(({ enc, ...rest }) => ({
          ...rest,
          plaintextSha256: sha256(decrypt(Buffer.from(enc, 'base64'))),
        })),
      ];
    }),
  );
}

export function readLauncherFiles(launchersDir: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const { path, parse } of LAUNCHER_FILES) {
    const file = join(launchersDir, ...path.split('/'));
    if (!existsSync(file)) continue;
    const bytes = readFileSync(file);
    out[path] = { bytes: bytes.byteLength, content: new Content(bytes), parsed: wrapDigests(parse(bytes.toString('utf8'))) };
  }
  return out;
}

export function readLog(dataDir: string): { warn: string[]; error: string[] } {
  const dir = join(dataDir, 'logs');
  if (!existsSync(dir)) return { warn: [], error: [] };
  // Rotated files are older the higher their number, and the live file is the newest.
  const files = readdirSync(dir)
    .filter((name) => /^onelaunch(\.\d+)?\.log$/.test(name))
    .sort((a, b) => Number(/\.(\d+)\./.exec(b)?.[1] ?? 0) - Number(/\.(\d+)\./.exec(a)?.[1] ?? 0));
  return projectLog(files.map((name) => readFileSync(join(dir, name), 'utf8')).join('\n'));
}

export function isBackupManifest(path: string, dataDir: string): { launcher: string; id: string } | null {
  const prefix = `${join(dataDir, 'backups')}\\`.toLowerCase();
  if (!path.toLowerCase().startsWith(prefix)) return null;
  const parts = path.slice(prefix.length).split('\\');
  return parts.length === 3 && parts[2] === 'manifest.json' ? { launcher: parts[0]!, id: parts[1]! } : null;
}
