// Play a Battle.net game on a non-current account (a stored token) against the fake Battle.net client.
import { playThrough } from './lib.mjs';

export const name = 'play-battlenet';
export const options = { fake: 'all-four' };

export default async (d) => {
  await d.waitFor('Overwatch');
  await playThrough(d, { game: 'Overwatch', account: 'Alt', launcher: 'battlenet' });
  const report = d.fakeReport();
  d.check(
    'the game was launched with --exec',
    report.processEvents.some((e) => e.kind === 'start' && e.args.some((a) => a.startsWith('--exec=launch'))),
    JSON.stringify(report.processEvents.filter((e) => e.kind === 'start').map((e) => e.args)),
  );
  d.check('the config now lists the account first', /"SavedAccountNames":\s*"saved3@example\.com/.test(d.launcherFile('appdata/Battle.net/Battle.net.config')));
  d.check('one snapshot was taken', (await d.invoke('backups:list', { launcher: 'battlenet' })).snapshots.length === 1);
};
