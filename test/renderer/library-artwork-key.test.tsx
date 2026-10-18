// @vitest-environment jsdom
import './setup';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { useUiStore } from '../../src/renderer/src/store/ui';
import { LibraryView } from '../../src/renderer/src/views/LibraryView';
import type { ArtworkStatus } from '../../src/shared/models';
import { game, installBridge, resetUi } from './harness';

resetUi();

const idle: ArtworkStatus = { queued: 0, running: 0, completed: 0, failed: 0, hasApiKey: false, revision: 1, scanned: true };
const NO_COVER = game({
  id: 'game-ow',
  launcher: 'battlenet',
  name: 'Overwatch 2',
  artwork: null,
  artworkError: 'Not found on Steam; add a SteamGridDB API key in Settings',
});

function library(status: Partial<ArtworkStatus>, games = [NO_COVER]) {
  return installBridge({
    'library:list': () => ({ games }),
    'launch:recent': () => ({ recent: [] }),
    'artwork:status': () => ({ status: { ...idle, ...status } }),
    'launchers:status': () => ({ launchers: [] }),
  });
}

describe('Library: the free-key nudge', () => {
  it('offers the key when a cover was not found and no key is stored, and lands on Settings › Artwork', async () => {
    library({});
    const user = userEvent.setup();
    render(<LibraryView />);
    const nudge = await screen.findByRole('button', { name: 'Add a free key for missing covers' });
    await user.click(nudge);
    await waitFor(() => expect(useUiStore.getState().view).toBe('settings'));
    expect(useUiStore.getState().settingsTab).toBe('artwork');
  });

  it('stays quiet while a key is stored, while downloads run, before the scan, or when every game has a cover', async () => {
    const cases: [Partial<ArtworkStatus>, ReturnType<typeof game>[]][] = [
      [{ hasApiKey: true }, [NO_COVER]],
      [{ queued: 1 }, [NO_COVER]],
      [{ scanned: false }, [NO_COVER]],
      [{}, [game({ artwork: null, artworkError: null })]],
    ];
    for (const [status, games] of cases) {
      const view = render(<LibraryView />);
      library(status, games);
      await screen.findByText('Library');
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Add a free key for missing covers' })).toBeNull());
      view.unmount();
    }
  });
});
