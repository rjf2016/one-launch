// Stop at each abort stage the dialog can reach, and the sentence each one ends with:
//   1. while Steam is closing (before any write): nothing changed;
//   3. after Steam was started again: the writes stand, Steam finishes signing in on its own;
//   4. after the sign-in was confirmed: the switch counts, only the game launch is skipped.
// Stage 2 (after the writes, before the start) lasts microseconds against a fake and is covered by test/pipeline.test.ts.
// Steam is running as user_1 and every Steam wait is stretched so each stage stays open for a few seconds.
import { sleep } from '../app-driver.mjs';
import { finishDialog, journalExists, startPlay, watchDialog } from './lib.mjs';

export const name = 'stop';
export const options = {
  fake: 'all-four',
  knobs: {
    knobs: { steam: { runningAs: 'user_1', reactMs: 5_000 } },
    processes: { shutdownPolls: 100_000 },
    timing: { steam: { shutdownMs: 4_000, killGraceMs: 1_000, readyGraceMs: 4_000 } },
  },
};

export default async (d) => {
  await d.waitFor('Rocket League');
  const original = d.launcherFile('steam/config/loginusers.vdf');

  await startPlay(d, { game: 'Rocket League', account: 'Persona Three', tag: 'closing' });
  await watchDialog(d, { until: (t) => t.includes('Close Steam…'), tag: 'closing' });
  await d.click('Stop');
  let text = await watchDialog(d, { until: (t) => t.includes('Nothing had been changed'), tag: 'closing' });
  d.check('stopped while closing: "Stopped before Steam was started"', text.includes('Stopped before Steam was started as user_3. Nothing had been changed.'));
  await finishDialog(d, 'closing');
  d.check('stopped while closing: loginusers.vdf untouched', d.launcherFile('steam/config/loginusers.vdf') === original);
  d.check('stopped while closing: no snapshot', (await d.invoke('backups:list', { launcher: 'steam' })).snapshots.length === 0);

  await startPlay(d, { game: 'Rocket League', account: 'Persona Three', tag: 'starting' });
  await watchDialog(d, { until: (t) => t.includes('Sign in…'), tag: 'starting' });
  await d.click('Stop');
  text = await watchDialog(d, { until: (t) => t.includes('Nothing was rolled back'), tag: 'starting' });
  d.check(
    'stopped after the start: "Steam carries on signing in on its own"',
    text.includes('Stopped while Steam was starting as user_3. Nothing was rolled back: Steam carries on signing in on its own.'),
  );
  await finishDialog(d, 'starting');
  d.check('stopped after the start: the writes stand', d.launcherFile('steam/config/loginusers.vdf') !== original);
  d.check('stopped after the start: one snapshot', (await d.invoke('backups:list', { launcher: 'steam' })).snapshots.length === 1);
  d.check('stopped after the start: the journal is gone', !journalExists(d));
  // Steam carries on signing in as user_3 on its own, reactMs after its start: let it finish, as it would on a real
  // PC, so the next switch starts from a Steam signed in as user_3 rather than racing the fake's reaction.
  await sleep(options.knobs.knobs.steam.reactMs + 500);

  await startPlay(d, { game: 'Rocket League', account: 'Persona One', tag: 'signed-in' });
  await watchDialog(d, { until: (t) => t.includes('Show details'), tag: 'signed-in' });
  await d.click('Show details');
  await watchDialog(d, { until: (t) => t.includes('Steam signed in as user_1.'), tag: 'signed-in' });
  await d.click('Stop');
  text = await watchDialog(d, { until: (t) => t.includes('Stopped before launching'), tag: 'signed-in' });
  d.check('stopped after the sign-in: only the launch was skipped', text.includes('Stopped before launching Rocket League.'));
  d.check('stopped after the sign-in: the switch counts', text.includes('Steam is signed in as Persona One. Press Play again to launch the game.'));
  await finishDialog(d, 'signed-in');
  d.check('stopped after the sign-in: the game was never launched', d.fakeReport().opened.length === 0);
  const { recent } = await d.invoke('launch:recent', { limit: 10 });
  d.check('no launch in the history', recent.length === 0);
};
