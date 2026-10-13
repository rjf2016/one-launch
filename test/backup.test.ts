import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BackupError, BackupService, PINNED_BACKUPS_TO_KEEP, snapshotIdFor, writeFileAtomic } from '../src/main/services/backup';

let root: string;
let launcherDir: string;
let keep = 20;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'onelaunch-backup-'));
  launcherDir = join(root, 'launcher');
  mkdirSync(join(launcherDir, 'config'), { recursive: true });
  writeFileSync(join(launcherDir, 'config', 'loginusers.vdf'), 'original');
  keep = 20;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const service = () => new BackupService(join(root, 'backups'), { keep: () => keep });

describe('BackupService', () => {
  it('snapshots files with a manifest, lists newest first, and reports missing sources honestly', () => {
    const svc = service();
    const snap = svc.snapshot({
      launcher: 'steam',
      reason: 'test',
      files: [
        { source: join(launcherDir, 'config', 'loginusers.vdf'), relative: 'config/loginusers.vdf' },
        { source: join(launcherDir, 'config', 'missing.vdf'), relative: 'config/missing.vdf' },
      ],
      meta: { AutoLoginUser: 'someone', RememberPassword: null },
    });
    expect(snap.launcher).toBe('steam');
    expect(snap.files).toEqual(['config/loginusers.vdf']);
    expect(snap.bytes).toBe('original'.length);
    expect(readFileSync(join(snap.path, 'config', 'loginusers.vdf'), 'utf8')).toBe('original');
    const manifest = JSON.parse(readFileSync(join(snap.path, 'manifest.json'), 'utf8'));
    expect(manifest.meta).toEqual({ AutoLoginUser: 'someone', RememberPassword: null });
    expect(manifest.files[1]).toMatchObject({ existed: false, sha256: null });

    const list = svc.list('steam');
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual(snap);
    expect(svc.list('epic')).toEqual([]);
    expect(svc.get('steam', snap.id)).toEqual(snap);
  });

  it('gives concurrent snapshots distinct ids and prunes the oldest beyond the keep limit', () => {
    keep = 3;
    const svc = service();
    const files = [{ source: join(launcherDir, 'config', 'loginusers.vdf'), relative: 'config/loginusers.vdf' }];
    const ids = Array.from({ length: 5 }, (_, i) => svc.snapshot({ launcher: 'steam', reason: `run ${i}`, files }).id);
    expect(new Set(ids).size).toBe(5);
    const remaining = svc.list('steam').map((s) => s.id);
    expect(remaining).toHaveLength(3);
    expect(remaining).toEqual([...ids].reverse().slice(0, 3));
    expect(readdirSync(join(root, 'backups', 'steam'))).toHaveLength(3);
  });

  it('keeps a pinned snapshot out of the usual pruning, under a quota of its own (B23)', () => {
    keep = 2;
    const svc = service();
    const files = [{ source: join(launcherDir, 'config', 'loginusers.vdf'), relative: 'config/loginusers.vdf' }];
    const pinned = svc.snapshot({ launcher: 'epic', reason: 'Before switching to Alt', files, pinned: 'Holds a sign-in that no One Launch account owns' });
    expect(pinned.pinned).toBe('Holds a sign-in that no One Launch account owns');
    const ordinary = Array.from({ length: 4 }, (_, i) => svc.snapshot({ launcher: 'epic', reason: `run ${i}`, files }).id);

    const listed = svc.list('epic');
    expect(listed.map((s) => s.id)).toEqual([ordinary[3], ordinary[2], pinned.id]);
    expect(listed.map((s) => s.pinned)).toEqual([null, null, 'Holds a sign-in that no One Launch account owns']);
    expect(svc.restore('epic', pinned.id, [files[0]!.source]).restored).toHaveLength(1);

    const morePinned = Array.from(
      { length: PINNED_BACKUPS_TO_KEEP },
      (_, i) => svc.snapshot({ launcher: 'epic', reason: `pinned ${i}`, files, pinned: 'why' }).id,
    );
    const after = svc.list('epic');
    expect(after.filter((s) => s.pinned !== null).map((s) => s.id)).toEqual([...morePinned].reverse());
    expect(after.filter((s) => s.pinned === null)).toHaveLength(2);
    expect(after.map((s) => s.id)).not.toContain(pinned.id);
  });

  it('reads a snapshot from before pinning existed, or with a malformed pin, as an ordinary one', () => {
    const svc = service();
    const files = [{ source: join(launcherDir, 'config', 'loginusers.vdf'), relative: 'config/loginusers.vdf' }];
    const snap = svc.snapshot({ launcher: 'epic', reason: 'r', files, pinned: 'why' });
    const manifestPath = join(snap.path, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    expect(manifest['pinned']).toBe('why');
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, pinned: { not: 'text' } }));
    expect(svc.list('epic')[0]!.pinned).toBeNull();
    delete manifest['pinned'];
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(svc.list('epic')[0]!.pinned).toBeNull();
  });

  it('never prunes the snapshot it is told to protect, so a pre-restore snapshot cannot delete its target', () => {
    keep = 2;
    const svc = service();
    const files = [{ source: join(launcherDir, 'config', 'loginusers.vdf'), relative: 'config/loginusers.vdf' }];
    const oldest = svc.snapshot({ launcher: 'steam', reason: 'run 0', files });
    svc.snapshot({ launcher: 'steam', reason: 'run 1', files });
    svc.snapshot({ launcher: 'steam', reason: `Before restoring ${oldest.id}`, files, protect: oldest.id });
    expect(svc.list('steam')).toHaveLength(3);
    expect(svc.restore('steam', oldest.id, [files[0]!.source]).restored).toHaveLength(1);

    svc.snapshot({ launcher: 'steam', reason: 'run 3', files });
    const remaining = svc.list('steam').map((s) => s.id);
    expect(remaining).toHaveLength(2);
    expect(remaining).not.toContain(oldest.id);
  });

  it('restores files atomically and hands back the meta, refusing corrupt copies', () => {
    const svc = service();
    const source = join(launcherDir, 'config', 'loginusers.vdf');
    const snap = svc.snapshot({ launcher: 'steam', reason: 'before edit', files: [{ source, relative: 'config/loginusers.vdf' }], meta: { k: 1 } });
    writeFileSync(source, 'modified');

    const result = svc.restore('steam', snap.id, [source]);
    expect(result).toEqual({ restored: [source], meta: { k: 1 } });
    expect(readFileSync(source, 'utf8')).toBe('original');
    expect(readdirSync(join(launcherDir, 'config')).filter((f) => f.includes('.tmp'))).toEqual([]);

    writeFileSync(join(snap.path, 'config', 'loginusers.vdf'), 'tampered');
    expect(() => svc.restore('steam', snap.id, [source])).toThrow(BackupError);
    expect(() => svc.restore('steam', 'nope', [source])).toThrow(BackupError);
  });

  it('stores sensitive files vault-encrypted, restores them in the clear, and falls back to plaintext without a vault', () => {
    const xor = (buf: Buffer): Buffer => Buffer.from(buf.map((b) => b ^ 0x5a));
    const vault = { isAvailable: () => true, encrypt: (p: string) => xor(Buffer.from(p, 'utf8')), decrypt: (c: Buffer) => xor(c).toString('utf8') };
    const secret = '[RememberMe]\r\nEnable=True\r\nData=QUJDREVGR0hJSktMTU5PUA==\r\n';
    const source = join(launcherDir, 'config', 'GameUserSettings.ini');
    writeFileSync(source, secret);
    const svc = new BackupService(join(root, 'backups'), { keep: () => keep, vault });
    const snap = svc.snapshot({ launcher: 'epic', reason: 'test', files: [{ source, relative: 'Config/Windows/GameUserSettings.ini', sensitive: true }] });
    expect(snap.files).toEqual(['Config/Windows/GameUserSettings.ini']);
    expect(snap.bytes).toBe(Buffer.byteLength(secret));
    const stored = join(snap.path, 'Config', 'Windows', 'GameUserSettings.ini.enc');
    expect(existsSync(join(snap.path, 'Config', 'Windows', 'GameUserSettings.ini'))).toBe(false);
    expect(readFileSync(stored, 'latin1')).not.toContain('QUJDREVG');
    expect(svc.readFile('epic', snap.id, 'Config/Windows/GameUserSettings.ini').toString('utf8')).toBe(secret);

    writeFileSync(source, 'overwritten');
    expect(svc.restore('epic', snap.id, [source]).restored).toEqual([source]);
    expect(readFileSync(source, 'utf8')).toBe(secret);

    writeFileSync(stored, Buffer.concat([readFileSync(stored), Buffer.from('x')]));
    expect(() => svc.restore('epic', snap.id, [source])).toThrow(/corrupt/);

    const plain = new BackupService(join(root, 'backups-plain'), { keep: () => keep });
    const clear = plain.snapshot({ launcher: 'epic', reason: 'test', files: [{ source, relative: 'Config/Windows/GameUserSettings.ini', sensitive: true }] });
    expect(readFileSync(join(clear.path, 'Config', 'Windows', 'GameUserSettings.ini'), 'utf8')).toBe(secret);
    expect(plain.readFile('epic', clear.id, 'Config/Windows/GameUserSettings.ini').toString('utf8')).toBe(secret);
  });

  it('writes only to the files the adapter names, whatever path the manifest holds', () => {
    const svc = service();
    const source = join(launcherDir, 'config', 'loginusers.vdf');
    const elsewhere = join(root, 'elsewhere.txt');
    const snap = svc.snapshot({ launcher: 'steam', reason: 'test', files: [{ source, relative: 'config/loginusers.vdf' }] });
    const manifestPath = join(snap.path, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

    writeFileSync(manifestPath, JSON.stringify({ ...manifest, files: [{ ...manifest.files[0], source: elsewhere }] }));
    expect(() => svc.restore('steam', snap.id, [source])).toThrow(/not one of steam's/);
    expect(existsSync(elsewhere)).toBe(false);

    // The same file spelled differently is still the adapter's file.
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, files: [{ ...manifest.files[0], source: source.toUpperCase().replace(/\\/g, '/') }] }));
    writeFileSync(source, 'modified');
    expect(svc.restore('steam', snap.id, [source]).restored).toHaveLength(1);
    expect(readFileSync(source, 'utf8')).toBe('original');
  });

  it('refuses ids that are not snapshot ids and snapshots taken for another launcher', () => {
    const svc = service();
    const source = join(launcherDir, 'config', 'loginusers.vdf');
    const snap = svc.snapshot({ launcher: 'steam', reason: 'test', files: [{ source, relative: 'config/loginusers.vdf' }], meta: { k: 1 } });
    for (const id of [`..\\steam\\${snap.id}`, `../steam/${snap.id}`, `${snap.id}\\..\\${snap.id}`, '.', '']) {
      expect(() => svc.restore('epic', id, [source])).toThrow(/not found/);
      expect(() => svc.meta('epic', id)).toThrow(/not found/);
      expect(() => svc.readFile('epic', id, 'config/loginusers.vdf')).toThrow(BackupError);
    }
    expect(svc.meta('steam', snap.id)).toEqual({ k: 1 });

    mkdirSync(join(root, 'backups', 'epic'), { recursive: true });
    cpSync(snap.path, join(root, 'backups', 'epic', snap.id), { recursive: true });
    writeFileSync(source, 'modified');
    expect(() => svc.restore('epic', snap.id, [source])).toThrow(/was taken for steam, not epic/);
    expect(readFileSync(source, 'utf8')).toBe('modified');
  });

  it('verifies every stored copy before it replaces any file', () => {
    const svc = service();
    const first = join(launcherDir, 'config', 'loginusers.vdf');
    const second = join(launcherDir, 'config', 'second.vdf');
    writeFileSync(second, 'second original');
    const snap = svc.snapshot({
      launcher: 'steam',
      reason: 'test',
      files: [
        { source: first, relative: 'config/loginusers.vdf' },
        { source: second, relative: 'config/second.vdf' },
      ],
    });
    writeFileSync(first, 'first modified');
    writeFileSync(second, 'second modified');
    writeFileSync(join(snap.path, 'config', 'second.vdf'), 'tampered');
    expect(() => svc.restore('steam', snap.id, [first, second])).toThrow(/corrupt/);
    expect(readFileSync(first, 'utf8')).toBe('first modified');
    expect(readFileSync(second, 'utf8')).toBe('second modified');
    expect(readdirSync(join(launcherDir, 'config')).filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  it('does not list a snapshot whose manifest has a malformed file entry', () => {
    const svc = service();
    const source = join(launcherDir, 'config', 'loginusers.vdf');
    const snap = svc.snapshot({ launcher: 'steam', reason: 'test', files: [{ source, relative: 'config/loginusers.vdf' }] });
    const manifestPath = join(snap.path, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, files: [{ relative: 'config/loginusers.vdf', source: 42, existed: true }] }));
    expect(svc.list('steam')).toEqual([]);
    expect(() => svc.restore('steam', snap.id, [source])).toThrow(/not found/);
  });

  it('rejects snapshot-relative paths that escape the snapshot folder', () => {
    const svc = service();
    for (const relative of ['../x', 'C:\\x', '/x', 'a/../../x', '']) {
      expect(() => svc.snapshot({ launcher: 'steam', reason: 't', files: [{ source: 'x', relative }] })).toThrow(BackupError);
    }
    expect(existsSync(join(root, 'backups', 'steam'))).toBe(false);
  });

  it('ignores folders without a valid manifest', () => {
    const svc = service();
    mkdirSync(join(root, 'backups', 'steam', 'junk'), { recursive: true });
    writeFileSync(join(root, 'backups', 'steam', 'junk', 'manifest.json'), '{ not json');
    mkdirSync(join(root, 'backups', 'steam', 'empty'), { recursive: true });
    expect(svc.list('steam')).toEqual([]);
  });
});

describe('helpers', () => {
  it('snapshot ids sort chronologically as strings', () => {
    const a = snapshotIdFor(new Date('2026-09-11T18:51:57.914Z'));
    const b = snapshotIdFor(new Date('2026-09-11T18:52:00.000Z'));
    expect(a).toBe('2026-09-11T18-51-57.914Z');
    expect(a < b).toBe(true);
  });

  it('writeFileAtomic leaves no temp file behind and creates parents', () => {
    const dest = join(root, 'deep', 'er', 'file.txt');
    writeFileAtomic(dest, 'hello');
    expect(readFileSync(dest, 'utf8')).toBe('hello');
    writeFileAtomic(dest, Buffer.from('bye'));
    expect(readFileSync(dest, 'utf8')).toBe('bye');
    expect(readdirSync(join(root, 'deep', 'er'))).toEqual(['file.txt']);
  });
});
