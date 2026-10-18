import { AlertTriangle, ChevronDown, ChevronRight, FolderSearch, Loader2, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { LAUNCHER_EXE_NAMES, LAUNCHER_IDS, type LauncherStatus } from '@shared/models';
import { ipc, useIpcQuery } from '../lib/ipc';
import { useUiStore } from '../store/ui';
import { Button } from './Button';
import { LauncherDot } from './LauncherBadge';
import { Panel } from './Panel';
import { healthLabel, StatusPill } from './StatusPill';

function locationNote(status: LauncherStatus): string {
  if (status.install?.source === 'user') return 'You chose this folder.';
  if (status.chosenPath) return `${LAUNCHER_EXE_NAMES[status.launcher]} is no longer in the folder you chose.`;
  return status.install ? 'Found automatically.' : `Not found. If it is installed, point One Launch at ${LAUNCHER_EXE_NAMES[status.launcher]}.`;
}

function LauncherRow({ status, refreshing, onChanged }: { status: LauncherStatus; refreshing: boolean; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  /** This row changed the folder and the re-check it asked for has not come back yet: what the row shows is still the old answer. */
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const working = busy || (stale && refreshing);

  useEffect(() => {
    if (!refreshing) setStale(false);
  }, [refreshing]);
  const checks = status.health?.checks ?? [];
  const expandable = status.implemented;

  const change = async (action: 'locate' | 'reset'): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      if (action === 'reset') await ipc.invoke('launchers:resetPath', { launcher: status.launcher });
      else if ((await ipc.invoke('launchers:locate', { launcher: status.launcher })).install === null) return;
      setStale(true);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const locateButton = (
    <Button icon={working ? <Loader2 className="animate-spin" /> : <FolderSearch />} disabled={working} onClick={() => void change('locate')}>
      Locate…
    </Button>
  );

  return (
    <div className="py-2.5 first:pt-0 last:pb-0 not-last:border-b not-last:border-border/60">
      <div className="flex items-center justify-between gap-6">
        <button
          type="button"
          onClick={() => expandable && setOpen((o) => !o)}
          disabled={!expandable}
          className="flex min-w-0 items-center gap-2 text-left disabled:cursor-default [&>svg]:size-3.5 [&>svg]:text-faint"
        >
          {expandable ? open ? <ChevronDown /> : <ChevronRight /> : <span className="inline-block w-3.5" />}
          <LauncherDot launcher={status.launcher} />
          <div className="min-w-0">
            <div className="text-sm text-text">{status.displayName}</div>
            <div className="truncate font-mono text-xs text-muted">{status.install ? status.install.installDir : 'Not installed'}</div>
          </div>
        </button>
        <div className="flex shrink-0 items-center gap-2">
          {status.implemented && !status.install && !open ? locateButton : null}
          {status.attention ? (
            <StatusPill tone="fail">
              <AlertTriangle className="size-3" /> Needs attention
            </StatusPill>
          ) : null}
          {status.health ? <StatusPill tone={status.health.status}>{healthLabel(status.health.status)}</StatusPill> : null}
          {status.running !== null ? <StatusPill tone="info">{status.running ? 'Running' : 'Not running'}</StatusPill> : null}
        </div>
      </div>

      {error && !open ? (
        <p role="alert" className="mt-1 ml-[22px] text-xs text-danger">
          {error}
        </p>
      ) : null}

      {open ? (
        <div className="mt-2 ml-[22px] rounded-lg border border-border bg-surface-2/50 px-3 py-2">
          {status.attention ? <p className="mb-2 text-xs text-danger">{status.attention.message}</p> : null}
          <div className="mb-2 flex items-center justify-between gap-3 border-b border-border/60 pb-2">
            <p className="min-w-0 text-xs text-muted">{working ? 'Checking…' : locationNote(status)}</p>
            <div className="flex shrink-0 items-center gap-2">
              {locateButton}
              {status.chosenPath ? (
                <Button variant="ghost" disabled={working} onClick={() => void change('reset')}>
                  Reset
                </Button>
              ) : null}
            </div>
          </div>
          {error ? (
            <p role="alert" className="mb-2 text-xs text-danger">
              {error}
            </p>
          ) : null}
          <ul className="flex flex-col gap-1.5">
            {checks.map((c) => (
              <li key={c.id} className="flex items-start gap-2 text-xs">
                <span
                  className={`mt-1 inline-block size-1.5 shrink-0 rounded-full ${
                    c.status === 'ok' ? 'bg-success' : c.status === 'warn' ? 'bg-warning' : c.status === 'absent' ? 'bg-faint' : 'bg-danger'
                  }`}
                />
                <span className="w-40 shrink-0 text-muted">{c.label}</span>
                <span className="min-w-0 break-words text-text">{c.detail}</span>
              </li>
            ))}
          </ul>
          {status.health ? <p className="mt-2 text-[11px] text-faint">Checked {new Date(status.health.checkedAt).toLocaleTimeString()}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

/** Same height as a LauncherRow, so the panel does not grow when the real rows arrive. */
function SkeletonRow() {
  return (
    <div className="flex items-center justify-between gap-6 py-2.5 first:pt-0 last:pb-0 not-last:border-b not-last:border-border/60" aria-hidden>
      <div className="flex items-center gap-2">
        <span className="inline-block w-3.5" />
        <span className="size-2 rounded-full bg-surface-3" />
        <div>
          <div className="h-4 w-24 animate-pulse rounded bg-surface-3" />
          <div className="mt-1 h-3 w-48 animate-pulse rounded bg-surface-2" />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className="h-5 w-16 animate-pulse rounded-md bg-surface-2" />
        <span className="h-5 w-20 animate-pulse rounded-md bg-surface-2" />
      </div>
    </div>
  );
}

/** Settings panel: detection, running state, and health for every launcher, plus Locate for an installation detection missed. */
export function LauncherStatusPanel() {
  const status = useIpcQuery(() => ipc.invoke('launchers:status'));
  const known = useUiStore((s) => s.launcherStatus);
  const setKnown = useUiStore((s) => s.setLauncherStatus);
  const rows = status.data?.launchers ?? known;

  useEffect(() => {
    if (status.data) setKnown(status.data.launchers);
  }, [status.data, setKnown]);

  return (
    <Panel
      title="Launchers"
      description="Which launchers are installed and set up the way One Launch expects."
      actions={
        <Button icon={<RefreshCw className={status.loading ? 'animate-spin' : ''} />} disabled={status.loading} onClick={status.reload}>
          Re-check
        </Button>
      }
    >
      {status.error ? <p className="text-sm text-danger">Could not check launchers: {status.error}</p> : null}
      {rows
        ? rows.map((s) => <LauncherRow key={s.launcher} status={s} refreshing={status.loading} onChanged={status.reload} />)
        : !status.error
          ? LAUNCHER_IDS.map((id) => <SkeletonRow key={id} />)
          : null}
    </Panel>
  );
}
