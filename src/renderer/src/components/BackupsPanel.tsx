import { AlertTriangle, ChevronRight, FolderOpen, RefreshCw, RotateCcw } from 'lucide-react';
import { useRef, useState } from 'react';
import { LAUNCHER_DISPLAY_NAMES, LAUNCHER_IDS, type BackupSnapshot, type LauncherId, type RestoreResult } from '@shared/models';
import { useFocusTrap } from '../lib/useFocusTrap';
import { ipc, IpcError, useIpcQuery } from '../lib/ipc';
import { formatDateTime } from '../lib/time';
import { Button } from './Button';
import { Dropdown } from './Dropdown';
import { LauncherDot } from './LauncherBadge';
import { Panel, Row } from './Panel';

const DEFAULT_KEEP = 20;
const KEEP_CHOICES = [5, 10, 20, 50, 100];

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function errorMessage(err: unknown): string {
  if (err instanceof IpcError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

function RestoreDialog({ snapshot, onClose, onRestored }: { snapshot: BackupSnapshot; onClose: () => void; onRestored: (r: RestoreResult) => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function restore(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const { result } = await ipc.invoke('backups:restore', { launcher: snapshot.launcher, id: snapshot.id });
      onRestored(result);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-x-0 top-9 bottom-0 z-30 flex items-center justify-center bg-bg/70 p-6" onClick={onClose} role="presentation">
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="restore-title"
        className="w-full max-w-lg rounded-panel border border-border bg-surface shadow-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="border-b border-border px-5 py-4">
          <h2 id="restore-title" className="text-sm font-semibold text-text-strong">
            Restore {LAUNCHER_DISPLAY_NAMES[snapshot.launcher]} files from {formatDateTime(snapshot.createdAt)}?
          </h2>
          <p className="mt-0.5 text-xs text-muted">{snapshot.reason || 'Snapshot'}</p>
        </header>
        <div className="flex flex-col gap-3 px-5 py-4 text-sm text-text">
          <p>This overwrites the current copies with the ones in the snapshot:</p>
          <ul className="list-disc pl-5 font-mono text-xs text-muted">
            {snapshot.files.map((f) => (
              <li key={f}>{f}</li>
            ))}
            {snapshot.launcher === 'steam' ? <li>HKCU\Software\Valve\Steam\AutoLoginUser and RememberPassword (as recorded)</li> : null}
          </ul>
          <p className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            {snapshot.launcher === 'steam'
              ? 'Steam must be closed first. It rewrites loginusers.vdf when it exits, which would undo the restore.'
              : `${LAUNCHER_DISPLAY_NAMES[snapshot.launcher]} must be closed first. It rewrites its settings file while it runs, which would undo the restore.`}
          </p>
          {error ? <p className="text-xs text-danger">{error}</p> : null}
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" icon={<RotateCcw />} disabled={busy} onClick={() => void restore()}>
            {busy ? 'Restoring…' : 'Restore this snapshot'}
          </Button>
        </footer>
      </div>
    </div>
  );
}

function LauncherBackups({ launcher, revision, onRestore }: { launcher: LauncherId; revision: number; onRestore: (s: BackupSnapshot) => void }) {
  const name = LAUNCHER_DISPLAY_NAMES[launcher];
  const backups = useIpcQuery(() => ipc.invoke('backups:list', { launcher }), [launcher, revision]);
  const snapshots = backups.data?.snapshots ?? [];
  const [open, setOpen] = useState(false);
  const count = backups.loading && !backups.data ? '…' : `${snapshots.length} snapshot${snapshots.length === 1 ? '' : 's'}`;
  return (
    <section className="not-last:border-b not-last:border-border/60">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-md py-3 text-left transition-colors duration-150 hover:text-text-strong"
      >
        <ChevronRight className={`size-3.5 shrink-0 text-faint transition-transform duration-150 ${open ? 'rotate-90' : ''}`} />
        <LauncherDot launcher={launcher} />
        <h3 className="text-sm font-medium text-text">{name}</h3>
        <span className="text-xs text-faint">{count}</span>
      </button>
      {!open ? null : backups.error ? (
        <p className="pb-3 pl-[22px] text-sm text-danger">Could not list backups: {backups.error}</p>
      ) : snapshots.length === 0 ? (
        backups.loading ? null : (
          <p className="pb-3 pl-[22px] text-xs text-muted">No snapshots yet. The first one is taken automatically before the first real switch.</p>
        )
      ) : (
        <ul className="mb-2 divide-y divide-border/60 pl-[22px]">
          {snapshots.map((snap) => (
            <li key={snap.id} className="flex items-center justify-between gap-4 py-2 text-sm">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-text">
                  {formatDateTime(snap.createdAt)}
                  {snap.pinned ? (
                    <span className="rounded-md border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[11px] font-medium text-warning" title={snap.pinned}>
                      Kept
                    </span>
                  ) : null}
                </div>
                <div className="truncate text-xs text-muted">
                  {snap.pinned ? `${snap.pinned} · ` : ''}
                  {snap.reason || 'Snapshot'} · {snap.files.length} file{snap.files.length === 1 ? '' : 's'} · {formatBytes(snap.bytes)} ·{' '}
                  <span className="font-mono text-faint">{snap.id}</span>
                </div>
              </div>
              <Button icon={<RotateCcw />} onClick={() => onRestore(snap)}>
                Restore
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Settings panel listing every launcher's config snapshots, with one-click restore behind a confirmation. */
export function BackupsPanel() {
  const [revision, setRevision] = useState(0);
  const [pending, setPending] = useState<BackupSnapshot | null>(null);
  const [lastRestore, setLastRestore] = useState<RestoreResult | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [keepError, setKeepError] = useState<string | null>(null);
  const settings = useIpcQuery(() => ipc.invoke('settings:get', { key: 'backups.keep' }));
  const keep = Number(settings.data?.value) >= 1 ? Number(settings.data?.value) : DEFAULT_KEEP;
  // A value set outside the app (any whole number up to 200 is valid) stays selectable.
  const keepChoices = [...new Set([...KEEP_CHOICES, keep])].sort((a, b) => a - b);

  async function setKeep(value: string): Promise<void> {
    setKeepError(null);
    try {
      await ipc.invoke('settings:set', { key: 'backups.keep', value });
    } catch (err) {
      setKeepError(errorMessage(err));
    } finally {
      settings.reload();
    }
  }

  async function openFolder(): Promise<void> {
    setOpenError(null);
    try {
      await ipc.invoke('app:openPath', { target: 'backups' });
    } catch (err) {
      setOpenError(errorMessage(err));
    }
  }

  return (
    <Panel
      title="Backups"
      description="The launcher files One Launch changes, saved before every switch."
      actions={
        <>
          <Button icon={<RefreshCw />} onClick={() => setRevision((r) => r + 1)}>
            Refresh
          </Button>
          <Button icon={<FolderOpen />} onClick={() => void openFolder()}>
            Open folder
          </Button>
        </>
      }
    >
      {openError ? <p className="mb-3 text-xs text-danger">Could not open the folder: {openError}</p> : null}
      {pending ? (
        <RestoreDialog
          snapshot={pending}
          onClose={() => setPending(null)}
          onRestored={(r) => {
            setPending(null);
            setLastRestore(r);
          }}
        />
      ) : null}

      {lastRestore ? (
        <div className="mb-3 rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-xs text-success">
          Restored snapshot {lastRestore.id}: {lastRestore.files.length} file{lastRestore.files.length === 1 ? '' : 's'}
          {lastRestore.registry.length > 0 ? `, registry ${lastRestore.registry.join(', ')}` : ''}. Start the launcher to check it signed in as expected.
        </div>
      ) : null}

      {keepError ? <p className="mb-3 text-xs text-danger">Could not save the setting: {keepError}</p> : null}
      <Row label="Snapshots to keep" hint="Per launcher. Older ones go as new ones are taken; Kept snapshots never count.">
        <Dropdown
          label="Snapshots to keep"
          value={String(keep)}
          disabled={settings.loading}
          onChange={(v) => void setKeep(v)}
          options={keepChoices.map((n) => ({ value: String(n), label: n === DEFAULT_KEEP ? `${n} (default)` : String(n) }))}
        />
      </Row>

      <div className="-mb-3">
        {LAUNCHER_IDS.map((launcher) => (
          <LauncherBackups key={launcher} launcher={launcher} revision={revision} onRestore={setPending} />
        ))}
      </div>
    </Panel>
  );
}
