// @vitest-environment jsdom
import './setup';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SessionPanel } from '../../src/renderer/src/components/SessionPanel';
import type { LauncherSessionState } from '../../src/shared/models';
import { account, installBridge, resetUi } from './harness';

resetUi();

const riot = account({ id: 'acct-riot', launcher: 'riot', login: 'riot_new' });

function state(over: Partial<LauncherSessionState> = {}): LauncherSessionState {
  return {
    launcher: 'riot',
    remembered: false,
    fingerprint: null,
    launcherUid: null,
    linkedAccountId: null,
    launcherRunning: false,
    lastSignIn: null,
    ...over,
  };
}

function open(s: LauncherSessionState) {
  installBridge({ 'sessions:get': () => ({ session: null, state: s, stateError: null }) });
  render(<SessionPanel account={riot} onAccountChanged={() => undefined} />);
}

describe('SessionPanel: a new account, before its first Play', () => {
  it('says the first Play saves the sign-in by itself, and why there is nothing to save yet', async () => {
    open(state());
    expect(await screen.findByText('Nobody')).toBeTruthy();
    expect(screen.getByText('Not saved yet')).toBeTruthy();
    expect(screen.getByText('Saved the first time you play on this account, and put back whenever you switch to it.')).toBeTruthy();
    const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Save sign-in' });
    expect(save.disabled).toBe(true);
    expect(save.title).toBe('Nothing to save: Riot Client holds no sign-in right now.');
    expect(screen.queryByText(/Stay signed in/)).toBeNull();
    expect(screen.queryByText('Last sign-in')).toBeNull();
  });

  it('names the unticked box when the client kept nothing from the last sign-in', async () => {
    open(
      state({
        lastSignIn: {
          ok: false,
          reason: 'the last sign-in was not kept because “Stay signed in” was not ticked. Sign in to the Riot Client again with it ticked.',
        },
      }),
    );
    expect(await screen.findByText('Last sign-in')).toBeTruthy();
    expect(
      screen.getByText('The last sign-in was not kept because “Stay signed in” was not ticked. Sign in to the Riot Client again with it ticked.'),
    ).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save sign-in' }).disabled).toBe(true);
  });

  it('offers Save when the client holds a sign-in nobody in One Launch owns yet', async () => {
    open(state({ remembered: true, fingerprint: 'f'.repeat(64), launcherUid: '44444444-4444-4444-8444-444444444444' }));
    expect(await screen.findByText('An account not yet linked in One Launch')).toBeTruthy();
    expect(screen.getByText('If that is this account, press Save sign-in.')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save sign-in' }).disabled).toBe(false);
  });

  it('warns when the sign-in the client holds belongs to another of the user’s accounts', async () => {
    open(
      state({
        remembered: true,
        fingerprint: 'f'.repeat(64),
        launcherUid: '11111111-1111-4111-8111-111111111111',
        linkedAccountId: 'acct-other',
        launcherRunning: true,
      }),
    );
    expect(await screen.findByText('Another of your accounts')).toBeTruthy();
    expect(screen.getByText('Riot Client is running.')).toBeTruthy();
  });
});
