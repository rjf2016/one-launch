import { FolderOpen, ShieldCheck, ShieldOff, Sparkles } from 'lucide-react';
import { lazy, Suspense, useRef, useState } from 'react';
import { BATTLENET_LAUNCH_FORMS, EPIC_LAUNCH_URI_FORMS, LOG_LEVELS, type BattlenetLaunchForm, type EpicLaunchUriForm, type LogLevel } from '@shared/models';
import { ArtworkPanel } from '../components/ArtworkPanel';
import { BackupsPanel } from '../components/BackupsPanel';
import { Button } from '../components/Button';
import { Dropdown } from '../components/Dropdown';
import { LauncherStatusPanel } from '../components/LauncherStatusPanel';
import { Page } from '../components/Page';
import { PageHeader } from '../components/PageHeader';
import { Panel, Row } from '../components/Panel';
import { TabList, TabPanel, type Tab } from '../components/Tabs';
import { Toggle } from '../components/Toggle';
import { UpdatesPanel } from '../components/UpdatesPanel';
import { ipc, useIpcQuery } from '../lib/ipc';
import { useUiStore, type SettingsTab } from '../store/ui';

type SelfTest = { state: 'idle' } | { state: 'running' } | { state: 'ok'; ms: number } | { state: 'failed'; message: string };

// A development build only; in a production build this is `null` and the panel's chunk is never emitted.
const WhatsNewDevPanel = import.meta.env.DEV ? lazy(() => import('../components/WhatsNewDevPanel')) : null;

const TABS: readonly Tab<SettingsTab>[] = [
  { id: 'general', label: 'General' },
  { id: 'launchers', label: 'Launchers' },
  { id: 'artwork', label: 'Artwork' },
  { id: 'backups', label: 'Backups' },
  { id: 'advanced', label: 'Advanced' },
];

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

interface SettingError {
  key: EditableSetting | 'autostart';
  message: string;
}

function formatMs(ms: number | null): string {
  return ms === null ? 'pending' : `${ms} ms`;
}

