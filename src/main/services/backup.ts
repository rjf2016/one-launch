import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, sep } from 'node:path';
import type { BackupSnapshot, LauncherId } from '@shared/models';
import { samePath } from '../platform/fs-path';
import type { Logger } from './logger';
import type { Vault } from './vault';

export const DEFAULT_BACKUPS_TO_KEEP = 20;
/** How many pinned snapshots are kept per launcher, on top of the ordinary ones. Not a setting: each is a few kilobytes, and a sign-in older than the ten after it has long expired. */
export const PINNED_BACKUPS_TO_KEEP = 10;

export interface BackupFileSpec {
  /** Absolute path of the launcher-owned file. */
  source: string;
  /** Where it lands inside the snapshot, e.g. "config/loginusers.vdf". */
  relative: string;
  /**
   * The file holds bearer material (Epic's [RememberMe] blob). Stored vault-encrypted as
   * `<relative>.enc` so nothing under backups/ is a usable credential in the clear.
   */
  sensitive?: boolean;
}

export interface SnapshotRequest {
  launcher: LauncherId;
  /** Why the snapshot was taken, e.g. "switch to account <id>". Shown in the UI; keep it secret-free. */
  reason: string;
  files: BackupFileSpec[];
  /** Small values to restore alongside the files (registry values, for instance). */
  meta?: Record<string, string | number | boolean | null>;
  /** A snapshot id this snapshot's pruning must not remove: the one about to be restored. */
  protect?: string;
  /**
   * Set when the snapshot holds the only copy of something, in practice a sign-in the launcher
   * remembered that no One Launch account owns. It is then not counted against `keep` and only the
   * oldest beyond PINNED_BACKUPS_TO_KEEP are removed. The text says why, for the UI; keep it secret-free.
   */
  pinned?: string;
}

interface ManifestFile {
  relative: string;
  source: string;
  /** False when the source did not exist at snapshot time; restore then leaves it alone. */
  existed: boolean;
  /** Size of the original file. */
  bytes: number;
  /** Hash of the stored copy (the ciphertext when encrypted). */
  sha256: string | null;
  /** The stored copy is vault ciphertext of the base64 file bytes, at `<relative>.enc`. */
  encrypted?: boolean;
}

interface Manifest {
  version: 1;
  launcher: LauncherId;
  createdAt: string;
  reason: string;
  files: ManifestFile[];
  meta: Record<string, string | number | boolean | null>;
  pinned?: string;
}

export class BackupError extends Error {
  readonly code = 'BACKUP';
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

const MANIFEST_NAME = 'manifest.json';
const ENCRYPTED_SUFFIX = '.enc';

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function checkRelative(relative: string): void {
  if (!relative || isAbsolute(relative) || relative.split(/[\\/]/).some((seg) => seg === '..' || seg === '')) {
    throw new BackupError(`Invalid snapshot-relative path: ${relative}`);
  }
}

/** Timestamp folder names sort chronologically as plain strings. */
export function snapshotIdFor(date: Date): string {
  return date.toISOString().replace(/:/g, '-');
}

/** What snapshotIdFor produces, with the "-2" a same-millisecond snapshot gets. Anything else never reaches a path join. */
const SNAPSHOT_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z(-\d+)?$/;

function isManifestFile(value: unknown): value is ManifestFile {
  if (!value || typeof value !== 'object') return false;
  const f = value as Partial<ManifestFile>;
  return (
    typeof f.relative === 'string' &&
    typeof f.source === 'string' &&
    typeof f.existed === 'boolean' &&
    typeof f.bytes === 'number' &&
    (f.sha256 === null || typeof f.sha256 === 'string')
  );
}

/**
 * Writes via a temp file in the same directory and renames over the destination, so a crash mid-write
 * leaves either the old file or the new one, never a truncated mix (spec section 12).
 */
export function writeFileAtomic(dest: string, data: Buffer | string): void {
  writeFilesAtomic([{ dest, data }]);
}

/** Every temp file is written before the first rename, so a full disk or a locked folder fails with nothing replaced. */
export function writeFilesAtomic(files: readonly { dest: string; data: Buffer | string }[]): void {
  const staged = files.map((f) => ({ dest: f.dest, tmp: `${f.dest}.onelaunch-${process.pid}.tmp`, data: f.data }));
  try {
    for (const f of staged) {
      mkdirSync(dirname(f.dest), { recursive: true });
      writeFileSync(f.tmp, f.data);
    }
    for (const f of staged) renameSync(f.tmp, f.dest);
  } finally {
    for (const f of staged) if (existsSync(f.tmp)) rmSync(f.tmp, { force: true });
  }
}

/**
 * Snapshots launcher-owned files under <backupsDir>\<launcher>\<timestamp>\ before any adapter
 * modifies them (spec section 8.1 rule 1). Keeps the newest N snapshots per launcher.
 */
export class BackupService {
  constructor(
    private readonly rootDir: string,
    private readonly opts: { keep: () => number; log?: Logger; vault?: Pick<Vault, 'isAvailable' | 'encrypt' | 'decrypt'> },
  ) {}

