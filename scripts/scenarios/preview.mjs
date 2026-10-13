// Preview mode: the Settings switch, the sidebar card, the dialog's preview stage (the plan, nothing done),
// launch:start refused with DRY_RUN, then "Turn preview off and play now" runs the real switch.
import { finishDialog, startPlay, watchDialog } from './lib.mjs';

export const name = 'preview';
export const options = { fake: 'all-four' };

export default async (d) => {
  await d.waitFor('Rocket League');
  d.check('preview mode starts off', (await d.invoke('settings:get', { key: 'dryRun' })).value !== 'true');

  await d.click('Settings');
  await d.waitFor('Advanced');
  await d.click({ selector: '[role="switch"][aria-label="Preview mode"]' });
  await d.waitFor('Preview mode is on');
  d.check('the switch stores dryRun=true', (await d.invoke('settings:get', { key: 'dryRun' })).value === 'true');
  await d.shot('settings-preview-on');

  await d.click('Library');
  await d.waitFor('Rescan');
  const persona = (await d.invoke('accounts:list')).accounts.find((a) => a.displayName === 'Persona Three');
  const refused = await d.invokeRaw('launch:start', { accountId: persona.id, gameId: null, confirmClose: false });
  d.check('launch:start is refused with DRY_RUN', refused.ok === false && refused.error.code === 'DRY_RUN', JSON.stringify(refused.error));

  await startPlay(d, { game: 'Rocket League', account: 'Persona Three', tag: 'preview' });
  await d.waitFor('Preview mode is on, so nothing happened.');
  const text = await d.text();
  d.check(
    'the preview lists the phases a real switch would run',
    ['Switch to Persona Three', 'Start Steam', 'Sign in', 'Launch Rocket League'].every((p) => text.includes(p)),
  );
  await d.shot('preview-stage');
  await d.click('Details');
  await d.waitFor('steps would run');
  await d.shot('preview-details');
  let report = d.fakeReport();
  d.check(
    'the preview wrote nothing and started nothing',
    report.registryWrites.length === 0 && report.processEvents.length === 0 && report.opened.length === 0,
  );

  await d.click('Turn preview off and play now');
  await watchDialog(d, { until: (t) => t.includes('Launched as'), tag: 'preview' });
  await finishDialog(d, 'preview');
  d.check('the switch turned preview mode off', (await d.invoke('settings:get', { key: 'dryRun' })).value === 'false');
  d.check('the sidebar card is gone', !(await d.has('Preview mode is on')));
  report = d.fakeReport();
  d.check('the real switch then ran', report.opened.includes('steam://rungameid/252950') && report.registryWrites.length > 0);
  await d.shot('after-preview');
};
