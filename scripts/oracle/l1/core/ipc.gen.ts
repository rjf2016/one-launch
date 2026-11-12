import { vectorFile } from '../lib/index';
import { expect, test, vi } from 'vitest';
import { channelMatrix, liftedBusyInstall, type Context, type MatrixCase } from './ipc/cases';
import { SCHEMA } from './ipc/schema';
import { IPC_CHANNELS as LISTED } from './ipc/channels.mjs';

const state = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, req: unknown) => Promise<unknown>>(),
  reached: [] as string[],
  trusted: true,
  busy: false,
}));

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-oracle', isPackaged: false },
  shell: {
    openPath: async () => {
      state.reached.push('shell.openPath');
      return '';
    },
    openExternal: async () => {
      state.reached.push('shell.openExternal');
    },
  },
  ipcMain: { handle: (channel: string, fn: (event: unknown, req: unknown) => Promise<unknown>) => state.handlers.set(channel, fn) },
}));

const { IPC_CHANNELS } = await import('../../../../src/shared/ipc-contract');
const { registerIpcHandlers } = await import('../../../../src/main/ipc/index');
type Deps = Parameters<typeof registerIpcHandlers>[0];

const service = (name: string): unknown =>
  new Proxy(
    {},
    {
      get: (_target, method) => (): unknown => {
        const call = `${name}.${String(method)}`;
        if (call === 'launch.isBusy') return state.busy;
        state.reached.push(call);
        return undefined;
      },
    },
  );

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => silent };
const reach = (name: string) => async (): Promise<null> => {
  state.reached.push(name);
  return null;
};

registerIpcHandlers({
  log: silent,
  paths: service('paths'),
  vault: service('vault'),
  vaultHealth: service('vaultHealth'),
  secrets: service('secrets'),
  settings: service('settings'),
  accounts: service('accounts'),
  clipboard: service('clipboard'),
  library: service('library'),
  launchers: service('launchers'),
  backups: service('backups'),
  launch: service('launch'),
  recovery: service('recovery'),
  artwork: service('artwork'),
  updates: service('updates'),
  loginItem: service('loginItem'),
  rescan: reach('rescan'),
  pickImage: reach('pickImage'),
  pickLauncherExe: reach('pickLauncherExe'),
  getStartupMetrics: () => {
    state.reached.push('getStartupMetrics');
    return { processToNodeMs: null, windowShownMs: null, readyToShowMs: null, didFinishLoadMs: null };
  },
  isTrustedSender: () => state.trusted,
} as unknown as Deps);

const channels = [...IPC_CHANNELS] as string[];
if (JSON.stringify(LISTED) !== JSON.stringify(channels)) throw new Error('ipc/channels.mjs (read by targets.ui.mjs) is not the IPC_CHANNELS of the contract');
const missing = channels.filter((channel) => !SCHEMA[channel]);
const extra = Object.keys(SCHEMA).filter((channel) => !channels.includes(channel));
if (missing.length > 0 || extra.length > 0)
  throw new Error(`the IPC schema and the contract differ: missing ${missing.join(', ') || 'none'}, extra ${extra.join(', ') || 'none'}`);
const unregistered = channels.filter((channel) => !state.handlers.has(channel));
if (unregistered.length > 0 || state.handlers.size !== channels.length)
  throw new Error(`registerIpcHandlers did not register exactly the contract: ${unregistered.join(', ')}`);

async function invoke(channel: string, payload: unknown, context: Context): Promise<{ envelope: unknown; reached: string[] }> {
  state.reached = [];
  state.trusted = context.trusted;
  state.busy = context.busy;
  const envelope = await state.handlers.get(channel)!({ senderFrame: { url: context.trusted ? 'file:///x' : 'https://example.com/' } }, payload);
  return { envelope, reached: state.reached };
}

async function call(channel: string, payload: unknown, context: Context): Promise<unknown> {
  const { envelope, reached } = await invoke(channel, payload, context);
  if (reached.length > 0) throw new Error(`${channel} reached ${reached.join(', ')}: the payload passed validation and is not a bad payload`);
  return envelope;
}

