// @vitest-environment jsdom
import './setup';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { SetupGuideHost } from '../../src/renderer/src/components/SetupGuide';
import { useUiStore, type SetupGuideSource } from '../../src/renderer/src/store/ui';
import { SettingsView } from '../../src/renderer/src/views/SettingsView';
import type { Account, AppInfo, LauncherId, LauncherStatus, RememberedAccount, SettingKey } from '../../src/shared/models';
import { account, BridgeError, game, installBridge, resetUi, type Handlers } from './harness';

resetUi();

function launcher(id: LauncherId, displayName: string, installed: boolean): LauncherStatus {
  return {
    launcher: id,
    displayName,
    implemented: true,
    install: installed ? { launcher: id, installDir: `C:\\Launchers\\${id}`, exePath: `C:\\Launchers\\${id}\\x.exe`, source: 'registry-hklm' } : null,
    chosenPath: null,
    running: false,
    health: null,
    attention: null,
  };
}

const TWO_FOUND = [
  launcher('steam', 'Steam', true),
  launcher('epic', 'Epic Games', false),
  launcher('battlenet', 'Battle.net', true),
  launcher('riot', 'Riot Games', false),
];
const NONE_FOUND = TWO_FOUND.map((l) => ({ ...l, install: null }));
const EPIC_AND_RIOT = TWO_FOUND.map((l) =>
  l.launcher === 'epic' || l.launcher === 'riot' ? launcher(l.launcher, l.displayName, true) : { ...l, install: null },
);
const STEAM_AND_RIOT = TWO_FOUND.map((l) =>
  l.launcher === 'steam' || l.launcher === 'riot' ? launcher(l.launcher, l.displayName, true) : { ...l, install: null },
);

function remembered(over: Partial<RememberedAccount> = {}): RememberedAccount {
  return {
    launcher: 'steam',
    launcherUid: '76561190000000001',
    login: 'user_1',
    personaName: 'Persona One',
    rememberPassword: true,
    mostRecent: false,
    lastLoginAt: null,
    sessionMayBeExpired: false,
    linkedAccountId: null,
    ...over,
  };
}

const STEAM_REMEMBERS = [
  remembered({ linkedAccountId: 'acct-main' }),
  remembered({ launcherUid: '76561190000000002', login: 'user_2', personaName: 'Persona Two', mostRecent: true }),
  remembered({ launcherUid: '76561190000000003', login: 'user_3', personaName: 'Persona Three' }),
];
const BATTLENET_REMEMBERS = [remembered({ launcher: 'battlenet', launcherUid: '', login: 'saved1@example.com', personaName: '' })];

interface GuideOptions {
  settings?: Partial<Record<SettingKey, string>>;
  accounts?: Account[];
  games?: ReturnType<typeof game>[];
  launchers?: LauncherStatus[];
  remembered?: Partial<Record<'steam' | 'battlenet', RememberedAccount[]>>;
  over?: Handlers;
}

/** A main process with a settings table and an accounts table that the import fills, like the real one. */
function guide(opts: GuideOptions = {}) {
  const stored: Partial<Record<SettingKey, string>> = { ...opts.settings };
  const accounts: Account[] = [...(opts.accounts ?? [])];
  return installBridge({
    'settings:getAll': () => ({ settings: { ...stored } }),
    'settings:set': (req) => {
      stored[req.key] = req.value;
      return { ok: true };
    },
    'accounts:list': () => ({ accounts: [...accounts] }),
    'launchers:status': () => ({ launchers: opts.launchers ?? TWO_FOUND }),
    'artwork:status': () => ({ status: { queued: 0, running: 0, completed: 0, failed: 0, hasApiKey: false, revision: 1, scanned: true } }),
    'library:list': () => ({ games: opts.games ?? [game()] }),
    'launchers:rememberedAccounts': (req) => ({ accounts: opts.remembered?.[req.launcher as 'steam' | 'battlenet'] ?? [] }),
    'launchers:importAccounts': (req) => {
      const created = req.launcherUids.map((uid) => account({ id: `acct-${uid}`, launcher: req.launcher, login: uid, launcherUid: uid || null }));
      accounts.push(...created);
      return { accounts: created, skipped: [] };
    },
    ...opts.over,
  });
}

