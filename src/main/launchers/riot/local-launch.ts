import { readFileSync } from 'node:fs';
import { Agent, request } from 'node:https';

/**
 * The one thing One Launch asks the Riot Client's local server for: the launch request its own Play
 * button sends (docs/adapters/riot.md, rule 4's single exception). The request goes to 127.0.0.1 on
 * the port the client wrote to its lockfile, over node:https alone (no proxy, no redirect), with the
 * lockfile's per-run password as basic auth, once, after the client has opened the game's page. The
 * password is read for the call and never kept, logged, or put in an error.
 */
export interface RiotLocalLaunch {
  launch(req: LocalLaunchRequest): Promise<void>;
}

export interface LocalLaunchRequest {
  product: string;
  patchline: string;
  /** `<client data>\Config\lockfile`: the adapter owns the path, the channel reads it at the moment of the call. */
  lockfilePath: string;
  signal?: AbortSignal | undefined;
}

export const LOCAL_LAUNCH_HOST = '127.0.0.1';
export const LOCAL_LAUNCH_TIMEOUT_MS = 10_000;
const LOCKFILE_NAME = 'Riot Client';
const ID_PART = /^[a-z0-9_]+$/;

export interface Lockfile {
  port: number;
  password: string;
}

/** `name:pid:port:password:protocol` on one line. Only the client's own https lockfile with a usable port counts. */
export function parseLockfile(text: string): Lockfile | null {
  const parts = text.trim().split(':');
  if (parts.length !== 5) return null;
  const [name, pid, port, password, protocol] = parts as [string, string, string, string, string];
  if (name !== LOCKFILE_NAME || protocol !== 'https' || !/^\d+$/.test(pid) || !password) return null;
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) return null;
  return { port: Number(port), password };
}

/** What goes on the wire, in full: a test sees exactly this. */
export interface LocalRequest {
  method: 'POST';
  host: string;
  port: number;
  path: string;
  headers: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}

export type LocalRequester = (req: LocalRequest) => Promise<{ status: number }>;

/** node:https alone: it honours no proxy and follows no redirect. A fresh agent accepts the client's self-signed certificate for this one loopback connection. */
export const httpsRequester: LocalRequester = (req) =>
  new Promise((resolve, reject) => {
    const r = request(
      {
        host: req.host,
        port: req.port,
        path: req.path,
        method: req.method,
        headers: { ...req.headers, 'content-length': '0' },
        agent: new Agent({ rejectUnauthorized: false, keepAlive: false }),
        timeout: req.timeoutMs,
        ...(req.signal ? { signal: req.signal } : {}),
      },
      (res) => {
        // Only the status counts; the body is drained and dropped, so nothing the client answers is kept.
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
        res.on('error', reject);
      },
    );
    r.on('timeout', () => r.destroy(new Error('timed out')));
    r.on('error', reject);
    r.end();
  });

/** A code or a name, never a message: nothing from the request ends up in a log line or a job detail. */
function errorLabel(err: unknown): string {
  if (err instanceof Error && err.message === 'timed out') return 'timed out';
  if (err && typeof err === 'object') {
    const { code, name } = err as { code?: unknown; name?: unknown };
    if (typeof code === 'string' && code) return code;
    if (typeof name === 'string' && name && name !== 'Error') return name;
  }
  return 'error';
}

export class WindowsRiotLocalLaunch implements RiotLocalLaunch {
  constructor(private readonly requester: LocalRequester = httpsRequester) {}

  async launch(req: LocalLaunchRequest): Promise<void> {
    if (!ID_PART.test(req.product) || !ID_PART.test(req.patchline)) throw new Error(`Not a Riot product id: ${req.product}.${req.patchline}`);
    let text: string;
    try {
      text = readFileSync(req.lockfilePath, 'utf8');
    } catch (err) {
      throw new Error('the Riot Client has no lockfile to answer on', { cause: err });
    }
    const lock = parseLockfile(text);
    if (!lock) throw new Error('the lockfile is not in the shape One Launch knows');
    let status: number;
    try {
      ({ status } = await this.requester({
        method: 'POST',
        host: LOCAL_LAUNCH_HOST,
        port: lock.port,
        path: `/product-launcher/v1/products/${req.product}/patchlines/${req.patchline}`,
        headers: { authorization: `Basic ${Buffer.from(`riot:${lock.password}`).toString('base64')}`, accept: 'application/json' },
        timeoutMs: LOCAL_LAUNCH_TIMEOUT_MS,
        signal: req.signal,
      }));
    } catch (err) {
      throw new Error(`the launch request did not reach the Riot Client (${errorLabel(err)})`, { cause: err });
    }
    if (status < 200 || status >= 300) throw new Error(`the Riot Client answered the launch request with HTTP ${status}`);
  }
}
