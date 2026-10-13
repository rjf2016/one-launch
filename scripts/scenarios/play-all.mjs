// Play on each fake launcher on a non-current account, in one app session: every dialog stage, one snapshot per
// switch, the launch command or URI recorded by the fake platform, and no ERROR line. What CI runs.
import { playThrough } from './lib.mjs';

export const name = 'play-all';
export const options = { fake: 'all-four' };

export default async (d) => {
  await d.waitFor('Rocket League');

  await playThrough(d, { game: 'Rocket League', account: 'Persona Three', launcher: 'steam' });
  let report = d.fakeReport();
  d.check('Steam: the game was launched through steam://', report.opened.includes('steam://rungameid/252950'), report.opened.join(' '));
  d.check('Steam: one snapshot was taken', (await d.invoke('backups:list', { launcher: 'steam' })).snapshots.length === 1);
  d.check(
    'Steam: loginusers.vdf now marks user_3 for automatic sign-in',
    /"AutoLogin"\s+"1"[\s\S]*?"Timestamp"/.test(d.launcherFile('steam/config/loginusers.vdf')),
  );

  await playThrough(d, { game: 'Rocket League®', account: 'Alt', launcher: 'epic' });
  report = d.fakeReport();
  d.check(
    'Epic: the game was launched through com.epicgames.launcher://',
    report.opened.some((u) => u.startsWith('com.epicgames.launcher://apps/')),
    report.opened.join(' '),
  );
  d.check('Epic: one snapshot was taken', (await d.invoke('backups:list', { launcher: 'epic' })).snapshots.length === 1);

  await playThrough(d, { game: 'Overwatch', account: 'Alt', launcher: 'battlenet' });
  report = d.fakeReport();
  d.check(
    'Battle.net: the game was launched with --exec',
    report.processEvents.some((e) => e.kind === 'start' && e.args.some((a) => a.startsWith('--exec=launch'))),
    JSON.stringify(report.processEvents.filter((e) => e.kind === 'start').map((e) => e.args)),
  );
  d.check('Battle.net: one snapshot was taken', (await d.invoke('backups:list', { launcher: 'battlenet' })).snapshots.length === 1);

  const riotText = await playThrough(d, { game: 'VALORANT', account: 'Riot Alt', launcher: 'riot' });
  d.check('Riot: One Launch pressed Play and the game started', riotText.includes('Launched as Riot Alt') && !riotText.includes('Press Play'));
  report = d.fakeReport();
  d.check(
    'Riot: one launch request went to the client’s local server, for VALORANT',
    JSON.stringify(report.riotLaunchRequests) === JSON.stringify(['valorant.live']),
    JSON.stringify(report.riotLaunchRequests),
  );
  const riotStarts = report.processEvents.filter((e) => e.kind === 'start' && e.exe.endsWith('RiotClientServices.exe')).map((e) => e.args);
  d.check(
    'Riot: the client was started once, with the shortcut’s launch arguments, and no game process was touched',
    JSON.stringify(riotStarts) === JSON.stringify([['--launch-product=valorant', '--launch-patchline=live']]) &&
      report.processEvents.filter((e) => /riot/i.test(e.exe)).every((e) => /RiotClientServices\.exe|Riot Client\.exe/.test(e.exe)),
    JSON.stringify(report.processEvents.filter((e) => /riot/i.test(e.exe))),
  );
  d.check('Riot: one snapshot was taken', (await d.invoke('backups:list', { launcher: 'riot' })).snapshots.length === 1);

  const { recent } = await d.invoke('launch:recent', { limit: 10 });
  d.check('four launches in the history', recent.length === 4, recent.map((l) => `${l.launcher}:${l.accountName}`).join(' '));
  d.check(
    'no registry write outside the fake registry',
    report.registryWrites.every((w) => w.path.startsWith('HKCU\\')),
    JSON.stringify(report.registryWrites),
  );
};