const matrices = new Map<string, { cases: MatrixCase[]; leftOut: string[] }>();
for (const channel of channels) {
  const matrix = channelMatrix(channel, SCHEMA[channel]!);
  if (channel === 'updates:install') matrix.cases.push(liftedBusyInstall());
  if (matrix.cases.length === 0) throw new Error(`${channel} has no case`);
  matrices.set(channel, matrix);
}

const NOTE = [
  'arg0 is the channel, arg1 the payload, arg2 the context { trusted, busy }.',
  'call reaches the real handler: electron is mocked (ipcMain.handle collects the handlers) and registerIpcHandlers from src/main/ipc/index.ts is run once, as test/ipc-validation.test.ts does, with every service a recording proxy that answers undefined, paths a proxy, rescan and the pickers recording stubs, and the logger a silent stub. Per case: isTrustedSender returns context.trusted, launch.isBusy returns context.busy (the only service a refused payload may reach), and the handler is invoked with the event { senderFrame: { url } } and arg1 as the request. A "__proto__" key in a payload is an own data key, as a structured clone over IPC delivers it. out is the envelope the handler layer returns, { ok: false, error: { code, message } }; the messages are exact.',
  'Every case is refused before any service, shell call, picker or rescan is reached: call throws if one is, so a payload that passes validation can never be recorded here.',
  'The matrix stops at validation: what a handler does once a payload passes (its service calls, the ?? defaults after a nullable field, the OPEN_FAILED, NO_PASSWORD, NOT_FOUND, NOT_A_LAUNCHER and UNAVAILABLE refusals) is hand-translated with the services, not recorded here.',
  "The generated family comes from a transcription of the handler's validators (scripts/oracle/l1/core/ipc/schema.ts and model.ts), checked by the generator against the real handlers on every case; cases from test/ipc-validation.test.ts are its REFUSED table, copied as written.",
];

const GAPS: Record<string, string[]> = {
  'settings:set': [
    'gap: src/main/ipc/index.ts:198:7 if never false, only a valid logLevel makes the check false, and that payload is stored',
    'gap: src/main/ipc/index.ts:219:5 if never false, only a valid backups.keep makes the check false, and that payload is stored',
  ],
  'accounts:update': ['gap: src/main/ipc/index.ts:276:30 if arm, a notes string that passes is the last field, so the patch would be applied'],
  'launch:recent': [
    'gap: src/main/ipc/index.ts:515:46 && right side, src/main/ipc/index.ts:515:71 && right side, src/main/ipc/index.ts:515:81 ?: true arm, limit is clamped, never refused, so every object payload reaches launch.recentLaunches',
  ],
};

for (const channel of channels) {
  const { cases, leftOut } = matrices.get(channel)!;
  const schema = SCHEMA[channel]!;
  const lines = [...NOTE, ...(GAPS[channel] ?? [])];
  if (schema.fields === null)
    lines.push(`${channel} reads no payload: any payload runs the handler, so its matrix is the sender check${schema.busy ? ' and the busy check' : ''} only.`);
  if (leftOut.length > 0)
    lines.push(`Left out, because the handler accepts them and no later field can be made bad, so they would reach the handler's work: ${leftOut.join('; ')}.`);
  vectorFile({
    area: 'core',
    function: 'registerIpcHandlers',
    source: 'src/main/ipc/index.ts',
    name: `ipc.${channel.replace(':', '-')}`,
    note: lines.join('\n'),
    call,
    cases: cases.map(({ predicted: _predicted, ...rest }) => rest),
  });
}

test('the transcribed validators agree with the real handlers', async () => {
  for (const channel of channels) {
    for (const item of matrices.get(channel)!.cases) {
      const [, payload, context] = item.args as [string, unknown, Context];
      const { envelope, reached } = await invoke(channel, payload, context);
      expect(reached, `${channel}/${item.id}`).toEqual([]);
      expect(envelope, `${channel}/${item.id}`).toEqual({ ok: false, error: item.predicted });
    }
  }
});
