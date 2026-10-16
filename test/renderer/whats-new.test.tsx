// @vitest-environment jsdom
import './setup';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatReleaseDate, WhatsNewHost } from '../../src/renderer/src/components/WhatsNewDialog';
import { useUiStore } from '../../src/renderer/src/store/ui';
import type { AppInfo, SettingKey, SwitchRecovery } from '../../src/shared/models';
import type { WhatsNewRelease } from '../../src/shared/whats-new';
import { BridgeError, installBridge, resetUi, type Bridge } from './harness';

resetUi();

const info: AppInfo = {
  version: '1.0.0-beta.5',
  electron: '44.0.0',
  node: '24.0.0',
  chrome: '140.0.0.0',
  isPackaged: true,
  dataDir: 'C:\\scratch\\data',
  logDir: 'C:\\scratch\\data\\logs',
  dbPath: 'C:\\scratch\\data\\onelaunch.db',
  startup: { processToNodeMs: 100, windowShownMs: 400, readyToShowMs: 500, didFinishLoadMs: 600 },
  platformSource: 'real',
};

const RELEASES: readonly WhatsNewRelease[] = [
  {
    version: '1.0.0-beta.5',
    date: '2026-10-20',
    intro: 'A quick one.',
    items: [{ lead: 'Faster switches.', detail: 'Steam comes back in half the time.' }, { lead: 'A tidier Library.' }],
  },
  { version: '1.0.0-beta.3', date: '2026-10-01', items: [{ lead: 'Older news.' }] },
];

const recovery: SwitchRecovery = {
  jobId: 'job-1',
  launcher: 'steam',
  accountName: 'Alt',
  startedAt: '2026-09-18T10:00:00.000Z',
  backupId: '20260918-100000-000',
  snapshotAvailable: true,
  phase: 'writing',
};

interface MainOptions {
  settings?: Partial<Record<SettingKey, string>>;
  recovery?: SwitchRecovery;
  failSave?: boolean;
}

/** A main process with a settings table, the running version, and how the last run ended. */
function main(opts: MainOptions = {}) {
  const stored: Partial<Record<SettingKey, string>> = { ...opts.settings };
  return installBridge({
    'app:info': () => info,
    'settings:getAll': () => ({ settings: { ...stored } }),
    'settings:set': (req) => {
      if (opts.failSave) throw new BridgeError('DB_UNAVAILABLE', 'read-only');
      stored[req.key] = req.value;
      return { ok: true };
    },
    'recovery:get': () => ({ recovery: opts.recovery ?? null }),
  });
}

const dialog = () => screen.queryByRole('dialog', { name: "What's New" });
const settle = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

describe('WhatsNewHost', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  it('opens the newest unseen notes once the Library has had a moment', async () => {
    main({ settings: { 'whatsNew.lastSeen': '1.0.0-beta.3' } });
    render(<WhatsNewHost releases={RELEASES} />);
    await settle(150);
    expect(dialog()).toBeNull();
    await settle(400);
    expect(dialog()).toBeTruthy();
    expect(useUiStore.getState().whatsNew).toMatchObject({ release: { version: '1.0.0-beta.5' }, version: '1.0.0-beta.5' });
  });

  it('treats an install from before the feature, with nothing seen, as needing the newest notes', async () => {
    main();
    render(<WhatsNewHost releases={RELEASES} />);
    await settle(600);
    expect(useUiStore.getState().whatsNew?.release.version).toBe('1.0.0-beta.5');
  });

  it('stays closed once the running version was seen', async () => {
    const bridge = main({ settings: { 'whatsNew.lastSeen': '1.0.0-beta.5' } });
    render(<WhatsNewHost releases={RELEASES} />);
    await settle(1000);
    expect(dialog()).toBeNull();
    expect(bridge.sent('settings:set')).toEqual([]);
  });

  it('with the setting off, stays closed and only records the running version as seen', async () => {
    const bridge = main({ settings: { 'whatsNew.enabled': 'false', 'whatsNew.lastSeen': '1.0.0-beta.3' } });
    render(<WhatsNewHost releases={RELEASES} />);
    await settle(1000);
    expect(dialog()).toBeNull();
    expect(bridge.sent('settings:set')).toEqual([{ key: 'whatsNew.lastSeen', value: '1.0.0-beta.5' }]);
  });

  it('leaves a start alone while the recovery prompt is up', async () => {
    const bridge = main({ recovery });
    render(<WhatsNewHost releases={RELEASES} />);
    await settle(1000);
    expect(dialog()).toBeNull();
    expect(bridge.sent('settings:set')).toEqual([]);
  });

  it('leaves a start alone while the setup guide is up', async () => {
    const bridge = main();
    useUiStore.setState({ setupGuide: 'first-run' });
    render(<WhatsNewHost releases={RELEASES} />);
    await settle(1000);
    expect(dialog()).toBeNull();
    expect(bridge.sent('settings:set')).toEqual([]);
  });
});

describe('WhatsNewDialog', () => {
  /** Mounts the host with the card already open for the newest release, the way the host or Settings leaves it. */
  function open(opts: MainOptions = {}) {
    const bridge = main({ settings: { 'whatsNew.lastSeen': info.version }, ...opts });
    useUiStore.setState({ whatsNew: { release: RELEASES[0]!, version: info.version } });
    render(<WhatsNewHost releases={RELEASES} />);
    return bridge;
  }
  const closed = () => waitFor(() => expect(dialog()).toBeNull());
  const recorded = (bridge: Bridge) => waitFor(() => expect(bridge.sent('settings:set')).toEqual([{ key: 'whatsNew.lastSeen', value: info.version }]));

  it('shows the title and the release date, one line per change, and starts with the focus on the list so the keyboard scrolls it', async () => {
    open();
    expect(dialog()?.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByRole('heading', { name: "What's New" })).toBeTruthy();
    expect(screen.getByText(formatReleaseDate('2026-10-20'))).toBeTruthy();
    expect(dialog()?.textContent).not.toContain('1.0.0-beta.5');
    expect(screen.getByText('A quick one.')).toBeTruthy();
    expect(screen.getByText('Faster switches.')).toBeTruthy();
    expect(screen.getByText('Steam comes back in half the time.')).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: "Let's go" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('list').parentElement));
  });

  it('the X records the running version as seen and closes', async () => {
    const bridge = open();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Close' }));
    await recorded(bridge);
    await closed();
  });

  it('Escape does the same', async () => {
    const bridge = open();
    fireEvent.keyDown(window, { key: 'Escape' });
    await recorded(bridge);
    await closed();
  });

  it('the backdrop does the same, and a click inside the card does nothing', async () => {
    const bridge = open();
    fireEvent.click(screen.getByRole('heading', { name: "What's New" }));
    expect(dialog()).toBeTruthy();
    expect(bridge.sent('settings:set')).toEqual([]);
    fireEvent.click(document.querySelector('[role="presentation"]')!);
    await recorded(bridge);
    await closed();
  });

  it('closes even when the save fails, so the card returns next start', async () => {
    const bridge = open({ failSave: true });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await closed();
    expect(bridge.sent('settings:set')).toHaveLength(1);
  });

  it('formats the release date from its parts, in the long local form', () => {
    expect(formatReleaseDate('2026-10-20')).toBe(new Date(2026, 9, 20).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }));
    expect(formatReleaseDate('soon')).toBe('soon');
  });
});
