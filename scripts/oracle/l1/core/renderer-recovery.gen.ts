import { adversarial, fromTest, vectorFile, type Case } from '../lib/index';
import { recoveryCopy } from '../../../../src/renderer/src/lib/recovery';

const TESTS = 'test/recovery-copy.test.ts';
const DESCRIBE = 'recoveryCopy';
const PHASES = ['writing', 'signing-in', 'rollback-failed'] as const;

const rc = (id: string, origin: Case['origin'], phase: string, accountName: string | null, snapshotAvailable: boolean, launcher: string): Case => ({
  id,
  origin,
  args: [{ phase, accountName, snapshotAvailable }, launcher],
  expect: 'out',
});

const grid: Case[] = PHASES.flatMap((phase) =>
  [true, false].flatMap((snapshot) =>
    [
      ['named', 'Alt'],
      ['deleted', null],
    ].map(([tag, name]) =>
      rc(
        `${phase}-${snapshot ? 'snapshot' : 'no-snapshot'}-${tag}`,
        adversarial('other', `recoveryCopy for phase ${phase}, snapshot ${snapshot ? 'kept' : 'gone'}, account ${name === null ? 'deleted' : 'named'}`),
        phase,
        name,
        snapshot,
        'Steam',
      ),
    ),
  ),
);

vectorFile({
  area: 'core',
  function: 'recoveryCopy',
  source: 'src/renderer/src/lib/recovery.ts',
  name: 'renderer.recovery.recoveryCopy',
  note: [
    "arg0 is the SwitchRecovery's phase, accountName and snapshotAvailable, the only fields recoveryCopy reads; arg1 the launcher's display name. out is { title, body, recommend }, the prompt's exact words.",
    'A phase outside SwitchRecoveryPhase with the snapshot kept falls out of the switch and returns undefined.',
  ].join('\n'),
  call: recoveryCopy,
  cases: [
    rc(
      'test-writing',
      fromTest(TESTS, DESCRIBE, 'leads with Restore when the files may be half-written or a rollback failed'),
      'writing',
      'Alt',
      true,
      'Steam',
    ),
    rc(
      'test-rollback-failed',
      fromTest(TESTS, DESCRIBE, 'leads with Restore when the files may be half-written or a rollback failed'),
      'rollback-failed',
      'Alt',
      true,
      'Steam',
    ),
    rc(
      'test-signing-in',
      fromTest(TESTS, DESCRIBE, 'leads with Keep as is when the files were written and the launcher was already signing in'),
      'signing-in',
      'Alt',
      true,
      'Battle.net',
    ),
    rc(
      'test-no-snapshot-deleted-account',
      fromTest(TESTS, DESCRIBE, 'offers no restore when the snapshot is gone, and copes with a deleted account'),
      'writing',
      null,
      false,
      'Epic Games Launcher',
    ),
    ...grid,
    rc('empty-account-name', adversarial('other', 'an empty account name is not null: ?? keeps it, and the sentence has a gap'), 'writing', '', true, 'Steam'),
    rc('riot-client', adversarial('other', 'a launcher name that reads mid-sentence starts no sentence here'), 'signing-in', 'Alt', true, 'the Riot Client'),
    rc('unknown-phase-snapshot', adversarial('other', 'a phase outside the type with the snapshot kept: undefined'), 'finished', 'Alt', true, 'Steam'),
    rc(
      'unknown-phase-no-snapshot',
      adversarial('other', 'a phase outside the type with the snapshot gone: the no-snapshot copy, with the writing title'),
      'finished',
      'Alt',
      false,
      'Steam',
    ),
    rc('astral-name', adversarial('utf16-length', 'an account name with an astral character'), 'writing', 'Alt \u{1F3AE}', true, 'Steam'),
  ],
});
