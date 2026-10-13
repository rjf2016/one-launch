import { isLauncherId, type LauncherId, type LauncherSession } from '@shared/models';
import type { Db } from '../db';
import type { Vault } from './vault';

interface SessionRow {
  account_id: string;
  launcher: string;
  launcher_uid: string | null;
  fingerprint: string;
  captured_at: string;
  verified_at: string | null;
  stale_reason: string | null;
}

/** Columns every read selects. The ciphertext column is never part of this list. */
const PUBLIC_COLUMNS = 'account_id, launcher, launcher_uid, fingerprint, captured_at, verified_at, stale_reason';

function toSession(row: SessionRow): LauncherSession | null {
  if (!isLauncherId(row.launcher)) return null;
  return {
    accountId: row.account_id,
    launcher: row.launcher,
    launcherUid: row.launcher_uid,
    fingerprint: row.fingerprint,
    capturedAt: row.captured_at,
    verifiedAt: row.verified_at,
    staleReason: row.stale_reason,
  };
}

export interface SaveSessionInput {
  accountId: string;
  launcher: LauncherId;
  launcherUid: string | null;
  /** SHA-256 of the blob, computed by the adapter that understands the blob's shape. */
  fingerprint: string;
  /** The session material, serialized by the adapter. Encrypted here and never returned in the clear except by decrypt(). */
  blob: string;
}

/**
 * One remembered-session snapshot per account (spec section 8.3, "session-file swap"). The blob is
 * a bearer credential and is handled like a password: vault-encrypted at rest, decrypted only by
 * the adapter at the moment it is written into the launcher's file, never logged.
 */
export class LauncherSessionStore {
  private readonly getStmt;
  private readonly byFingerprintStmt;
  private readonly byLauncherStmt;
  private readonly blobStmt;
  private readonly upsertStmt;
  private readonly verifiedStmt;
  private readonly staleStmt;
  private readonly deleteStmt;

  constructor(
    db: Db,
    private readonly vault: Vault,
  ) {
    this.getStmt = db.prepare<[string], SessionRow>(`SELECT ${PUBLIC_COLUMNS} FROM launcher_sessions WHERE account_id = ?`);
    this.byFingerprintStmt = db.prepare<[string, string], SessionRow>(
      `SELECT ${PUBLIC_COLUMNS} FROM launcher_sessions WHERE launcher = ? AND fingerprint = ? ORDER BY captured_at DESC LIMIT 1`,
    );
    this.byLauncherStmt = db.prepare<[string], SessionRow>(`SELECT ${PUBLIC_COLUMNS} FROM launcher_sessions WHERE launcher = ? ORDER BY captured_at DESC`);
    this.blobStmt = db.prepare<[string], { blob_enc: Buffer }>('SELECT blob_enc FROM launcher_sessions WHERE account_id = ?');
    this.upsertStmt = db.prepare<[string, string, string | null, Buffer, string, string]>(
      `INSERT INTO launcher_sessions (account_id, launcher, launcher_uid, blob_enc, fingerprint, captured_at, verified_at, stale_reason)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
       ON CONFLICT (account_id) DO UPDATE
         SET launcher = excluded.launcher, launcher_uid = COALESCE(excluded.launcher_uid, launcher_sessions.launcher_uid),
             blob_enc = excluded.blob_enc, fingerprint = excluded.fingerprint, captured_at = excluded.captured_at,
             verified_at = NULL, stale_reason = NULL`,
    );
    this.verifiedStmt = db.prepare<[string, string]>('UPDATE launcher_sessions SET verified_at = ?, stale_reason = NULL WHERE account_id = ?');
    this.staleStmt = db.prepare<[string, string]>('UPDATE launcher_sessions SET stale_reason = ? WHERE account_id = ?');
    this.deleteStmt = db.prepare<[string]>('DELETE FROM launcher_sessions WHERE account_id = ?');
  }

  get(accountId: string): LauncherSession | null {
    const row = this.getStmt.get(accountId);
    return row ? toSession(row) : null;
  }

  findByFingerprint(launcher: LauncherId, fingerprint: string): LauncherSession | null {
    const row = this.byFingerprintStmt.get(launcher, fingerprint);
    return row ? toSession(row) : null;
  }

  list(launcher: LauncherId): LauncherSession[] {
    return this.byLauncherStmt
      .all(launcher)
      .map(toSession)
      .filter((s): s is LauncherSession => s !== null);
  }

  /** Stores (or replaces) the account's snapshot. A replaced snapshot starts out unverified and not stale. */
  save(input: SaveSessionInput): LauncherSession {
    const enc = this.vault.encrypt(input.blob);
    this.upsertStmt.run(input.accountId, input.launcher, input.launcherUid, enc, input.fingerprint, new Date().toISOString());
    const session = this.get(input.accountId);
    if (!session) throw new Error(`Session for ${input.accountId} vanished after save`);
    return session;
  }

  /** The decrypted blob. Callers write it into the launcher file at once and drop it. */
  decrypt(accountId: string): string | null {
    const row = this.blobStmt.get(accountId);
    return row ? this.vault.decrypt(row.blob_enc) : null;
  }

  markVerified(accountId: string): void {
    this.verifiedStmt.run(new Date().toISOString(), accountId);
  }

  markStale(accountId: string, reason: string): void {
    this.staleStmt.run(reason, accountId);
  }

  delete(accountId: string): boolean {
    return this.deleteStmt.run(accountId).changes > 0;
  }
}
