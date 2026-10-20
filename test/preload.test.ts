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
import { IPC_CHANNELS, STARTUP_REQUESTS } from '../src/shared/ipc-contract';

// What the preload sent on its own, before any call from the page.
const atLoad = forwarded.map((f) => ({ ...f }));

type Invoke = (channel: string, req?: unknown) => Promise<unknown>;
type Api = { invoke: Invoke; startup: (channel: string) => Promise<unknown> };
const api = (): Api => exposed.get('oneLaunch') as Api;
const invoke = (): Invoke => api().invoke;

beforeEach(() => {
  forwarded.length = 0;
});

describe('preload bridge (B19)', () => {
  it('exposes one object with invoke and startup, and nothing else', () => {
    expect([...exposed.keys()]).toEqual(['oneLaunch']);
    expect(Object.keys(exposed.get('oneLaunch') as object)).toEqual(['invoke', 'startup']);
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

  it('sends the startup requests as soon as it loads, once, and startup(channel) hands back that one answer', async () => {
    expect(atLoad).toEqual(Object.entries(STARTUP_REQUESTS).map(([channel, req]) => ({ channel, req })));
    for (const channel of Object.keys(STARTUP_REQUESTS)) {
      const first = api().startup(channel);
      expect(api().startup(channel)).toBe(first);
      expect(await first).toEqual({ ok: true, data: { echoed: channel } });
    }
    expect(await api().startup('accounts:get')).toEqual({ ok: false, error: { code: 'UNKNOWN_CHANNEL', message: 'Not a startup channel: accounts:get' } });
    expect(forwarded).toEqual([]);
  });
});
