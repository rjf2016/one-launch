import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../src/main/services/logger';
import { isRefusal, refusalCode } from '../src/main/services/refusals';

const handlers = new Map<string, (event: unknown, req: unknown) => Promise<unknown>>();
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (event: unknown, req: unknown) => Promise<unknown>) => handlers.set(channel, fn) },
}));

const { createRegistrar, IpcRequestError } = await import('../src/main/ipc/handle');

function capturing(): { log: Logger; lines: { level: string; message: string }[] } {
  const lines: { level: string; message: string }[] = [];
  const log: Logger = {
    debug: (m) => void lines.push({ level: 'debug', message: m }),
    info: (m) => void lines.push({ level: 'info', message: m }),
    warn: (m) => void lines.push({ level: 'warn', message: m }),
    error: (m) => void lines.push({ level: 'error', message: m }),
    child: () => log,
  };
  return { log, lines };
}

describe('refusals', () => {
  it('recognises an expected refusal by its code and nothing else', () => {
    expect(refusalCode(Object.assign(new Error('running'), { code: 'LAUNCHER_RUNNING' }))).toBe('LAUNCHER_RUNNING');
    expect(isRefusal({ code: 'DRY_RUN' })).toBe(true);
    expect(isRefusal(Object.assign(new Error('bad'), { code: 'VAULT_UNREADABLE' }))).toBe(false);
    expect(isRefusal(new Error('plain'))).toBe(false);
    expect(isRefusal(null)).toBe(false);
    expect(refusalCode('DRY_RUN')).toBeNull();
  });

  it('the IPC wrapper logs a refusal at warn and any other failure at error', async () => {
    const { log, lines } = capturing();
    const handle = createRegistrar({ log, isTrustedSender: () => true });
    handle('launch:start', async () => {
      throw new IpcRequestError('DRY_RUN', 'Preview mode is on.');
    });
    handle('backups:restore', async () => {
      throw Object.assign(new Error('Close Steam first'), { code: 'LAUNCHER_RUNNING' });
    });
    handle('library:rescan', async () => {
      throw new Error('disk on fire');
    });
    const event = { senderFrame: { url: 'file:///x' } };
    expect(await handlers.get('launch:start')!(event, {})).toMatchObject({ ok: false, error: { code: 'DRY_RUN' } });
    expect(await handlers.get('backups:restore')!(event, {})).toMatchObject({ ok: false, error: { code: 'LAUNCHER_RUNNING' } });
    expect(await handlers.get('library:rescan')!(event, undefined)).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
    expect(lines).toEqual([
      { level: 'warn', message: 'ipc launch:start refused' },
      { level: 'warn', message: 'ipc backups:restore refused' },
      { level: 'error', message: 'ipc library:rescan failed' },
    ]);
  });
});
