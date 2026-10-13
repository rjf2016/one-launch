// Play a Steam game on a non-current account against the fake Steam.
import { playThrough } from './lib.mjs';

export const name = 'play-steam';
export const options = { fake: 'all-four' };

export default async (d) => {
  await d.waitFor('Rocket League');
  await playThrough(d, { game: 'Rocket League', account: 'Persona Three', launcher: 'steam' });
  const report = d.fakeReport();
  d.check('the game was launched through steam://', report.opened.includes('steam://rungameid/252950'), report.opened.join(' '));
  d.check(
    'Steam was started for the switch',
    report.processEvents.some((e) => e.kind === 'start' && e.exe.toLowerCase().endsWith('steam.exe')),
  );
  d.check(
    'the account was written to the registry',
    report.registryWrites.some((w) => w.path.includes('AutoLoginUser')),
    JSON.stringify(report.registryWrites),
  );
  d.check('one snapshot was taken', (await d.invoke('backups:list', { launcher: 'steam' })).snapshots.length === 1);
};
