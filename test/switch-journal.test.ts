import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '../src/main/db';
import { AccountsService } from '../src/main/services/accounts';
import { BackupService } from '../src/main/services/backup';
import type { LauncherService } from '../src/main/services/launchers';
import { createLogger } from '../src/main/services/logger';
import { SwitchJournal, SwitchRecoveryService } from '../src/main/services/switch-journal';
import type { Vault } from '../src/main/services/vault';
import type { LauncherId, RestoreResult, VaultStatus } from '../src/shared/models';

class FakeVault implements Vault {
  readonly backend = 'dpapi' as const;
  isAvailable(): boolean {
    return true;
  }
  status(): VaultStatus {
    return { available: true, backend: 'dpapi' };
  }
  encrypt(plaintext: string): Buffer {
    return Buffer.from(plaintext, 'utf8');
  }
  decrypt(ciphertext: Buffer): string {
    return ciphertext.toString('utf8');
  }
}

const JOB = '11111111-2222-3333-4444-555555555555';
const OTHER_JOB = '99999999-2222-3333-4444-555555555555';
const ACCOUNT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

let dir: string;
let file: string;
const log = createLogger('test:journal');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'onelaunch-journal-'));
  file = join(dir, 'switch.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('SwitchJournal', () => {
  it('records the job, then the snapshot and the running step, and goes away when cleared', () => {
    const journal = new SwitchJournal(file, log);
    expect(journal.read()).toBeNull();

    journal.begin({ jobId: JOB, launcher: 'steam', accountId: ACCOUNT });
    expect(journal.read()).toMatchObject({
      version: 1,
      jobId: JOB,
      launcher: 'steam',
      accountId: ACCOUNT,
      backupId: null,
      stepId: null,
      rollbackFailed: false,
    });

    journal.update({ stepId: 'close' });
    journal.update({ backupId: '2026-09-18T10-00-00.000Z', stepId: 'backup' });
    journal.update({ stepId: 'file' });
    expect(new SwitchJournal(file, log).read()).toMatchObject({ backupId: '2026-09-18T10-00-00.000Z', stepId: 'file' });
    expect(readdirSync(dir)).toEqual(['switch.json']);

    journal.clear(JOB);
    expect(existsSync(file)).toBe(false);
    expect(journal.read()).toBeNull();
  });

  it('holds nothing that names a person or a launcher account: ids, a step id, and times only', () => {
    const journal = new SwitchJournal(file, log);
    journal.begin({ jobId: JOB, launcher: 'battlenet', accountId: ACCOUNT });
    journal.update({ backupId: '2026-09-18T10-00-00.000Z', stepId: 'registry' });
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual(['accountId', 'backupId', 'jobId', 'launcher', 'rollbackFailed', 'startedAt', 'stepId', 'updatedAt', 'version']);
  });

  it('rewrites the file only when something changed', () => {
    const journal = new SwitchJournal(file, log);
    journal.begin({ jobId: JOB, launcher: 'steam', accountId: ACCOUNT });
    journal.update({ stepId: 'close' });
    const before = readFileSync(file, 'utf8');
    writeFileSync(file, `${before}\n`);
    journal.update({ stepId: 'close' });
    expect(readFileSync(file, 'utf8')).toBe(`${before}\n`);
  });

  it('never removes another job’s journal', () => {
    const old = new SwitchJournal(file, log);
    old.begin({ jobId: JOB, launcher: 'steam', accountId: ACCOUNT });
    const next = new SwitchJournal(file, log);
    next.begin({ jobId: OTHER_JOB, launcher: 'epic', accountId: ACCOUNT });
    old.clear(JOB);
    expect(next.read()?.jobId).toBe(OTHER_JOB);
    new SwitchJournal(file, log).clear(JOB);
    expect(next.read()?.jobId).toBe(OTHER_JOB);
    next.clear(OTHER_JOB);
    expect(existsSync(file)).toBe(false);
  });

  it('moves a file it cannot understand aside instead of reporting it at every start', () => {
    for (const bad of [
      '{ not json',
      JSON.stringify({ version: 2, jobId: JOB }),
      JSON.stringify({ version: 1, jobId: '../x', launcher: 'steam', accountId: ACCOUNT, startedAt: 'now', backupId: null, stepId: null }),
    ]) {
      writeFileSync(file, bad);
      expect(new SwitchJournal(file, log).read()).toBeNull();
      expect(existsSync(file)).toBe(false);
      expect(readFileSync(`${file}.unreadable`, 'utf8')).toBe(bad);
    }
  });

  it('swallows write failures: a journal that cannot be written never stops a switch', () => {
    const journal = new SwitchJournal(join(dir, 'missing-folder', 'switch.json'), log);
    expect(() => journal.begin({ jobId: JOB, launcher: 'steam', accountId: ACCOUNT })).not.toThrow();
    expect(() => journal.update({ stepId: 'close' })).not.toThrow();
    expect(() => journal.clear(JOB)).not.toThrow();
  });
});