  private storedPath(dir: string, f: Pick<ManifestFile, 'relative' | 'encrypted'>): string {
    return join(dir, ...f.relative.split(/[\\/]/)) + (f.encrypted ? ENCRYPTED_SUFFIX : '');
  }

  dirFor(launcher: LauncherId): string {
    return join(this.rootDir, launcher);
  }

  /** The folder a snapshot taken right now would use. For dry-run plans; creates nothing. */
  previewPath(launcher: LauncherId): string {
    return join(this.dirFor(launcher), `<timestamp>`);
  }

  snapshot(req: SnapshotRequest): BackupSnapshot {
    for (const f of req.files) checkRelative(f.relative);
    const launcherDir = this.dirFor(req.launcher);
    mkdirSync(launcherDir, { recursive: true });

    const createdAt = new Date();
    let id = snapshotIdFor(createdAt);
    let dir = join(launcherDir, id);
    for (let n = 2; existsSync(dir); n++) {
      id = `${snapshotIdFor(createdAt)}-${n}`;
      dir = join(launcherDir, id);
    }
    mkdirSync(dir, { recursive: true });

    const files: ManifestFile[] = [];
    for (const f of req.files) {
      if (!existsSync(f.source)) {
        files.push({ relative: f.relative, source: f.source, existed: false, bytes: 0, sha256: null });
        continue;
      }
      const vault = this.opts.vault;
      const encrypted = Boolean(f.sensitive) && vault !== undefined && vault.isAvailable();
      if (f.sensitive && !encrypted) this.opts.log?.warn('secure storage unavailable; sensitive backup file stored in the clear', { relative: f.relative });
      const dest = this.storedPath(dir, { relative: f.relative, encrypted });
      mkdirSync(dirname(dest), { recursive: true });
      let stored: Buffer;
      let bytes: number;
      if (encrypted) {
        const plain = readFileSync(f.source);
        bytes = plain.byteLength;
        stored = vault.encrypt(plain.toString('base64'));
        writeFileSync(dest, stored);
      } else {
        copyFileSync(f.source, dest);
        stored = readFileSync(dest);
        bytes = stored.byteLength;
      }
      files.push({ relative: f.relative, source: f.source, existed: true, bytes, sha256: sha256(stored), ...(encrypted ? { encrypted: true } : {}) });
    }

    const manifest: Manifest = {
      version: 1,
      launcher: req.launcher,
      createdAt: createdAt.toISOString(),
      reason: req.reason,
      files,
      meta: req.meta ?? {},
      ...(req.pinned ? { pinned: req.pinned } : {}),
    };
    writeFileAtomic(join(dir, MANIFEST_NAME), JSON.stringify(manifest, null, 2));
    this.opts.log?.info('backup snapshot written', { launcher: req.launcher, id, files: files.length, pinned: Boolean(req.pinned) });

    this.prune(req.launcher, undefined, req.protect);
    return this.toSnapshot(req.launcher, id, dir, manifest);
  }

