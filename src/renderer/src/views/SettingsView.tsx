import { FolderOpen, PartyPopper, ShieldCheck, ShieldOff, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { BATTLENET_LAUNCH_FORMS, EPIC_LAUNCH_URI_FORMS, LOG_LEVELS, type BattlenetLaunchForm, type EpicLaunchUriForm, type LogLevel } from '@shared/models';
import { latestWhatsNew } from '@shared/whats-new';
import { WHATS_NEW } from '@shared/whats-new-releases';
import { ArtworkPanel } from '../components/ArtworkPanel';
import { BackupsPanel } from '../components/BackupsPanel';
import { Button } from '../components/Button';
import { Collapsible } from '../components/Collapsible';
import { Dropdown } from '../components/Dropdown';
import { LauncherStatusPanel } from '../components/LauncherStatusPanel';
import { Page } from '../components/Page';
import { PageHeader } from '../components/PageHeader';
import { Panel, Row } from '../components/Panel';
import { Toggle } from '../components/Toggle';
import { UpdatesPanel } from '../components/UpdatesPanel';
import { ipc, useIpcQuery } from '../lib/ipc';
import { useUiStore } from '../store/ui';

type SelfTest = { state: 'idle' } | { state: 'running' } | { state: 'ok'; ms: number } | { state: 'failed'; message: string };

type EditableSetting =
  | 'dryRun'
  | 'logLevel'
  | 'artwork.autoFetch'
  | 'epic.launchUri'
  | 'battlenet.launch'
  | 'steam.autoLogin'
  | 'riot.pressPlay'
  | 'window.closeToTray'
  | 'updates.auto'
  | 'whatsNew.enabled';

function formatMs(ms: number | null): string {
  return ms === null ? 'pending' : `${ms} ms`;
}

export function SettingsView() {
  const info = useIpcQuery(() => ipc.invoke('app:info'));
  const vault = useIpcQuery(() => ipc.invoke('vault:status'));
  const settings = useIpcQuery(() => ipc.invoke('settings:getAll'));
  const [selfTest, setSelfTest] = useState<SelfTest>({ state: 'idle' });
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetNote, setResetNote] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [pathError, setPathError] = useState<string | null>(null);
  const settingsChanged = useUiStore((s) => s.settingsChanged);
  const openSetupGuide = useUiStore((s) => s.openSetupGuide);
  const openWhatsNew = useUiStore((s) => s.openWhatsNew);

  async function resetVault(): Promise<void> {
    setResetting(true);
    setResetNote(null);
    try {
      const removed = await ipc.invoke('vault:reset');
      setResetNote(
        `Removed ${removed.passwords} password${removed.passwords === 1 ? '' : 's'}, ${removed.sessions} saved sign-in${removed.sessions === 1 ? '' : 's'}, ${removed.secrets} other secret${removed.secrets === 1 ? '' : 's'}.`,
      );
      setConfirmReset(false);
      vault.reload();
    } catch (err) {
      setResetNote(err instanceof Error ? err.message : String(err));
    } finally {
      setResetting(false);
    }
  }

  const dryRun = settings.data?.settings.dryRun === 'true';
  const logLevel: LogLevel = (settings.data?.settings.logLevel as LogLevel | undefined) ?? 'info';
  const epicUri: EpicLaunchUriForm = (settings.data?.settings['epic.launchUri'] as EpicLaunchUriForm | undefined) ?? 'catalog';
  const battlenetLaunch: BattlenetLaunchForm = (settings.data?.settings['battlenet.launch'] as BattlenetLaunchForm | undefined) ?? 'exec';
  const steamAutoLogin = settings.data?.settings['steam.autoLogin'] === 'true';
  const riotPressPlay = settings.data?.settings['riot.pressPlay'] !== 'false';
  const closeToTray = settings.data?.settings['window.closeToTray'] !== 'false';
  const whatsNewOn = settings.data?.settings['whatsNew.enabled'] !== 'false';
  const version = info.data?.version ?? null;
  const latestNotes = version ? latestWhatsNew(WHATS_NEW, version) : null;

  async function setSetting(key: EditableSetting, value: string): Promise<void> {
    setSettingsError(null);
    try {
      await ipc.invoke('settings:set', { key, value });
      settingsChanged();
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : String(err));
    } finally {
      settings.reload();
    }
  }

  async function openPath(target: 'logs' | 'data'): Promise<void> {
    setPathError(null);
    try {
      await ipc.invoke('app:openPath', { target });
    } catch (err) {
      setPathError(err instanceof Error ? err.message : String(err));
    }
  }

  async function runSelfTest(): Promise<void> {
    setSelfTest({ state: 'running' });
    const started = performance.now();
    const probe = crypto.randomUUID();
    try {
      await ipc.invoke('vault:setSecret', { key: 'diagnostics.roundtrip', value: probe });
      const { value } = await ipc.invoke('vault:getSecret', { key: 'diagnostics.roundtrip' });
      await ipc.invoke('vault:deleteSecret', { key: 'diagnostics.roundtrip' });
      if (value !== probe) throw new Error('Decrypted value did not match what was stored');
      setSelfTest({ state: 'ok', ms: Math.round(performance.now() - started) });
    } catch (err) {
      setSelfTest({ state: 'failed', message: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <Page narrow>
      <PageHeader title="Settings" />

      <div className="flex flex-col gap-4 pb-6">
        {vault.data?.readable === false ? (
          <div className="flex flex-col gap-2 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
            <p className="flex items-start gap-2">
              <ShieldOff className="mt-0.5 size-4 shrink-0" />
              <span>
                Your stored passwords and saved sign-ins can no longer be read. This happens when the app's data folder was copied from another PC or Windows
                user, or when its <span className="font-mono">chromium</span> folder was deleted. Clearing them makes One Launch usable again; you then enter
                passwords and save sign-ins afresh.
              </span>
            </p>
            <div className="ml-6 flex items-center gap-2">
              {confirmReset ? (
                <>
                  <Button variant="danger" disabled={resetting} onClick={() => void resetVault()}>
                    {resetting ? 'Clearing…' : 'Yes, clear them'}
                  </Button>
                  <Button variant="ghost" disabled={resetting} onClick={() => setConfirmReset(false)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <Button variant="danger" onClick={() => setConfirmReset(true)}>
                  Clear stored passwords and sign-ins…
                </Button>
              )}
              {resetNote ? <span className="text-xs">{resetNote}</span> : null}
            </div>
          </div>
        ) : null}

        <Panel title="General">
          {settingsError ? <p className="mb-3 text-xs text-danger">Could not save the setting: {settingsError}</p> : null}
          <Row label="Keep running in the system tray" hint="Closing the window keeps One Launch running in the tray, where you can reopen or quit it.">
            <Toggle
              label="Keep running in the system tray"
              checked={closeToTray}
              disabled={settings.loading}
              onChange={(next) => void setSetting('window.closeToTray', String(next))}
            />
          </Row>
          <Row label="Preview mode" hint="Play shows what a switch would do instead of doing it.">
            <Toggle label="Preview mode" checked={dryRun} disabled={settings.loading} onChange={(next) => void setSetting('dryRun', String(next))} />
          </Row>
          <Row
            label="Steam automatic sign-in"
            hint="Let One Launch type a stored Steam password for you. The password is visible to other programs on this PC while Steam runs."
          >
            <Toggle
              label="Steam automatic sign-in"
              checked={steamAutoLogin}
              disabled={settings.loading}
              onChange={(next) => void setSetting('steam.autoLogin', String(next))}
            />
          </Row>
          <Row
            label="Start Riot games for you"
            hint="Sends the Riot Client the launch request its Play button sends. Off, the client opens the game's page and you press Play."
          >
            <Toggle
              label="Start Riot games for you"
              checked={riotPressPlay}
              disabled={settings.loading}
              onChange={(next) => void setSetting('riot.pressPlay', String(next))}
            />
          </Row>
          <Row label="Show what's new after an update" hint="The first time you open One Launch after an update, a short list of what changed.">
            <Toggle
              label="Show what's new after an update"
              checked={whatsNewOn}
              disabled={settings.loading}
              onChange={(next) => void setSetting('whatsNew.enabled', String(next))}
            />
          </Row>
          <Row label="What's new" hint="The changes in the latest update.">
            <Button
              icon={<PartyPopper />}
              aria-label="Show what's new"
              disabled={!latestNotes}
              onClick={() => {
                if (latestNotes && version) openWhatsNew({ release: latestNotes, version });
              }}
            >
              Show
            </Button>
          </Row>
          <Row label="Setup guide" hint="The welcome steps: your launchers, how Play works, and adding accounts.">
            <Button icon={<Sparkles />} onClick={() => openSetupGuide('settings')}>
              Show again
            </Button>
          </Row>
        </Panel>

        <UpdatesPanel
          version={info.data?.version ?? null}
          auto={settings.data?.settings['updates.auto'] !== 'false'}
          settingsLoading={settings.loading}
          onAuto={(next) => void setSetting('updates.auto', String(next))}
        />

        <LauncherStatusPanel />

        <BackupsPanel />

        <ArtworkPanel
          autoFetch={settings.data?.settings['artwork.autoFetch'] !== 'false'}
          settingsLoading={settings.loading}
          vaultAvailable={vault.data?.available ?? false}
          onAutoFetch={(next) => void setSetting('artwork.autoFetch', String(next))}
        />

        <Collapsible title="Advanced" hint="Launch commands, logging, encryption, and diagnostics">
          <Panel title="Launch commands">
            <Row label="Epic launch link" hint="How Epic games are started. Change this only if launching stops working after an Epic update." align="center">
              <Dropdown
                label="Epic launch link"
                value={epicUri}
                disabled={settings.loading}
                onChange={(v) => void setSetting('epic.launchUri', v)}
                options={EPIC_LAUNCH_URI_FORMS.map((f) => ({ value: f, label: f === 'catalog' ? 'Catalog link (default)' : 'App name link' }))}
              />
            </Row>
            <Row
              label="Battle.net launch"
              hint="How Battle.net games are started. Change this only if launching stops working after a Battle.net update."
              align="center"
            >
              <Dropdown
                label="Battle.net launch"
                value={battlenetLaunch}
                disabled={settings.loading}
                onChange={(v) => void setSetting('battlenet.launch', v)}
                options={BATTLENET_LAUNCH_FORMS.map((f) => ({ value: f, label: f === 'exec' ? 'Launch command (default)' : 'battlenet:// link' }))}
              />
            </Row>
          </Panel>

          <Panel title="Logging">
            <Row label="Log level" hint="Logs stay on this PC. Passwords, tokens, emails, and account ids are removed before writing." align="center">
              <Dropdown
                label="Log level"
                value={logLevel}
                disabled={settings.loading}
                onChange={(v) => void setSetting('logLevel', v)}
                options={LOG_LEVELS.map((l) => ({ value: l, label: l[0]!.toUpperCase() + l.slice(1) }))}
              />
            </Row>
          </Panel>

          <Panel
            title="Encryption"
            description="Passwords and saved sign-ins are encrypted by Windows for your user account. Nothing is stored in plain text."
            actions={
              <Button onClick={() => void runSelfTest()} disabled={selfTest.state === 'running' || vault.data?.available === false}>
                {selfTest.state === 'running' ? 'Testing…' : 'Run test'}
              </Button>
            }
          >
            <Row label="Status">
              {vault.loading ? (
                'Checking…'
              ) : vault.data?.available ? (
                vault.data.readable === false ? (
                  <span className="inline-flex items-center gap-1.5 text-danger">
                    <ShieldOff className="size-4" /> Key lost
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-success">
                    <ShieldCheck className="size-4" /> Working
                  </span>
                )
              ) : (
                <span className="inline-flex items-center gap-1.5 text-danger">
                  <ShieldOff className="size-4" /> Unavailable · passwords and sign-ins cannot be stored
                </span>
              )}
            </Row>
            <Row label="Last test" hint="Stores a random value, reads it back, deletes it.">
              {selfTest.state === 'idle' && 'Not run'}
              {selfTest.state === 'running' && 'Running…'}
              {selfTest.state === 'ok' && <span className="text-success">Passed in {selfTest.ms} ms</span>}
              {selfTest.state === 'failed' && <span className="text-danger">Failed: {selfTest.message}</span>}
            </Row>
          </Panel>

          <Panel
            title="Diagnostics"
            actions={
              <>
                <Button icon={<FolderOpen />} onClick={() => void openPath('logs')}>
                  Logs
                </Button>
                <Button icon={<FolderOpen />} onClick={() => void openPath('data')}>
                  Data folder
                </Button>
              </>
            }
          >
            {pathError ? <p className="mb-3 text-xs text-danger">Could not open the folder: {pathError}</p> : null}
            <Row label="Version">{info.data ? `${info.data.version} · Electron ${info.data.electron} · Node ${info.data.node}` : '…'}</Row>
            <Row label="Startup" hint="From process start until the window appeared / the interface finished loading.">
              {info.data
                ? `${formatMs(info.data.startup.windowShownMs)} / ${formatMs(info.data.startup.didFinishLoadMs)}${
                    info.data.startup.processToNodeMs === null ? '' : ` (${info.data.startup.processToNodeMs} ms of that before app code ran)`
                  }`
                : '…'}
            </Row>
            <Row label="Data folder">
              <span className="font-mono text-xs select-text">{info.data?.dataDir ?? '…'}</span>
            </Row>
            <Row label="Build">{info.data ? (info.data.isPackaged ? 'Packaged' : 'Development') : '…'}</Row>
          </Panel>
        </Collapsible>
      </div>
    </Page>
  );
}
