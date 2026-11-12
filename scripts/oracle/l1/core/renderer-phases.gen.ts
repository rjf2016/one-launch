import { adversarial, fromTest, vectorFile, type Case } from '../lib/index';
import { groupSteps, jobAnnouncement, phaseLabel, phaseOf, planPhases, sentence, stoppedNote } from '../../../../src/renderer/src/lib/phases';

const SOURCE = 'src/renderer/src/lib/phases.ts';
const TESTS = 'test/phases.test.ts';
const LONE = '\uD800';

type Status = 'pending' | 'running' | 'done' | 'skipped' | 'failed';
const step = (id: string, status: Status, title = id) => ({ id, status, title, detail: '' });
const names = { launcher: 'Steam', account: 'Alt', game: 'Dota 2' };
const account = { id: 'a', displayName: 'Alt', login: 'alt' };
const game = { id: 'g', name: 'Dota 2', launcherGameId: '570' };
const t = (...titles: string[]) => fromTest(TESTS, ...titles);

const STEP_IDS = [
  'close',
  'capture',
  'backup',
  'file',
  'registry',
  'registry-user',
  'registry-remember',
  'start',
  'wait',
  'verify',
  'login',
  'manual',
  'recapture',
  'launch',
];

const projectPhaseOf = (stepId: string): unknown => {
  const phase: unknown = phaseOf(stepId);
  if (typeof phase === 'string') return phase;
  return { notAString: typeof phase, name: typeof phase === 'function' ? phase.name : null };
};

vectorFile({
  area: 'core',
  function: 'phaseOf',
  source: SOURCE,
  name: 'renderer.phases.phaseOf',
  note: [
    "call returns phaseOf's result when it is a string, and otherwise { notAString: typeof result, name } (name is the function's name, or null): PHASE_OF is a plain object literal, so a step id that names an Object.prototype member (constructor, toString, __proto__) is found on the prototype and its value comes back instead of the 'switch' fallback.",
    'Step ids come from the adapters, never from the user; the prototype cases record what the code does, not a reachable path.',
  ].join('\n'),
  call: projectPhaseOf,
  cases: [
    ...STEP_IDS.map((id) => ({ id: `known-${id}`, origin: adversarial('other', `phaseOf of the known step id ${id}`), args: [id], expect: 'out' as const })),
    { id: 'unknown', origin: t('groupSteps', 'files unknown step ids under the switch phase'), args: ['something-new'], expect: 'out' },
    { id: 'empty', origin: adversarial('other', 'an empty step id falls back to switch'), args: [''], expect: 'out' },
    { id: 'upper', origin: adversarial('case-mapping', 'CLOSE: the lookup is case-sensitive'), args: ['CLOSE'], expect: 'out' },
    { id: 'padded', origin: adversarial('unicode-space', 'a trailing space: nothing is trimmed'), args: ['close '], expect: 'out' },
    { id: 'lone-surrogate', origin: adversarial('lone-surrogate', 'a lone surrogate after a known id'), args: [`close${LONE}`], expect: 'out' },
    {
      id: 'proto-constructor',
      origin: adversarial('json', 'constructor is inherited from Object.prototype: the lookup returns the Object function'),
      args: ['constructor'],
      expect: 'out',
    },
    { id: 'proto-tostring', origin: adversarial('json', 'toString is inherited: the lookup returns a function'), args: ['toString'], expect: 'out' },
    { id: 'proto-proto', origin: adversarial('json', '__proto__ returns Object.prototype itself'), args: ['__proto__'], expect: 'out' },
    { id: 'proto-hasownproperty', origin: adversarial('json', 'hasOwnProperty is inherited too'), args: ['hasOwnProperty'], expect: 'out' },
  ],
});

