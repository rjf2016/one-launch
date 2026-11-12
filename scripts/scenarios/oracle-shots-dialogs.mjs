import { readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { sleep } from '../app-driver.mjs';
import { startPlay, waitForVaultKey, watchDialog } from './lib.mjs';

export const area = 'dialogs';

const DEMO_HELD = "the page's setInterval callbacks stopped before the step opened, so the phase demo stays on its first step, every phase pending";

export const rows = {
  102: {
    how: 'a Steam switch killed while it was writing. No knob parks a switch between its snapshot and the start of the launcher (a few milliseconds), so the confirm click is sent without waiting for its answer, switch.json is watched, and killHard follows the first entry that names the snapshot; the journal the app left names a write step (file). A kill that lands after the journal has moved on to the start step is undone with Restore snapshot in the prompt and the switch is run again, three times at most',
  },
  103: { how: 'the fake Epic launcher never signs in (the reactMs knob), so the switch waits in its sign-in phase; the app is killed there and started again' },
  104: {
    how: 'an Epic switch that fails after its write (the processes.startFails knob: the fake launcher never comes up) and whose rollback fails too: while the switch waited for the launcher, the Config folder of its snapshot was moved aside in the scratch data folder, so the restore found no file; once the app had written rollbackFailed to switch.json the folder was moved back, the app closed and started again. Nothing in switch.json was written by the capture',
  },
  105: {
    how: 'the switch parked and killed as for row 103, and the folder of its snapshot removed from the scratch data folder between the kill and the restart',
  },
  106: { how: 'the switch parked and killed as for row 103, then Restore snapshot pressed with the fake launcher closed' },
  107: {
    how: 'the switch parked and killed as for row 103, and the app restarted with the fake Epic launcher running (the processes.running knob); the answer to recovery:restore held in main until the dialog had painted "Restoring…" and its disabled buttons had dropped the focus, then released. The refusal is the adapter\'s own',
  },
  111: { how: 'the answers to launchers:status and artwork:status held in main, then the page reloaded and the guide moved on to step 2' },
  112: { how: DEMO_HELD },
  113: { how: DEMO_HELD },
};

const PARKED = { knobs: { epic: { reactMs: 600_000 } } };
const RECOVERY_TITLE = 'One Launch was closed during a switch';
const WHATS_NEW_LIST = '[role="dialog"][aria-labelledby="whats-new-title"] .overflow-y-auto';

const guideOpen = () => document.querySelector('[role="dialog"][aria-labelledby="setup-title"]') !== null;
const cardOpen = () => document.querySelector('[role="dialog"][aria-labelledby="whats-new-title"]') !== null;
const chipPressed = () => document.querySelector('[role="dialog"] button[aria-pressed="true"]') !== null;
const continueOffered = () => [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Continue');
const pressContinue = () => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Continue').click();
const focusIs = (name) => (document.activeElement?.textContent ?? '').replace(/\s+/g, ' ').trim() === name;
const focusDropped = () => document.activeElement === document.body;
const statTiles = (expected) => [...document.querySelectorAll('[role="dialog"] dd')].map((el) => el.textContent.trim()).join(' ') === expected;
const scrolledToEnd = (selector) => {
  const el = document.querySelector(selector);
  return el.scrollTop > 0 && el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
};

async function until(d, test, ...args) {
  const deadline = Date.now() + 10_000;
  while (!(await d.evaluate(test, ...args))) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${test.toString().replace(/\s+/g, ' ').slice(0, 120)} with ${JSON.stringify(args)}`);
    await sleep(100);
  }
}

function journalOf(d) {
  try {
    return JSON.parse(readFileSync(join(d.dataDir, 'switch.json'), 'utf8'));
  } catch {
    return null;
  }
}

async function untilJournal(d, test, { timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const journal = journalOf(d);
    if (journal && test(journal)) return journal;
    if (Date.now() > deadline) throw new Error(`switch.json never reached the expected state; its step is ${journal?.stepId ?? 'not there'}`);
    await sleep(50);
  }
}

async function parkEpicSignIn(s) {
  const { d } = s;
  await d.waitFor('Rocket League');
  await waitForVaultKey(d);
  await startPlay(d, { game: 'Rocket League®', account: 'Alt', tag: 'park' });
  await watchDialog(d, { until: (text) => text.includes('Sign in…'), tag: 'park' });
  return untilJournal(d, (journal) => journal.backupId !== null && ['start', 'wait', 'verify'].includes(journal.stepId));
}

// The click's answer comes back tens of milliseconds late and the write steps are over in less, so the click is not awaited.
async function killWhileWriting(d) {
  const deadline = Date.now() + 20_000;
  d.evaluate(pressContinue).catch(() => undefined);
  while (!journalOf(d)?.backupId) {
    if (Date.now() > deadline) throw new Error('the switch never recorded its snapshot');
    await new Promise((resolve) => setImmediate(resolve));
  }
  await d.killHard();
}

async function enter(s, button, text) {
  await until(s.d, focusIs, button);
  await s.d.key('Enter');
  await s.d.waitFor(text);
}

async function tabTo(s, button) {
  for (let i = 0; i < 8 && !(await s.d.evaluate(focusIs, button)); i += 1) await s.d.key('Tab');
  await until(s.d, focusIs, button);
}

async function toPlayStep(s, shot, text) {
  await s.freezeIntervals(true);
  await enter(s, 'Continue', text);
  await s.shot(shot);
  await s.freezeIntervals(false);
}

async function waitForTiles(s) {
  const { d } = s;
  const [{ launchers }, { games }, { accounts }] = await Promise.all([d.invoke('launchers:status'), d.invoke('library:list'), d.invoke('accounts:list')]);
  await until(d, statTiles, [launchers.filter((l) => l.install !== null).length, games.length, accounts.length].join(' '));
}

export const sessions = [
  {
    name: 'confirm',
    fake: 'all-four',
    async run(s) {
      const { d } = s;
      await d.waitFor('Rocket League');
      await d.click('Accounts');
      await d.waitFor('Add account');
      await d.click('Add account');
      await d.click({ selector: '[role="menuitem"]' });
      await d.waitFor('Display name');
      await d.focus({ selector: 'label input' });
      await d.type('Test Persona');
      await d.evaluate(() => document.activeElement?.blur());
      await d.key('1', { ctrl: true });
      await d.waitFor('Leave without creating this account?');
      await s.shot(101);
    },
  },
  {
    name: 'recovery-writing',
    fake: 'all-four',
    async run(s) {
      const { d } = s;
      await d.waitFor('Rocket League');
      await waitForVaultKey(d);
      for (let attempt = 1; ; attempt += 1) {
        await startPlay(d, { game: 'Rocket League', account: 'Persona Three', tag: `writing-${attempt}` });
        await d.waitFor(continueOffered);
        await killWhileWriting(d);
        await s.restart();
        await d.waitFor(RECOVERY_TITLE);
        if (await d.has('may be half-switched')) break;
        if (attempt === 3) throw new Error(`the kill landed after the writes three times; the journal's step was ${journalOf(d)?.stepId}`);
        await d.click('Restore snapshot');
        await d.waitFor('Steam was put back the way it was');
        await d.click('Done');
        await d.waitFor('Steam was put back the way it was', { absent: true });
      }
      await s.shot(102);
    },
  },
  {
    name: 'recovery-signing-in',
    fake: 'all-four',
    knobs: PARKED,
    async run(s) {
      const { d } = s;
      await parkEpicSignIn(s);
      await d.killHard();
      await s.restart();
      await d.waitFor(RECOVERY_TITLE);
      await d.waitFor('was starting or signing in');
      await s.shot(103);
      await s.mouseClick('Restore snapshot');
      await d.waitFor('Epic Games was put back the way it was');
      await s.shot(106);
    },
  },
  {
    name: 'recovery-rollback-failed',
    fake: 'all-four',
    knobs: { processes: { startFails: ['EpicGamesLauncher.exe'] }, timing: { epic: { startupMs: 6_000 } } },
    async run(s) {
      const { d } = s;
      await d.waitFor('Rocket League');
      await waitForVaultKey(d);
      await startPlay(d, { game: 'Rocket League®', account: 'Alt', tag: 'rollback' });
      const { backupId } = await untilJournal(d, (journal) => journal.backupId !== null);
      const stored = join(d.dataDir, 'backups', 'epic', backupId, 'Config');
      renameSync(stored, `${stored}.aside`);
      await watchDialog(d, { until: (text) => text.includes('could not be put back automatically'), tag: 'rollback' });
      await untilJournal(d, (journal) => journal.rollbackFailed === true);
      renameSync(`${stored}.aside`, stored);
      await s.stop();
      await s.restart();
      await d.waitFor('The last switch could not be undone');
      await s.shot(104);
    },
  },
  {
    name: 'recovery-no-snapshot',
    fake: 'all-four',
    knobs: PARKED,
    async run(s) {
      const { d } = s;
      const { backupId } = await parkEpicSignIn(s);
      await d.killHard();
      rmSync(join(d.dataDir, 'backups', 'epic', backupId), { recursive: true });
      await s.restart();
      await d.waitFor(RECOVERY_TITLE);
      await d.waitFor('The snapshot taken before that switch is gone');
      await s.shot(105);
    },
  },
  {
    name: 'recovery-restore-error',
    fake: 'all-four',
    knobs: PARKED,
    async run(s) {
      const { d } = s;
      await parkEpicSignIn(s);
      await d.killHard();
      await s.restart({ knobs: { ...PARKED, processes: { running: ['EpicGamesLauncher.exe'] } } });
      await d.waitFor(RECOVERY_TITLE);
      s.hold('recovery:restore');
      await s.mouseClick('Restore snapshot');
      await d.waitFor('Restoring…');
      await until(d, focusDropped);
      s.release('recovery:restore');
      await d.waitFor('Try the restore again');
      await s.shot(107);
    },
  },
  {
    name: 'guide-first-run',
    fake: 'none',
    async run(s) {
      const { d } = s;
      await d.waitFor('Welcome to One Launch');
      await s.shot(108);

      s.hold('launchers:status');
      s.hold('artwork:status');
      await d.reload();
      await d.waitFor('Welcome to One Launch');
      await enter(s, 'Get started', 'Looking for installed games');
      await s.shot(111);
      s.release('launchers:status');
      s.release('artwork:status');
      await d.waitFor('No launcher was found on this PC');
      await d.waitFor('0 installed games found');
      await s.shot(109);

      await toPlayStep(s, 112, 'Play switches accounts for you');

      await enter(s, 'Continue', 'nothing to import yet');
      await s.shot(115);
      await s.mouseClick('Riot Games');
      await d.waitFor(chipPressed);
      await s.shot(116);

      await tabTo(s, 'Continue');
      await enter(s, 'Continue', 'Almost there');
      await d.waitFor('Add a Riot Games account');
      await waitForTiles(s);
      await s.shot(118);

      await d.invoke('settings:set', { key: 'dryRun', value: 'true' });
      await d.reload();
      await d.waitFor('Welcome to One Launch');
      await enter(s, 'Get started', 'Your launchers');
      await toPlayStep(s, 113, 'Preview mode is on, so Play only shows');
    },
  },
  {
    name: 'guide-found',
    fake: 'all-four',
    async run(s) {
      const { d } = s;
      await d.waitFor('Rocket League');
      const { games } = await d.invoke('library:list');
      await d.click('Settings');
      await d.waitFor('Show again');
      await d.click('Show again');
      await d.waitFor('Welcome to One Launch');
      await enter(s, 'Get started', 'One Launch found these launchers');
      await d.waitFor(`${games.length} installed games found`);
      await s.shot(110);

      await enter(s, 'Continue', 'Play switches accounts for you');
      await enter(s, 'Continue', 'Add your accounts');
      await d.waitFor(() => / and continue/.test(document.body.innerText) && !document.body.innerText.includes('reading…'));
      await s.shot(114);

      while (await d.evaluate(() => document.querySelector('[role="dialog"] input[type="checkbox"]:checked:not(:disabled)') !== null)) {
        await d.click({ selector: '[role="dialog"] input[type="checkbox"]:checked:not(:disabled)' });
      }
      await enter(s, 'Continue', "You're all set");
      await waitForTiles(s);
      await s.shot(117);
      await d.click('Open Library');
      await d.waitFor(guideOpen, { absent: true });
    },
  },
  {
    name: 'whats-new',
    fake: 'all-four',
    async run(s) {
      const { d } = s;
      await d.waitFor('Rocket League');
      await d.click('Settings');
      await d.waitFor('Show again');
      await d.click("Show what's new");
      await d.waitFor(cardOpen);
      await s.shot(119);

      const [x, y, w, h] = await s.rectOf({ selector: WHATS_NEW_LIST });
      await s.pointer(x + w / 2, y + h / 2);
      await s.wheel(x + w / 2, y + h / 2, 2000);
      await until(d, scrolledToEnd, WHATS_NEW_LIST);
      await s.shot(120, { keepPointer: true });
    },
  },
];
