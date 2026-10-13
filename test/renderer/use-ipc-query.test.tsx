// @vitest-environment jsdom
import './setup';
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ipc, IpcError, useIpcQuery } from '../../src/renderer/src/lib/ipc';
import { BridgeError, deferred, installBridge, resetUi } from './harness';

resetUi();

function Probe({ id }: { id: string }) {
  const q = useIpcQuery(() => ipc.invoke('accounts:get', { id }), [id]);
  return (
    <div>
      <span data-testid="data">{q.data?.account.displayName ?? ''}</span>
      <span data-testid="error">{q.error ?? ''}</span>
      <span data-testid="loading">{String(q.loading)}</span>
      <button type="button" onClick={q.reload}>
        reload
      </button>
    </div>
  );
}

const text = (id: string): string => screen.getByTestId(id).textContent ?? '';

describe('ipc client', () => {
  it('unwraps the envelope and throws failures with their code', async () => {
    installBridge({
      'app:ping': (req) => ({ echo: req.message, receivedAt: 'now' }),
      'accounts:get': () => {
        throw new BridgeError('NOT_FOUND', 'No such account');
      },
    });
    expect(await ipc.invoke('app:ping', { message: 'hi' })).toEqual({ echo: 'hi', receivedAt: 'now' });
    const err = await ipc.invoke('accounts:get', { id: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IpcError);
    expect(err).toMatchObject({ code: 'NOT_FOUND', message: 'No such account' });
  });
});

describe('useIpcQuery (B14)', () => {
  it('drops the last error as soon as the next run starts, and keeps the data it already had', async () => {
    const { account } = await import('./harness');
    let answer: () => Promise<{ account: ReturnType<typeof account> }> = async () => ({ account: account({ displayName: 'Main' }) });
    installBridge({ 'accounts:get': () => answer() });
    render(<Probe id="a" />);
    await act(async () => undefined);
    expect(text('data')).toBe('Main');

    answer = async () => {
      throw new BridgeError('INTERNAL', 'database is locked');
    };
    await act(async () => screen.getByRole('button').click());
    expect(text('error')).toBe('database is locked');
    expect(text('data')).toBe('Main');

    const held = deferred<{ account: ReturnType<typeof account> }>();
    answer = () => held.promise;
    act(() => screen.getByRole('button').click());
    expect(text('loading')).toBe('true');
    expect(text('error')).toBe('');
    expect(text('data')).toBe('Main');
    await act(async () => held.resolve({ account: account({ displayName: 'Main again' }) }));
    expect(text('data')).toBe('Main again');
  });

  it('ignores an answer that arrives after its inputs changed', async () => {
    const { account } = await import('./harness');
    const slow = deferred<{ account: ReturnType<typeof account> }>();
    installBridge({ 'accounts:get': (req) => (req.id === 'a' ? slow.promise : Promise.resolve({ account: account({ displayName: 'B' }) })) });
    const view = render(<Probe id="a" />);
    view.rerender(<Probe id="b" />);
    await act(async () => undefined);
    expect(text('data')).toBe('B');
    await act(async () => slow.resolve({ account: account({ displayName: 'A, too late' }) }));
    expect(text('data')).toBe('B');
  });
});
