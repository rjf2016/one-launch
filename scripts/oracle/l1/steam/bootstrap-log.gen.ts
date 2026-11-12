import { adversarial, bytes, corpus, fixture, fromTest, input, text, vectorFile, type Case } from '../lib/index';
import { updateInProgress, updatingSince } from '../../../../src/main/launchers/steam/bootstrap-log';
import { withFile } from './support';

const SOURCE = 'src/main/launchers/steam/bootstrap-log.ts';
const TESTS = 'test/steam-bootstrap-log.test.ts';
const PARSING = 'bootstrap_log.txt parsing';
const APPENDS = 'reading only what the updater appends';

const stamp = (line: string): string => `[2026-09-11 12:56:02] ${line}`;
const PLAIN_START = [
  'Startup - updater built Sep  2 2026 18:32:43',
  'Startup - Steam Client launched with: d:\\games\\steam\\steam.exe',
  'Verifying installation...',
  'Verifying file sizes only',
  'Verification complete',
].map(stamp);
const UPDATE = [
  'Startup - updater built Sep  2 2026 18:32:43',
  'Checking for update on startup',
  'Checking for available updates...',
  'Downloaded new manifest: /steam_client_win64 version 1788652215, installed version 1785799196, existing pending version 0',
  'Downloading update (12,842 of 212,314 KB)...',
  'Download complete.',
  'Found pending update',
  'Installing update...',
  'Extracting package...',
  'Installing update...',
].map(stamp);
const RELAUNCH = ['Update complete, launching Steam...', 'Shutdown', 'Startup - updater built Sep  2 2026 18:32:43', 'Verifying installation...'].map(stamp);
const CHECKED = [
  ...PLAIN_START,
  stamp('Background update loop checking for update. . .'),
  stamp('Download skipped: /steam_client_win64 version 1788652215, installed version 1788652215, existing pending version 0'),
  stamp('Nothing to do'),
];
const BACKGROUND = [
  ...PLAIN_START,
  stamp('Background update loop checking for update. . .'),
  stamp('Downloaded new manifest: /steam_client_win64 version 1779486452, installed version 1778281814, existing pending version 0'),
  stamp('Downloading update (141 of 269 KB)...'),
  stamp('Download complete.'),
];
const NEXT_START = [
  ...BACKGROUND,
  stamp('Shutdown'),
  stamp('Startup - updater built May  8 2026 15:40:38'),
  stamp('Download complete.'),
  stamp('Found pending update'),
];

const T_PLAIN = 'sees no update in a plain start, or when the client only checked and found nothing';
const T_BACKGROUND = 'ignores the download a running client makes in the background, and counts the install at the next start';
const T_UPDATE = 'reports an update from its first line until the relaunched client has verified itself';
const UPDATE_LINES = [
  'Downloaded new manifest',
  'Downloading update',
  'Found pending update',
  'Installing update',
  'Extracting package',
  'Update complete, launching Steam',
];

const lines = (list: string[]): Buffer => Buffer.from(`${list.join('\r\n')}\r\n`);
const BASES = [
  { name: 'update.txt', bytes: lines([...UPDATE, ...RELAUNCH]) },
  { name: 'verified.txt', bytes: lines([...UPDATE, ...RELAUNCH, stamp('Verification complete')]) },
  { name: 'next-start.txt', bytes: lines(NEXT_START) },
];