/** Mounts the host with the guide already open, the way a new install or Settings leaves it. */
function open(source: SetupGuideSource = 'first-run') {
  useUiStore.setState({ setupGuide: source, view: source === 'settings' ? 'settings' : 'library' });
  return render(<SetupGuideHost />);
}

const dialog = () => screen.queryByRole('dialog', { name: /Welcome to One Launch|Your launchers|Play switches|Add your accounts|You're all set|Almost there/ });
const heading = (name: string | RegExp) => screen.findByRole('heading', { name });
const button = (name: string | RegExp) => screen.getByRole('button', { name });
const statusText = (text: string | RegExp) =>
  waitFor(
    () => expect(screen.getAllByRole('status').some((el) => (typeof text === 'string' ? el.textContent === text : text.test(el.textContent ?? '')))).toBe(true),
    {
      timeout: 2500,
    },
  );

async function forwardTo(user: ReturnType<typeof userEvent.setup>, step: 'launchers' | 'play' | 'accounts' | 'ready'): Promise<void> {
  await heading('Welcome to One Launch');
  await user.click(button('Get started'));
  await heading('Your launchers');
  if (step === 'launchers') return;
  await user.click(button('Continue'));
  await heading('Play switches accounts for you');
  if (step === 'play') return;
  await user.click(button('Continue'));
  await heading('Add your accounts');
  if (step === 'accounts') return;
  await user.click(button('Continue'));
  await heading(/You're all set|Almost there/);
}

describe('SetupGuideHost', () => {
  it('opens the guide for a data folder nobody has set up: no dismissal and no account', async () => {
    guide();
    render(<SetupGuideHost />);
    expect(await heading('Welcome to One Launch')).toBeTruthy();
    expect(useUiStore.getState().setupGuide).toBe('first-run');
  });

  it('stays closed once the guide was dismissed', async () => {
    const bridge = guide({ settings: { 'firstRun.dismissed': 'true' } });
    render(<SetupGuideHost />);
    await waitFor(() => expect(bridge.calls.filter((c) => c.channel === 'accounts:list').length).toBe(1));
    await waitFor(() => expect(bridge.calls.filter((c) => c.channel === 'settings:getAll').length).toBe(1));
    expect(dialog()).toBeNull();
  });

  it('stays closed for an install that already has an account, dismissed or not', async () => {
    const bridge = guide({ accounts: [account()] });
    render(<SetupGuideHost />);
    await waitFor(() => expect(bridge.calls.filter((c) => c.channel === 'accounts:list').length).toBe(1));
    expect(dialog()).toBeNull();
  });
});

describe('SetupGuide: the steps', () => {
  it('walks forward and back through five steps, announcing each and keeping the focus on the way forward', async () => {
    guide();
    const user = userEvent.setup();
    open();
    expect(await heading('Welcome to One Launch')).toBeTruthy();
    await statusText('Step 1 of 5: Welcome');
    await waitFor(() => expect(document.activeElement).toBe(button('Get started')));
    expect(screen.getByRole('list', { name: 'Setup steps' }).querySelectorAll('li').length).toBe(5);

    await user.click(button('Get started'));
    expect(await heading('Your launchers')).toBeTruthy();
    await statusText('Step 2 of 5: Your launchers');
    await waitFor(() => expect(document.activeElement).toBe(button('Continue')));

    await user.click(button('Continue'));
    expect(await heading('Play switches accounts for you')).toBeTruthy();
    await user.click(button('Continue'));
    expect(await heading('Add your accounts')).toBeTruthy();
    await user.click(button('Continue'));
    expect(await heading('Almost there')).toBeTruthy();
    await statusText('Step 5 of 5: Ready');

    await user.click(button('Back'));
    expect(await heading('Add your accounts')).toBeTruthy();
    await user.click(button('Back'));
    expect(await heading('Play switches accounts for you')).toBeTruthy();
  });

  it('is a modal dialog named after the current step', async () => {
    guide();
    open();
    const el = await screen.findByRole('dialog', { name: 'Welcome to One Launch' });
    expect(el.getAttribute('aria-modal')).toBe('true');
  });

  it('lists the launchers it found, offers Locate for the rest, and counts the installed games', async () => {
    const bridge = guide({ over: { 'launchers:locate': () => ({ install: null }) } });
    const user = userEvent.setup();
    open();
    await forwardTo(user, 'launchers');
    expect(await screen.findAllByText('Found')).toHaveLength(2);
    expect(screen.getByText('C:\\Launchers\\steam')).toBeTruthy();
    const locates = screen.getAllByRole('button', { name: 'Locate…' });
    expect(locates).toHaveLength(2);
    expect(screen.getByText(/point One Launch at EpicGamesLauncher\.exe/)).toBeTruthy();
    await statusText('1 installed game found');
    expect(screen.getByText(/Only game names and store ids are sent/)).toBeTruthy();

    await user.click(locates[0]!);
    await waitFor(() => expect(bridge.sent('launchers:locate')).toEqual([{ launcher: 'epic' }]));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says why a chosen file was refused, next to that launcher', async () => {
    guide({
      over: {
        'launchers:locate': () => {
          throw new BridgeError('NOT_A_LAUNCHER', 'That file is not EpicGamesLauncher.exe.');
        },
      },
    });
    const user = userEvent.setup();
    open();
    await forwardTo(user, 'launchers');
    await user.click((await screen.findAllByRole('button', { name: 'Locate…' }))[0]!);
    expect((await screen.findByRole('alert')).textContent).toBe('That file is not EpicGamesLauncher.exe.');
  });

  it('says that no launcher was found, and still lets the user go on', async () => {
    guide({ launchers: NONE_FOUND, games: [] });
    const user = userEvent.setup();
    open();
    await forwardTo(user, 'launchers');
    expect(await screen.findByText(/^No launcher was found on this PC\./)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Locate…' })).toHaveLength(4);
    await user.click(button('Continue'));
    expect(await heading('Play switches accounts for you')).toBeTruthy();
  });

  it('mentions preview mode only on a data folder that turned it on', async () => {
    guide({ settings: { dryRun: 'true' } });
    const user = userEvent.setup();
    open();
    await forwardTo(user, 'play');
    expect(await screen.findByText(/^Preview mode is on, so Play only shows what a switch would do/)).toBeTruthy();
  });

  it('does not mention preview mode by default, and says the lookup is off when artwork is off', async () => {
    guide({ settings: { 'artwork.autoFetch': 'false' } });
    const user = userEvent.setup();
    open();
    await forwardTo(user, 'launchers');
    expect(await screen.findByText(/^Cover art downloads are off\./)).toBeTruthy();
    await user.click(button('Continue'));
    await heading('Play switches accounts for you');
    expect(screen.queryByText(/Preview mode is on/)).toBeNull();
  });
});

describe('SetupGuide: accounts', () => {
  it('preselects what Steam and Battle.net remember, imports it in one go, and ends all set', async () => {
    const bridge = guide({ remembered: { steam: STEAM_REMEMBERS, battlenet: BATTLENET_REMEMBERS } });
    const user = userEvent.setup();
    open();
    await forwardTo(user, 'accounts');
    const two = (await screen.findByRole('checkbox', { name: /Persona Two/ })) as HTMLInputElement;
    expect(two.checked).toBe(true);
    const one = screen.getByRole('checkbox', { name: /Persona One/ }) as HTMLInputElement;
    expect(one.checked).toBe(false);
    expect(one.disabled).toBe(true);
    expect(screen.getByText('Already in One Launch')).toBeTruthy();
    expect(screen.getByText('Signed in')).toBeTruthy();
    await statusText('3 of 3 selected');

    await user.click(button('Import 3 accounts'));
    await waitFor(() =>
      expect(bridge.sent('launchers:importAccounts')).toEqual([
        { launcher: 'steam', launcherUids: ['76561190000000002', '76561190000000003'] },
        { launcher: 'battlenet', launcherUids: ['saved1@example.com'] },
      ]),
    );
    await statusText('Imported 3 accounts');
    expect(screen.getAllByText('Imported')).toHaveLength(3);
    expect((screen.getByRole('checkbox', { name: /Persona Two/ }) as HTMLInputElement).disabled).toBe(true);
    expect((button('Import') as HTMLButtonElement).disabled).toBe(true);

    await user.click(button('Continue'));
    expect(await heading("You're all set")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Go to Accounts' })).toBeNull();
    await user.click(button('Open Library'));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(bridge.sent('settings:set')).toEqual([{ key: 'firstRun.dismissed', value: 'true' }]);
    expect(useUiStore.getState().view).toBe('library');
  });

  it('leaves out an entry the user unticks', async () => {
    const bridge = guide({ remembered: { steam: STEAM_REMEMBERS } });
    const user = userEvent.setup();
    open();
    await forwardTo(user, 'accounts');
    await user.click(await screen.findByRole('checkbox', { name: /Persona Two/ }));
    await user.click(button('Import 1 account'));
    await waitFor(() => expect(bridge.sent('launchers:importAccounts')).toEqual([{ launcher: 'steam', launcherUids: ['76561190000000003'] }]));
  });

  it('keeps the rest selected and says what went wrong when an import fails', async () => {
    guide({
      remembered: { steam: STEAM_REMEMBERS },
      over: {
        'launchers:importAccounts': () => {
          throw new BridgeError('ADAPTER_FAILED', 'loginusers.vdf could not be read');
        },
      },
    });
    const user = userEvent.setup();
    open();
    await forwardTo(user, 'accounts');
    await screen.findByRole('checkbox', { name: /Persona Two/ });
    await user.click(button('Import 2 accounts'));
    await statusText('Could not import: loginusers.vdf could not be read');
    expect((button('Import 2 accounts') as HTMLButtonElement).disabled).toBe(false);
  });

  it('says there is nothing to import on a PC without launchers, and why for Epic and Riot', async () => {
    guide({ launchers: NONE_FOUND, games: [] });
    const user = userEvent.setup();
    open();
    await forwardTo(user, 'accounts');
    expect(await screen.findByText(/^No launcher was found on this PC, so there is nothing to import yet\./)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Import/ })).toBeNull();
  });

  it('explains that Epic Games and Riot Games keep no list', async () => {
    const bridge = guide({ launchers: EPIC_AND_RIOT });
    const user = userEvent.setup();
    open();
    await forwardTo(user, 'accounts');
    expect(await screen.findByText('Epic Games and Riot Games keep no account list. Add those under Add by hand.')).toBeTruthy();
    expect(bridge.sent('launchers:rememberedAccounts')).toEqual([]);
  });

  it('names an installed launcher that keeps no list under the ones that do', async () => {
    guide({ launchers: STEAM_AND_RIOT, remembered: { steam: STEAM_REMEMBERS } });
    const user = userEvent.setup();
    open();
    await forwardTo(user, 'accounts');
    expect(await screen.findByRole('checkbox', { name: /Persona Two/ })).toBeTruthy();
    expect(screen.getByText('Riot Games keeps no account list. Add it under Add by hand.')).toBeTruthy();
  });

  it('says nothing about launchers that are not installed', async () => {
    guide({ remembered: { steam: STEAM_REMEMBERS } });
    const user = userEvent.setup();
    open();
    await forwardTo(user, 'accounts');
    expect(await screen.findByRole('checkbox', { name: /Persona Two/ })).toBeTruthy();
    expect(screen.queryByText(/keeps? no account list/)).toBeNull();
  });

  it('says when a launcher remembers nothing', async () => {
    guide({ remembered: { steam: STEAM_REMEMBERS } });
    const user = userEvent.setup();
    open();
    await forwardTo(user, 'accounts');
    expect(await screen.findByText('Battle.net has not remembered any account on this PC yet.')).toBeTruthy();
  });

  it('ends in the account form of a launcher picked under Add by hand', async () => {
    const bridge = guide({ launchers: EPIC_AND_RIOT });
    const user = userEvent.setup();
    open();
    await forwardTo(user, 'accounts');
    const riot = await screen.findByRole('button', { name: 'Riot Games' });
    await user.click(riot);
    expect(riot.getAttribute('aria-pressed')).toBe('true');
    await user.click(button('Continue'));
    expect(await heading('Almost there')).toBeTruthy();
    expect(screen.getByText(/^Add your Riot Games account next\./)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open Library' })).toBeTruthy();
    await user.click(button('Add a Riot Games account'));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(bridge.sent('settings:set')).toEqual([{ key: 'firstRun.dismissed', value: 'true' }]);
    expect(useUiStore.getState().view).toBe('accounts');
    expect(useUiStore.getState().accountRoute).toEqual({ kind: 'new', launcher: 'riot' });
  });

  it('offers the Accounts page when the guide ends with no account', async () => {
    guide();
    const user = userEvent.setup();
    open();
    await forwardTo(user, 'ready');
    expect(await heading('Almost there')).toBeTruthy();
    await user.click(await screen.findByRole('button', { name: 'Go to Accounts' }));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(useUiStore.getState().view).toBe('accounts');
  });

  it('sums up what it found', async () => {
    guide({ accounts: [account()] });
    const user = userEvent.setup();
    open('settings');
    await forwardTo(user, 'ready');
    expect(await heading("You're all set")).toBeTruthy();
    const valueOf = (label: string): string | null => screen.getByText(label).nextElementSibling?.textContent ?? null;
    await waitFor(() => expect(valueOf('Launchers found')).toBe('2'), { timeout: 5000 });
    await waitFor(() => expect(valueOf('Games found')).toBe('1'), { timeout: 5000 });
    await waitFor(() => expect(valueOf('Accounts')).toBe('1'), { timeout: 5000 });
  });
});

describe('SetupGuide: leaving', () => {
  it('Skip writes the dismissal and closes, from any step', async () => {
    const bridge = guide();
    const user = userEvent.setup();
    open();
    await forwardTo(user, 'play');
    await user.click(button('Skip'));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(bridge.sent('settings:set')).toEqual([{ key: 'firstRun.dismissed', value: 'true' }]);
    expect(useUiStore.getState().setupGuide).toBeNull();
  });

  it('Escape and the close button do the same', async () => {
    const bridge = guide();
    const first = open();
    await heading('Welcome to One Launch');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(dialog()).toBeNull());
    expect(bridge.sent('settings:set')).toEqual([{ key: 'firstRun.dismissed', value: 'true' }]);
    first.unmount();

    open();
    await heading('Welcome to One Launch');
    const user = userEvent.setup();
    await user.click(button('Skip setup'));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(bridge.sent('settings:set')).toHaveLength(2);
  });

  it('closes even when the dismissal cannot be saved, so a broken database never traps the user behind it', async () => {
    guide({
      over: {
        'settings:set': () => {
          throw new BridgeError('INTERNAL', 'database is locked');
        },
      },
    });
    const user = userEvent.setup();
    open();
    await heading('Welcome to One Launch');
    await user.click(button('Skip'));
    await waitFor(() => expect(dialog()).toBeNull());
  });

  it('shows the Library when it is finished from Settings', async () => {
    guide({ accounts: [account()] });
    const user = userEvent.setup();
    open('settings');
    await forwardTo(user, 'ready');
    await user.click(button('Open Library'));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(useUiStore.getState().view).toBe('library');
  });
});

const info: AppInfo = {
  version: '1.0.0-test',
  electron: '44.0.0',
  node: '24.0.0',
  chrome: '140.0.0.0',
  isPackaged: false,
  dataDir: 'C:\\scratch\\data',
  logDir: 'C:\\scratch\\data\\logs',
  dbPath: 'C:\\scratch\\data\\onelaunch.db',
  startup: { processToNodeMs: 100, windowShownMs: 400, readyToShowMs: 500, didFinishLoadMs: 600 },
  platformSource: 'fake',
};

describe('Settings › General › Setup guide', () => {
  it('opens the guide again for an install that has long been set up', async () => {
    guide({
      settings: { 'firstRun.dismissed': 'true' },
      accounts: [account()],
      over: {
        'app:info': () => info,
        'vault:status': () => ({ available: true, backend: 'dpapi', readable: true }),
        'backups:list': () => ({ snapshots: [] }),
      },
    });
    const user = userEvent.setup();
    useUiStore.setState({ view: 'settings' });
    render(
      <>
        <SetupGuideHost />
        <SettingsView />
      </>,
    );
    expect(dialog()).toBeNull();
    await user.click(await screen.findByRole('button', { name: 'Show again' }));
    expect(await heading('Welcome to One Launch')).toBeTruthy();
    expect(useUiStore.getState().setupGuide).toBe('settings');
  });
});
