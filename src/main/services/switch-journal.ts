import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { isLauncherId, type LauncherId, type RestoreResult, type SwitchRecovery } from '@shared/models';
import type { AccountsService } from './accounts';
import type { BackupService } from './backup';
import type { LauncherService } from './launchers';
import type { Logger } from './logger';

/**
 * What is on disk while a switch runs. No login, display name, launcher account id, or step title:
 * the account is named by its One Launch id and the step by its fixed id.
 */
export interface JournalEntry {
  version: 1;
  jobId: string;
  launcher: LauncherId;
  accountId: string;
  startedAt: string;
  updatedAt: string;
  /** Null until the snapshot exists, which is always before the first launcher file or registry value is written. */
  backupId: string | null;
  /** The step that was running when the entry was last written. */
  stepId: string | null;
  /** The switch ended, failed, and its rollback failed too; kept so the next start offers the snapshot again. */
  rollbackFailed: boolean;
}

const ID = /^[0-9a-f-]{1,64}$/i;
const BACKUP_ID = /^[0-9A-Za-z.-]{1,64}$/;
const STEP_ID = /^[a-z-]{1,32}$/;
/** Steps that only run once the launcher's files have been written and it is being started or is signing in. */
const AFTER_WRITES: ReadonlySet<string> = new Set(['start', 'wait', 'verify', 'login', 'manual', 'recapture']);

function parseEntry(raw: unknown): JournalEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o['version'] !== 1) return null;
  const { jobId, launcher, accountId, startedAt, updatedAt, backupId, stepId } = o;
  if (typeof jobId !== 'string' || !ID.test(jobId)) return null;
  if (typeof launcher !== 'string' || !isLauncherId(launcher)) return null;
  if (typeof accountId !== 'string' || !ID.test(accountId)) return null;
  if (typeof startedAt !== 'string' || Number.isNaN(Date.parse(startedAt))) return null;
  if (backupId !== null && (typeof backupId !== 'string' || !BACKUP_ID.test(backupId))) return null;
  if (stepId !== null && (typeof stepId !== 'string' || !STEP_ID.test(stepId))) return null;
  return {
    version: 1,
    jobId,
    launcher,
    accountId,
    startedAt,
    updatedAt: typeof updatedAt === 'string' ? updatedAt : startedAt,
    backupId,
    stepId,
    rollbackFailed: o['rollbackFailed'] === true,
  };
}

/**
 * The crash-safe record of a switch in progress: `<dataDir>\switch.json`, written before the adapter
 * is called, updated when the snapshot exists and at each step, removed when the switch settles.
 * A file rather than a table so that it survives a damaged or locked database. Every failure here
 * is logged and swallowed: a journal that cannot be written never stops a switch.
 */
export class SwitchJournal {
  private current: JournalEntry | null = null;

  constructor(
    private readonly file: string,
    private readonly log: Logger,
  ) {}

  begin(input: { jobId: string; launcher: LauncherId; accountId: string }): void {
    const now = new Date().toISOString();
    this.current = { version: 1, ...input, startedAt: now, updatedAt: now, backupId: null, stepId: null, rollbackFailed: false };
    this.write(this.current);
  }

  /** Records the snapshot id, the running step, or a failed rollback for the job begun last. Writes only when something changed. */
  update(patch: { backupId?: string; stepId?: string; rollbackFailed?: true }): void {
    const entry = this.current;
    if (!entry) return;
    const next: JournalEntry = { ...entry, ...patch };
    if (next.backupId === entry.backupId && next.stepId === entry.stepId && next.rollbackFailed === entry.rollbackFailed) return;
    next.updatedAt = new Date().toISOString();
    this.current = next;
    this.write(next);
  }

  /** Removes the file. With a job id, only when the file still belongs to that job. */
  clear(jobId?: string): void {
    try {
      if (this.current && (jobId === undefined || this.current.jobId === jobId)) this.current = null;
      if (jobId !== undefined) {
        const onDisk = this.read();
        if (onDisk && onDisk.jobId !== jobId) return;
      }
      rmSync(this.file, { force: true });
    } catch (err) {
      this.log.warn('could not remove the switch journal', { error: err });
    }
  }

