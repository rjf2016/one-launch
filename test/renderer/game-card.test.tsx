// @vitest-environment jsdom
import './setup';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GameCard } from '../../src/renderer/src/components/GameCard';
import { game } from './harness';

const art = (source: 'steamcdn' | 'launcher', grid: string) => ({ source, grid, hero: null, logo: null, fetchedAt: '2026-10-01T00:00:00.000Z' });

describe('GameCard artwork', () => {
  it('fills the poster with a cover and drops the name once it has loaded', () => {
    const { container } = render(
      <GameCard game={game({ name: 'Dota 2', artwork: art('steamcdn', 'onelaunch-art://art/x/grid.jpg') })} onOpen={vi.fn()} onMenu={vi.fn()} />,
    );
    const img = container.querySelector('img')!;
    expect(img.className).toContain('object-cover');
    expect(screen.getAllByText('Dota 2').length).toBeGreaterThan(1);
    fireEvent.load(img);
    expect(screen.getAllByText('Dota 2')).toHaveLength(1);
    expect(img.className).toContain('opacity-100');
  });

  it("shows the game's own icon as a mark on the poster, keeping the name", () => {
    const { container } = render(
      <GameCard
        game={game({ launcher: 'riot', name: 'VALORANT', artwork: art('launcher', 'onelaunch-art://art/x/grid.ico') })}
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
