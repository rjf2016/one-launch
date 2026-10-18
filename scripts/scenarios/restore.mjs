// Settings › Backups: after a real Steam switch, restoring the pre-switch snapshot puts loginusers.vdf and
// AutoLoginUser back. While Steam runs the restore is refused; after a second start (Steam closed) it goes through.
import { fixture, playThrough } from './lib.mjs';

export const name = 'restore';
export const options = { fake: 'all-four' };

export default async (d) => {
  await d.waitFor('Rocket League');
  const original = fixture('steam/loginusers.vdf');

  await playThrough(d, { game: 'Rocket League', account: 'Persona Three', launcher: 'steam' });
  d.check('the switch changed loginusers.vdf', d.launcherFile('steam/config/loginusers.vdf') !== original);
  const [snapshot] = (await d.invoke('backups:list', { launcher: 'steam' })).snapshots;
  d.check('one snapshot, taken before the switch', Boolean(snapshot) && snapshot.reason === 'Before switching to Persona Three', snapshot?.reason);

  const refused = await d.invokeRaw('backups:restore', { launcher: 'steam', id: snapshot.id });
  d.check('a restore is refused while Steam runs', refused.ok === false && refused.error.code === 'LAUNCHER_RUNNING', JSON.stringify(refused.error));

  await d.restart();
  await d.waitFor('Rescan');
  await d.click('Settings');
  await d.waitFor('Advanced');
  await d.click('Backups');
  await d.waitFor('Snapshots to keep');
  await d.click({ contains: '1 snapshot' });
  await d.waitFor('Before switching to Persona Three');
  await d.find('Restore', 0);
  await d.shot('backups');
  await d.click('Restore');
  await d.waitFor('Restore this snapshot');
  d.check('the confirmation says Steam must be closed first', await d.has('Steam must be closed first'));
  await d.shot('restore-confirm');
  await d.click('Restore this snapshot');
  await d.waitFor('Restored snapshot');
  await d.shot('restored');

  d.check('loginusers.vdf is byte for byte the original', d.launcherFile('steam/config/loginusers.vdf') === original);
  const report = d.fakeReport();
  d.check(
    'AutoLoginUser was put back to user_1',
    report.registryWrites.some((w) => w.path.endsWith('\\AutoLoginUser') && w.value === 'user_1'),
    JSON.stringify(report.registryWrites),
  );
  const { snapshots } = await d.invoke('backups:list', { launcher: 'steam' });
  d.check(
    'a "before restoring" snapshot was added',
    snapshots.length === 2 && snapshots.some((s) => s.reason.startsWith('Before restoring')),
    snapshots.map((s) => s.reason).join(' | '),
  );
};
