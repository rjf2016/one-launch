import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS, type IpcEnvelope, type OneLaunchApi } from '@shared/ipc-contract';

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

const api: OneLaunchApi = {
  invoke: invoke as OneLaunchApi['invoke'],
};

contextBridge.exposeInMainWorld('oneLaunch', api);
