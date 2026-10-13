// Overwatch was started from the Battle.net window and the client has since gone (its launch setting, or closed by
// hand) while the game runs on. The switch starts the client, which sees the game, and the launch is refused at once
// with the client's own reason instead of sending a command the client drops and watching 15 s for a start that never
// comes.
import { finishDialog, startPlay, watchDialog } from './lib.mjs';

export const name = 'game-running';
export const options = { fake: 'all-four', knobs: { knobs: { battlenet: { gamesRunning: ['prometheus'] } } } };

export default async (d) => {
  await d.waitFor('Overwatch');
  await startPlay(d, { game: 'Overwatch', account: 'Alt', tag: 'game-running' });
  const text = await watchDialog(d, { until: (t) => t.includes('only the game launch failed'), tag: 'game-running' });
  d.check('the launch was refused with the client’s reason', text.includes('Battle.net: Overwatch is already running. Close it, then press Play again.'));
  d.check('the switch itself counts', text.includes('Battle.net is signed in as Alt; only the game launch failed.'));
  await finishDialog(d, 'game-running');

  const report = d.fakeReport();
  d.check(
    'no launch command was sent: the client only started',
    !report.processEvents.some((e) => e.args.some((a) => a.startsWith('--exec='))) &&
      report.processEvents.filter((e) => e.kind === 'start' && /Battle\.net( Launcher)?\.exe$/.test(e.exe)).length === 1,
    JSON.stringify(report.processEvents),
  );
  d.check('the switch wrote the account', report.registryWrites.length > 0);
  d.check('no launch in the history', (await d.invoke('launch:recent', { limit: 10 })).recent.length === 0);
};