const progressCases = (): Case[] => [
  { id: 'empty', origin: fromTest(TESTS, PARSING, T_PLAIN), args: [text('')], expect: 'out' },
  { id: 'plain-start', origin: fromTest(TESTS, PARSING, T_PLAIN), args: [text(PLAIN_START.join('\r\n'))], expect: 'out' },
  { id: 'checked-nothing', origin: fromTest(TESTS, PARSING, T_PLAIN), args: [text(CHECKED.join('\n'))], expect: 'out' },
  { id: 'background-download', origin: fromTest(TESTS, PARSING, T_BACKGROUND), args: [text(BACKGROUND.join('\r\n'))], expect: 'out' },
  { id: 'next-start-install', origin: fromTest(TESTS, PARSING, T_BACKGROUND), args: [text(NEXT_START.join('\r\n'))], expect: 'out' },
  {
    id: 'next-start-verified',
    origin: fromTest(TESTS, PARSING, T_BACKGROUND),
    args: [text([...NEXT_START, stamp('Installing update...'), ...RELAUNCH, stamp('Verification complete')].join('\r\n'))],
    expect: 'out',
  },
  { id: 'update-first-lines', origin: fromTest(TESTS, PARSING, T_UPDATE), args: [text(UPDATE.slice(0, 4).join('\r\n'))], expect: 'out' },
  { id: 'update-all', origin: fromTest(TESTS, PARSING, T_UPDATE), args: [text(UPDATE.join('\r\n'))], expect: 'out' },
  { id: 'update-relaunch', origin: fromTest(TESTS, PARSING, T_UPDATE), args: [text([...UPDATE, ...RELAUNCH].join('\r\n'))], expect: 'out' },
  {
    id: 'update-verified',
    origin: fromTest(TESTS, PARSING, T_UPDATE),
    args: [text([...UPDATE, ...RELAUNCH, stamp('Verification complete')].join('\r\n'))],
    expect: 'out',
  },
  ...UPDATE_LINES.map((line) => ({
    id: `update-line-${line.toLowerCase().replace(/[^a-z]+/g, '-')}`,
    origin: adversarial('other', `the update line "${line}" alone starts an update`),
    args: [text(stamp(line))],
    expect: 'out' as const,
  })),
  {
    id: 'download-complete-alone',
    origin: adversarial('other', '"Download complete." is not an update line'),
    args: [text(stamp('Download complete.'))],
    expect: 'out',
  },
  {
    id: 'background-without-startup',
    origin: adversarial('other', 'a background loop line with no startup before it marks the rest as background'),
    args: [text([stamp('Background update loop checking'), stamp('Downloading update (1 of 2 KB)...')].join('\n'))],
    expect: 'out',
  },
  {
    id: 'startup-clears-background',
    origin: adversarial('other', 'a startup line ends the background run, so a later update line counts'),
    args: [text([stamp('Background update loop checking'), stamp('Startup - updater built x'), stamp('Installing update...')].join('\n'))],
    expect: 'out',
  },
  {
    id: 'verification-in-background',
    origin: adversarial('other', 'Verification complete settles an update even inside a background run'),
    args: [text([stamp('Installing update...'), stamp('Background update loop checking'), stamp('Verification complete')].join('\n'))],
    expect: 'out',
  },
  {
    id: 'update-before-background',
    origin: adversarial('other', 'an update already started stays started when a background loop line follows'),
    args: [text([stamp('Installing update...'), stamp('Background update loop checking'), stamp('Downloading update')].join('\n'))],
    expect: 'out',
  },
  {
    id: 'line-order-startup-first',
    origin: adversarial('other', 'one line holding both a startup tag and Verification complete is a startup line only'),
    args: [text([stamp('Installing update...'), stamp('Startup - updater built x Verification complete')].join('\n'))],
    expect: 'out',
  },
  {
    id: 'line-order-background-first',
    origin: adversarial('other', 'one line holding a background tag and an update tag is a background line only'),
    args: [text(stamp('Background update loop: Downloading update'))],
    expect: 'out',
  },
  {
    id: 'line-order-settled-first',
    origin: adversarial('other', 'one line holding Verification complete and an update tag settles'),
    args: [text([stamp('Installing update...'), stamp('Verification complete, Installing update')].join('\n'))],
    expect: 'out',
  },
  { id: 'case-sensitive', origin: adversarial('case-mapping', 'the tags are case-sensitive'), args: [text(stamp('installing UPDATE...'))], expect: 'out' },
  { id: 'glued-text', origin: adversarial('word-boundary', 'the tags are unanchored and have no \\b'), args: [text('xxInstalling updatexx')], expect: 'out' },
  {
    id: 'lone-cr-lines',
    origin: adversarial('regex', 'a lone CR does not split lines, so a CR-separated log is one line and the first matching branch decides'),
    args: [text([stamp('Installing update...'), stamp('Verification complete')].join('\r'))],
    expect: 'out',
  },
  {
    id: 'line-separator',
    origin: adversarial('regex', 'U+2028 does not split lines either'),
    args: [text([stamp('Installing update...'), stamp('Verification complete')].join('\u2028'))],
    expect: 'out',
  },
  {
    id: 'nbsp-in-tag',
    origin: adversarial('unicode-space', 'an NBSP in place of the space of a tag does not match'),
    args: [text(stamp('Installing\u00a0update...'))],
    expect: 'out',
  },
  {
    id: 'invalid-utf8',
    origin: adversarial('utf8-decode', 'invalid bytes around a tag do not stop it matching'),
    args: [bytes(Buffer.from('\xffInstalling update\xc0\n', 'latin1'))],
    expect: 'out',
  },
  ...BASES.map((base) => ({
    id: `fixture-${base.name.replace('.txt', '')}-file`,
    origin: fixture(`l1/steam/files/updateInProgress/${base.name}`),
    args: [input('steam', `updateInProgress/${base.name}`, base.bytes)],
    expect: 'out' as const,
  })),
  ...corpus({
    seed: 71,
    count: 60,
    from: BASES.map((base) => ({ path: `l1/steam/files/updateInProgress/${base.name}`, bytes: base.bytes })),
    ops: ['line-duplicate', 'line-delete', 'line-swap', 'eol', 'flip', 'delete', 'insert'],
    args: (mutated) => [mutated],
  }),
];

