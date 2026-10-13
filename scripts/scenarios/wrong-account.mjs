// Epic's log names an account id the switch did not expect. Account "New" has no Epic id yet (credentials path);
// the "user" signs in as Main's id, which another One Launch account holds: the switch fails and rolls back, and the
// settings file ends byte for byte as it began. A second start with an id nobody holds adopts it instead.
import { finishDialog, fixture, journalExists, startPlay, watchDialog } from './lib.mjs';

const EPIC_MAIN = '3'.repeat(32);
const EPIC_NOBODY = '4'.repeat(32);
const INI = 'localappdata/EpicGamesLauncher/Saved/Config/Windows/GameUserSettings.ini';

export const name = 'wrong-account';
export const options = { fake: 'all-four', knobs: { knobs: { epic: { signInWhenAskedMs: 2_000, signInAs: EPIC_MAIN } } } };

export default async (d) => {
  await d.waitFor('Rocket League');
  const original = fixture('epic/GameUserSettings.ini');
  d.check('the scratch copy starts as the fixture', d.launcherFile(INI) === original);

  await startPlay(d, { game: 'Rocket League®', account: 'New', tag: 'wrong' });
  let text = await watchDialog(d, { until: (t) => t.includes('Stop waiting'), tag: 'wrong' });
  d.check('the credentials path hands over at once', text.includes('Sign in to Epic Games Launcher as new@example.com'));
  await d.shot('wrong-attention');
  text = await watchDialog(d, { until: (t) => t.includes('put back the way it was'), tag: 'wrong' });
  d.check('the failure names the other account', text.includes('signed in as Main (account …333333), which is another One Launch account, instead of New'));
  d.check('the launcher was put back and left closed', text.includes('Epic Games was put back the way it was and left closed.'));
  await finishDialog(d, 'wrong');
  d.check('GameUserSettings.ini is byte for byte the original', d.launcherFile(INI) === original);
  d.check('the journal is gone', !journalExists(d));
  d.check('no launch went out', d.fakeReport().opened.length === 0);
  let { accounts } = await d.invoke('accounts:list');
  d.check('New still has no Epic id', accounts.find((a) => a.launcher === 'epic' && a.displayName === 'New').launcherUid === null);

  await d.restart({ knobs: { knobs: { epic: { signInWhenAskedMs: 2_000, signInAs: EPIC_NOBODY } } } });
  await d.waitFor('Rocket League');
  await startPlay(d, { game: 'Rocket League®', account: 'New', tag: 'adopt' });
  await watchDialog(d, { until: (t) => t.includes('Show details'), tag: 'adopt' });
  await d.click('Show details');
  text = await watchDialog(d, { until: (t) => t.includes('Launched as'), tag: 'adopt' });
  d.check('an id nobody holds is adopted and shown', text.includes('Linked to Epic Games account …4444'));
  await finishDialog(d, 'adopt');
  ({ accounts } = await d.invoke('accounts:list'));
  d.check('New now carries that Epic id', accounts.find((a) => a.launcher === 'epic' && a.displayName === 'New').launcherUid === EPIC_NOBODY);
  d.check('the settings file now remembers the new session', d.launcherFile(INI) !== original && d.launcherFile(INI).includes('[RememberMe]'));
  d.assertNoErrorLines([/\[main:epic\] epic switch failed /]);
};
