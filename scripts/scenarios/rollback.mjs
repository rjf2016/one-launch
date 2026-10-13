// Steam never comes back after the writes (a start that shows no steam.exe): the switch fails after its first
// write, so the adapter restores the snapshot. loginusers.vdf ends byte for byte as it began, AutoLoginUser is put
// back, and the dialog says so.
import { playThrough, fixture, journalExists } from './lib.mjs';

export const name = 'rollback';
export const options = {
  fake: 'all-four',
  knobs: { processes: { startFails: ['steam.exe'] }, timing: { steam: { startupMs: 1_500 } } },
};

export default async (d) => {
  await d.waitFor('Rocket League');
  const original = fixture('steam/loginusers.vdf');
  d.check('the scratch copy starts as the fixture', d.launcherFile('steam/config/loginusers.vdf') === original);

  const text = await playThrough(d, { game: 'Rocket League', account: 'Persona Three', launcher: 'steam', expect: 'put back the way it was' });
  d.check('the dialog names the cause', text.includes('steam.exe did not appear within 1.5 s'));
  d.check('the dialog says Steam was put back and left closed', text.includes('Steam was put back the way it was and left closed.'));

  const report = d.fakeReport();
  const autoLogin = report.registryWrites.filter((w) => w.path.endsWith('\\AutoLoginUser')).map((w) => w.value);
  d.check('AutoLoginUser was set to user_3 and then back to user_1', autoLogin.join(',') === 'user_3,user_1', autoLogin.join(','));
  d.check('loginusers.vdf is byte for byte the original', d.launcherFile('steam/config/loginusers.vdf') === original);
  d.check('the game was never launched', report.opened.length === 0, report.opened.join(' '));
  d.check('one snapshot was taken', (await d.invoke('backups:list', { launcher: 'steam' })).snapshots.length === 1);
  d.check('the journal is gone: the rollback settled the switch', !journalExists(d));
  d.check('no launch in the history', (await d.invoke('launch:recent', { limit: 10 })).recent.length === 0);

  d.assertNoErrorLines([/\[main:steam\] switch failed /]);
};