vectorFile({
  area: 'steam',
  function: 'updateInProgress',
  source: SOURCE,
  decode: { 0: 'utf8' },
  note: [
    'arg0 is bootstrap_log.txt text as updatingSince reads it: readLoginLogSince → readTail/readRange (src/main/launchers/log-read.ts), toString(utf8), BOM kept.',
    'Lines are split on /\\r?\\n/ and each is tested against the startup, background, settled and update patterns in that order; the first that matches decides.',
    'No cap of its own; the 512 KiB tail is the caller’s (updatingSince).',
    'Corpus bases: the test UPDATE and RELAUNCH lines, the same closed by Verification complete, and the background download then next start, as l1/steam/files/updateInProgress/*.txt.',
  ].join('\n'),
  call: updateInProgress,
  cases: progressCases,
});

const LOG = 'bootstrap_log.txt';
const log = (content: string | undefined): { file?: Buffer } => (content === undefined ? {} : { file: Buffer.from(content) });

vectorFile({
  area: 'steam',
  function: 'updatingSince',
  source: SOURCE,
  note: [
    `arg0 stands for the log file: { file: <bytes> } when <SteamPath>\\logs\\${LOG} exists, {} when it does not. call writes the bytes to ${LOG} in a fresh temporary folder, passes that path, and removes the folder; the path never reaches the result.`,
    'arg1 is the mark. The function is updateInProgress(readLoginLogSince(path, mark)): at most the last 512 KiB since the mark, from the start if the log shrank, toString(utf8). The tail cap is covered by outcomeSince’s cap-tail-* on the same reader.',
  ].join('\n'),
  call: (arg: { file?: Buffer }, mark: number) => withFile(LOG, arg.file, (path) => updatingSince(path, mark)),
  cases: () => {
    const update = `${UPDATE.join('\r\n')}\r\n`;
    const more = `${stamp('Downloading update (1 of 2 KB)...')}\r\n`;
    const T = 'ignores an update from before the mark and copes with a missing file';
    return [
      { id: 'missing', origin: fromTest(TESTS, APPENDS, T), args: [log(undefined), 0], expect: 'out' },
      { id: 'from-start', origin: fromTest(TESTS, APPENDS, T), args: [log(update), 0], expect: 'out' },
      { id: 'from-mark', origin: fromTest(TESTS, APPENDS, T), args: [log(update), Buffer.byteLength(update)], expect: 'out' },
      { id: 'appended-after-mark', origin: fromTest(TESTS, APPENDS, T), args: [log(`${update}${more}`), Buffer.byteLength(update)], expect: 'out' },
      { id: 'rotated', origin: adversarial('other', 'a log smaller than the mark is read from its start'), args: [log(more), 10_000], expect: 'out' },
      {
        id: 'mark-mid-line',
        origin: adversarial('other', 'a mark inside an update line still sees the rest of the tag'),
        args: [log(stamp('Installing update...')), 22],
        expect: 'out',
      },
      {
        id: 'mark-cuts-tag',
        origin: adversarial('other', 'a mark that cuts into the tag hides it'),
        args: [log(stamp('Installing update...')), 25],
        expect: 'out',
      },
    ];
  },
});