  list(launcher: LauncherId): BackupSnapshot[] {
    const launcherDir = this.dirFor(launcher);
    if (!existsSync(launcherDir)) return [];
    const out: BackupSnapshot[] = [];
    for (const entry of readdirSync(launcherDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(launcherDir, entry.name);
      const manifest = this.readManifest(dir);
      if (manifest) out.push(this.toSnapshot(launcher, entry.name, dir, manifest));
    }
    return out.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  }

  get(launcher: LauncherId, id: string): BackupSnapshot | null {
    return this.list(launcher).find((s) => s.id === id) ?? null;
  }

  /** The snapshot's folder and manifest. The id is never joined onto a path unless it has a snapshot id's shape, and the manifest must be this launcher's. */
  private load(launcher: LauncherId, id: string): { dir: string; manifest: Manifest } {
    const dir = SNAPSHOT_ID.test(id) ? join(this.dirFor(launcher), id) : null;
    const manifest = dir ? this.readManifest(dir) : null;
    if (!dir || !manifest) throw new BackupError(`Snapshot ${id} not found for ${launcher}`);
    if (manifest.launcher !== launcher) throw new BackupError(`Snapshot ${id} was taken for ${String(manifest.launcher)}, not ${launcher}`);
    return { dir, manifest };
  }

  /** The small values recorded with a snapshot (registry values and the like), without touching any file. */
  meta(launcher: LauncherId, id: string): Manifest['meta'] {
    return this.load(launcher, id).manifest.meta;
  }

  /** Deletes the oldest ordinary snapshots beyond `keep` and the oldest pinned ones beyond their own quota, never `protect`. Returns the ids removed. */
  prune(launcher: LauncherId, keep: number = this.opts.keep(), protect?: string): string[] {
    const limit = Math.max(1, Math.floor(keep));
    const snapshots = this.list(launcher);
    const surplus = [...snapshots.filter((s) => s.pinned === null).slice(limit), ...snapshots.filter((s) => s.pinned !== null).slice(PINNED_BACKUPS_TO_KEEP)];
    const removed: string[] = [];
    for (const s of surplus) {
      if (s.id === protect) continue;
      rmSync(s.path, { recursive: true, force: true });
      removed.push(s.id);
    }
    if (removed.length > 0) this.opts.log?.info('pruned backups', { launcher, removed: removed.length, keep: limit });
    return removed;
  }

  /**
   * Copies every file in the snapshot back over its source after verifying each stored copy against
   * its recorded hash. `targets` are the files the adapter owns: the manifest's absolute paths are
   * data on disk, so a path that is not one of them is refused rather than written. Every copy is
   * verified and decrypted before the first write, so a bad one fails with nothing replaced.
   * Returns the snapshot's meta so the caller can restore registry values too.
   */
  restore(launcher: LauncherId, id: string, targets: readonly string[]): { restored: string[]; meta: Manifest['meta'] } {
    const { dir, manifest } = this.load(launcher, id);
    const files = manifest.files.filter((f) => f.existed);
    const stray = files.find((f) => !isAbsolute(f.source) || !targets.some((t) => samePath(t, f.source)));
    if (stray) throw new BackupError(`Snapshot ${id} names a file that is not one of ${launcher}'s: ${stray.source}`);
    writeFilesAtomic(files.map((f) => ({ dest: f.source, data: this.readStored(dir, f) })));
    const restored = files.map((f) => f.source);
    this.opts.log?.warn('restored launcher files from backup', { launcher, id, files: restored.length });
    return { restored, meta: manifest.meta };
  }

  /** The original bytes of one file in a snapshot, decrypted when it was stored encrypted. Verifies the recorded hash first. */
  readFile(launcher: LauncherId, id: string, relative: string): Buffer {
    const { dir, manifest } = this.load(launcher, id);
    const f = manifest.files.find((entry) => entry.relative === relative && entry.existed);
    if (!f) throw new BackupError(`Snapshot ${id} for ${launcher} has no file ${relative}`);
    return this.readStored(dir, f);
  }

  private readStored(dir: string, f: ManifestFile): Buffer {
    checkRelative(f.relative);
    const data = readFileSync(this.storedPath(dir, f));
    if (f.sha256 && sha256(data) !== f.sha256) throw new BackupError(`Snapshot file is corrupt: ${f.relative}`);
    if (!f.encrypted) return data;
    if (!this.opts.vault) throw new BackupError(`Snapshot file ${f.relative} is encrypted and no vault is available to decrypt it`);
    return Buffer.from(this.opts.vault.decrypt(data), 'base64');
  }

  private readManifest(dir: string): Manifest | null {
    const file = join(dir, MANIFEST_NAME);
    if (!existsSync(file)) return null;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<Manifest>;
      if (parsed.version !== 1 || !Array.isArray(parsed.files) || !parsed.files.every(isManifestFile) || typeof parsed.createdAt !== 'string') return null;
      return {
        version: 1,
        launcher: parsed.launcher as LauncherId,
        createdAt: parsed.createdAt,
        reason: typeof parsed.reason === 'string' ? parsed.reason : '',
        files: parsed.files,
        meta: parsed.meta && typeof parsed.meta === 'object' ? parsed.meta : {},
        ...(typeof parsed.pinned === 'string' && parsed.pinned ? { pinned: parsed.pinned } : {}),
      };
    } catch {
      this.opts.log?.warn('unreadable backup manifest', { dir });
      return null;
    }
  }

  private toSnapshot(launcher: LauncherId, id: string, dir: string, manifest: Manifest): BackupSnapshot {
    return {
      id,
      launcher,
      createdAt: manifest.createdAt,
      reason: manifest.reason,
      files: manifest.files.filter((f) => f.existed).map((f) => f.relative),
      bytes: manifest.files.reduce((sum, f) => sum + f.bytes, 0),
      pinned: manifest.pinned ?? null,
      path: dir.endsWith(sep) ? dir.slice(0, -1) : dir,
    };
  }
}
