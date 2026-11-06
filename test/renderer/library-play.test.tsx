// @vitest-environment jsdom
import './setup';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { LibraryView } from '../../src/renderer/src/views/LibraryView';
import { useUiStore } from '../../src/renderer/src/store/ui';
import type { ArtworkStatus } from '../../src/shared/models';
import { game, installBridge, job, resetUi } from './harness';

resetUi();

const idle: ArtworkStatus = { queued: 0, running: 0, completed: 0, failed: 0, hasApiKey: false, revision: 1, scanned: true };
const LAST = { accountId: 'acct-alt', accountName: 'Alt', launchedAt: '2026-10-01T00:00:00.000Z' };

function library(games: ReturnType<typeof game>[]) {
  return installBridge({
    'library:list': () => ({ games, revision: 1 }),
    'launch:recent': () => ({
      recent: [{ gameId: 'game-1', gameName: 'Dota 2', launcher: 'steam', accountId: 'acct-alt', accountName: 'Alt', launchedAt: LAST.launchedAt }],
    }),
    'artwork:status': () => ({ status: idle }),
    'launchers:status': () => ({ launchers: [] }),
  });
}

beforeEach(() => {
  resetUi();
});

describe('Library: one-click Play', () => {
  it('plays a game as the account it was last launched with, with no dialog', async () => {
    library([game({ lastLaunch: LAST })]);
    const user = userEvent.setup();
    render(<LibraryView />);
    await user.click(await screen.findByRole('button', { name: 'Play Dota 2' }));
    expect(useUiStore.getState().launchRequest).toMatchObject({ game: { id: 'game-1' }, initialAccountId: 'acct-alt', instant: true });
    expect(screen.getByRole('button', { name: 'Play Dota 2' }).getAttribute('aria-busy')).toBe('true');
  });

  it('opens the picker for a game never launched here, one whose account is gone, one its launcher will not start before an update, or while a job runs', async () => {
    library([
      game({ id: 'game-1', name: 'Dota 2' }),
      game({ id: 'game-2', name: 'Gone', lastLaunch: { ...LAST, accountName: null } }),
      game({ id: 'game-3', name: 'Stale', launcher: 'battlenet', launcherGameId: 'pro', lastLaunch: LAST, needsUpdate: true }),
      game({ id: 'game-5', name: 'Steam updates it', lastLaunch: LAST, needsUpdate: true }),
      game({ id: 'game-4', name: 'Busy', lastLaunch: LAST }),
    ]);
    const user = userEvent.setup();
    render(<LibraryView />);
    await user.click(await screen.findByRole('button', { name: 'Play Dota 2' }));
    expect(useUiStore.getState().launchRequest).toMatchObject({ game: { id: 'game-1' }, initialAccountId: null });
    expect(useUiStore.getState().launchRequest?.instant).toBeFalsy();
    await user.click(screen.getByRole('button', { name: 'Play Gone' }));
    expect(useUiStore.getState().launchRequest).toMatchObject({ game: { id: 'game-2' }, initialAccountId: 'acct-alt' });
    expect(useUiStore.getState().launchRequest?.instant).toBeFalsy();
    await user.click(screen.getByRole('button', { name: 'Play Stale' }));
    expect(useUiStore.getState().launchRequest).toMatchObject({ game: { id: 'game-3' }, initialAccountId: 'acct-alt' });
    expect(useUiStore.getState().launchRequest?.instant).toBeFalsy();
    await user.click(screen.getByRole('button', { name: 'Play Steam updates it' }));
    expect(useUiStore.getState().launchRequest).toMatchObject({ game: { id: 'game-5' }, initialAccountId: 'acct-alt', instant: true });
    useUiStore.getState().setActiveLaunch({ job: job(), game: game() });
    await user.click(screen.getByRole('button', { name: 'Play Busy' }));
    expect(useUiStore.getState().launchRequest).toMatchObject({ game: { id: 'game-4' }, initialAccountId: 'acct-alt' });
    expect(useUiStore.getState().launchRequest?.instant).toBeFalsy();
  });

  it('offers "Play as…" first in the card menu, which opens the picker on the last account', async () => {
    library([game({ lastLaunch: LAST })]);
    const user = userEvent.setup();
    render(<LibraryView />);
    await user.click(await screen.findByRole('button', { name: 'More for Dota 2' }));
    const items = screen.getAllByRole('menuitem');
    expect(items[0]?.textContent).toBe('Play as…');
    await user.click(items[0]!);
    expect(useUiStore.getState().launchRequest).toMatchObject({ game: { id: 'game-1' }, initialAccountId: 'acct-alt' });
    expect(useUiStore.getState().launchRequest?.instant).toBeFalsy();
  });

  it('a Recent tile plays at once too', async () => {
    library([game({ lastLaunch: LAST })]);
    const user = userEvent.setup();
    render(<LibraryView />);
    await user.click(await screen.findByTitle('Play Dota 2 as Alt'));
    expect(useUiStore.getState().launchRequest).toMatchObject({ game: { id: 'game-1' }, initialAccountId: 'acct-alt', instant: true });
  });
});
