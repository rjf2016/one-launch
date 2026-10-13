import { describe, expect, it } from 'vitest';
import { normalizeTags, type VaultStatus } from '../src/shared/models';
import { migrate, openDatabase } from '../src/main/db';
import { AccountsService } from '../src/main/services/accounts';
import { ClipboardService, type ClipboardLike } from '../src/main/services/clipboard';
import type { Vault } from '../src/main/services/vault';

class FakeVault implements Vault {
  readonly backend = 'dpapi' as const;
  available = true;
  encryptCalls = 0;
  isAvailable(): boolean {
    return this.available;
  }
  status(): VaultStatus {
    return { available: this.available, backend: this.available ? 'dpapi' : 'none' };
  }
  encrypt(plaintext: string): Buffer {
    if (!this.available) throw new Error('unavailable');
    this.encryptCalls++;
    return Buffer.from(Buffer.from(plaintext, 'utf8').map((b) => b ^ 0x5a));
  }
  decrypt(ciphertext: Buffer): string {
    if (!this.available) throw new Error('unavailable');
    return Buffer.from(ciphertext.map((b) => b ^ 0x5a)).toString('utf8');
  }
}

function setup() {
  const db = openDatabase(':memory:');
  migrate(db);
  const vault = new FakeVault();
  return { db, vault, accounts: new AccountsService(db, vault) };
}

describe('normalizeTags', () => {
  it('trims, drops empties, dedupes case-insensitively, and caps', () => {
    expect(normalizeTags([' Smurf ', 'smurf', '', 'Gold', 'gold ', 'x'.repeat(100)])).toEqual(['Smurf', 'Gold', 'x'.repeat(40)]);
    expect(normalizeTags(Array.from({ length: 50 }, (_, i) => `t${i}`))).toHaveLength(32);
  });
});

