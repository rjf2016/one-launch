// Steam is already running and signed in as the chosen account: the plan notes it and the dialog asks nothing (no
// close, no Continue), nothing is closed, written, or snapshotted, and only the game launch goes out.
import { finishDialog, startPlay, watchDialog } from './lib.mjs';

export const name = 'already-active';
export const options = { fake: 'all-four', knobs: { knobs: { steam: { runningAs: 'user_1' } } } };

export default async (d) => {
  await d.waitFor('Rocket League');
  const original = d.launcherFile('steam/config/loginusers.vdf');

  const { accounts } = await d.invoke('accounts:list');
  const main = accounts.find((a) => a.launcher === 'steam' && a.login === 'user_1');
  const { plan } = await d.invoke('launchers:switchPlan', { accountId: main.id });
  d.check(
    'the plan notes that the switch would change nothing, and warns of nothing',
    plan.notes.includes('Steam is already set to sign in as user_1. The real switch would change nothing and would leave Steam running.') &&
      plan.warnings.length === 0,
    JSON.stringify({ notes: plan.notes, warnings: plan.warnings }),
  );

  await startPlay(d, { game: 'Rocket League', account: 'Persona One', tag: 'active' });
  await d.waitFor('Show details');
  d.check('the dialog went straight to the switch, with no Continue and no close to confirm', !(await d.text()).includes('Continue'));
  const text = await watchDialog(d, { until: (t) => t.includes('Launched as'), tag: 'active' });
  d.check('every phase but the launch was not needed', text.split('not needed').length - 1 === 4, String(text.split('not needed').length - 1));
  await d.click('Show details');
  const details = await finishDialog(d, 'active');
  d.check('the sign-in confirmation was skipped', /Confirm Steam signed in\s*skipped/.test(details));

  const report = d.fakeReport();
  d.check('Steam was neither closed nor started', report.processEvents.length === 0, JSON.stringify(report.processEvents));
  d.check('nothing was written to the registry', report.registryWrites.length === 0, JSON.stringify(report.registryWrites));
  d.check('loginusers.vdf is untouched', d.launcherFile('steam/config/loginusers.vdf') === original);
  d.check('no snapshot was taken', (await d.invoke('backups:list', { launcher: 'steam' })).snapshots.length === 0);
  d.check('the game was launched through steam://', report.opened.includes('steam://rungameid/252950'), report.opened.join(' '));
  d.check('the launch is in the history', (await d.invoke('launch:recent', { limit: 10 })).recent.length === 1);
};
