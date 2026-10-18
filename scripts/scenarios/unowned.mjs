// The launcher remembers a sign-in that no One Launch account owns (scenario "unowned": Epic, Battle.net and Riot).
// The plan warns before the switch, the snapshot taken before it is pinned ("Kept" in Settings › Backups), and
// restoring that snapshot brings the sign-in back.
import { fixture, playThrough, switchThrough } from './lib.mjs';

const INI = 'localappdata/EpicGamesLauncher/Saved/Config/Windows/GameUserSettings.ini';

export const name = 'unowned';
export const options = { fake: 'unowned' };

export default async (d) => {
  await d.waitFor('Rocket League');
  const original = fixture('epic/GameUserSettings.ini');

  const { preflight } = await d.invoke('launch:preflight', { accountId: (await d.invoke('accounts:list')).accounts.find((a) => a.launcher === 'epic').id });
  d.check(
    'the plan warns that the remembered session belongs to nobody',
    preflight.plan.warnings.some((w) => w.includes('remembers a session that no One Launch account owns')),
    preflight.plan.warnings.join(' | '),
  );

  let text = await playThrough(d, { game: 'Rocket League®', account: 'Alt', launcher: 'epic' });
  d.check('Epic: launched as Alt', text.includes('Launched as Alt'));
  text = await playThrough(d, { game: 'Overwatch', account: 'Alt', launcher: 'battlenet' });
  d.check('Battle.net: launched as Alt', text.includes('Launched as Alt'));
  d.check('the settings file now holds Alt’s session', d.launcherFile(INI) !== original);
  text = await switchThrough(d, { account: 'Riot Alt', login: 'riot_alt', launcher: 'riot' });
  d.check('Riot: switched to Riot Alt', text.includes('Switched to Riot Alt'));

  for (const launcher of ['epic', 'battlenet', 'riot']) {
    const { snapshots } = await d.invoke('backups:list', { launcher });
    d.check(
      `${launcher}: the pre-switch snapshot is pinned`,
      snapshots.length === 1 && snapshots[0].pinned !== null,
      JSON.stringify(snapshots.map((s) => s.pinned)),
    );
  }

  await d.restart();
  await d.waitFor('Rescan');
  // Settings › Backups lists Epic's snapshot first, so the restore below is Epic's; Riot's pinned snapshot is checked above.
  await d.click('Settings');
  await d.waitFor('Advanced');
  await d.click('Backups');
  await d.waitFor('Snapshots to keep');
  await d.click({ contains: '1 snapshot' });
  await d.waitFor('Kept');
  await d.find('Restore', 0);
  await d.shot('backups-kept');
  await d.click('Restore');
  await d.waitFor('Restore this snapshot');
  await d.shot('restore-confirm');
  await d.click('Restore this snapshot');
  await d.waitFor('Restored snapshot');
  await d.shot('restored');
  d.check('the restore put the unowned sign-in back byte for byte', d.launcherFile(INI) === original);
  const { snapshots } = await d.invoke('backups:list', { launcher: 'epic' });
  d.check(
    'a "before restoring" snapshot was added and the Kept one stays',
    snapshots.length === 2 && snapshots.some((s) => s.pinned !== null),
    JSON.stringify(snapshots.map((s) => s.reason)),
  );
};
