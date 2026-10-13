import { describe, expect, it } from 'vitest';
import type { JobStep, SwitchPlan } from '../src/shared/models';
import { groupSteps, jobAnnouncement, phaseLabel, planPhases, sentence, stoppedNote } from '../src/renderer/src/lib/phases';

function step(id: string, status: JobStep['status'], title = id): JobStep {
  return { id, status, title, detail: '' };
}

const names = { launcher: 'Steam', account: 'Alt', game: 'Dota 2' };

describe('groupSteps', () => {
  it('collapses a running switch into phases and points at the running step', () => {
    const phases = groupSteps(
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
    );
    expect(phases.map((p) => [p.id, p.status])).toEqual([
      ['close', 'done'],
      ['switch', 'running'],
      ['start', 'pending'],
      ['signin', 'pending'],
      ['launch', 'pending'],
    ]);
    expect(phases[1]!.current?.title).toBe('Write loginusers.vdf');
  });

  it('shows the gap between two steps as still running', () => {
    const phases = groupSteps([step('backup', 'done'), step('file', 'pending'), step('start', 'pending')], true);
    expect(phases[0]!.status).toBe('running');
    expect(phases[0]!.current).toBeNull();
  });

  it('marks a phase done when its last step is done even if an earlier one failed', () => {
    const phases = groupSteps([step('verify', 'failed', 'Automatic sign-in'), step('manual', 'done', 'Handed over')], false);
    expect(phases).toEqual([{ id: 'signin', status: 'done', current: null }]);
  });

  it('marks the phase failed when the job stopped mid-way and names the failed step', () => {
    const phases = groupSteps([step('close', 'done'), step('file', 'failed', 'Write config'), step('registry', 'pending')], false);
    expect(phases[1]!.status).toBe('failed');
    expect(phases[1]!.current?.title).toBe('Write config');
  });

  it('turns a running phase into failed once the job is no longer running', () => {
    const phases = groupSteps([step('close', 'done'), step('file', 'running')], false);
    expect(phases[1]!.status).toBe('failed');
  });

  it('skips a phase whose steps were all skipped and drops phases with no steps', () => {
    const phases = groupSteps([step('close', 'skipped'), step('file', 'done'), step('start', 'done')], false);
    expect(phases.map((p) => [p.id, p.status])).toEqual([
      ['close', 'skipped'],
      ['switch', 'done'],
      ['start', 'done'],
    ]);
  });

  it('files unknown step ids under the switch phase', () => {
    expect(groupSteps([step('something-new', 'done')], false)).toEqual([{ id: 'switch', status: 'done', current: null }]);
  });
});

describe('planPhases', () => {
  const plan = {
    steps: [
      { id: 'close', skipped: true },
      { id: 'backup', skipped: false },
      { id: 'file', skipped: false },
      { id: 'start', skipped: false },
      { id: 'verify', skipped: false },
    ],
  } as unknown as SwitchPlan;

  it('lists the phases a plan would run, in order, without the skipped ones', () => {
    expect(planPhases(plan, false)).toEqual(['switch', 'start', 'signin']);
  });

  it('appends the launch phase when a game is being launched', () => {
    expect(planPhases(plan, true)).toEqual(['switch', 'start', 'signin', 'launch']);
  });
});

describe('phaseLabel', () => {
  it('names each phase for the user', () => {
    expect(phaseLabel('close', names)).toBe('Close Steam');
    expect(phaseLabel('switch', names)).toBe('Switch to Alt');
    expect(phaseLabel('start', names)).toBe('Start Steam');
    expect(phaseLabel('signin', names)).toBe('Sign in');
    expect(phaseLabel('launch', names)).toBe('Launch Dota 2');
    expect(phaseLabel('launch', { ...names, game: null })).toBe('Launch');
  });
});

