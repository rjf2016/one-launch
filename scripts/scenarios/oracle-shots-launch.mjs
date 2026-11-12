import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { playThrough, startPlay, watchDialog } from './lib.mjs';

export const area = 'launch';

const PARKED_IN_SIGN_IN =
  'the fake Steam runs as user_1 and never answers its restart (reactMs raised, signInMs and updateMs stretched), so the switch stays in Sign in';
const PARKED_IN_HAND_OVER = 'the hand-over wait is stretched (manualSignInMs) and nobody signs in, so the switch stays on the panel';

export const rows = {
  71: { how: 'the answer to launch:preflight held in main after Play was pressed' },
  77: { how: `knob-parked: ${PARKED_IN_SIGN_IN}` },
  78: { how: `knob-parked: ${PARKED_IN_SIGN_IN}` },
  79: {
    how: `knob-parked: Steam's session for user_3 expired and its -login answered with a Steam Guard verdict (steam.autoLogin on); ${PARKED_IN_HAND_OVER}`,
  },
  80: { how: `knob-parked: the fake Battle.net rejects the saved token; ${PARKED_IN_HAND_OVER}` },
  81: { how: `knob-parked: the fake Riot Client rejects the saved sign-in; ${PARKED_IN_HAND_OVER}` },
  82: { how: `knob-parked as row 79: ${PARKED_IN_HAND_OVER}` },
  83: {
    how: 'the fake Steam never exits (shutdownPolls and shutdownMs raised), so the switch stays in Close; the answer to launch:status held in main, then Stop pressed',
  },
  88: { how: 'Stop pressed while the switch was parked in Close as for row 83' },
  89: {
    skipped:
      'cannot be reached without editing src/: a Stop rolls back only when it lands after the first write and before the launcher is started, and on fake launchers nothing in that stretch waits (the fake registry and process list answer within one turn of the event loop, where no launch:cancel is handled). 66 timed Stops across the boundary ended either "Nothing had been changed" or "Stopped while Steam was starting"; test/pipeline.test.ts reaches the state by gating the process-list check there, which the kit cannot hold',
  },
  90: { how: 'Stop waiting pressed on the hand-over parked as for row 79' },
  92: {
    how: 'fault: the fake Steam never shows up after its start (startFails), and while the switch waited for it one byte was appended to the stored loginusers.vdf of its snapshot in the scratch data folder, so the rollback refuses the copy',
  },
  95: {
    how: 'a plain switch started over IPC and parked in Sign in (reactMs raised), then Play pressed in the dialog: main refuses the second launch:start with BUSY',
  },
  97: { how: `knob-parked: ${PARKED_IN_SIGN_IN}` },
  98: { how: `knob-parked as row 79: ${PARKED_IN_HAND_OVER}` },
};

const EPIC_INI = 'localappdata/EpicGamesLauncher/Saved/Config/Windows/GameUserSettings.ini';
const BATTLENET_ALT = '0b2c3d4e';
const RIOT_ALT = '33333333-3333-4333-8333-333333333333';
const LONG = 180_000;

const dialogClose = { selector: '[role="dialog"] button[aria-label="Close"]' };
const dialogGone = () => document.querySelector('[role="dialog"]') === null;
const lastLaunchShown = () => (document.body.innerText.match(/just now/g) ?? []).length === 2;

async function openPicker(d, game) {
  await d.click(`More for ${game}`);
  await d.waitFor('Play as…');
  await d.click('Play as…');
  await d.waitFor(() => document.querySelector('[role="dialog"] button[aria-pressed="true"]') !== null);
}

async function setPreview(d, on) {
  await d.invoke('settings:set', { key: 'dryRun', value: String(on) });
  await d.reload();
  await d.waitFor('Rocket League');
}

async function pressDone(d) {
  await d.click('Done');
  await d.waitFor(dialogGone);
}