export function SettingsView() {
  const tab = useUiStore((s) => s.settingsTab);
  const setSettingsTab = useUiStore((s) => s.setSettingsTab);
  const settingsRevision = useUiStore((s) => s.settingsRevision);
  const settingsChanged = useUiStore((s) => s.settingsChanged);
  const openSetupGuide = useUiStore((s) => s.openSetupGuide);
  const info = useIpcQuery(() => ipc.invoke('app:info'));
  const vault = useIpcQuery(() => ipc.invoke('vault:status'));
  const autostart = useIpcQuery(() => ipc.invoke('autostart:status'));
  const settings = useIpcQuery(() => ipc.invoke('settings:getAll'), [settingsRevision]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [selfTest, setSelfTest] = useState<SelfTest>({ state: 'idle' });
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetNote, setResetNote] = useState<string | null>(null);
  const [settingError, setSettingError] = useState<SettingError | null>(null);
  const [pathError, setPathError] = useState<string | null>(null);

  function selectTab(next: SettingsTab): void {
    setSettingsTab(next);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }

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

  async function setSetting(key: EditableSetting, value: string): Promise<void> {
    setSettingError(null);
    try {
      await ipc.invoke('settings:set', { key, value });
      settingsChanged();
    } catch (err) {
      setSettingError({ key, message: err instanceof Error ? err.message : String(err) });
      settings.reload();
    }
  }

  async function setAutostart(next: boolean): Promise<void> {
    setSettingError(null);
    try {
      await ipc.invoke('autostart:set', { openAtLogin: next });
    } catch (err) {
      setSettingError({ key: 'autostart', message: err instanceof Error ? err.message : String(err) });
    }
    autostart.reload();
  }

  const errorFor = (key: SettingError['key']): string | null => (settingError?.key === key ? settingError.message : null);

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
    <Page narrow scrollRef={scrollRef}>
      <PageHeader title="Settings" toolbar={<TabList idBase="settings" label="Settings sections" tabs={TABS} value={tab} onChange={selectTab} />} />

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

        <TabPanel idBase="settings" id={tab}>
          <div className="flex flex-col gap-4">
            {tab === 'general' ? (
              <>
                <Panel title="General">
                  <Row
                    label="Start with Windows"
                    hint="Starts One Launch when you sign in to Windows, in the tray when it keeps running there."
                    error={errorFor('autostart')}
                  >
                    <Toggle
                      label="Start with Windows"
                      checked={autostart.data?.openAtLogin ?? false}
                      disabled={autostart.loading || autostart.data?.available !== true}
                      onChange={(next) => void setAutostart(next)}
                    />
                  </Row>
                  <Row
                    label="Keep running in the system tray"
                    hint="Closing the window keeps One Launch running in the tray, where you can reopen or quit it."
                    error={errorFor('window.closeToTray')}
                  >
                    <Toggle
                      label="Keep running in the system tray"
                      checked={closeToTray}
                      disabled={settings.loading}
                      onChange={(next) => void setSetting('window.closeToTray', String(next))}
                    />
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
                  whatsNewOn={whatsNewOn}
                  settingsLoading={settings.loading}
                  settingError={settingError}
                  onAuto={(next) => void setSetting('updates.auto', String(next))}
                  onWhatsNewOn={(next) => void setSetting('whatsNew.enabled', String(next))}
                />
              </>
            ) : null}

            {tab === 'launchers' ? (
              <>
                <LauncherStatusPanel />

                <Panel title="Play" description="What One Launch does for you when you press Play.">
                  <Row
                    label="Steam automatic sign-in"
                    hint="Passes a stored Steam password to Steam for you; other programs can see it while Steam runs."
                    error={errorFor('steam.autoLogin')}
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
                    hint="Presses Play in the Riot Client for you. Off, it opens the game's page and you press Play."
                    error={errorFor('riot.pressPlay')}
                  >
                    <Toggle
                      label="Start Riot games for you"
                      checked={riotPressPlay}
                      disabled={settings.loading}
                      onChange={(next) => void setSetting('riot.pressPlay', String(next))}
                    />
                  </Row>
                </Panel>
              </>
            ) : null}

            {tab === 'artwork' ? (
              <ArtworkPanel
                autoFetch={settings.data?.settings['artwork.autoFetch'] !== 'false'}
                settingsLoading={settings.loading}
                vaultAvailable={vault.data?.available ?? false}
                settingError={errorFor('artwork.autoFetch')}
                onAutoFetch={(next) => void setSetting('artwork.autoFetch', String(next))}
              />
            ) : null}

            {tab === 'backups' ? <BackupsPanel /> : null}

            {tab === 'advanced' ? (
              <>
                <Panel title="Launching" description="How Play switches and starts games.">
                  <Row label="Preview mode" hint="Play shows what a switch would do instead of doing it." error={errorFor('dryRun')}>
                    <Toggle label="Preview mode" checked={dryRun} disabled={settings.loading} onChange={(next) => void setSetting('dryRun', String(next))} />
                  </Row>
                  <Row label="Epic launch link" hint="Change only if Epic games stop launching after an Epic update." error={errorFor('epic.launchUri')}>
                    <Dropdown
                      label="Epic launch link"
                      value={epicUri}
                      disabled={settings.loading}
                      onChange={(v) => void setSetting('epic.launchUri', v)}
                      options={EPIC_LAUNCH_URI_FORMS.map((f) => ({ value: f, label: f === 'catalog' ? 'Catalog link (default)' : 'App name link' }))}
                    />
                  </Row>
                  <Row label="Battle.net launch" hint="Change only if games stop launching after a Battle.net update." error={errorFor('battlenet.launch')}>
                    <Dropdown
                      label="Battle.net launch"
                      value={battlenetLaunch}
                      disabled={settings.loading}
                      onChange={(v) => void setSetting('battlenet.launch', v)}
                      options={BATTLENET_LAUNCH_FORMS.map((f) => ({ value: f, label: f === 'exec' ? 'Launch command (default)' : 'battlenet:// link' }))}
                    />
                  </Row>
                </Panel>

                <Panel
                  title="Encryption"
                  description="Windows encrypts passwords and saved sign-ins for your account; nothing is in plain text."
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
                  <Row label="Log level" hint="Logs stay on this PC, with passwords, tokens, emails and account ids removed." error={errorFor('logLevel')}>
                    <Dropdown
                      label="Log level"
                      value={logLevel}
                      disabled={settings.loading}
                      onChange={(v) => void setSetting('logLevel', v)}
                      options={LOG_LEVELS.map((l) => ({ value: l, label: l[0]!.toUpperCase() + l.slice(1) }))}
                    />
                  </Row>
                  <Row label="Runtime">{info.data ? `Electron ${info.data.electron} · Node ${info.data.node}` : '…'}</Row>
                  <Row
                    label="Startup"
                    hint={`From process start to the window, then to the interface${
                      info.data?.startup.processToNodeMs == null ? '' : `; ${info.data.startup.processToNodeMs} ms before app code ran`
                    }.`}
                  >
                    {info.data ? `${formatMs(info.data.startup.windowShownMs)} / ${formatMs(info.data.startup.didFinishLoadMs)}` : '…'}
                  </Row>
                  <Row label="Data folder">
                    <span className="font-mono text-xs select-text">{info.data?.dataDir ?? '…'}</span>
                  </Row>
                  <Row label="Build">{info.data ? (info.data.isPackaged ? 'Packaged' : 'Development') : '…'}</Row>
                </Panel>

                {WhatsNewDevPanel ? (
                  <Suspense fallback={null}>
                    <WhatsNewDevPanel />
                  </Suspense>
                ) : null}
              </>
            ) : null}
          </div>
        </TabPanel>
      </div>
    </Page>
  );
}
