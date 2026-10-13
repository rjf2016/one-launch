import type { VaultHealthStatus } from '@shared/models';
import type { Db } from '../db';
import type { Logger } from './logger';
import type { SecretStore } from './secrets';
import { VaultUnreadableError, type Vault } from './vault';

/** A known plaintext stored encrypted at first run, so a later start can tell whether the key still works. */
const PROBE_VALUE = 'one-launch-vault-probe-v1';

export interface VaultResetResult {
  /** Accounts whose stored password was removed. */
  passwords: number;
  /** Session snapshots removed. */
  sessions: number;
  /** Named secrets removed (SteamGridDB key and the like). */
  secrets: number;
}

/**
 * Tells "the key is fine" from "the key is gone" (spec section 6 stores everything under one DPAPI
 * key that lives in the Chromium profile folder), and offers the only way out of the latter: drop every
 * ciphertext so the app is usable again and the user re-enters passwords and re-captures sessions.
 */
export class VaultHealth {
  private readonly clearPasswordsStmt;
  private readonly clearSessionsStmt;
  private readonly clearSecretsStmt;

  constructor(
    db: Db,
    private readonly vault: Vault,
    private readonly secrets: SecretStore,
    private readonly log: Logger,
  ) {
    this.clearPasswordsStmt = db.prepare<[string]>('UPDATE accounts SET secret_enc = NULL, updated_at = ? WHERE secret_enc IS NOT NULL');
    this.clearSessionsStmt = db.prepare<[]>('DELETE FROM launcher_sessions');
    this.clearSecretsStmt = db.prepare<[]>('DELETE FROM secrets');
  }

  /** Stores the probe when there is none yet. Never overwrites one: an unreadable probe is the signal. */
  ensureProbe(): void {
    if (!this.vault.isAvailable() || this.secrets.has('vault.probe')) return;
    this.secrets.set('vault.probe', PROBE_VALUE);
    this.log.info('vault probe stored');
  }

  /** `readable` is null when nothing has ever been stored to test against. */
  status(): VaultHealthStatus {
    const base = this.vault.status();
    if (!base.available || !this.secrets.has('vault.probe')) return { ...base, readable: null };
    try {
      return { ...base, readable: this.secrets.get('vault.probe') === PROBE_VALUE };
    } catch (err) {
      if (err instanceof VaultUnreadableError) return { ...base, readable: false };
      throw err;
    }
  }

  /** Drops every ciphertext (passwords, session snapshots, named secrets) and stores a fresh probe. */
  reset(): VaultResetResult {
    const passwords = this.clearPasswordsStmt.run(new Date().toISOString()).changes;
    const sessions = this.clearSessionsStmt.run().changes;
    const secrets = this.clearSecretsStmt.run().changes;
    this.log.warn('vault reset: all stored secrets removed', { passwords, sessions, secrets });
    this.ensureProbe();
    return { passwords, sessions, secrets };
  }
}
