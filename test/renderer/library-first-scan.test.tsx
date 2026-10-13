// @vitest-environment jsdom
import './setup';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LibraryView } from '../../src/renderer/src/views/LibraryView';
import type { ArtworkStatus, LauncherStatus } from '../../src/shared/models';
import { game, installBridge, resetUi, type Handlers } from './harness';

resetUi();

const idle: ArtworkStatus = { queued: 0, running: 0, completed: 0, failed: 0, hasApiKey: false, revision: 1, scanned: true };

function launcher(id: LauncherStatus['launcher'], displayName: string, installed: boolean): LauncherStatus {
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

const NONE = [launcher('steam', 'Steam', false), launcher('epic', 'Epic Games', false), launcher('battlenet', 'Battle.net', false)];

function library(opts: { games?: ReturnType<typeof game>[]; launchers?: LauncherStatus[]; over?: Handlers } = {}) {
  return installBridge({
    'library:list': () => ({ games: opts.games ?? [game()] }),
    'launch:recent': () => ({ recent: [] }),
    'artwork:status': () => ({ status: idle }),
    'launchers:status': () => ({ launchers: opts.launchers ?? NONE }),
    ...opts.over,
  });
}

describe('the Library around the first scan', () => {
  it('says that no launcher was found once the scan is over and the library is empty', async () => {
    library({ games: [] });
    render(<LibraryView />);
    expect(await screen.findByRole('heading', { name: 'No launchers found' })).toBeTruthy();
  });

  it('does not check the launchers while it has games to show', async () => {
    const bridge = library();
    render(<LibraryView />);
    expect((await screen.findAllByText('Dota 2')).length).toBeGreaterThan(0);
    await waitFor(() => expect(bridge.calls.some((c) => c.channel === 'artwork:status')).toBe(true));
    expect(bridge.sent('launchers:status')).toEqual([]);
  });

  it('shows the games of the first scan about a second after it finishes, not four', async () => {
    let scanned = false;
    let statusCalls = 0;
    library({
      over: {
        'library:list': () => ({ games: scanned ? [game()] : [] }),
        'artwork:status': () => {
          if (++statusCalls >= 2) scanned = true;
          return { status: { ...idle, revision: scanned ? 2 : 1 } };
        },
      },
    });
    render(<LibraryView />);
    expect(await screen.findByRole('heading', { name: 'Scanning your launchers…' })).toBeTruthy();
    expect((await screen.findAllByText('Dota 2', {}, { timeout: 2500 })).length).toBeGreaterThan(0);
  });

  it('says it is scanning, not that no games were found, until the first scan has finished', async () => {
    let scanned = false;
    library({
      games: [],
      launchers: [launcher('steam', 'Steam', true)],
      over: { 'artwork:status': () => ({ status: { ...idle, scanned } }) },
    });
    render(<LibraryView />);
    expect(await screen.findByRole('heading', { name: 'Scanning your launchers…' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Scan now' }) as HTMLButtonElement).disabled).toBe(true);
    scanned = true;
    expect(await screen.findByRole('heading', { name: 'No games found' }, { timeout: 2500 })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Scan now' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
