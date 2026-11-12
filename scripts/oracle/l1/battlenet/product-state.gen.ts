import { adversarial, bundleBytes, fixture, vectorFile, type Case, type Origin } from '../lib/index';
import { parseLogEvents, type LogEvent } from '../../../../src/main/launchers/battlenet/client-log';
import { gameRunning, gameStarted, productNeedsUpdate, productStates } from '../../../../src/main/launchers/battlenet/product-state';
import { testOrigin, D_STATE, LOG_0913, LOG_0919, LOG_0924, LOGS, STATE_TEST } from './shared';

const SOURCE = 'src/main/launchers/battlenet/product-state.ts';
const S = testOrigin(STATE_TEST, D_STATE);
const READS = 'reads each product install state and the --exec game start sequence (client 2.52.12, 2026-09-19)';
const REFRESHED = 'takes the refreshed state over the cached one, and sees no start when the client only selects the page (2026-09-24)';
const OLDER = 'still accepts the launch request line older builds logged, matched on the program code';
const REGIONAL = 'ignores the regional playable flags and a game exit';
const RUNNING = 'knows a game is running from the last start or exit the client logged for it, whoever started it (2026-10-10)';

const eventsOf = (path: string): LogEvent[] => parseLogEvents(bundleBytes(path).toString('utf8'));
const parsed = (lines: string[]): LogEvent[] => parseLogEvents(lines.join('\n'));
const logId = (path: string): string => `fixture-log-${/-(\d{8})T/.exec(path)![1]}`;
const EVENTS_NOTE =
  'arg0 is the event list parseLogEvents returns, in memory; fixture and test cases are parseLogEvents of the fixture or literal, computed by the generator.';

const LAUNCH_REQUEST = parsed(['I 2026-09-13 03:22:00.000000 [GameLaunchController] {Main} Launch request Pro. isRunning=0 isLaunching=0 supportsMultibox=0']);
const WOW = parsed([
  'D 2026-09-24 22:07:03.000000 [ProductState] {Main} InstallState (wow): currentOperation=Repair currentOperationStatus=On installed=1 playable=0 regionalVersions=(us: {playable:true config_key:abc})',
  'D 2026-09-24 22:07:04.000000 [InstallInfo] {Main} Operation status changed: opType=Execute oldStatus=On newStatus=Off agentUid=wow',
]);
const RUNNING_EVENTS = parsed([
  'D 2026-10-10 23:44:19.513560 [InstallInfo] {Main} Operation status changed: opType=Execute oldStatus=Off newStatus=On agentUid=prometheus',
  'D 2026-10-10 23:44:19.514172 [ProductState] {Main} InstallState (prometheus): gameRunning=1 isGameProcessRunning=1',
]);
const EXITED = parsed([
  'D 2026-10-10 23:44:19.514172 [ProductState] {Main} InstallState (prometheus): gameRunning=1 isGameProcessRunning=1',
  'D 2026-10-10 23:44:22.613138 [InstallInfo] {Main} Operation status changed: opType=Execute oldStatus=On newStatus=Off agentUid=prometheus',
  'D 2026-10-10 23:44:22.615643 [ProductState] {Main} InstallState (prometheus): gameRunning=0 isGameProcessRunning=0',
]);
const LAUNCHING = parsed(['D 2026-10-10 23:43:29.436396 [ProductState] {Main} InstallState (prometheus): GameLaunching=1']);

const state = (codename: string, operation: string | null, status: string | null = null, playable: boolean | null = null): LogEvent => ({
  kind: 'product-state',
  codename,
  operation,
  status,
  playable,
});