const PHASES = ['close', 'switch', 'start', 'signin', 'launch'];
vectorFile({
  area: 'core',
  function: 'phaseLabel',
  source: SOURCE,
  name: 'renderer.phases.phaseLabel',
  note: 'arg1 is PhaseNames { launcher, account, game }. An id outside PhaseId falls out of the switch and returns undefined.',
  call: phaseLabel,
  cases: [
    ...PHASES.map((id) => ({ id: `test-${id}`, origin: t('phaseLabel', 'names each phase for the user'), args: [id, names], expect: 'out' as const })),
    { id: 'test-launch-no-game', origin: t('phaseLabel', 'names each phase for the user'), args: ['launch', { ...names, game: null }], expect: 'out' },
    {
      id: 'launch-empty-game',
      origin: adversarial('other', 'an empty game name is falsy: plain Launch'),
      args: ['launch', { ...names, game: '' }],
      expect: 'out',
    },
    {
      id: 'riot-client',
      origin: adversarial('other', 'a launcher name that reads mid-sentence is not capitalised here'),
      args: ['close', { ...names, launcher: 'the Riot Client' }],
      expect: 'out',
    },
    {
      id: 'astral-account',
      origin: adversarial('utf16-length', 'an account name with an astral character'),
      args: ['switch', { ...names, account: 'Alt \u{1F3AE}' }],
      expect: 'out',
    },
    { id: 'unknown-id', origin: adversarial('other', 'an id outside PhaseId: undefined'), args: ['bogus', names], expect: 'out' },
  ],
});

const g = (titles: string[], id: string, steps: unknown[], running: boolean): Case => ({
  id,
  origin: t('groupSteps', ...titles),
  args: [steps, running],
  expect: 'out',
});
const ga = (id: string, what: string, steps: unknown[], running: boolean, cls: 'other' | 'json' | 'sort' = 'other'): Case => ({
  id,
  origin: adversarial(cls, `groupSteps ${what}`),
  args: [steps, running],
  expect: 'out',
});

vectorFile({
  area: 'core',
  function: 'groupSteps',
  source: SOURCE,
  name: 'renderer.phases.groupSteps',
  note: 'arg0 is the job steps (JobStep[]: id, title, status, detail), arg1 whether the job is still running. out is Phase[]: id, status and current, the JobStep object itself or null.',
  call: groupSteps,
  cases: [
    g(
      ['collapses a running switch into phases and points at the running step'],
      'test-running-switch',
      [
        step('close', 'done'),
        step('backup', 'done'),
        step('file', 'running', 'Write loginusers.vdf'),
        step('registry', 'pending'),
        step('start', 'pending'),
        step('verify', 'pending'),
        step('launch', 'pending'),
      ],
      true,
    ),
    g(['shows the gap between two steps as still running'], 'test-gap', [step('backup', 'done'), step('file', 'pending'), step('start', 'pending')], true),
    g(
      ['marks a phase done when its last step is done even if an earlier one failed'],
      'test-handover',
      [step('verify', 'failed', 'Automatic sign-in'), step('manual', 'done', 'Handed over')],
      false,
    ),
    g(
      ['marks the phase failed when the job stopped mid-way and names the failed step'],
      'test-stopped-midway',
      [step('close', 'done'), step('file', 'failed', 'Write config'), step('registry', 'pending')],
      false,
    ),
    g(['turns a running phase into failed once the job is no longer running'], 'test-running-stopped', [step('close', 'done'), step('file', 'running')], false),
    g(
      ['skips a phase whose steps were all skipped and drops phases with no steps'],
      'test-all-skipped',
      [step('close', 'skipped'), step('file', 'done'), step('start', 'done')],
      false,
    ),
    g(['files unknown step ids under the switch phase'], 'test-unknown-id', [step('something-new', 'done')], false),
    ga('empty', 'with no steps: no phases', [], true),
    ga('all-pending', 'with every step pending', [step('close', 'pending'), step('file', 'pending')], true),
    ga(
      'gap-stopped-no-failure',
      'gap between steps when the job stopped: failed, current is the last live step',
      [step('backup', 'done'), step('file', 'pending')],
      false,
    ),
    ga(
      'gap-stopped-earlier-failure',
      'gap after a failed step when the job stopped: current is the last failed step',
      [step('backup', 'failed', 'Back up'), step('file', 'done'), step('registry', 'pending')],
      false,
    ),
    ga('last-failed-running-job', 'last step failed while the job still runs: failed', [step('file', 'done'), step('registry', 'failed', 'Write key')], true),
    ga('two-failures', 'two failed steps: current is the later one', [step('file', 'failed', 'First'), step('registry', 'failed', 'Second')], false),
    ga('skipped-last', 'a skipped step after a done one: the done step is the last live one', [step('file', 'done'), step('registry', 'skipped')], false),
    ga('two-running', 'two running steps in one phase: current is the first', [step('file', 'running', 'One'), step('registry', 'running', 'Two')], true),
    ga(
      'out-of-order',
      'steps out of phase order: phases come in the fixed order',
      [step('launch', 'pending'), step('start', 'done'), step('close', 'done')],
      false,
      'sort',
    ),
    ga('duplicate-ids', 'the same step id twice', [step('file', 'done', 'A'), step('file', 'running', 'B')], true),
    ga('done-then-pending', 'done followed by pending in a running job: running with no current step', [step('start', 'done'), step('wait', 'pending')], true),
    ga(
      'proto-step-id',
      'a step whose id names an Object.prototype member: phaseOf returns a function, which matches no phase, so the step disappears',
      [step('constructor', 'running'), step('file', 'done')],
      true,
      'json',
    ),
    ga(
      'every-phase-done',
      'every phase done after the job finished',
      STEP_IDS.map((id) => step(id, 'done')),
      false,
    ),
  ],
});

