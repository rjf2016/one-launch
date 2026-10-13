// @vitest-environment jsdom
import './setup';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ImportAccountsDialog } from '../../src/renderer/src/components/ImportAccountsDialog';
import type { RememberedAccount } from '../../src/shared/models';
import { installBridge, resetUi } from './harness';

resetUi();

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

function open(accounts: RememberedAccount[]) {
  const bridge = installBridge({ 'launchers:rememberedAccounts': () => ({ accounts }) });
  const onClose = vi.fn();
  render(<ImportAccountsDialog launcher="steam" onClose={onClose} onImported={() => undefined} />);
  return { bridge, onClose };
}

describe('ImportAccountsDialog: focus', () => {
  it('puts the focus on Import once the remembered accounts are in, so Enter imports instead of closing', async () => {
    open([remembered(), remembered({ launcherUid: '76561190000000002', login: 'user_2', personaName: 'Persona Two' })]);
    const button = await waitFor(() => {
      const found = screen.getByRole<HTMLButtonElement>('button', { name: 'Import 2' });
      expect(found.disabled).toBe(false);
      return found;
    });
    await waitFor(() => expect(document.activeElement).toBe(button));
  });

  it('puts the focus on Cancel when there is nothing to import', async () => {
    open([remembered({ linkedAccountId: 'acct-1' })]);
    expect(await screen.findByText('Everything here is already in One Launch.')).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' })));
  });
});