vectorFile({
  area: 'battlenet',
  function: 'productStates',
  source: SOURCE,
  note: [
    EVENTS_NOTE,
    'call projects the returned Map to its entries in insertion order ([...map]); the Rust test must compare the same list of [codename, state] pairs.',
  ].join('\n'),
  call: (events: LogEvent[]) => [...productStates(events)],
  cases: [
    ...LOGS.map((path) => ({
      id: logId(path),
      origin: path === LOG_0919 ? S(READS) : path === LOG_0924 ? S(REFRESHED) : fixture(path, 'parsed by parseLogEvents'),
      args: [eventsOf(path)],
      expect: 'out' as const,
    })),
    { id: 'test-regional-playable', origin: S(REGIONAL), args: [WOW], expect: 'out' },
    { id: 'test-running', origin: S(RUNNING), args: [RUNNING_EVENTS], expect: 'out' },
    { id: 'empty', origin: S(RUNNING, 'no events'), args: [[]], expect: 'out' },
    {
      id: 'last-wins-insertion-order-kept',
      origin: fixture(LOG_0924, 'b, a, then b again: b keeps its first place in the map and takes its last state'),
      args: [[state('b', 'Update', 'New'), state('a', 'UpToDate'), { kind: 'exit' }, state('b', 'UpToDate', 'Paused', true)]],
      expect: 'out',
    },
    {
      id: 'case-distinct',
      origin: fixture(LOG_0924, 'codenames differing only in case are two products'),
      args: [[state('wow', 'Update'), state('WOW', 'UpToDate')]],
      expect: 'out',
    },
    {
      id: 'proto-codename',
      origin: adversarial('other', 'the codename __proto__ is an ordinary Map key'),
      args: [[state('__proto__', 'Update', 'New')]],
      expect: 'out',
    },
    {
      id: 'no-product-events',
      origin: fixture(LOG_0913, 'only game and sign-in events'),
      args: [[{ kind: 'game-running', codename: 'wow' }, { kind: 'signed-out' }]],
      expect: 'out',
    },
  ],
});

vectorFile({
  area: 'battlenet',
  function: 'productNeedsUpdate',
  source: SOURCE,
  note: 'arg0 is one ProductState from productStates, or undefined when the product has none; in memory.',
  call: productNeedsUpdate,
  cases: [
    { id: 'up-to-date', origin: S(READS, 'prometheus'), args: [{ operation: 'UpToDate', status: 'Paused', playable: true }], expect: 'out' },
    { id: 'update', origin: S(READS, 'hs_beta'), args: [{ operation: 'Update', status: 'New', playable: null }], expect: 'out' },
    { id: 'undefined', origin: S(READS, 'no state'), args: [undefined], expect: 'out' },
    { id: 'repair', origin: S(REGIONAL), args: [{ operation: 'Repair', status: 'On', playable: false }], expect: 'out' },
    { id: 'null-operation', origin: S(READS, 'operation null'), args: [{ operation: null, status: null, playable: null }], expect: 'out' },
    { id: 'upper-case', origin: S(READS, 'UPDATE in upper case'), args: [{ operation: 'UPDATE', status: null, playable: null }], expect: 'out' },
    { id: 'updating', origin: S(READS, 'a longer word'), args: [{ operation: 'Updating', status: null, playable: null }], expect: 'out' },
    {
      id: 'dotted-i',
      origin: adversarial('case-mapping', 'a trailing dotted capital I lower-cases to i + U+0307, two units, so the word is no longer update'),
      args: [{ operation: 'UPDATE\u0130', status: null, playable: null }],
      expect: 'out',
    },
    {
      id: 'fullwidth-u',
      origin: adversarial('case-mapping', 'a fullwidth \uFF35 does not lower-case to an ASCII u'),
      args: [{ operation: '\uFF35pdate', status: null, playable: null }],
      expect: 'out',
    },
  ],
});

