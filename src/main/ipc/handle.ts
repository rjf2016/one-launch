import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { IpcChannel, IpcEnvelope, IpcErrorShape, IpcRequest, IpcResponse } from '@shared/ipc-contract';
import type { Logger } from '../services/logger';
import { REFUSAL_CODES } from '../services/refusals';

/** Throw this from a handler to send a specific error code to the renderer. */
export class IpcRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'IpcRequestError';
  }
}

export type IpcHandler<K extends IpcChannel> = (req: IpcRequest<K>, event: IpcMainInvokeEvent) => IpcResponse<K> | Promise<IpcResponse<K>>;

export interface RegistrarOptions {
  log: Logger;
  /** Reject calls from any frame that is not our own renderer. */
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean;
}

function toErrorShape(err: unknown): IpcErrorShape {
  if (err instanceof IpcRequestError) return { code: err.code, message: err.message };
  if (err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string') {
    return { code: (err as { code: string }).code, message: err instanceof Error ? err.message : String(err) };
  }
  if (err instanceof Error) return { code: 'INTERNAL', message: err.message };
  return { code: 'INTERNAL', message: 'Unknown error' };
}

/**
 * Returns a `handle` function that registers a typed handler for one channel.
 * Errors never propagate across the bridge; they are logged (redacted) and returned as data.
 */
export function createRegistrar(opts: RegistrarOptions) {
  const registered = new Set<string>();

  return function handle<K extends IpcChannel>(channel: K, fn: IpcHandler<K>): void {
    if (registered.has(channel)) throw new Error(`IPC handler already registered for ${channel}`);
    registered.add(channel);

    ipcMain.handle(channel, async (event, req: unknown): Promise<IpcEnvelope<IpcResponse<K>>> => {
      if (!opts.isTrustedSender(event)) {
        opts.log.warn('rejected IPC call from untrusted sender', { channel, url: event.senderFrame?.url });
        return { ok: false, error: { code: 'UNTRUSTED_SENDER', message: 'Request rejected' } };
      }
      try {
        const data = await fn(req as IpcRequest<K>, event);
        return { ok: true, data };
      } catch (err) {
        const error = toErrorShape(err);
        if (REFUSAL_CODES.has(error.code)) opts.log.warn(`ipc ${channel} refused`, { code: error.code, message: error.message });
        else opts.log.error(`ipc ${channel} failed`, { code: error.code, message: error.message });
        return { ok: false, error };
      }
    });
  };
}

// ---------------------------------------------------------------------------
// Request validation helpers. The renderer is sandboxed, but its input is still untrusted.
// ---------------------------------------------------------------------------

export function expectObject(req: unknown, channel: string): Record<string, unknown> {
  if (!req || typeof req !== 'object' || Array.isArray(req)) {
    throw new IpcRequestError('BAD_REQUEST', `${channel}: expected an object payload`);
  }
  return req as Record<string, unknown>;
}

export function expectString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== 'string') throw new IpcRequestError('BAD_REQUEST', `${name} must be a string`);
  if (value.length > maxLength) throw new IpcRequestError('BAD_REQUEST', `${name} exceeds ${maxLength} characters`);
  return value;
}

export function expectOneOf<T extends string>(value: unknown, name: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new IpcRequestError('BAD_REQUEST', `${name} is not an allowed value`);
  }
  return value as T;
}

export function expectOptionalString(value: unknown, name: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  return expectString(value, name, maxLength);
}

/** Accepts undefined (leave untouched), null (clear), or a string. */
export function expectNullableString(value: unknown, name: string, maxLength: number): string | null | undefined {
  if (value === undefined || value === null) return value;
  return expectString(value, name, maxLength);
}

export function expectStringArray(value: unknown, name: string, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) throw new IpcRequestError('BAD_REQUEST', `${name} must be an array`);
  if (value.length > maxItems) throw new IpcRequestError('BAD_REQUEST', `${name} has more than ${maxItems} items`);
  return value.map((v, i) => expectString(v, `${name}[${i}]`, maxLength));
}

export function expectOptionalStringArray(value: unknown, name: string, maxItems: number, maxLength: number): string[] | undefined {
  if (value === undefined) return undefined;
  return expectStringArray(value, name, maxItems, maxLength);
}