describe('SwitchRecoveryService', () => {
  function setup(entry: { backupId: string | null; stepId: string | null; rollbackFailed?: boolean; launcher?: LauncherId } | null) {
    const db = openDatabase(':memory:');
    migrate(db);
    const accounts = new AccountsService(db, new FakeVault());
    const account = accounts.create({ launcher: entry?.launcher ?? 'steam', displayName: 'Main', login: 'user_1' });
    const backups = new BackupService(join(dir, 'backups'), { keep: () => 20 });
    const restored: [LauncherId, string][] = [];
    let restoreError: Error | null = null;
    const launchers = {
      restoreBackup: async (launcher: LauncherId, id: string): Promise<RestoreResult> => {
        if (restoreError) throw restoreError;
        restored.push([launcher, id]);
        return { launcher, id, files: [], registry: [] };
      },
    } as unknown as LauncherService;
    const journal = new SwitchJournal(file, log);
    if (entry) {
      const writer = new SwitchJournal(file, log);
      writer.begin({ jobId: JOB, launcher: entry.launcher ?? 'steam', accountId: account.id });
      if (entry.backupId) writer.update({ backupId: entry.backupId });
      if (entry.stepId) writer.update({ stepId: entry.stepId });
      if (entry.rollbackFailed) writer.update({ rollbackFailed: true });
    }
    const recovery = new SwitchRecoveryService({ journal, accounts, backups, launchers, log });
    return { recovery, journal, accounts, account, backups, restored, failRestoreWith: (e: Error | null) => (restoreError = e) };
  }

  it('has nothing to offer after a clean run', () => {
    const { recovery } = setup(null);
    recovery.load();
    expect(recovery.get()).toBeNull();
  });

  it('drops a journal without a snapshot silently: nothing had been written', () => {
    const { recovery } = setup({ backupId: null, stepId: 'close' });
    recovery.load();
    expect(recovery.get()).toBeNull();
    expect(existsSync(file)).toBe(false);
  });

  it('offers the snapshot, says how far the switch got, and notices a snapshot that is gone', () => {
    const first = setup({ backupId: 'missing-snapshot', stepId: 'registry-user' });
    first.recovery.load();
    expect(first.recovery.get()).toMatchObject({
      jobId: JOB,
      launcher: 'steam',
      accountName: 'Main',
      backupId: 'missing-snapshot',
      snapshotAvailable: false,
      phase: 'writing',
    });

    const snapshot = first.backups.snapshot({ launcher: 'steam', reason: 'Before switching', files: [] });
    const second = setup({ backupId: snapshot.id, stepId: 'verify' });
    second.recovery.load();
    expect(second.recovery.get()).toMatchObject({ snapshotAvailable: true, phase: 'signing-in' });
    second.accounts.delete(second.account.id);
    expect(second.recovery.get()).toMatchObject({ accountName: null });

    const third = setup({ backupId: snapshot.id, stepId: 'file', rollbackFailed: true });
    third.recovery.load();
    expect(third.recovery.get()).toMatchObject({ phase: 'rollback-failed' });
  });

  it('restores through the launcher service and settles; a refused restore keeps the prompt and the file', async () => {
    const { recovery, restored, failRestoreWith } = setup({ backupId: 'snap-1', stepId: 'file' });
    recovery.load();
    failRestoreWith(new Error('Close Steam before restoring'));
    await expect(recovery.restore()).rejects.toThrow(/Close Steam/);
    expect(recovery.get()).not.toBeNull();
    expect(existsSync(file)).toBe(true);

    failRestoreWith(null);
    expect(await recovery.restore()).toMatchObject({ launcher: 'steam', id: 'snap-1' });
    expect(restored).toEqual([['steam', 'snap-1']]);
    expect(recovery.get()).toBeNull();
    expect(existsSync(file)).toBe(false);
    await expect(recovery.restore()).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('dismiss forgets the interrupted switch but never a journal a newer job has written', () => {
    const { recovery, journal } = setup({ backupId: 'snap-1', stepId: 'wait' });
    recovery.load();
    journal.begin({ jobId: OTHER_JOB, launcher: 'epic', accountId: ACCOUNT });
    recovery.dismiss();
    expect(recovery.get()).toBeNull();
    expect(journal.read()?.jobId).toBe(OTHER_JOB);
  });

  it('a restore from Settings > Backups settles what the journal said about that launcher, and only that launcher', () => {
    const { recovery } = setup({ backupId: 'snap-1', stepId: 'file', rollbackFailed: true });
    recovery.load();
    recovery.restoredFromBackups('epic');
    expect(recovery.get()).not.toBeNull();
    expect(existsSync(file)).toBe(true);
    recovery.restoredFromBackups('steam');
    expect(recovery.get()).toBeNull();
    expect(existsSync(file)).toBe(false);
  });
});