const startCases = (): Case[] => [
  { id: 'fixture-0919-prometheus', origin: S(READS), args: [eventsOf(LOG_0919), 'prometheus', 'Pro'], expect: 'out' },
  { id: 'fixture-0919-hs-beta', origin: S(READS), args: [eventsOf(LOG_0919), 'hs_beta', 'WTCG'], expect: 'out' },
  { id: 'fixture-0924-prometheus', origin: S(REFRESHED), args: [eventsOf(LOG_0924), 'prometheus', 'Pro'], expect: 'out' },
  { id: 'fixture-0913-prometheus', origin: fixture(LOG_0913, 'parsed by parseLogEvents'), args: [eventsOf(LOG_0913), 'prometheus', 'Pro'], expect: 'out' },
  { id: 'test-launch-request', origin: S(OLDER), args: [LAUNCH_REQUEST, 'prometheus', 'Pro'], expect: 'out' },
  { id: 'test-launch-request-other', origin: S(OLDER), args: [LAUNCH_REQUEST, 'hs_beta', 'WTCG'], expect: 'out' },
  { id: 'test-regional', origin: S(REGIONAL), args: [WOW, 'wow', 'WoW'], expect: 'out' },
  { id: 'test-running', origin: S(RUNNING), args: [RUNNING_EVENTS, 'prometheus', 'Pro'], expect: 'out' },
  { id: 'empty', origin: S(RUNNING, 'no events'), args: [[], 'prometheus', 'Pro'], expect: 'out' },
  { id: 'launching-case-insensitive', origin: S(RUNNING, 'codename in another case'), args: [LAUNCHING, 'PROMETHEUS', 'x'], expect: 'out' },
  { id: 'request-case-insensitive', origin: S(OLDER, 'program code in another case'), args: [LAUNCH_REQUEST, 'x', 'pRO'], expect: 'out' },
  { id: 'exited-only', origin: S(REGIONAL, 'an exit is no start'), args: [[{ kind: 'game-exited', codename: 'wow' }], 'wow', 'WoW'], expect: 'out' },
  {
    id: 'case-kelvin',
    origin: adversarial('case-mapping', 'a codename with the Kelvin sign lower-cases to an ASCII k and matches'),
    args: [[{ kind: 'game-running', codename: 'kr' }], '\u212Ar', 'x'],
    expect: 'out',
  },
  {
    id: 'case-dotted-i',
    origin: adversarial('case-mapping', '\u0130 lower-cases to i + U+0307, so it does not match a plain i'),
    args: [[{ kind: 'game-launching', codename: 'i' }], '\u0130', 'x'],
    expect: 'out',
  },
];

vectorFile({
  area: 'battlenet',
  function: 'gameStarted',
  source: SOURCE,
  note: [EVENTS_NOTE, 'arg1 is the product codename and arg2 its program code, in memory.'].join('\n'),
  call: gameStarted,
  cases: startCases,
});

vectorFile({
  area: 'battlenet',
  function: 'gameRunning',
  source: SOURCE,
  note: [
    EVENTS_NOTE,
    'arg1 is the product codename, in memory. call drops the program code the shared cases carry: gameRunning takes (events, codename).',
  ].join('\n'),
  call: (events: LogEvent[], codename: string) => gameRunning(events, codename),
  cases: () => [
    ...startCases(),
    { id: 'test-exited', origin: S(RUNNING), args: [EXITED, 'prometheus', 'Pro'], expect: 'out' },
    { id: 'test-running-other-case', origin: S(RUNNING), args: [RUNNING_EVENTS, 'Prometheus', 'Pro'], expect: 'out' },
    { id: 'test-running-hs', origin: S(RUNNING), args: [RUNNING_EVENTS, 'hs_beta', 'WTCG'], expect: 'out' },
    {
      id: 'restart-after-exit',
      origin: S(RUNNING, 'exit, then a new start'),
      args: [
        [
          { kind: 'game-running', codename: 'wow' },
          { kind: 'game-exited', codename: 'wow' },
          { kind: 'game-launching', codename: 'WOW' },
        ],
        'wow',
        'WoW',
      ],
      expect: 'out',
    },
    {
      id: 'other-product-exit',
      origin: S(RUNNING, 'another product exits'),
      args: [
        [
          { kind: 'game-running', codename: 'wow' },
          { kind: 'game-exited', codename: 'prometheus' },
        ],
        'wow',
        'WoW',
      ],
      expect: 'out',
    },
  ],
});
