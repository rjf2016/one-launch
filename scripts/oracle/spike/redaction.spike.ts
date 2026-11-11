// The recorder's redaction, tested with a planted value before anything is recorded. No app is started.
//   $env:ORACLE_GENERATOR = 'scripts/oracle/spike/redaction.spike.ts'; npx vitest run --config scripts/oracle/vitest.config.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../../src/main/services/logger';

const PLANTED = 'planted-placeholder-canary';
const CONTROL = 'visible-control-value';

const handlers = new Map<string, (event: unknown, req: unknown) => Promise<unknown>>();
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (event: unknown, req: unknown) => Promise<unknown>) => handlers.set(channel, fn) },
}));

const { createRegistrar, ipcTrace } = await import('../../../src/main/ipc/handle');

const log: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => log };
const event = { senderFrame: { url: 'file:///x' } };
const seen: unknown[] = [];
const handle = createRegistrar({ log, isTrustedSender: (e) => e === (event as never) });
const account = { id: 'a', hasSecret: true } as never;
handle('accounts:create', (req) => (seen.push(req), { account }));
handle('accounts:setPassword', (req) => (seen.push(req), { account }));
handle('vault:setSecret', (req) => (seen.push(req), { ok: true }));
handle('vault:getSecret', () => ({ value: PLANTED }));
handle('settings:set', () => ({ ok: true }));
handle('accounts:delete', () => {
  throw new Error('refused');
});

const SECRET_CALLS: [string, string][] = [
  ['accounts:create', 'password'],
  ['accounts:setPassword', 'password'],
  ['vault:setSecret', 'value'],
];

function record(): string[] {
  const lines: string[] = [];
  ipcTrace.record = (channel, req, res) => lines.push(JSON.stringify({ channel, req, res }));
  return lines;
}

afterEach(() => {
  ipcTrace.record = null;
  seen.length = 0;
});

describe('the IPC recorder', () => {
  it('is off until something sets it', async () => {
    expect(ipcTrace.record).toBeNull();
    expect(await handlers.get('settings:set')!(event, { key: 'dryRun', value: 'true' })).toEqual({ ok: true, data: { ok: true } });
  });

  it('never sees a planted password or secret in a request, and the handler still gets it', async () => {
    const lines = record();
    for (const [channel, field] of SECRET_CALLS) {
      await handlers.get(channel)!(event, { id: 'a', key: 'steamgriddb.apiKey', [field]: PLANTED, displayName: CONTROL });
    }
    expect(seen).toHaveLength(3);
    for (const req of seen) expect(JSON.stringify(req)).toContain(PLANTED);
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line).not.toContain(PLANTED);
      expect(line).toContain('<redacted>');
      expect(line).toContain(CONTROL);
    }
  });

  it('masks a secret channel whose payload is not the object it should be', async () => {
    const lines = record();
    for (const [channel] of SECRET_CALLS) {
      for (const req of [PLANTED, [PLANTED], 0, null]) await handlers.get(channel)!(event, req);
    }
    expect(lines).toHaveLength(12);
    for (const line of lines) expect(line).not.toContain(PLANTED);
  });

  it('masks the field even when the request left it out, so the marker says nothing about what was sent', async () => {
    const lines = record();
    await handlers.get('accounts:create')!(event, { displayName: CONTROL, password: null });
    expect(JSON.parse(lines[0]!).req).toEqual({ displayName: CONTROL, password: '<redacted>' });
  });

  it('never sees what vault:getSecret answered, and the caller still does', async () => {
    const lines = record();
    const answer = await handlers.get('vault:getSecret')!(event, { key: 'diagnostics.roundtrip' });
    expect(answer).toEqual({ ok: true, data: { value: PLANTED } });
    expect(lines).toEqual([
      JSON.stringify({ channel: 'vault:getSecret', req: { key: 'diagnostics.roundtrip' }, res: { ok: true, data: { value: '<redacted>' } } }),
    ]);
  });

  it('records every other call as it was, the error envelope and the untrusted-sender refusal included', async () => {
    const lines = record();
    await handlers.get('settings:set')!(event, { key: 'dryRun', value: CONTROL });
    await handlers.get('accounts:delete')!(event, { id: 'a' });
    await handlers.get('accounts:setPassword')!({ senderFrame: { url: 'https://elsewhere.example' } }, { id: 'a', password: PLANTED });
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { channel: 'settings:set', req: { key: 'dryRun', value: CONTROL }, res: { ok: true, data: { ok: true } } },
      { channel: 'accounts:delete', req: { id: 'a' }, res: { ok: false, error: { code: 'INTERNAL', message: 'refused' } } },
      {
        channel: 'accounts:setPassword',
        req: { id: 'a', password: '<redacted>' },
        res: { ok: false, error: { code: 'UNTRUSTED_SENDER', message: 'Request rejected' } },
      },
    ]);
    expect(seen).toHaveLength(0);
  });
});
