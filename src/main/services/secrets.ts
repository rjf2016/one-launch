import type { SecretKey } from '@shared/models';
import type { Db } from '../db';
import type { Vault } from './vault';

/**
 * Named secrets (not account passwords). Ciphertext lives in the `secrets` table;
 * plaintext exists only transiently inside get/set.
 */
export class SecretStore {
  private readonly selectStmt;
  private readonly upsertStmt;
  private readonly deleteStmt;
  private readonly existsStmt;

  constructor(
    db: Db,
    private readonly vault: Vault,
  ) {
    this.selectStmt = db.prepare<[string], { value_enc: Buffer }>('SELECT value_enc FROM secrets WHERE key = ?');
    this.upsertStmt = db.prepare<[string, Buffer, string]>(
      `INSERT INTO secrets (key, value_enc, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_enc = excluded.value_enc, updated_at = excluded.updated_at`,
    );
    this.deleteStmt = db.prepare<[string]>('DELETE FROM secrets WHERE key = ?');
    this.existsStmt = db.prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM secrets WHERE key = ?');
  }

  set(key: SecretKey, plaintext: string): void {
    const enc = this.vault.encrypt(plaintext);
    this.upsertStmt.run(key, enc, new Date().toISOString());
  }

  get(key: SecretKey): string | null {
    const row = this.selectStmt.get(key);
    if (!row) return null;
    return this.vault.decrypt(row.value_enc);
  }

  has(key: SecretKey): boolean {
    return (this.existsStmt.get(key)?.n ?? 0) > 0;
  }

  delete(key: SecretKey): void {
    this.deleteStmt.run(key);
  }
}