describe('AccountsService', () => {
  it('creates an account with an encrypted password and never exposes it', () => {
    const { db, accounts } = setup();
    const created = accounts.create({
      launcher: 'steam',
      displayName: '  OW Main ',
      login: 'user_1',
      password: 'correct horse battery staple',
      tags: ['gold', 'Gold', ' main '],
      notes: 'Rank: Gold 3',
    });
    expect(created).toMatchObject({
      launcher: 'steam',
      displayName: 'OW Main',
      login: 'user_1',
      hasSecret: true,
      launcherUid: null,
      tags: ['gold', 'main'],
      notes: 'Rank: Gold 3',
      lastUsedAt: null,
    });
    expect(JSON.stringify(created)).not.toContain('correct horse');
    expect(JSON.stringify(accounts.list())).not.toContain('correct horse');

    const raw = db.prepare<[string], { secret_enc: Buffer }>('SELECT secret_enc FROM accounts WHERE id = ?').get(created.id);
    expect(raw?.secret_enc.toString('utf8')).not.toContain('correct horse');
    expect(accounts.decryptPassword(created.id)).toBe('correct horse battery staple');
  });

  it('creates without a password and reports hasSecret false', () => {
    const { accounts } = setup();
    const a = accounts.create({ launcher: 'epic', displayName: 'RL Alt', login: 'alt@example.com' });
    expect(a.hasSecret).toBe(false);
    expect(accounts.decryptPassword(a.id)).toBeNull();
  });

  it('rejects invalid input without creating rows', () => {
    const { accounts } = setup();
    expect(() => accounts.create({ launcher: 'steam', displayName: '   ', login: 'x' })).toThrow(/Display name is required/);
    expect(() => accounts.create({ launcher: 'steam', displayName: 'x', login: '' })).toThrow(/Login is required/);
    expect(() => accounts.create({ launcher: 'origin' as never, displayName: 'x', login: 'y' })).toThrow(/Unknown launcher/);
    expect(() => accounts.create({ launcher: 'steam', displayName: 'x', login: 'y', notes: 'n'.repeat(20_001) })).toThrow(/Notes/);
    expect(() => accounts.create({ launcher: 'steam', displayName: 'x', login: 'y', password: 'p'.repeat(1025) })).toThrow(/Password/);
    expect(accounts.list()).toHaveLength(0);
  });

  it('refuses to create with a password when the vault is unavailable, leaving no row', () => {
    const { accounts, vault } = setup();
    vault.available = false;
    expect(() => accounts.create({ launcher: 'steam', displayName: 'x', login: 'y', password: 'secret' })).toThrow();
    expect(accounts.list()).toHaveLength(0);
    // Without a password there is nothing to encrypt, so creation still works.
    expect(accounts.create({ launcher: 'steam', displayName: 'x', login: 'y' }).hasSecret).toBe(false);
  });

  it('updates only the fields present in the patch', () => {
    const { accounts } = setup();
    const a = accounts.create({ launcher: 'steam', displayName: 'A', login: 'a', tags: ['t1'], notes: 'n', launcherUid: '765' });
    const b = accounts.update(a.id, { notes: 'changed' });
    expect(b).toMatchObject({ displayName: 'A', login: 'a', tags: ['t1'], notes: 'changed', launcherUid: '765' });
    const c = accounts.update(a.id, { displayName: 'B', tags: [], launcherUid: null });
    expect(c).toMatchObject({ displayName: 'B', tags: [], launcherUid: null, notes: 'changed' });
    expect(c.updatedAt >= a.updatedAt).toBe(true);
    expect(() => accounts.update(a.id, { login: ' ' })).toThrow(/Login is required/);
    expect(() => accounts.update('missing', { notes: 'x' })).toThrow(/does not exist/);
  });

  it('sets, re-encrypts, and clears the password without touching other fields', () => {
    const { accounts, vault } = setup();
    const a = accounts.create({ launcher: 'battlenet', displayName: 'A', login: 'a@example.com', notes: 'keep me' });
    expect(vault.encryptCalls).toBe(0);

    const withPw = accounts.setPassword(a.id, 'first');
    expect(withPw.hasSecret).toBe(true);
    expect(withPw.notes).toBe('keep me');
    expect(accounts.decryptPassword(a.id)).toBe('first');

    accounts.setPassword(a.id, 'second');
    expect(vault.encryptCalls).toBe(2);
    expect(accounts.decryptPassword(a.id)).toBe('second');

    expect(() => accounts.setPassword(a.id, '')).toThrow(/empty/);
    expect(accounts.decryptPassword(a.id)).toBe('second');

    const cleared = accounts.clearPassword(a.id);
    expect(cleared.hasSecret).toBe(false);
    expect(accounts.decryptPassword(a.id)).toBeNull();
    expect(() => accounts.setPassword('missing', 'x')).toThrow(/does not exist/);
  });

  it('deletes and reports missing ids', () => {
    const { accounts } = setup();
    const a = accounts.create({ launcher: 'steam', displayName: 'A', login: 'a' });
    accounts.delete(a.id);
    expect(accounts.get(a.id)).toBeNull();
    expect(() => accounts.delete(a.id)).toThrow(/does not exist/);
    expect(() => accounts.require(a.id)).toThrow(/does not exist/);
  });

  it('refuses a second account with the same login or launcher id on one launcher, case-insensitively', () => {
    const { accounts: svc } = setup();
    const a = svc.create({ launcher: 'epic', displayName: 'A', login: 'Someone@Example.com', launcherUid: 'ABCDEF' });
    expect(() => svc.create({ launcher: 'epic', displayName: 'B', login: 'someone@example.com' })).toThrow(/already uses this login/);
    expect(() => svc.create({ launcher: 'epic', displayName: 'B', login: 'other@example.com', launcherUid: 'abcdef' })).toThrow(/already linked/);
    expect(svc.create({ launcher: 'steam', displayName: 'B', login: 'someone@example.com' }).launcher).toBe('steam');
    const b = svc.create({ launcher: 'epic', displayName: 'B', login: 'other@example.com' });
    expect(() => svc.update(b.id, { login: 'SOMEONE@example.com' })).toThrow(/already uses this login/);
    expect(() => svc.update(b.id, { launcherUid: 'abcdef' })).toThrow(/already linked/);
    expect(svc.update(a.id, { login: 'someone@example.com', launcherUid: 'abcdef' }).login).toBe('someone@example.com');
    expect(svc.listByLauncher('epic')).toHaveLength(2);
  });

  it('finds by login (case-insensitive, per launcher) and by launcher uid', () => {
    const { accounts } = setup();
    const steam = accounts.create({ launcher: 'steam', displayName: 'S', login: 'Player_One', launcherUid: '76561198000000001' });
    const epic = accounts.create({ launcher: 'epic', displayName: 'E', login: 'player_one', launcherUid: 'ABCDEF00ABCDEF00ABCDEF00ABCDEF00' });
    expect(accounts.findByLauncherUid('epic', 'abcdef00abcdef00abcdef00abcdef00')?.id).toBe(epic.id);
    expect(accounts.findByLogin('steam', 'player_one')?.id).toBe(steam.id);
    expect(accounts.findByLogin('battlenet', 'player_one')).toBeNull();
    expect(accounts.findByLauncherUid('steam', '76561198000000001')?.id).toBe(steam.id);
    expect(accounts.findByLauncherUid('epic', '76561198000000001')).toBeNull();
    expect(accounts.listByLauncher('epic').map((a) => a.displayName)).toEqual(['E']);
  });

  it('records last use', () => {
    const { accounts } = setup();
    const a = accounts.create({ launcher: 'steam', displayName: 'A', login: 'a' });
    const at = new Date('2026-09-11T12:00:00.000Z');
    accounts.touchLastUsed(a.id, at);
    expect(accounts.get(a.id)?.lastUsedAt).toBe(at.toISOString());
  });
});

