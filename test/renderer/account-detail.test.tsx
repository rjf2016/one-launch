// @vitest-environment jsdom
import './setup';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { useUiStore } from '../../src/renderer/src/store/ui';
import { AccountDetailView } from '../../src/renderer/src/views/AccountDetailView';
import type { Account, LauncherSessionState } from '../../src/shared/models';
import { account, game, installBridge, resetUi, type Handlers } from './harness';

resetUi();

const NOBODY: LauncherSessionState = {
  launcher: 'riot',
  remembered: false,
  fingerprint: null,
  launcherUid: null,
  linkedAccountId: null,
  launcherRunning: false,
  lastSignIn: null,
};

/** A main process that creates the account it is asked for and serves it back afterwards. */
function main(over: Handlers = {}) {
  const created: Account[] = [];
  return installBridge({
    'accounts:create': (req) => {
      const a = account({ id: 'acct-created', launcher: req.launcher, displayName: req.displayName, login: req.login });
      created.push(a);
      return { account: a };
    },
    'accounts:get': (req) => ({ account: created.find((a) => a.id === req.id) ?? account({ id: req.id, launcher: 'riot', login: 'riot_main' }) }),
    'sessions:get': () => ({ session: null, state: NOBODY, stateError: null }),
    ...over,
  });
}

async function fillAndCreate(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByPlaceholderText('VALORANT alt'), 'Smurf');
  await user.type(screen.getByPlaceholderText('username'), 'riot_smurf');
  await user.click(screen.getByRole('button', { name: 'Create account' }));
}

describe('AccountDetailView: creating an account', () => {
  it('opens the new account’s page and says what to do next', async () => {
    const bridge = main();
    const user = userEvent.setup();
    useUiStore.setState({ view: 'accounts', accountRoute: { kind: 'new', launcher: 'riot' } });
    render(<AccountDetailView />);
    expect(await screen.findByRole('heading', { name: 'New Riot Games account' })).toBeTruthy();
    expect(screen.getByText('First Play: the Riot Client asks you to sign in once; tick “Stay signed in”.')).toBeTruthy();
    await fillAndCreate(user);
    await waitFor(() => expect(bridge.sent('accounts:create')).toHaveLength(1));
    expect(bridge.sent('accounts:create')[0]).toMatchObject({ launcher: 'riot', displayName: 'Smurf', login: 'riot_smurf', password: null });
    await waitFor(() => expect(useUiStore.getState().accountRoute).toEqual({ kind: 'detail', id: 'acct-created', created: true }));
    expect(await screen.findByText('Account created. Pick a game in the Library and press Play.')).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Smurf' })).toBeTruthy();
    const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Save changes' });
    expect(save.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Saved' })).toBeNull();
    expect(screen.getByText('Not saved yet')).toBeTruthy();
  });

  it('goes straight back to the game whose Play sent the user here, with the new account picked', async () => {
    main();
    const user = userEvent.setup();
    const valorant = game({ id: 'game-val', launcher: 'riot', name: 'VALORANT', launcherGameId: 'valorant.live' });
    useUiStore.setState({ view: 'accounts', accountRoute: { kind: 'new', launcher: 'riot' }, returnTo: valorant });
    render(<AccountDetailView />);
    await screen.findByRole('heading', { name: 'New Riot Games account' });
    await fillAndCreate(user);
    await waitFor(() => expect(useUiStore.getState().launchRequest).toMatchObject({ game: valorant, initialAccountId: 'acct-created' }));
    await waitFor(() => expect(useUiStore.getState().view).toBe('library'));
    expect(useUiStore.getState().returnTo).toBeNull();
  });

  it('ignores a remembered game from another launcher', async () => {
    main();
    const user = userEvent.setup();
    useUiStore.setState({ view: 'accounts', accountRoute: { kind: 'new', launcher: 'riot' }, returnTo: game({ launcher: 'steam' }) });
    render(<AccountDetailView />);
    await screen.findByRole('heading', { name: 'New Riot Games account' });
    await fillAndCreate(user);
    await waitFor(() => expect(useUiStore.getState().accountRoute).toEqual({ kind: 'detail', id: 'acct-created', created: true }));
    expect(useUiStore.getState().launchRequest).toBeNull();
  });
});

describe('AccountDetailView: the password panel', () => {
  it('asks before leaving with a typed password that was never stored', async () => {
    main();
    const user = userEvent.setup();
    useUiStore.setState({ view: 'accounts', accountRoute: { kind: 'detail', id: 'acct-riot' } });
    render(<AccountDetailView />);
    await user.click(await screen.findByRole('button', { name: 'Store password' }));
    await user.type(screen.getByLabelText('Password'), 'hunter2');
    useUiStore.getState().setView('library');
    await waitFor(() => expect(useUiStore.getState().confirm?.title).toBe('Leave without storing the password?'));
    useUiStore.getState().answerConfirm(false);
    expect(useUiStore.getState().view).toBe('accounts');
  });
});
