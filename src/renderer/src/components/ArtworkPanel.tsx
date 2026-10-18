import { ExternalLink, Images, KeyRound, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { LAUNCHER_DISPLAY_NAMES, type ArtworkStatus } from '@shared/models';
import { ipc } from '../lib/ipc';
import { Button } from './Button';
import { TextInput } from './Field';
import { Panel, Row } from './Panel';
import { Toggle } from './Toggle';

interface ArtworkPanelProps {
  autoFetch: boolean;
  settingsLoading: boolean;
  vaultAvailable: boolean;
  /** Why the last change to the auto-fetch switch was not saved. */
  settingError?: string | null;
  onAutoFetch: (next: boolean) => void;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Settings > Artwork: SteamGridDB key (vault), auto-fetch, refresh all, rescan, and queue status. */
export function ArtworkPanel({ autoFetch, settingsLoading, vaultAvailable, settingError, onAutoFetch }: ArtworkPanelProps) {
  const [status, setStatus] = useState<ArtworkStatus | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<'key' | 'refresh' | 'rescan' | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function loadStatus(): Promise<void> {
    try {
      const res = await ipc.invoke('artwork:status');
      setStatus(res.status);
    } catch {
      // the row shows "…" until the next poll
    }
  }

  useEffect(() => {
    void loadStatus();
    const id = window.setInterval(() => void loadStatus(), 3000);
    return () => window.clearInterval(id);
  }, []);

  async function saveKey(): Promise<void> {
    const value = key.trim();
    if (!value) return;
    setBusy('key');
    setMessage(null);
    try {
      await ipc.invoke('vault:setSecret', { key: 'steamgriddb.apiKey', value });
      setKey('');
      const { queued } = await ipc.invoke('artwork:refresh', { gameId: null, force: false });
      setMessage(queued > 0 ? `Key saved. Fetching artwork for ${queued} game${queued === 1 ? '' : 's'}.` : 'Key saved.');
      await loadStatus();
    } catch (err) {
      setMessage(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  async function getKey(): Promise<void> {
    setMessage(null);
    try {
      await ipc.invoke('app:openUrl', { target: 'steamgriddb-api-key' });
    } catch (err) {
      setMessage(`Could not open the browser: ${errorText(err)}`);
    }
  }

  async function removeKey(): Promise<void> {
    setBusy('key');
    setMessage(null);
    try {
      await ipc.invoke('vault:deleteSecret', { key: 'steamgriddb.apiKey' });
      setMessage('Key removed.');
      await loadStatus();
    } catch (err) {
      setMessage(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  async function refreshAll(): Promise<void> {
    setBusy('refresh');
    setMessage(null);
    try {
      const { queued } = await ipc.invoke('artwork:refresh', { gameId: null, force: true });
      setMessage(`Re-fetching artwork for ${queued} game${queued === 1 ? '' : 's'}. Images you chose yourself are kept.`);
      await loadStatus();
    } catch (err) {
      setMessage(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  async function rescan(): Promise<void> {
    setBusy('rescan');
    setMessage(null);
    try {
      const { scanned } = await ipc.invoke('library:rescan');
      const added = scanned.reduce((n, s) => n + s.added, 0);
      const removed = scanned.reduce((n, s) => n + s.removed, 0);
      const failed = scanned.filter((s) => s.error !== null).map((s) => `${LAUNCHER_DISPLAY_NAMES[s.launcher]}: ${s.error}`);
      setMessage(`Library rescanned: ${added} added, ${removed} removed.${failed.length > 0 ? ` Not scanned: ${failed.join('; ')}` : ''}`);
      await loadStatus();
    } catch (err) {
      setMessage(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  const active = status ? status.queued + status.running : 0;

  return (
    <Panel
      title="Artwork"
      description="Covers come from Steam. Other games need a free SteamGridDB key."
      actions={
        <>
          <Button
            icon={<RefreshCw className={busy === 'rescan' ? 'animate-spin' : ''} />}
            title="Look for games added or removed since the last scan"
            disabled={busy !== null}
            onClick={() => void rescan()}
          >
            Rescan
          </Button>
          <Button
            icon={<Images />}
            title="Fetch every cover again; images you chose yourself are kept"
            disabled={busy !== null}
            onClick={() => void refreshAll()}
          >
            Refresh all
          </Button>
        </>
      }
    >
      <Row
        label="SteamGridDB API key"
        hint={status?.hasApiKey ? 'Paste a new key to replace the stored one.' : 'Free. Press Get a key, sign in, paste it here.'}
      >
        {status && !status.hasApiKey ? (
          <Button icon={<ExternalLink />} title="Opens the SteamGridDB API page in your browser" onClick={() => void getKey()}>
            Get a key
          </Button>
        ) : null}
        <TextInput
          type="password"
          autoComplete="off"
          aria-label="SteamGridDB API key"
          placeholder={status?.hasApiKey ? '••••••••' : 'Paste your key'}
          value={key}
          disabled={!vaultAvailable || busy === 'key'}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void saveKey();
          }}
          className="max-w-56 min-w-56"
        />
        <Button
          variant="primary"
          icon={<KeyRound />}
          aria-label="Save key"
          title="Save key"
          disabled={!vaultAvailable || busy === 'key' || key.trim() === ''}
          onClick={() => void saveKey()}
        />
        {status?.hasApiKey ? (
          <Button variant="ghost" icon={<Trash2 />} disabled={busy === 'key'} onClick={() => void removeKey()} aria-label="Remove key" title="Remove key" />
        ) : null}
      </Row>
      <Row label="Fetch artwork automatically" hint="Looks up missing covers after each scan; only game names and ids are sent." error={settingError ?? null}>
        <Toggle label="Fetch artwork automatically" checked={autoFetch} disabled={settingsLoading} onChange={onAutoFetch} />
      </Row>
      <Row label="Queue" hint="Background downloads since the app started.">
        {status ? (
          <span className={active > 0 ? 'text-text' : ''}>
            {active > 0 ? `${active} in progress · ` : ''}
            {status.completed} done{status.failed > 0 ? ` · ${status.failed} not found` : ''}
          </span>
        ) : (
          '…'
        )}
      </Row>
      {message ? <p className="pt-2 text-xs text-muted">{message}</p> : null}
    </Panel>
  );
}
