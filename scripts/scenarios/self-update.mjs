// Steam updates itself when it is started: the sign-in wait reports the update instead of timing out, and the
// switch finishes once the updated client signs in.
import { finishDialog, startPlay, watchDialog } from './lib.mjs';

export const name = 'self-update';
export const options = { fake: 'all-four', knobs: { knobs: { steam: { selfUpdateMs: 3_000 } } } };

export default async (d) => {
  await d.waitFor('Rocket League');

  await startPlay(d, { game: 'Rocket League', account: 'Persona Three', tag: 'update' });
  await watchDialog(d, { until: (t) => t.includes('Show details'), tag: 'update' });
  await d.click('Show details');
  await watchDialog(d, { until: (t) => t.includes('Steam is updating itself first'), tag: 'update' });
  await d.shot('updating');
  const text = await watchDialog(d, { until: (t) => t.includes('Launched as'), tag: 'update' });
  d.check(
    'the details say the update finished before the sign-in',
    text.includes('Steam finished updating itself.') || text.includes('Steam signed in as user_3.'),
  );
  await finishDialog(d, 'update');

  const report = d.fakeReport();
  d.check('the game was launched after the update', report.opened.includes('steam://rungameid/252950'), report.opened.join(' '));
  d.check(
    'the account was written before the start',
    report.registryWrites.some((w) => w.path.endsWith('\\AutoLoginUser') && w.value === 'user_3'),
  );
};
