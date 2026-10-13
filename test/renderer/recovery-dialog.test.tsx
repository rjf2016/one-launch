// @vitest-environment jsdom
import './setup';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { RecoveryHost } from '../../src/renderer/src/components/RecoveryDialog';
import type { SwitchRecovery } from '../../src/shared/models';
import { BridgeError, installBridge, resetUi } from './harness';

resetUi();

const recovery = (over: Partial<SwitchRecovery> = {}): SwitchRecovery => ({
  jobId: 'job-1',
  launcher: 'steam',
  accountName: 'Alt',
  startedAt: '2026-09-18T10:00:00.000Z',
  backupId: '20260918-100000-000',
  snapshotAvailable: true,
  phase: 'writing',
  ...over,
});

const primary = (name: string): boolean => screen.getByRole('button', { name }).className.includes('bg-accent');

describe('RecoveryHost (B1)', () => {
  it('shows nothing when the last run ended cleanly', async () => {
    const bridge = installBridge({ 'recovery:get': () => ({ recovery: null }) });
    render(<RecoveryHost />);
    await waitFor(() => expect(bridge.sent('recovery:get')).toHaveLength(1));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('leads with Restore for a switch that stopped while writing, restores through main, and reports it', async () => {
    const bridge = installBridge({
      'recovery:get': () => ({ recovery: recovery() }),
      'recovery:restore': () => ({ result: { launcher: 'steam', id: '20260918-100000-000', files: [], registry: [] } }),
    });
    const user = userEvent.setup();
    render(<RecoveryHost />);
    expect(await screen.findByRole('alertdialog', { name: 'One Launch was closed during a switch' })).toBeTruthy();
    expect(primary('Restore snapshot')).toBe(true);
    expect(primary('Keep as is')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Restore snapshot' }));
    expect(await screen.findByText('Steam was put back the way it was')).toBeTruthy();
    expect(bridge.sent('recovery:restore')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('leads with Keep as is once the launcher was already signing in, and forgets the switch', async () => {
    const bridge = installBridge({ 'recovery:get': () => ({ recovery: recovery({ phase: 'signing-in' }) }), 'recovery:dismiss': () => ({ ok: true }) });
    const user = userEvent.setup();
    render(<RecoveryHost />);
    await screen.findByRole('alertdialog');
    expect(primary('Keep as is')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Keep as is' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(bridge.sent('recovery:dismiss')).toHaveLength(1);
    expect(bridge.sent('recovery:restore')).toHaveLength(0);
  });

  it('keeps the prompt and offers another try when the restore is refused', async () => {
    installBridge({
      'recovery:get': () => ({ recovery: recovery({ phase: 'rollback-failed' }) }),
      'recovery:restore': () => {
        throw new BridgeError('LAUNCHER_RUNNING', 'Steam: Close Steam before restoring.');
      },
    });
    const user = userEvent.setup();
    render(<RecoveryHost />);
    expect(await screen.findByRole('alertdialog', { name: 'The last switch could not be undone' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Restore snapshot' }));
    expect(await screen.findByText('Steam: Close Steam before restoring.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try the restore again' })).toBeTruthy();
  });

  it('offers only OK when the snapshot is gone', async () => {
    const bridge = installBridge({ 'recovery:get': () => ({ recovery: recovery({ snapshotAvailable: false }) }), 'recovery:dismiss': () => ({ ok: true }) });
    const user = userEvent.setup();
    render(<RecoveryHost />);
    await screen.findByRole('alertdialog');
    expect(screen.queryByRole('button', { name: 'Restore snapshot' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(bridge.sent('recovery:dismiss')).toHaveLength(1));
  });
});