export const sessions = [
  {
    name: 'pick',
    fake: 'all-four',
    async run(s) {
      const { d } = s;
      await d.waitFor('Rocket League');

      await openPicker(d, 'Rocket League');
      await s.shot(66);

      await d.click({ contains: 'Persona Three' });
      await d.waitFor('Play as Persona Three');
      s.hold('launch:preflight');
      await d.click('Play');
      await d.waitFor('Checking Steam…');
      await s.shot(71);
      s.release('launch:preflight');
      await d.waitFor('Continue');

      await setPreview(d, true);
      await d.waitFor('Preview mode is on');
      await startPlay(d, { game: 'Rocket League', account: 'Persona Three', tag: 'preview' });
      await d.waitFor('Preview mode is on, so nothing happened.');
      await s.shot(75);
      await setPreview(d, false);

      await d.click('Accounts');
      await d.waitFor('user_3');
      await d.click({ contains: 'user_3' });
      await d.waitFor('Switch to this account');
      await d.click('Switch to this account');
      await d.waitFor('Switch Steam to Persona Three');
      await s.shot(67);
      await d.click('Switch');
      await watchDialog(d, { until: (t) => t.includes('Switched to Persona Three'), tag: 'switch' });
      await s.shot(85);
    },
  },
  {
    name: 'launched',
    fake: 'all-four',
    async run(s) {
      const { d } = s;
      await d.waitFor('Rocket League');
      await startPlay(d, { game: 'Rocket League', account: 'Persona Three', tag: 'launched' });
      await watchDialog(d, { until: (t) => t.includes('Launched as Persona Three'), tag: 'launched' });
      await d.waitFor(lastLaunchShown);
      await s.shot(84);
    },
  },
  {
    name: 'steam-running',
    fake: 'all-four',
    knobs: { knobs: { steam: { runningAs: 'user_1' } } },
    async run(s) {
      const { d } = s;
      await d.waitFor('Rocket League');
      await d.invoke('settings:set', { key: 'play.hideToTray', value: 'false' });

      await startPlay(d, { game: 'Rocket League', account: 'Persona Three', tag: 'confirm' });
      await d.waitFor('Close Steam and continue');
      await s.shot(72);
      await d.click('Details');
      await d.waitFor('steps would run');
      await s.shot(74);
      await d.click(dialogClose);
      await d.waitFor(dialogGone);

      await playThrough(d, { game: 'Rocket League', account: 'Persona One', launcher: 'steam', tag: 'first' });
      await d.waitFor(lastLaunchShown);
      await d.click('Play Rocket League');
      await d.waitFor('Launched Rocket League as Persona One');
      await s.shot(99);
    },
  },
  {
    name: 'closing',
    fake: 'all-four',
    knobs: { knobs: { steam: { runningAs: 'user_1' } }, processes: { shutdownPolls: 100_000 }, timing: { steam: { shutdownMs: LONG } } },
    async run(s) {
      const { d } = s;
      await d.waitFor('Rocket League');
      await startPlay(d, { game: 'Rocket League', account: 'Persona Three', tag: 'closing' });
      await watchDialog(d, { until: (t) => t.includes('Close Steam…'), tag: 'closing' });
      s.hold('launch:status');
      await d.click('Stop');
      await d.waitFor('Stopping…');
      await s.shot(83);
      s.release('launch:status');
      await d.waitFor('Nothing had been changed.');
      await s.shot(88);
    },
  },
  {
    name: 'running',
    fake: 'all-four',
    knobs: { knobs: { steam: { runningAs: 'user_1', reactMs: 600_000 } }, timing: { steam: { signInMs: LONG, updateMs: LONG } } },
    async run(s) {
      const { d } = s;
      await d.waitFor('Rocket League');
      await startPlay(d, { game: 'Rocket League', account: 'Persona Three', tag: 'running' });
      await watchDialog(d, { until: (t) => t.includes('Sign in…'), tag: 'running' });
      await s.shot(77);

      await d.click('Show details');
      await d.waitFor('Hide details');
      await s.shot(78);

      await d.click('Hide');
      await d.waitFor('Switching to Persona Three and launching Rocket League…');
      await s.shot(97);
    },
  },
  {
    name: 'handover-steam',
    fake: 'all-four',
    knobs: {
      knobs: { steam: { expiredSessions: ['user_3'], loginVerdict: 'Account Login Denied Need Two Factor' } },
      timing: { steam: { signInMs: 2_000, manualSignInMs: LONG } },
    },
    async run(s) {
      const { d } = s;
      await d.waitFor('Rocket League');
      await d.invoke('settings:set', { key: 'steam.autoLogin', value: 'true' });
      await startPlay(d, { game: 'Rocket League', account: 'Persona Three', tag: 'handover' });
      await watchDialog(d, { until: (t) => t.includes('Stop waiting'), tag: 'handover' });
      await s.shot(79);

      await d.click('Copy login');
      await d.waitFor('Login copied');
      await s.shot(82);

      await d.click('Hide');
      await d.waitFor('Waiting for you to sign in as Persona Three');
      await s.shot(98);

      await d.click('Show');
      await d.waitFor('Stop waiting');
      await d.click('Stop waiting');
      await d.waitFor('Nothing was rolled back. Once Steam is signed in');
      await s.shot(90);
    },
  },
  {
    name: 'handover-clients',
    fake: 'all-four',
    knobs: {
      knobs: { battlenet: { rejected: [BATTLENET_ALT] }, riot: { rejected: [RIOT_ALT] } },
      timing: { battlenet: { manualSignInMs: LONG }, riot: { manualSignInMs: LONG } },
    },
    async run(s) {
      const { d } = s;
      await d.waitFor('Overwatch');
      await startPlay(d, { game: 'Overwatch', account: 'Alt', tag: 'battlenet' });
      await watchDialog(d, { until: (t) => t.includes('Stop waiting'), tag: 'battlenet' });
      await s.shot(80);
      await d.click('Stop waiting');
      await d.waitFor('Stopped waiting for the sign-in');
      await pressDone(d);

      await startPlay(d, { game: 'VALORANT', account: 'Riot Alt', tag: 'riot' });
      await watchDialog(d, { until: (t) => t.includes('Stop waiting'), tag: 'riot' });
      await s.shot(81);
    },
  },
  {
    name: 'sign-in-timeout',
    fake: 'all-four',
    knobs: { knobs: { steam: { expiredSessions: ['user_3'] } }, timing: { steam: { signInMs: 2_000, manualSignInMs: 60_000 } } },
    async run(s) {
      const { d } = s;
      await d.waitFor('Rocket League');
      await startPlay(d, { game: 'Rocket League', account: 'Persona Three', tag: 'timeout' });
      await watchDialog(d, { until: (t) => t.includes('gave up'), tag: 'timeout', timeoutMs: 120_000 });
      await s.shot(87);
    },
  },
  {
    name: 'needs-update',
    fake: 'all-four',
    knobs: { knobs: { battlenet: { updatesPending: ['prometheus'] } } },
    async run(s) {
      const { d } = s;
      await d.waitFor('Overwatch');
      await openPicker(d, 'Overwatch');
      await d.waitFor('Battle.net wants to update Overwatch first.');
      await d.click({ contains: 'Alt' });
      await d.waitFor('Play as Alt');
      await s.shot(68);

      await d.click('Play');
      await watchDialog(d, { until: (t) => t.includes('only the game launch failed'), tag: 'update' });
      await s.shot(93);
    },
  },
  {
    name: 'elevated',
    fake: 'all-four',
    knobs: {
      knobs: { steam: { runningAs: 'user_1' } },
      processes: { elevated: ['steam.exe'], shutdownPolls: 100_000 },
      timing: { steam: { shutdownMs: 1_000, killGraceMs: 500 } },
    },
    async run(s) {
      const { d } = s;
      await d.waitFor('Rocket League');
      await startPlay(d, { game: 'Rocket League', account: 'Persona Three', tag: 'elevated' });
      await watchDialog(d, { until: (t) => t.includes('Nothing had been changed yet.'), tag: 'elevated' });
      await s.shot(94);
    },
  },
  {
    name: 'rollback',
    fake: 'all-four',
    knobs: { processes: { startFails: ['steam.exe'] } },
    async run(s) {
      const { d } = s;
      await d.waitFor('Rocket League');
      await startPlay(d, { game: 'Rocket League', account: 'Persona Three', tag: 'rollback' });
      await d.waitFor('Continue');
      await d.click('Continue');
      await d.click('Hide');
      await d.waitFor('The switch to Persona Three failed', { timeoutMs: 30_000 });
      await s.shot(100);

      await d.click('Show');
      await d.waitFor('put back the way it was');
      await s.shot(91);
    },
  },
  {
    name: 'restore-fails',
    fake: 'all-four',
    knobs: { processes: { startFails: ['steam.exe'] } },
    async run(s) {
      const { d } = s;
      await d.waitFor('Rocket League');
      await startPlay(d, { game: 'Rocket League', account: 'Persona Three', tag: 'restore-fails' });
      await d.waitFor('Continue');
      await d.click('Continue');
      await d.waitFor('Start Steam…');
      const { snapshots } = await d.invoke('backups:list', { launcher: 'steam' });
      appendFileSync(join(snapshots[0].path, 'config', 'loginusers.vdf'), '\n');
      await d.waitFor('could not be put back automatically', { timeoutMs: 30_000 });
      await s.shot(92);
    },
  },
  {
    name: 'busy',
    fake: 'all-four',
    knobs: { knobs: { steam: { reactMs: 600_000 } }, timing: { steam: { signInMs: LONG, updateMs: LONG } } },
    async run(s) {
      const { d } = s;
      await d.waitFor('Rocket League');
      const { accounts } = await d.invoke('accounts:list');
      await d.invoke('launch:start', { accountId: accounts.find((a) => a.login === 'user_1').id, gameId: null, confirmClose: false });
      await startPlay(d, { game: 'Rocket League®', account: 'Alt', tag: 'busy' });
      await watchDialog(d, { until: (t) => t.includes('Another switch or launch is still running'), tag: 'busy' });
      await s.shot(95);
    },
  },
  {
    name: 'riot-game-running',
    fake: 'all-four',
    knobs: { processes: { table: [{ name: 'VALORANT-Win64-Shipping', pid: 1, path: null }] } },
    async run(s) {
      const { d } = s;
      await d.waitFor('VALORANT');
      await startPlay(d, { game: 'VALORANT', account: 'Riot Alt', tag: 'riot-game' });
      await d.waitFor('One Launch never closes a Riot game');
      await s.shot(96);
    },
  },
  {
    name: 'riot-hand-off',
    fake: 'all-four',
    async run(s) {
      const { d } = s;
      await d.waitFor('VALORANT');
      await d.invoke('settings:set', { key: 'riot.pressPlay', value: 'false' });
      await startPlay(d, { game: 'VALORANT', account: 'Riot Alt', tag: 'riot-hand-off' });
      await watchDialog(d, { until: (t) => t.includes('Press Play in the Riot Client window'), tag: 'riot-hand-off' });
      await d.waitFor(lastLaunchShown);
      await s.shot(86);
    },
  },
  {
    name: 'blocked',
    fake: {
      from: 'all-four',
      change(scenario) {
        delete scenario.files[EPIC_INI];
      },
    },
    async run(s) {
      const { d } = s;
      await d.waitFor('Rocket League');
      await startPlay(d, { game: 'Rocket League®', account: 'Alt', tag: 'blocked' });
      await d.waitFor('One Launch never creates it');
      await s.shot(76);
    },
  },
  {
    name: 'unowned',
    fake: 'unowned',
    async run(s) {
      const { d } = s;
      await d.waitFor('Rocket League');
      await startPlay(d, { game: 'Rocket League®', account: 'Alt', tag: 'unowned' });
      await d.waitFor('remembers a session that no One Launch account owns');
      await s.shot(73);
    },
  },
  {
    name: 'no-accounts',
    fake: 'all-four',
    async run(s) {
      const { d } = s;
      await d.waitFor('Rocket League');
      const { accounts } = await d.invoke('accounts:list');
      for (const account of accounts.filter((a) => a.launcher === 'steam' || a.launcher === 'riot')) await d.invoke('accounts:delete', { id: account.id });
      await d.reload();
      await d.waitFor('Rocket League');

      await d.click('Play Rocket League');
      await d.waitFor('No Steam accounts yet.');
      await s.shot(69);
      await d.click(dialogClose);
      await d.waitFor(dialogGone);

      await d.click('Play VALORANT');
      await d.waitFor('No Riot Games accounts yet.');
      await s.shot(70);
    },
  },
];
