// @vitest-environment jsdom
import './setup';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { LauncherBadge, launcherDot } from '../../src/renderer/src/components/LauncherBadge';
import { LauncherStatusPanel } from '../../src/renderer/src/components/LauncherStatusPanel';
import { hasSessionPanel, SessionPanel } from '../../src/renderer/src/components/SessionPanel';
import { LibraryView } from '../../src/renderer/src/views/LibraryView';
import { LAUNCHER_IDS, type ArtworkStatus, type LauncherSessionState, type LauncherStatus } from '../../src/shared/models';
import { account, BridgeError, installBridge, resetUi } from './harness';

resetUi();

function missing(launcher: LauncherStatus['launcher'], displayName: string): LauncherStatus {
  return {
    launcher,
    displayName,
    implemented: true,
    install: null,
    chosenPath: null,
    running: null,
    health: { launcher, status: 'absent', checks: [{ id: 'install', label: 'Installation', status: 'absent', detail: 'not installed' }], checkedAt: 'x' },
    attention: null,
  };
}

const NONE = [missing('steam', 'Steam'), missing('epic', 'Epic Games'), missing('battlenet', 'Battle.net'), missing('riot', 'Riot Games')];

describe('Riot Games in the renderer', () => {
  it('has a dot colour of its own and a badge', () => {
    expect(launcherDot.riot).toBe('bg-riot');
    expect(Object.keys(launcherDot).sort()).toEqual([...LAUNCHER_IDS].sort());
    const { container } = render(<LauncherBadge launcher="riot" />);
    expect(screen.getByText('Riot Games')).toBeTruthy();
    expect(container.querySelector('.bg-riot')).toBeTruthy();
  });

  it('gets its own row in Settings › Launchers, with Locate when it is not installed', async () => {
    installBridge({ 'launchers:status': () => ({ launchers: NONE }) });
    render(<LauncherStatusPanel />);
    const label = await screen.findByText('Riot Games');
    const row = label.closest('div.py-2\\.5') as HTMLElement;
    expect(within(row).getAllByText('Not installed').length).toBeGreaterThan(0);
    expect(within(row).getByRole('button', { name: 'Locate…' })).toBeTruthy();
    for (const name of ['Steam', 'Epic Games', 'Battle.net', 'Riot Games']) expect(screen.getByText(name)).toBeTruthy();
  });

  it('names the Riot Client among the launchers the empty library looks for', async () => {
    const idle: ArtworkStatus = { queued: 0, running: 0, completed: 0, failed: 0, hasApiKey: false, revision: 1, scanned: true };
    installBridge({
      'launchers:status': () => ({ launchers: NONE }),
      'library:list': () => ({ games: [] }),
      'accounts:list': () => ({ accounts: [] }),
      'settings:getAll': () => ({ settings: { 'firstRun.dismissed': 'true' } }),
      'artwork:status': () => ({ status: idle }),
      'launch:recent': () => ({ recent: [] }),
    });
    render(<LibraryView />);
    expect(await screen.findByText(/looks for Steam, Epic Games Launcher, Battle\.net, and the Riot Client/)).toBeTruthy();
  });

  it('gets the saved sign-in panel on its account page, with the Stay signed in instructions', async () => {
    expect(hasSessionPanel('riot')).toBe(true);
    expect(hasSessionPanel('steam')).toBe(false);
    const riot = account({ id: 'acct-riot', launcher: 'riot', login: 'riot_main', launcherUid: '11111111-1111-4111-8111-111111111111' });
    const state: LauncherSessionState = {
      launcher: 'riot',
      remembered: true,
      fingerprint: 'f'.repeat(64),
      launcherUid: riot.launcherUid,
      linkedAccountId: riot.id,
      launcherRunning: true,
      lastSignIn: null,
    };
    const bridge = installBridge({
      'sessions:get': () => ({ session: null, state, stateError: null }),
      'sessions:capture': () => {
        throw new BridgeError('SWITCH_BLOCKED', 'Riot Games: The Riot Client is running. Right-click its tray icon, choose Exit, then save again.');
      },
    });
    render(<SessionPanel account={riot} onAccountChanged={() => undefined} />);
    expect(await screen.findByText('This account (newer than the saved sign-in; press Save again)')).toBeTruthy();
    expect(screen.getByText(/sign in to the Riot Client as this account with “Stay signed in” ticked, exit the client from its tray icon/)).toBeTruthy();
    expect(screen.getByText('Riot Client is signed in as')).toBeTruthy();
    expect(screen.getByText('Riot Client is running.')).toBeTruthy();
    expect(screen.getByText('Linked to …1111')).toBeTruthy();
    expect(screen.getByText('Not saved yet')).toBeTruthy();

    const save = screen.getByRole('button', { name: 'Save sign-in' });
    expect((save as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(save);
    await waitFor(() => expect(screen.getByText(/Right-click its tray icon, choose Exit, then save again/)).toBeTruthy());
    expect(bridge.sent('sessions:capture')).toEqual([{ accountId: 'acct-riot' }]);
  });
});
