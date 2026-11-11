import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { vi } from 'vitest';

export type IpcHandlerFn = (event: unknown, req: unknown) => Promise<unknown>;

const slot = vi.hoisted(() => ({ handlers: null as Map<string, (event: unknown, req: unknown) => Promise<unknown>> | null, version: '' }));

slot.version = (JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../package.json'), 'utf8')) as { version: string }).version;

const refuse = (what: string) => (): never => {
  throw new Error(`the replay harness has no ${what}; the channel that needs it is excluded from replay`);
};

vi.mock('electron', () => ({
  app: { getVersion: () => slot.version, isPackaged: false },
  shell: { openPath: refuse('shell'), openExternal: refuse('shell') },
  safeStorage: { isEncryptionAvailable: refuse('safeStorage') },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, req: unknown) => Promise<unknown>) => {
      if (!slot.handlers) throw new Error('an IPC handler was registered with no app instance starting');
      slot.handlers.set(channel, fn);
    },
  },
}));

/** The handlers the next `registerIpcHandlers` call fills: one map per app start, as each start is its own process. */
export function collectHandlers(handlers: Map<string, IpcHandlerFn> | null): void {
  slot.handlers = handlers;
}

export const appVersion = (): string => slot.version;
