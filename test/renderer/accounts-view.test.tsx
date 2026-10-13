// @vitest-environment jsdom
import './setup';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { useUiStore } from '../../src/renderer/src/store/ui';
import { AccountsView } from '../../src/renderer/src/views/AccountsView';
import { account, installBridge, resetUi } from './harness';

resetUi();

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
