import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  httpsRequester,
  LOCAL_LAUNCH_HOST,
  LOCAL_LAUNCH_TIMEOUT_MS,
  parseLockfile,
  WindowsRiotLocalLaunch,
  type LocalRequest,
} from '../src/main/launchers/riot/local-launch';

const PASSWORD = 'placeholder-lockfile-password-0123456789';
const LOCKFILE = `Riot Client:4242:51234:${PASSWORD}:https`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A lockfile where the client would keep it; `null` for none. */
function lockfile(text: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'onelaunch-lockfile-'));
  dirs.push(dir);
  const path = join(dir, 'lockfile');
  if (text !== null) writeFileSync(path, text);
  return path;
}

async function failing(call: Promise<unknown>): Promise<Error> {
  let err: unknown = null;
  await call.catch((e: unknown) => {
    err = e;
  });
  if (!(err instanceof Error)) throw new Error('expected a rejection');
  return err;
}

const VALORANT = { product: 'valorant', patchline: 'live' };

describe('Riot lockfile', () => {
  it('reads the port and the password from the client’s own https lockfile, and nothing else passes', () => {
    expect(parseLockfile(LOCKFILE)).toEqual({ port: 51234, password: PASSWORD });
    expect(parseLockfile(`${LOCKFILE}\r\n`)).toEqual({ port: 51234, password: PASSWORD });
    expect(parseLockfile('')).toBeNull();
    expect(parseLockfile('Riot Client:4242:51234:https')).toBeNull();
    expect(parseLockfile(`LeagueClient:4242:51234:${PASSWORD}:https`)).toBeNull();
    expect(parseLockfile(`Riot Client:4242:51234:${PASSWORD}:http`)).toBeNull();
    expect(parseLockfile(`Riot Client:4242:0:${PASSWORD}:https`)).toBeNull();
    expect(parseLockfile(`Riot Client:4242:70000:${PASSWORD}:https`)).toBeNull();
    expect(parseLockfile('Riot Client:4242:51234::https')).toBeNull();
    expect(parseLockfile(`Riot Client:pid:51234:${PASSWORD}:https`)).toBeNull();
  });
});

describe('Riot local launch request', () => {
  const withRequester = (answer: (req: LocalRequest) => Promise<{ status: number }>): { requests: LocalRequest[]; launch: WindowsRiotLocalLaunch } => {
    const requests: LocalRequest[] = [];
    const launch = new WindowsRiotLocalLaunch(async (req) => {
      requests.push(req);
      return answer(req);
    });
    return { requests, launch };
  };

  it('sends the Play button’s request to the loopback address on the lockfile’s port, with the lockfile’s password as basic auth, once', async () => {
    const { requests, launch } = withRequester(async () => ({ status: 200 }));
    await launch.launch({ ...VALORANT, lockfilePath: lockfile(LOCKFILE) });
    expect(requests).toEqual([
      {
        method: 'POST',
        host: '127.0.0.1',
        port: 51234,
        path: '/product-launcher/v1/products/valorant/patchlines/live',
        headers: { authorization: `Basic ${Buffer.from(`riot:${PASSWORD}`).toString('base64')}`, accept: 'application/json' },
        timeoutMs: LOCAL_LAUNCH_TIMEOUT_MS,
        signal: undefined,
      },
    ]);
    expect(LOCAL_LAUNCH_HOST).toBe('127.0.0.1');
    expect(LOCAL_LAUNCH_TIMEOUT_MS).toBe(10_000);
  });

  it('refuses an id that is not a product before reading anything, and a lockfile that is missing or not the client’s', async () => {
    const { requests, launch } = withRequester(async () => ({ status: 200 }));
    expect((await failing(launch.launch({ product: 'valorant/../x', patchline: 'live', lockfilePath: lockfile(null) }))).message).toBe(
      'Not a Riot product id: valorant/../x.live',
    );
    expect((await failing(launch.launch({ product: 'valorant', patchline: 'Live', lockfilePath: lockfile(null) }))).message).toContain('Not a Riot product id');
    expect((await failing(launch.launch({ ...VALORANT, lockfilePath: lockfile(null) }))).message).toBe('the Riot Client has no lockfile to answer on');
    expect((await failing(launch.launch({ ...VALORANT, lockfilePath: lockfile('garbage') }))).message).toBe(
      'the lockfile is not in the shape One Launch knows',
    );
    expect(requests).toEqual([]);
  });

  it('reports a refusal by its status and a failure by its code or name, never the password or the client’s answer', async () => {
    const refused = withRequester(async () => ({ status: 404 }));
    const notFound = await failing(refused.launch.launch({ ...VALORANT, lockfilePath: lockfile(LOCKFILE) }));
    expect(notFound.message).toBe('the Riot Client answered the launch request with HTTP 404');

    const down = withRequester(async () => {
      throw Object.assign(new Error(`connect ECONNREFUSED 127.0.0.1:51234 ${PASSWORD}`), { code: 'ECONNREFUSED' });
    });
    const unreachable = await failing(down.launch.launch({ ...VALORANT, lockfilePath: lockfile(LOCKFILE) }));
    expect(unreachable.message).toBe('the launch request did not reach the Riot Client (ECONNREFUSED)');

    const slow = withRequester(async () => {
      throw new Error('timed out');
    });
    expect((await failing(slow.launch.launch({ ...VALORANT, lockfilePath: lockfile(LOCKFILE) }))).message).toBe(
      'the launch request did not reach the Riot Client (timed out)',
    );
    const aborted = withRequester(async () => {
      throw Object.assign(new Error(`aborted ${PASSWORD}`), { name: 'AbortError' });
    });
    const stopped = await failing(aborted.launch.launch({ ...VALORANT, lockfilePath: lockfile(LOCKFILE) }));
    expect(stopped.message).toBe('the launch request did not reach the Riot Client (AbortError)');
    for (const err of [notFound, unreachable, stopped]) expect(err.message.includes(PASSWORD)).toBe(false);
  });

  it('the https requester refuses a port nobody answers on, over the loopback address alone', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const err = await failing(httpsRequester({ method: 'POST', host: '127.0.0.1', port, path: '/x', headers: {}, timeoutMs: 2_000 }));
    expect((err as NodeJS.ErrnoException).code).toBe('ECONNREFUSED');
  });
});
