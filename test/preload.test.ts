import { beforeEach, describe, expect, it, vi } from 'vitest';

const exposed = new Map<string, unknown>();
const forwarded: { channel: string; req: unknown }[] = [];
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (name: string, api: unknown) => exposed.set(name, api) },
  ipcRenderer: {
    invoke: async (channel: string, req: unknown) => {
      forwarded.push({ channel, req });
      return { ok: true, data: { echoed: channel } };
    },
  },
}));

await import('../src/preload/index');
import { IPC_CHANNELS } from '../src/shared/ipc-contract';

type Invoke = (channel: string, req?: unknown) => Promise<unknown>;
const invoke = (): Invoke => (exposed.get('oneLaunch') as { invoke: Invoke }).invoke;

beforeEach(() => {
  forwarded.length = 0;
});

describe('preload bridge (B19)', () => {
  it('exposes one object with one function, and nothing else', () => {
    expect([...exposed.keys()]).toEqual(['oneLaunch']);
    expect(Object.keys(exposed.get('oneLaunch') as object)).toEqual(['invoke']);
  });

  it('forwards every channel of the contract with its payload and hands the envelope back untouched', async () => {
    for (const channel of IPC_CHANNELS) {
      expect(await invoke()(channel, { n: 1 })).toEqual({ ok: true, data: { echoed: channel } });
    }
    expect(forwarded.map((f) => f.channel)).toEqual([...IPC_CHANNELS]);
    expect(forwarded.every((f) => JSON.stringify(f.req) === '{"n":1}')).toBe(true);
  });

  it('answers an unknown channel itself, without asking main', async () => {
    for (const channel of ['shell:exec', 'fs:read', 'APP:INFO', ' app:info', '__proto__', 'constructor', 'toString', '']) {
      expect(await invoke()(channel, {})).toEqual({ ok: false, error: { code: 'UNKNOWN_CHANNEL', message: `Unknown IPC channel: ${channel}` } });
    }
    expect(forwarded).toEqual([]);
  });
});
