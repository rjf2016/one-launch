import { RefreshCw, RotateCw } from 'lucide-react';
import { useState } from 'react';
import type { UpdateStatus, UpdateUnavailableReason } from '@shared/models';
import { ipc } from '../lib/ipc';
import { isUpdateBusy, restartToUpdate, useUpdateStatus } from '../lib/updates';
import { useUiStore } from '../store/ui';
import { Button } from './Button';
import { Panel, Row } from './Panel';
import { Toggle } from './Toggle';

const PANEL_POLL_MS = 5_000;

const UNAVAILABLE: Record<UpdateUnavailableReason, string> = {
  development: 'Updates work only in the installed app.',
  'custom-data-folder': 'Updates are off while One Launch runs from a custom data folder.',
  'not-installed': 'Updates work only in a copy installed with the One Launch installer.',
  'all-users-install': 'Updates need a copy installed for your Windows account only. Reinstall and choose "Only for me".',
};

function stateText(status: UpdateStatus | null) {
  switch (status?.state) {
    case undefined:
      return '…';
    case 'idle':
      return 'Not checked yet';
    case 'checking':
      return 'Checking…';
    case 'up-to-date':
      return <span className="text-success">Up to date</span>;
    case 'downloading':
      return `Downloading ${status.version} · ${status.percent}%`;
    case 'ready':
      return <span className="text-success">{status.version} is ready</span>;
    case 'failed':
      return <span className="text-danger">{status.step === 'check' ? 'Check failed' : status.step === 'download' ? 'Download failed' : 'Not verified'}</span>;
    case 'unavailable':
      return 'Off for this copy';
  }
}

function stateHint(status: UpdateStatus | null, auto: boolean): string | undefined {
  if (status?.state === 'up-to-date') return `Last checked at ${new Date(status.checkedAt).toLocaleTimeString(undefined, { timeStyle: 'short' })}.`;
  if (status?.state === 'unavailable') return UNAVAILABLE[status.reason];
  if (status?.state === 'ready') return auto ? 'It installs the next time One Launch restarts.' : 'It installs when you choose Restart to update.';
  return undefined;
}

function failureText(status: Extract<UpdateStatus, { state: 'failed' }>): string {
  if (status.step === 'check') return `Could not check for updates: ${status.message}.`;
  if (status.step === 'download') return `Could not download the update: ${status.message}.`;
  return `Could not verify the update, so it was not installed: ${status.message}.`;
}

interface UpdatesPanelProps {
  version: string | null;
  auto: boolean;
  settingsLoading: boolean;
  onAuto: (next: boolean) => void;
}

export function UpdatesPanel({ version, auto, settingsLoading, onAuto }: UpdatesPanelProps) {
  const status = useUpdateStatus(PANEL_POLL_MS);
  const setStatus = useUiStore((s) => s.setUpdateStatus);
  const running = useUiStore((s) => s.activeLaunch?.job.state === 'running');
  const [error, setError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const busy = isUpdateBusy(status);
  const hint = stateHint(status, auto);

  async function check(): Promise<void> {
    setError(null);
    try {
      setStatus(await ipc.invoke('updates:check'));
    } catch (err) {
      setError(`Could not check for updates: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function restart(): Promise<void> {
    setError(null);
    setRestarting(true);
    try {
      if (!(await restartToUpdate())) setRestarting(false);
    } catch (err) {
      setRestarting(false);
      setError(`Could not restart to update: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return (
    <Panel
      title="Updates"
      description="New versions come from One Launch's releases on GitHub. Nothing about your accounts is sent."
      actions={
        status?.state === 'ready' ? (
          <Button variant="primary" icon={<RotateCw />} disabled={restarting || running} onClick={() => void restart()}>
            Restart to update
          </Button>
        ) : (
          <Button
            icon={<RefreshCw className={busy ? 'animate-spin motion-reduce:animate-none' : ''} />}
            disabled={status === null || busy || status.state === 'unavailable'}
            onClick={() => void check()}
          >
            Check for updates
          </Button>
        )
      }
    >
      <Row label="Keep One Launch updated automatically" hint="Downloads new versions in the background and installs them the next time One Launch restarts.">
        <Toggle label="Keep One Launch updated automatically" checked={auto} disabled={settingsLoading} onChange={onAuto} />
      </Row>
      <Row label="Version" {...(hint ? { hint } : {})}>
        <span className="truncate">
          {version ?? '…'} · {stateText(status)}
        </span>
      </Row>
      {status?.state === 'failed' ? (
        <p role="alert" className="pt-2 text-xs text-danger">
          {failureText(status)}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="pt-2 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </Panel>
  );
}
