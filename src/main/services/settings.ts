import { isSettingKey, type SettingKey } from '@shared/models';
import type { Db } from '../db';

/** Plain key/value settings in SQLite. Values are strings; typed accessors parse at the edge. */
export class SettingsService {
  private readonly selectStmt;
  private readonly upsertStmt;
  private readonly deleteStmt;
  private readonly allStmt;

  constructor(db: Db) {
    this.selectStmt = db.prepare<[string], { value: string }>('SELECT value FROM settings WHERE key = ?');
    this.upsertStmt = db.prepare<[string, string]>('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    this.deleteStmt = db.prepare<[string]>('DELETE FROM settings WHERE key = ?');
    this.allStmt = db.prepare<[], { key: string; value: string }>('SELECT key, value FROM settings');
  }

  get(key: SettingKey): string | null {
    return this.selectStmt.get(key)?.value ?? null;
  }

  set(key: SettingKey, value: string): void {
    this.upsertStmt.run(key, value);
  }

  delete(key: SettingKey): void {
    this.deleteStmt.run(key);
  }

  getAll(): Partial<Record<SettingKey, string>> {
    const out: Partial<Record<SettingKey, string>> = {};
    for (const row of this.allStmt.all()) {
      if (isSettingKey(row.key)) out[row.key] = row.value;
    }
    return out;
  }

  getBool(key: SettingKey, fallback: boolean): boolean {
    const v = this.get(key);
    if (v === null) return fallback;
    return v === 'true' || v === '1';
  }

  getInt(key: SettingKey, fallback: number): number {
    const v = this.get(key);
    if (v === null) return fallback;
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : fallback;
  }
}
