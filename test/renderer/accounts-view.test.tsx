// @vitest-environment jsdom
import './setup';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { useUiStore } from '../../src/renderer/src/store/ui';
import { AccountsView } from '../../src/renderer/src/views/AccountsView';
import type { RememberedAccount } from '../../src/shared/models';
import { account, game, installBridge, resetUi } from './harness';

resetUi();

const REMEMBERED: RememberedAccount = {
  launcher: 'steam',
  launcherUid: '76561190000000002',
  login: 'user_2',
  personaName: 'Persona Two',
  rememberPassword: true,
  mostRecent: true,
  lastLoginAt: null,
  sessionMayBeExpired: false,
  linkedAccountId: null,
};

describe('AccountsView: sent here by a game’s Play', () => {
  it('opens the import dialog it was asked for, and an import goes straight back to the game with the account picked', async () => {
    const dota = game();
    const imported = account({ id: 'acct-two', login: 'user_2', launcherUid: REMEMBERED.launcherUid });
    const bridge = installBridge({
      'accounts:list': () => ({ accounts: [] }),
      'launchers:rememberedAccounts': () => ({ accounts: [REMEMBERED] }),
      'launchers:importAccounts': () => ({ accounts: [imported], skipped: [] }),
    });
    useUiStore.setState({ view: 'accounts', importIntent: 'steam', returnTo: dota });
    const user = userEvent.setup();
    render(<AccountsView />);
    expect(await screen.findByRole('heading', { name: 'Import Steam accounts' })).toBeTruthy();
    await waitFor(() => expect(useUiStore.getState().importIntent).toBeNull());
    await user.click(await screen.findByRole('button', { name: 'Import 1' }));
    await waitFor(() => expect(bridge.sent('launchers:importAccounts')).toEqual([{ launcher: 'steam', launcherUids: [REMEMBERED.launcherUid] }]));
    await waitFor(() => expect(useUiStore.getState().launchRequest).toMatchObject({ game: dota, initialAccountId: 'acct-two' }));
    await waitFor(() => expect(useUiStore.getState().view).toBe('library'));
  });

  it('stays on the page, as usual, when no game sent the user here', async () => {
    const bridge = installBridge({
      'accounts:list': () => ({ accounts: [] }),
      'launchers:rememberedAccounts': () => ({ accounts: [REMEMBERED] }),
      'launchers:importAccounts': () => ({ accounts: [account({ id: 'acct-two', login: 'user_2' })], skipped: [] }),
    });
    useUiStore.setState({ view: 'accounts', importIntent: 'steam' });
    const user = userEvent.setup();
    render(<AccountsView />);
    await user.click(await screen.findByRole('button', { name: 'Import 1' }));
    expect(await screen.findByText('Imported 1 account from Steam')).toBeTruthy();
    expect(useUiStore.getState().launchRequest).toBeNull();
    expect(bridge.sent('accounts:list').length).toBeGreaterThan(1);
  });
});

function open() {
  installBridge({ 'accounts:list': () => ({ accounts: [account()] }) });
  render(<AccountsView />);
}

describe('AccountsView: Import menu', () => {
  it('names every launcher, and the two that keep no list open their account form', async () => {
    open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Import' }));
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual([
      'From SteamLogins Steam has saved',
      'From Battle.netLogins Battle.net has saved',
      'Epic Games: add by handEpic keeps no account list',
      'Riot Games: add by handThe Riot Client keeps no account list',
    ]);
    await user.click(screen.getByRole('menuitem', { name: /^Riot Games: add by hand/ }));
    await waitFor(() => expect(useUiStore.getState().accountRoute).toEqual({ kind: 'new', launcher: 'riot' }));
  });
});