vectorFile({
  area: 'core',
  function: 'sentence',
  source: SOURCE,
  name: 'renderer.phases.sentence',
  note: 'charAt(0).toUpperCase() + slice(1): the first UTF-16 code unit is upper-cased with the default (locale-independent) mapping, so an astral first letter is left alone and a letter whose upper case is longer (ß) grows.',
  call: sentence,
  cases: [
    {
      id: 'test-riot-client',
      origin: t('stoppedNote', 'starts its sentences properly when the program is "the Riot Client"'),
      args: ['the Riot Client'],
      expect: 'out',
    },
    { id: 'test-steam', origin: t('stoppedNote', 'starts its sentences properly when the program is "the Riot Client"'), args: ['Steam'], expect: 'out' },
    { id: 'empty', origin: adversarial('utf16-length', "an empty string: charAt(0) is ''"), args: [''], expect: 'out' },
    { id: 'accented', origin: adversarial('case-mapping', 'é upper-cases to É'), args: ['éclair'], expect: 'out' },
    { id: 'sharp-s', origin: adversarial('case-mapping', 'ß upper-cases to SS: the string grows by one'), args: ['ßtrasse'], expect: 'out' },
    { id: 'dz-digraph', origin: adversarial('case-mapping', 'ǆ upper-cases to Ǆ, not the title-case ǅ'), args: ['ǆungla'], expect: 'out' },
    { id: 'dotless-i', origin: adversarial('case-mapping', 'i upper-cases to I whatever the locale; Turkish would give İ'), args: ['istanbul'], expect: 'out' },
    { id: 'n-apostrophe', origin: adversarial('case-mapping', 'ŉ upper-cases to two characters, ʼN'), args: ['ŉx'], expect: 'out' },
    {
      id: 'astral-lower',
      origin: adversarial(
        'utf16-length',
        'Deseret 𐐨 (U+10428) first: charAt(0) is its high surrogate alone, so nothing is upper-cased; a char-based port would give 𐐀',
      ),
      args: ['\u{10428}x'],
      expect: 'out',
    },
    { id: 'leading-space', origin: adversarial('unicode-space', 'a leading space is not skipped'), args: [' steam'], expect: 'out' },
    { id: 'digit-first', origin: adversarial('other', 'a digit first'), args: ['7 Days'], expect: 'out' },
    { id: 'lone-surrogate', origin: adversarial('lone-surrogate', 'a lone high surrogate first'), args: [`${LONE}abc`], expect: 'out' },
  ],
});

type Job = Parameters<typeof stoppedNote>[0];
const job = (over: Partial<Job>): Job => ({ state: 'cancelled', switched: false, restored: null, steps: [], account, game, ...over }) as Job;
const sn = (id: string, origin: Case['origin'], over: Partial<Job>, launcher = 'Steam', action = 'Play'): Case => ({
  id,
  origin,
  args: [job(over), launcher, action],
  expect: 'out',
});
const SN1 = ['stoppedNote', 'says what state the launcher was left in after a stopped or timed-out job'];
const SN2 = ['stoppedNote', 'starts its sentences properly when the program is "the Riot Client"'];
const SN3 = ['stoppedNote', 'adds nothing when the job was stopped before or while the launcher started: the job sentence already says it'];

