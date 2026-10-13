import { describe, expect, it } from 'vitest';
import type { VaultStatus } from '../src/shared/models';
import { migrate, openDatabase } from '../src/main/db';
import { AccountsService } from '../src/main/services/accounts';
import { LauncherSessionStore } from '../src/main/services/sessions';
import type { Vault } from '../src/main/services/vault';

class FakeVault implements Vault {
  readonly backend = 'dpapi' as const;
  isAvailable(): boolean {
    return true;
  }
  status(): VaultStatus {
    return { available: true, backend: 'dpapi' };
  }
  encrypt(plaintext: string): Buffer {
    return Buffer.from(Buffer.from(plaintext, 'utf8').map((b) => b ^ 0x5a));
  }
  decrypt(ciphertext: Buffer): string {
    return Buffer.from(ciphertext.map((b) => b ^ 0x5a)).toString('utf8');
  }
}

function setup() {
  const db = openDatabase(':memory:');
  migrate(db);
  const vault = new FakeVault();
  const accounts = new AccountsService(db, vault);
  const a = accounts.create({ launcher: 'epic', displayName: 'RL Main', login: 'main@example.com' });
  const b = accounts.create({ launcher: 'epic', displayName: 'RL Alt', login: 'alt@example.com' });
  return { db, vault, accounts, sessions: new LauncherSessionStore(db, vault), a, b };
}

describe('LauncherSessionStore', () => {
  it('stores a blob encrypted, exposes only metadata, and decrypts on demand', () => {
    const { db, sessions, a } = setup();
    const session = sessions.save({ accountId: a.id, launcher: 'epic', launcherUid: 'abc', fingerprint: 'f1', blob: '{"secret":"blob"}' });
    expect(session).toMatchObject({ accountId: a.id, launcher: 'epic', launcherUid: 'abc', fingerprint: 'f1', verifiedAt: null, staleReason: null });
    expect(JSON.stringify(session)).not.toContain('blob');
    const raw = db.prepare<[string], { blob_enc: Buffer }>('SELECT blob_enc FROM launcher_sessions WHERE account_id = ?').get(a.id)!;
    expect(raw.blob_enc.toString('utf8')).not.toContain('secret');
    expect(sessions.decrypt(a.id)).toBe('{"secret":"blob"}');
    expect(sessions.decrypt('nobody')).toBeNull();
    expect(sessions.findByFingerprint('epic', 'f1')?.accountId).toBe(a.id);
    expect(sessions.findByFingerprint('steam', 'f1')).toBeNull();
  });

  it('tracks verified and stale state, resets both on re-capture, keeps the uid when a re-capture has none', () => {
    const { sessions, a } = setup();
    sessions.save({ accountId: a.id, launcher: 'epic', launcherUid: 'abc', fingerprint: 'f1', blob: '1' });
    sessions.markVerified(a.id);
    expect(sessions.get(a.id)?.verifiedAt).not.toBeNull();
    sessions.markStale(a.id, 'TOKEN_EXPIRED');
    expect(sessions.get(a.id)?.staleReason).toBe('TOKEN_EXPIRED');
    const again = sessions.save({ accountId: a.id, launcher: 'epic', launcherUid: null, fingerprint: 'f2', blob: '2' });
    expect(again).toMatchObject({ launcherUid: 'abc', fingerprint: 'f2', verifiedAt: null, staleReason: null });
    expect(sessions.decrypt(a.id)).toBe('2');
  });

  it('lists per launcher, deletes, and goes away with the account', () => {
    const { accounts, sessions, a, b } = setup();
    sessions.save({ accountId: a.id, launcher: 'epic', launcherUid: null, fingerprint: 'f1', blob: '1' });
    sessions.save({ accountId: b.id, launcher: 'epic', launcherUid: null, fingerprint: 'f2', blob: '2' });
    expect(
      sessions
        .list('epic')
        .map((s) => s.accountId)
        .sort(),
    ).toEqual([a.id, b.id].sort());
    expect(sessions.delete(b.id)).toBe(true);
    expect(sessions.delete(b.id)).toBe(false);
    accounts.delete(a.id);
    expect(sessions.list('epic')).toEqual([]);
  });

  it('refuses a session for an account that does not exist', () => {
    const { sessions } = setup();
    expect(() => sessions.save({ accountId: 'ghost', launcher: 'epic', launcherUid: null, fingerprint: 'f', blob: 'x' })).toThrow(/FOREIGN KEY/);
  });
});
