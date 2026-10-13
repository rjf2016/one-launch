import { describe, expect, it } from 'vitest';
import type { VaultStatus } from '../src/shared/models';
import { migrate, openDatabase } from '../src/main/db';
import { AccountsService } from '../src/main/services/accounts';
import { createLogger } from '../src/main/services/logger';
import { SecretStore } from '../src/main/services/secrets';
import { LauncherSessionStore } from '../src/main/services/sessions';
import { VaultUnreadableError, type Vault } from '../src/main/services/vault';
import { VaultHealth } from '../src/main/services/vault-health';

/** XORs with a per-instance key, so swapping the key models a lost or foreign DPAPI key. */
class KeyedVault implements Vault {
  readonly backend = 'dpapi' as const;
  key = 0x5a;
  isAvailable(): boolean {
    return true;
  }
  status(): VaultStatus {
    return { available: true, backend: 'dpapi' };
  }
  encrypt(plaintext: string): Buffer {
    const k = this.key;
    return Buffer.from([k, ...Buffer.from(plaintext, 'utf8').map((b) => b ^ k)]);
  }
  decrypt(ciphertext: Buffer): string {
    if (ciphertext[0] !== this.key) throw new VaultUnreadableError();
    return Buffer.from(ciphertext.subarray(1).map((b) => b ^ this.key)).toString('utf8');
  }
}

function setup() {
  const db = openDatabase(':memory:');
  migrate(db);
  const vault = new KeyedVault();
  const secrets = new SecretStore(db, vault);
  const accounts = new AccountsService(db, vault);
  const sessions = new LauncherSessionStore(db, vault);
  const health = new VaultHealth(db, vault, secrets, createLogger('test:vault'));
  return { db, vault, secrets, accounts, sessions, health };
}

describe('VaultHealth', () => {
  it('reports null before anything is stored, then readable once the probe exists', () => {
    const { health, secrets } = setup();
    expect(health.status()).toEqual({ available: true, backend: 'dpapi', readable: null });
    health.ensureProbe();
    expect(secrets.has('vault.probe')).toBe(true);
    expect(health.status().readable).toBe(true);
    health.ensureProbe();
    expect(health.status().readable).toBe(true);
  });

  it('reports unreadable when the key changes and never overwrites the probe on its own', () => {
    const { health, vault, accounts } = setup();
    health.ensureProbe();
    const account = accounts.create({ launcher: 'epic', displayName: 'A', login: 'a@example.com', password: 'pw' });
    vault.key = 0x33;
    expect(health.status().readable).toBe(false);
    expect(() => accounts.decryptPassword(account.id)).toThrow(VaultUnreadableError);
    health.ensureProbe();
    expect(health.status().readable).toBe(false);
  });

  it('reset removes every ciphertext and leaves a readable vault behind', () => {
    const { health, vault, accounts, sessions, secrets } = setup();
    health.ensureProbe();
    const a = accounts.create({ launcher: 'steam', displayName: 'A', login: 'a', password: 'pw' });
    const b = accounts.create({ launcher: 'epic', displayName: 'B', login: 'b@example.com' });
    sessions.save({ accountId: b.id, launcher: 'epic', launcherUid: null, fingerprint: 'f', blob: '{}' });
    secrets.set('steamgriddb.apiKey', 'k');
    vault.key = 0x33;
    expect(health.status().readable).toBe(false);

    const removed = health.reset();
    expect(removed).toEqual({ passwords: 1, sessions: 1, secrets: 2 });
    expect(health.status().readable).toBe(true);
    expect(accounts.get(a.id)?.hasSecret).toBe(false);
    expect(accounts.get(b.id)?.login).toBe('b@example.com');
    expect(sessions.get(b.id)).toBeNull();
    expect(secrets.has('steamgriddb.apiKey')).toBe(false);
    expect(accounts.decryptPassword(a.id)).toBeNull();
  });
});