vectorFile({
  area: 'core',
  function: 'stoppedNote',
  source: SOURCE,
  name: 'renderer.phases.stoppedNote',
  note: "arg0 is the job's state, switched, restored, steps, account and game; arg1 the launcher's name as it reads mid-sentence; arg2 the action label. Checks run in order: switched, restored true, restored false, then the hand-over test on the manual step.",
  call: stoppedNote,
  cases: [
    sn('test-switched', t(...SN1), { switched: true }),
    sn('test-restored', t(...SN1), { restored: true }),
    sn('test-not-restored', t(...SN1), { restored: false }),
    sn('test-manual-failed', t(...SN1), { steps: [step('manual', 'failed')] }),
    sn('test-needs-sign-in-no-game', t(...SN1), { state: 'needs-sign-in', game: null }, 'Steam', 'Switch'),
    sn('test-riot-switched', t(...SN2), { switched: true }, 'the Riot Client'),
    sn('test-riot-restored', t(...SN2), { restored: true }, 'the Riot Client'),
    sn('test-riot-manual-failed', t(...SN2), { steps: [step('manual', 'failed')] }, 'the Riot Client'),
    sn('test-close-failed-manual-pending', t(...SN3), { steps: [step('close', 'failed'), step('manual', 'pending')] }),
    sn('test-wait-failed-manual-skipped', t(...SN3), { steps: [step('wait', 'failed'), step('manual', 'skipped')] }),
    sn('switched-wins', adversarial('other', 'switched and restored false together: switched is checked first'), { switched: true, restored: false }),
    sn('cancelled-no-steps', adversarial('other', 'cancelled with no steps: null'), {}),
    sn('cancelled-manual-running', adversarial('other', 'cancelled while the manual step runs: handed over, so the note'), {
      steps: [step('manual', 'running')],
    }),
    sn('cancelled-manual-done', adversarial('other', 'cancelled after the manual step finished'), { steps: [step('manual', 'done')] }),
    sn('failed-no-steps', adversarial('other', 'failed (not cancelled) with no steps: the note, with the game'), { state: 'failed' }),
    sn('failed-no-game', adversarial('other', 'failed with no game: no "to launch the game"'), { state: 'failed', game: null }),
    sn('restored-lowercase-name', adversarial('case-mapping', 'a launcher name starting with é'), { restored: true }, 'épic'),
    sn('switched-astral-account', adversarial('utf16-length', 'an account name with an astral character'), {
      switched: true,
      account: { ...account, displayName: 'Alt \u{1F3AE}' },
    }),
  ],
});

type AJob = Parameters<typeof jobAnnouncement>[0];
const ajob = (over: Partial<AJob>): AJob =>
  ({
    state: 'running',
    steps: [step('close', 'done'), step('backup', 'running'), step('file', 'pending'), step('launch', 'pending')],
    attention: null,
    error: null,
    account,
    game,
    ...over,
  }) as AJob;
const attention = { kind: 'sign-in', title: 'Steam is asking you to sign in as alt', message: '', reason: null, canCopyPassword: false, until: '' };
const JA1 = ['jobAnnouncement', 'names the phase underway, and stays the same sentence while steps inside that phase change'];
const JA2 = ['jobAnnouncement', 'says when the job waits for the user, and how it ended'];
const ja = (id: string, origin: Case['origin'], over: Partial<AJob>, n = names): Case => ({ id, origin, args: [ajob(over), n], expect: 'out' });