describe('stoppedNote', () => {
  const job = (over: Partial<Parameters<typeof stoppedNote>[0]>): Parameters<typeof stoppedNote>[0] => ({
    state: 'cancelled',
    switched: false,
    restored: null,
    steps: [],
    account: { id: 'a', displayName: 'Alt', login: 'alt' },
    game: { id: 'g', name: 'Dota 2', launcherGameId: '570' },
    ...over,
  });

  it('says what state the launcher was left in after a stopped or timed-out job', () => {
    expect(stoppedNote(job({ switched: true }), 'Steam', 'Play')).toBe('Steam is signed in as Alt. Press Play again to launch the game.');
    expect(stoppedNote(job({ restored: true }), 'Steam', 'Play')).toBe('Steam was put back the way it was and left closed.');
    expect(stoppedNote(job({ restored: false }), 'Steam', 'Play')).toMatch(/could not be put back automatically/);
    expect(stoppedNote(job({ steps: [step('manual', 'failed')] }), 'Steam', 'Play')).toBe(
      'Nothing was rolled back. Once Steam is signed in, press Play again to launch the game.',
    );
    expect(stoppedNote(job({ state: 'needs-sign-in', game: null }), 'Steam', 'Switch')).toBe(
      'Nothing was rolled back. Once Steam is signed in, press Switch again.',
    );
  });

  it('starts its sentences properly when the program is "the Riot Client"', () => {
    expect(stoppedNote(job({ switched: true }), 'the Riot Client', 'Play')).toBe('The Riot Client is signed in as Alt. Press Play again to launch the game.');
    expect(stoppedNote(job({ restored: true }), 'the Riot Client', 'Play')).toBe('The Riot Client was put back the way it was and left closed.');
    expect(stoppedNote(job({ steps: [step('manual', 'failed')] }), 'the Riot Client', 'Play')).toBe(
      'Nothing was rolled back. Once the Riot Client is signed in, press Play again to launch the game.',
    );
    expect(sentence('the Riot Client')).toBe('The Riot Client');
    expect(sentence('Steam')).toBe('Steam');
  });

  it('adds nothing when the job was stopped before or while the launcher started: the job sentence already says it', () => {
    expect(stoppedNote(job({ steps: [step('close', 'failed'), step('manual', 'pending')] }), 'Steam', 'Play')).toBeNull();
    expect(stoppedNote(job({ steps: [step('wait', 'failed'), step('manual', 'skipped')] }), 'Steam', 'Play')).toBeNull();
  });
});

describe('jobAnnouncement', () => {
  const job = (over: Partial<Parameters<typeof jobAnnouncement>[0]>): Parameters<typeof jobAnnouncement>[0] => ({
    state: 'running',
    steps: [step('close', 'done'), step('backup', 'running'), step('file', 'pending'), step('launch', 'pending')],
    attention: null,
    error: null,
    account: { id: 'a', displayName: 'Alt', login: 'alt' },
    game: { id: 'g', name: 'Dota 2', launcherGameId: '570' },
    ...over,
  });

  it('names the phase underway, and stays the same sentence while steps inside that phase change', () => {
    expect(jobAnnouncement(job({}), names)).toBe('Switch to Alt…');
    expect(jobAnnouncement(job({ steps: [step('close', 'done'), step('backup', 'done'), step('file', 'running'), step('launch', 'pending')] }), names)).toBe(
      'Switch to Alt…',
    );
    expect(jobAnnouncement(job({ steps: [] }), names)).toBe('Working…');
  });

  it('says when the job waits for the user, and how it ended', () => {
    const attention = {
      kind: 'sign-in' as const,
      title: 'Steam is asking you to sign in as alt',
      message: '',
      reason: null,
      canCopyPassword: false,
      until: '',
    };
    expect(jobAnnouncement(job({ attention }), names)).toBe('Steam is asking you to sign in as alt');
    expect(jobAnnouncement(job({ state: 'done' }), names)).toBe('Launched as Alt');
    expect(jobAnnouncement(job({ state: 'done', game: null }), names)).toBe('Switched to Alt');
    expect(jobAnnouncement(job({ state: 'failed', error: 'Steam did not start.' }), names)).toBe('Steam did not start.');
    expect(jobAnnouncement(job({ state: 'failed' }), names)).toBe('The switch failed.');
  });
});