describe('ClipboardService', () => {
  class FakeBoard implements ClipboardLike {
    text = '';
    async writeText(t: string) {
      this.text = t;
    }
    async readText() {
      return this.text;
    }
    clear() {
      this.text = '';
    }
  }

  it('uses the private writer when it works and falls back to the plain clipboard when it does not', async () => {
    const board = new FakeBoard();
    const reasons: string[] = [];
    let mode: 'ok' | 'throws' | 'mismatch' = 'ok';
    const privateWrite = async (text: string): Promise<void> => {
      if (mode === 'throws') throw new Error('powershell missing');
      board.text = mode === 'mismatch' ? 'something else' : text;
    };
    const svc = new ClipboardService(board, 60_000, privateWrite, (r) => reasons.push(r));
    await expect(svc.copySensitive('hunter2')).resolves.toEqual({ clearAfterMs: 60_000, historyExcluded: true });
    expect(board.text).toBe('hunter2');

    mode = 'throws';
    await expect(svc.copySensitive('hunter3')).resolves.toEqual({ clearAfterMs: 60_000, historyExcluded: false });
    expect(board.text).toBe('hunter3');

    mode = 'mismatch';
    await expect(svc.copySensitive('hunter4')).resolves.toEqual({ clearAfterMs: 60_000, historyExcluded: false });
    expect(board.text).toBe('hunter4');
    expect(reasons).toEqual(['powershell missing', 'clipboard read-back did not match']);
    await expect(svc.clearIfUnchanged()).resolves.toBe(true);
  });

  it('clears the clipboard only when it still holds the copied value', async () => {
    const board = new FakeBoard();
    const svc = new ClipboardService(board, 60_000);
    await expect(svc.copySensitive('hunter2')).resolves.toEqual({ clearAfterMs: 60_000, historyExcluded: false });
    expect(board.text).toBe('hunter2');
    await expect(svc.clearIfUnchanged()).resolves.toBe(true);
    expect(board.text).toBe('');

    await svc.copySensitive('hunter2');
    await board.writeText('something the user copied');
    await expect(svc.clearIfUnchanged()).resolves.toBe(false);
    expect(board.text).toBe('something the user copied');
    // Nothing pending any more.
    await expect(svc.clearIfUnchanged()).resolves.toBe(false);
  });
});