vectorFile({
  area: 'core',
  function: 'jobAnnouncement',
  source: SOURCE,
  name: 'renderer.phases.jobAnnouncement',
  note: "arg0 is the job's state, steps, attention, error, account, game and optional handOff; arg1 is PhaseNames. The running phase comes from groupSteps(steps, true).",
  call: jobAnnouncement,
  cases: [
    ja('test-switch-underway', t(...JA1), {}),
    ja('test-switch-file-running', t(...JA1), { steps: [step('close', 'done'), step('backup', 'done'), step('file', 'running'), step('launch', 'pending')] }),
    ja('test-no-steps', t(...JA1), { steps: [] }),
    ja('test-attention', t(...JA2), { attention } as Partial<AJob>),
    ja('test-done', t(...JA2), { state: 'done' }),
    ja('test-done-no-game', t(...JA2), { state: 'done', game: null }),
    ja('test-failed-error', t(...JA2), { state: 'failed', error: 'Steam did not start.' }),
    ja('test-failed-no-error', t(...JA2), { state: 'failed' }),
    ja('gap-running', adversarial('other', 'no step running but a phase between steps: that phase'), {
      steps: [step('backup', 'done'), step('file', 'pending')],
    }),
    ja('all-pending', adversarial('other', 'every step pending: Working…'), { steps: [step('close', 'pending'), step('file', 'pending')] }),
    ja('launch-phase', adversarial('other', 'the launch phase running'), { steps: [step('start', 'done'), step('launch', 'running')] }),
    ja(
      'launch-phase-no-game',
      adversarial('other', 'the launch phase running with no game name'),
      { steps: [step('launch', 'running')] },
      { ...names, game: null },
    ),
    ja('done-handoff', adversarial('other', 'done with a hand-off sentence'), { state: 'done', handOff: 'Press Play in the Riot Client.' }),
    ja('done-empty-handoff', adversarial('other', 'done with an empty hand-off: falsy, so the plain sentence'), { state: 'done', handOff: '' }),
    ja('done-null-handoff', adversarial('other', 'done with handOff null'), { state: 'done', handOff: null }),
    ja('failed-empty-error', adversarial('other', 'failed with an empty error: ?? keeps the empty string'), { state: 'failed', error: '' }),
    ja('cancelled', adversarial('other', 'cancelled with no error'), { state: 'cancelled' }),
    ja('needs-sign-in-error', adversarial('other', 'needs-sign-in with an error'), { state: 'needs-sign-in', error: 'Sign in to Steam to finish.' }),
    ja('attention-when-done', adversarial('other', 'attention set on a finished job is ignored'), { state: 'done', attention } as Partial<AJob>),
  ],
});

const plan = {
  steps: [
    { id: 'close', skipped: true },
    { id: 'backup', skipped: false },
    { id: 'file', skipped: false },
    { id: 'start', skipped: false },
    { id: 'verify', skipped: false },
  ],
};
const PP = 'planPhases';

vectorFile({
  area: 'core',
  function: 'planPhases',
  source: SOURCE,
  name: 'renderer.phases.planPhases',
  note: "arg0 is a SwitchPlan reduced to the steps' id and skipped, the only fields planPhases reads (as test/phases.test.ts gives it); arg1 whether a game is launched.",
  call: planPhases,
  cases: [
    { id: 'test-without-launch', origin: t(PP, 'lists the phases a plan would run, in order, without the skipped ones'), args: [plan, false], expect: 'out' },
    { id: 'test-with-launch', origin: t(PP, 'appends the launch phase when a game is being launched'), args: [plan, true], expect: 'out' },
    { id: 'empty-no-launch', origin: adversarial('other', 'no steps and no launch: no phases'), args: [{ steps: [] }, false], expect: 'out' },
    { id: 'empty-with-launch', origin: adversarial('other', 'no steps with a launch: only launch'), args: [{ steps: [] }, true], expect: 'out' },
    {
      id: 'all-skipped',
      origin: adversarial('other', 'every step skipped'),
      args: [
        {
          steps: [
            { id: 'close', skipped: true },
            { id: 'file', skipped: true },
          ],
        },
        false,
      ],
      expect: 'out',
    },
    {
      id: 'launch-step-without-flag',
      origin: adversarial('other', 'a launch step in the plan counts even when withLaunch is false'),
      args: [{ steps: [{ id: 'launch', skipped: false }] }, false],
      expect: 'out',
    },
    {
      id: 'out-of-order',
      origin: adversarial('sort', 'steps out of phase order come back in the fixed order'),
      args: [
        {
          steps: [
            { id: 'verify', skipped: false },
            { id: 'close', skipped: false },
            { id: 'start', skipped: false },
          ],
        },
        false,
      ],
      expect: 'out',
    },
    {
      id: 'unknown-ids',
      origin: adversarial('other', 'unknown step ids count as switch, once'),
      args: [
        {
          steps: [
            { id: 'mystery', skipped: false },
            { id: 'other', skipped: false },
          ],
        },
        false,
      ],
      expect: 'out',
    },
    {
      id: 'proto-id',
      origin: adversarial('json', 'a step id naming an Object.prototype member adds a function to the set, which matches no phase'),
      args: [{ steps: [{ id: 'toString', skipped: false }] }, false],
      expect: 'out',
    },
  ],
});
