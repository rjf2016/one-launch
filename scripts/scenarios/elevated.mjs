// Steam runs as administrator and Windows refuses to end it: the graceful shutdown times out, the kill is denied,
// and the switch fails before anything was changed, with the adapter's own sentence.
import { playThrough } from './lib.mjs';

export const name = 'elevated';
export const options = {
  fake: 'all-four',
  knobs: {
    knobs: { steam: { runningAs: 'user_1' } },
    processes: { elevated: ['steam.exe'], shutdownPolls: 100_000 },
    timing: { steam: { shutdownMs: 1_000, killGraceMs: 500 } },
  },
};

export default async (d) => {
  await d.waitFor('Rocket League');
  const original = d.launcherFile('steam/config/loginusers.vdf');

  const text = await playThrough(d, { game: 'Rocket League', account: 'Persona Three', launcher: 'steam', expect: 'Nothing had been changed yet.' });
  d.check(
    'the dialog explains the elevated launcher',
    text.includes('Windows would not let One Launch close steam.exe. It is most likely running as administrator'),
  );

  const report = d.fakeReport();
  d.check(
    'Steam was asked to shut down, then the kill was refused',
    report.processEvents.some((e) => e.args.includes('-shutdown')) && report.processEvents.some((e) => e.kind === 'kill'),
    JSON.stringify(report.processEvents),
  );
  d.check('nothing was written', report.registryWrites.length === 0 && d.launcherFile('steam/config/loginusers.vdf') === original);
  d.check('no snapshot was taken', (await d.invoke('backups:list', { launcher: 'steam' })).snapshots.length === 0);
  d.check('the game was never launched', report.opened.length === 0);
};
