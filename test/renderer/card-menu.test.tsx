// @vitest-environment jsdom
import './setup';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { CardMenu } from '../../src/renderer/src/components/CardMenu';
import { resetUi } from './harness';

resetUi();

function Host({ onRefresh, onChoose }: { onRefresh: () => void; onChoose: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        More for Dota 2
      </button>
      <button type="button">Elsewhere</button>
      {open ? (
        <CardMenu
          x={10}
          y={10}
          title="Dota 2"
          subtitle="Artwork: Steam"
          items={[
            { id: 'refresh', label: 'Refresh artwork', onSelect: onRefresh },
            { id: 'choose', label: 'Choose portrait image…', onSelect: onChoose },
          ]}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function setup() {
  const onRefresh = vi.fn();
  const onChoose = vi.fn();
  render(<Host onRefresh={onRefresh} onChoose={onChoose} />);
  return { onRefresh, onChoose, user: userEvent.setup(), opener: screen.getByRole('button', { name: 'More for Dota 2' }) };
}

describe('CardMenu (B13)', () => {
  it('takes focus on its first item when it opens, and is named after the game', async () => {
    const { user, opener } = setup();
    opener.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('menu', { name: 'More for Dota 2' })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Refresh artwork' }));
  });

  it('moves with the arrow keys, wraps, and jumps with Home and End', async () => {
    const { user, opener } = setup();
    await user.click(opener);
    const first = screen.getByRole('menuitem', { name: 'Refresh artwork' });
    const last = screen.getByRole('menuitem', { name: 'Choose portrait image…' });
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(last);
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(first);
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(last);
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(first);
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(last);
    expect(screen.getByRole('menu')).toBeTruthy();
  });

  it.each(['{Escape}', '{Tab}'])('%s closes it and gives focus back to what opened it', async (key) => {
    const { user, opener, onRefresh } = setup();
    await user.click(opener);
    await user.keyboard(key);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('runs the focused item on Enter, closes, and returns focus', async () => {
    const { user, opener, onRefresh, onChoose } = setup();
    await user.click(opener);
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onRefresh).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('closes on a press outside without pulling focus back, and stays open on a press inside', async () => {
    const { user, opener } = setup();
    await user.click(opener);
    fireEvent.pointerDown(screen.getByText('Artwork: Steam'));
    expect(screen.getByRole('menu')).toBeTruthy();
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    await user.click(elsewhere);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(elsewhere);
  });

  it('an ordinary key no longer closes it', async () => {
    const { user, opener } = setup();
    await user.click(opener);
    await user.keyboard('a');
    expect(screen.getByRole('menu')).toBeTruthy();
  });
});