  /** The entry on disk, or null. A file that cannot be understood is moved aside so it is reported once, not at every start. */
  read(): JournalEntry | null {
    if (!existsSync(this.file)) return null;
    try {
      const entry = parseEntry(JSON.parse(readFileSync(this.file, 'utf8')));
      if (entry) return entry;
      this.log.warn('the switch journal has an unexpected shape; moving it aside');
    } catch (err) {
      this.log.warn('the switch journal could not be read; moving it aside', { error: err });
    }
    try {
      renameSync(this.file, `${this.file}.unreadable`);
    } catch (err) {
      this.log.warn('could not move the unreadable switch journal aside', { error: err });
    }
    return null;
  }

  /** Temp file, fsync, rename: after a power cut the file is the old entry or the new one, never a torn mix. */
  private write(entry: JournalEntry): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      const fd = openSync(tmp, 'w');
      try {
        writeSync(fd, JSON.stringify(entry, null, 2));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, this.file);
    } catch (err) {
      this.log.warn('could not write the switch journal', { error: err });
      rmSync(tmp, { force: true });
    }
  }
}

export class RecoveryNotPendingError extends Error {
  readonly code = 'NOT_FOUND';
  constructor() {
    super('There is no interrupted switch to recover');
    this.name = 'RecoveryNotPendingError';
  }
}

/**
 * What the last run left behind. Loaded once at startup, before any job can start, so a journal
 * written by a switch in this session is never mistaken for one to recover from.
 */
export class SwitchRecoveryService {
  private pending: JournalEntry | null = null;

  constructor(
    private readonly deps: {
      journal: SwitchJournal;
      accounts: AccountsService;
      backups: BackupService;
      launchers: LauncherService;
      log: Logger;
    },
  ) {}

  load(): void {
    const entry = this.deps.journal.read();
    if (!entry) return;
    if (entry.backupId === null) {
      // The snapshot always comes before the first write, so without one nothing was changed.
      this.deps.log.info('the last run ended during a switch before anything was written; nothing to recover', { jobId: entry.jobId, stepId: entry.stepId });
      this.deps.journal.clear(entry.jobId);
      return;
    }
    this.pending = entry;
    this.deps.log.warn('the last run ended during a switch; offering its snapshot', {
      jobId: entry.jobId,
      launcher: entry.launcher,
      accountId: entry.accountId,
      backupId: entry.backupId,
      stepId: entry.stepId,
      rollbackFailed: entry.rollbackFailed,
    });
  }

  get(): SwitchRecovery | null {
    const entry = this.pending;
    if (!entry || entry.backupId === null) return null;
    return {
      jobId: entry.jobId,
      launcher: entry.launcher,
      accountName: this.deps.accounts.get(entry.accountId)?.displayName ?? null,
      startedAt: entry.startedAt,
      backupId: entry.backupId,
      snapshotAvailable: this.deps.backups.get(entry.launcher, entry.backupId) !== null,
      phase: entry.rollbackFailed ? 'rollback-failed' : entry.stepId !== null && AFTER_WRITES.has(entry.stepId) ? 'signing-in' : 'writing',
    };
  }

  /** Puts the journal's snapshot back through the same path as Settings > Backups. The prompt stays when it fails. */
  async restore(): Promise<RestoreResult> {
    const entry = this.pending;
    if (!entry || entry.backupId === null) throw new RecoveryNotPendingError();
    const result = await this.deps.launchers.restoreBackup(entry.launcher, entry.backupId);
    this.deps.log.warn('interrupted switch recovered from its snapshot', { jobId: entry.jobId, launcher: entry.launcher, backupId: entry.backupId });
    this.settle(entry);
    return result;
  }

  dismiss(): void {
    const entry = this.pending;
    if (!entry) return;
    this.deps.log.info('interrupted switch left as it is', { jobId: entry.jobId, launcher: entry.launcher });
    this.settle(entry);
  }

  /** A snapshot of this launcher was restored from Settings > Backups: whatever the journal said about it is settled. */
  restoredFromBackups(launcher: LauncherId): void {
    if (this.pending?.launcher === launcher) this.settle(this.pending);
    const onDisk = this.deps.journal.read();
    if (onDisk?.launcher === launcher) this.deps.journal.clear(onDisk.jobId);
  }

  private settle(entry: JournalEntry): void {
    this.pending = null;
    this.deps.journal.clear(entry.jobId);
  }
}
