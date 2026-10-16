import { describe, expect, it } from 'vitest';
import type { VaultStatus } from '../src/shared/models';
import { migrate, openDatabase } from '../src/main/db';
import { AccountsService } from '../src/main/services/accounts';
import { LibraryService } from '../src/main/services/library';
import { SecretStore } from '../src/main/services/secrets';
import { SettingsService } from '../src/main/services/settings';
import type { Vault } from '../src/main/services/vault';
import { seedWhatsNewSeen } from '../src/main/services/whats-new';

/** Reversible stand-in for DPAPI so the store logic can be tested without Electron. */
class FakeVault implements Vault {
  readonly backend = 'dpapi' as const;
  available = true;
  isAvailable(): boolean {
    return this.available;
  }
  status(): VaultStatus {
    return { available: this.available, backend: this.available ? 'dpapi' : 'none' };
  }
  encrypt(plaintext: string): Buffer {
    if (!this.available) throw new Error('unavailable');
    return Buffer.from(Buffer.from(plaintext, 'utf8').map((b) => b ^ 0x5a));
  }
  decrypt(ciphertext: Buffer): string {
    if (!this.available) throw new Error('unavailable');
    return Buffer.from(ciphertext.map((b) => b ^ 0x5a)).toString('utf8');
  }
}

function freshDb() {
  const db = openDatabase(':memory:');
  migrate(db);
  return db;
}

describe('SecretStore', () => {
  it('round-trips a secret and never stores plaintext', () => {
    const db = freshDb();
    const store = new SecretStore(db, new FakeVault());
    store.set('steamgriddb.apiKey', 'plain-text-key');
    expect(store.get('steamgriddb.apiKey')).toBe('plain-text-key');
    expect(store.has('steamgriddb.apiKey')).toBe(true);

    const raw = db.prepare<[], { value_enc: Buffer }>('SELECT value_enc FROM secrets').get();
    expect(raw?.value_enc.toString('utf8')).not.toContain('plain-text-key');

    store.set('steamgriddb.apiKey', 'rotated');
    expect(store.get('steamgriddb.apiKey')).toBe('rotated');
    store.delete('steamgriddb.apiKey');
    expect(store.get('steamgriddb.apiKey')).toBeNull();
    expect(store.has('steamgriddb.apiKey')).toBe(false);
  });

  it('refuses to store when the vault is unavailable', () => {
    const vault = new FakeVault();
    vault.available = false;
    const store = new SecretStore(freshDb(), vault);
    expect(() => store.set('diagnostics.roundtrip', 'x')).toThrow();
    expect(store.has('diagnostics.roundtrip')).toBe(false);
  });
});

describe('SettingsService', () => {
  it('stores, reads, overwrites, deletes, and lists known keys only', () => {
    const db = freshDb();
    const s = new SettingsService(db);
    expect(s.get('dryRun')).toBeNull();
    s.set('dryRun', 'true');
    s.set('dryRun', 'false');
    s.set('logLevel', 'debug');
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('unknown.key', 'x');
    expect(s.getAll()).toEqual({ dryRun: 'false', logLevel: 'debug' });
    expect(s.getBool('dryRun', true)).toBe(false);
    expect(s.getBool('artwork.autoFetch', true)).toBe(true);
    s.set('backups.keep', '12');
    expect(s.getInt('backups.keep', 20)).toBe(12);
    s.set('backups.keep', 'nope');
    expect(s.getInt('backups.keep', 20)).toBe(20);
    s.delete('dryRun');
    expect(s.get('dryRun')).toBeNull();
  });
});

describe('seedWhatsNewSeen', () => {
  it('marks the running version as seen on a brand-new DB only, and never overwrites', () => {
    const s = new SettingsService(freshDb());
    expect(seedWhatsNewSeen(s, false, '1.2.3')).toBe(false);
    expect(s.get('whatsNew.lastSeen')).toBeNull();
    expect(seedWhatsNewSeen(s, true, '1.2.3')).toBe(true);
    expect(s.get('whatsNew.lastSeen')).toBe('1.2.3');
    expect(seedWhatsNewSeen(s, true, '1.2.4')).toBe(false);
    expect(s.get('whatsNew.lastSeen')).toBe('1.2.3');
  });
});

describe('read services', () => {
  it('list accounts without exposing the secret and with parsed tags', () => {
    const db = freshDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO accounts (id, launcher, display_name, login, secret_enc, tags, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('a1', 'steam', 'Main', 'user@example.com', Buffer.from('cipher'), '["smurf","gold"]', '', now, now);
    db.prepare(
      `INSERT INTO accounts (id, launcher, display_name, login, tags, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('a2', 'epic', 'Alt', 'alt', 'not json', '', now, now);

    const list = new AccountsService(db, new FakeVault()).list();
    expect(list).toHaveLength(2);
    const main = list.find((a) => a.id === 'a1');
    expect(main).toMatchObject({ hasSecret: true, tags: ['smurf', 'gold'] });
    expect(JSON.stringify(main)).not.toContain('cipher');
    expect(list.find((a) => a.id === 'a2')).toMatchObject({ hasSecret: false, tags: [] });
  });

  it('lists only installed games', () => {
    const db = freshDb();
    const now = new Date().toISOString();
    const ins = db.prepare('INSERT INTO games (id, launcher, launcher_game_id, name, install_path, installed, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    ins.run('g1', 'steam', '252950', 'Rocket League', 'D:\\Games\\Steam\\steamapps\\common\\rocketleague', 1, now);
    ins.run('g2', 'battlenet', 'prometheus', 'Overwatch', null, 0, now);
    const games = new LibraryService(db).list();
    expect(games.map((g) => g.id)).toEqual(['g1']);
    expect(games[0]).toMatchObject({ launcher: 'steam', installed: true });
  });
});
