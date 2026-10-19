import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS, STARTUP_REQUESTS, type IpcEnvelope, type OneLaunchApi } from '@shared/ipc-contract';

/**
 * The only bridge between renderer and main. It forwards invoke() calls for channels on the
 * allowlist and nothing else. No Node, fs, child_process, or shell ever crosses this line.
 * The envelope is passed through as data; the renderer client turns failures into typed errors.
 */
const allowed: ReadonlySet<string> = new Set(IPC_CHANNELS);

const invoke = async (channel: string, req?: unknown): Promise<IpcEnvelope<unknown>> => {
  if (!allowed.has(channel)) {
    return { ok: false, error: { code: 'UNKNOWN_CHANNEL', message: `Unknown IPC channel: ${channel}` } };
  }
  return (await ipcRenderer.invoke(channel, req)) as IpcEnvelope<unknown>;
};

// Sent now, at document start, so the answers are back before the page's own scripts have been fetched. Each channel
// settles on its own, and a rejected call becomes that channel's error envelope.
const startup = new Map<string, Promise<IpcEnvelope<unknown>>>(
  Object.entries(STARTUP_REQUESTS).map(([channel, req]) => [
    channel,
    invoke(channel, req).catch((err: unknown): IpcEnvelope<unknown> => ({
      ok: false,
      error: { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) },
    })),
  ]),
);

const api: OneLaunchApi = {
  invoke: invoke as OneLaunchApi['invoke'],
  startup: ((channel: string) =>
    startup.get(channel) ??
    Promise.resolve<IpcEnvelope<unknown>>({
      ok: false,
      error: { code: 'UNKNOWN_CHANNEL', message: `Not a startup channel: ${channel}` },
    })) as OneLaunchApi['startup'],
};

contextBridge.exposeInMainWorld('oneLaunch', api);
