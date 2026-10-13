// @vitest-environment jsdom
import './setup';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TitleBar } from '../../src/renderer/src/components/TitleBar';
import type { AppInfo, PlatformSource } from '../../src/shared/models';
import { installBridge, resetUi } from './harness';

resetUi();

const info = (platformSource: PlatformSource): AppInfo => ({
  version: '1.0.0-test',
  electron: '0',
  node: '0',
  chrome: '0',
  isPackaged: false,
  dataDir: 'C:\\scratch',
  logDir: 'C:\\scratch\\logs',
  dbPath: 'C:\\scratch\\onelaunch.db',
  startup: { processToNodeMs: null, windowShownMs: null, readyToShowMs: null, didFinishLoadMs: null },
  platformSource,
});

describe('TitleBar', () => {
  it('marks a run against fake launchers so a screenshot can never pass for a real one', async () => {
    installBridge({ 'app:info': () => info('fake') });
    render(<TitleBar />);
    expect((await screen.findByRole('status')).textContent).toBe('Fake launchers');
  });

  it('shows only the app name against real launchers', async () => {
    const bridge = installBridge({ 'app:info': () => info('real') });
    render(<TitleBar />);
    await waitFor(() => expect(bridge.sent('app:info')).toHaveLength(1));
    expect(screen.getByText('One Launch')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });
});
