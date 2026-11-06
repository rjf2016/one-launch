// Steam is already running and signed in as the chosen account: the plan notes it and the dialog asks nothing (no
// close, no Continue), nothing is closed, written, or snapshotted, and only the game launch goes out. Then, with the
// game's last account known, one click on the poster plays at once: no dialog, the job goes straight to the launch,
// the banner says so, and the window hides to the tray until a second start brings it back.
import { sleep } from '../app-driver.mjs';
import { finishDialog, journalExists, startPlay, watchDialog } from './lib.mjs';

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

  await d.waitFor(() => document.body.innerText.includes('Persona One ·'));
  await d.shot('card-with-last-account');
  const clickedAt = Date.now();
  await d.click('Play Rocket League');
  let launchedAt = null;
  while (Date.now() - clickedAt < 10_000) {
    if (d.fakeReport().opened.length > report.opened.length) {
      launchedAt = Date.now();
      break;
    }
    await sleep(20);
  }
  d.check('one click on the poster sent the game to steam:// again', launchedAt !== null, d.fakeReport().opened.join(' '));
  d.check('within a second of the click', launchedAt !== null && launchedAt - clickedAt < 1000, `${launchedAt === null ? 'never' : launchedAt - clickedAt} ms`);
  await d.waitFor('Launched Rocket League as Persona One');
  d.check('no dialog opened for it', await d.evaluate(() => document.querySelector('[role="dialog"]') === null));
  const log = d.readLog();
  d.check('the job went straight to the launch', /launch job direct/.test(log));
  d.check('no switch ran for it', (log.match(/switch started/g) ?? []).length === 0, String((log.match(/switch started/g) ?? []).length));
  await d.waitFor(() => document.visibilityState === 'hidden');
  d.check(
    'the window hid to the tray as the game started',
    log.includes('window hidden to the tray after an instant launch') || d.readLog().includes('window hidden to the tray after an instant launch'),
  );

  const after = d.fakeReport();
  d.check(
    'still nothing closed, started, or written',
    after.processEvents.length === 0 && after.registryWrites.length === 0,
    JSON.stringify(after.processEvents),
  );
  d.check('loginusers.vdf is still untouched', d.launcherFile('steam/config/loginusers.vdf') === original);
  d.check('still no snapshot and no journal', (await d.invoke('backups:list', { launcher: 'steam' })).snapshots.length === 0 && !journalExists(d));
  d.check('the history still holds the one pair', (await d.invoke('launch:recent', { limit: 10 })).recent.length === 1);

  const handover = await d.secondInstance();
  d.check('a second start brings the window back', handover === 0, `code=${handover}`);
  await d.waitFor(() => document.visibilityState === 'visible');
  await d.shot('after-instant-play');
};
