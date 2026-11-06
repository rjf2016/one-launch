// @vitest-environment jsdom
import './setup';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GameCard } from '../../src/renderer/src/components/GameCard';
import { game } from './harness';

const art = (source: 'steamcdn' | 'launcher', grid: string) => ({ source, grid, hero: null, logo: null, fetchedAt: '2026-10-01T00:00:00.000Z' });

afterEach(cleanup);

describe('GameCard: Play', () => {
  it('plays on a click or Enter on the poster, and shows who it would play as', () => {
    const onOpen = vi.fn();
    const g = game({ lastLaunch: { accountId: 'acct-alt', accountName: 'Alt', launchedAt: '2026-10-01T00:00:00.000Z' } });
    render(<GameCard game={g} now={Date.now()} onOpen={onOpen} onMenu={vi.fn()} />);
    const play = screen.getByRole('button', { name: 'Play Dota 2' });
    expect(screen.getByText(/^Alt/)).toBeTruthy();
    play.focus();
    fireEvent.click(play);
    expect(onOpen).toHaveBeenCalledWith(g);
    expect(play.getAttribute('aria-busy')).toBeNull();
  });

  it('spins while a one-click Play is being checked', () => {
    const { container } = render(<GameCard game={game()} now={Date.now()} onOpen={vi.fn()} onMenu={vi.fn()} busy />);
    expect(screen.getByRole('button', { name: 'Play Dota 2' }).getAttribute('aria-busy')).toBe('true');
    expect(container.querySelector('.animate-spin')).not.toBeNull();
  });
});

describe('GameCard artwork', () => {
  it('fills the poster with a cover and drops the name once it has loaded', () => {
    const { container } = render(
      <GameCard
        game={game({ name: 'Dota 2', artwork: art('steamcdn', 'onelaunch-art://art/x/grid.jpg') })}
        now={Date.now()}
        onOpen={vi.fn()}
        onMenu={vi.fn()}
      />,
    );
    const img = container.querySelector('img')!;
    expect(img.className).toContain('object-cover');
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.getAttribute('decoding')).toBe('async');
    expect(screen.getAllByText('Dota 2').length).toBeGreaterThan(1);
    fireEvent.load(img);
    expect(screen.getAllByText('Dota 2')).toHaveLength(1);
    expect(img.className).toContain('opacity-100');
  });

  it("shows the game's own icon as a mark on the poster, keeping the name", () => {
    const { container } = render(
      <GameCard
        game={game({ launcher: 'riot', name: 'VALORANT', artwork: art('launcher', 'onelaunch-art://art/x/grid.ico') })}
        now={Date.now()}
        onOpen={vi.fn()}
        onMenu={vi.fn()}
      />,
    );
    const img = container.querySelector('img')!;
    expect(img.className).toContain('object-contain');
    expect(img.className).not.toContain('object-cover');
    fireEvent.load(img);
    expect(within(container).getAllByText('VALORANT')).toHaveLength(2);
    expect(within(container).queryByText('V')).toBeNull();
    expect(within(container).getByRole('button', { name: 'Play VALORANT' })).toBeTruthy();
  });
});
