// One Launch dies mid-switch (killHard, as a crash or power cut would) after Epic's settings file was rewritten and
// the launcher restarted. The next start finds the journal and asks: Restore snapshot puts the file back byte for
// byte; a second crash and Keep as is leaves the launcher alone. The fake launcher never signs in, so the switch
// is parked in "Sign in" for as long as the scenario needs. The first crash waits for the vault key to reach disk:
// a crash in the first seconds of a data folder's first session loses it, and the snapshot's encrypted file with it.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, readJournal, startPlay, waitForVaultKey, watchDialog } from './lib.mjs';

const INI = 'localappdata/EpicGamesLauncher/Saved/Config/Windows/GameUserSettings.ini';

export const name = 'recovery';
export const options = { fake: 'all-four', knobs: { knobs: { epic: { reactMs: 600_000 } } } };

async function crashDuringSignIn(d, tag) {
  await startPlay(d, { game: 'Rocket League®', account: 'Alt', tag });
  await watchDialog(d, { until: (t) => t.includes('Sign in…'), tag });
  const journal = readJournal(d);
  d.check(
    `${tag}: the journal names the snapshot and a post-write step`,
    journal?.backupId && ['start', 'wait', 'verify'].includes(journal.stepId),
    JSON.stringify(journal),
  );
  await d.shot(`${tag}-before-crash`);
  await d.killHard();
  d.check(`${tag}: the journal survives the crash`, existsSync(join(d.dataDir, 'switch.json')));
}

export default async (d) => {
  await d.waitFor('Rocket League');
  const original = fixture('epic/GameUserSettings.ini');
  await waitForVaultKey(d);

  await crashDuringSignIn(d, 'crash-1');
  d.check('the settings file was changed before the crash', d.launcherFile(INI) !== original);
  await d.restart();
  await d.waitFor('One Launch was closed during a switch');
  const { recovery } = await d.invoke('recovery:get');
  d.check(
    'recovery:get reports the signing-in phase with the snapshot available',
    recovery?.phase === 'signing-in' && recovery.snapshotAvailable === true,
    JSON.stringify(recovery),
  );
  d.check('the prompt explains the state and leads with Keep as is', await d.has('was starting or signing in'));
  await d.shot('recovery-prompt');
  await d.click('Restore snapshot');
  await d.waitFor('Epic Games was put back the way it was');
  await d.shot('recovery-restored');
  await d.click('Done');
  d.check('the restore put the settings file back byte for byte', d.launcherFile(INI) === original);
  d.check('the journal is gone', !existsSync(join(d.dataDir, 'switch.json')));
  d.check('recovery:get is now empty', (await d.invoke('recovery:get')).recovery === null);

  await crashDuringSignIn(d, 'crash-2');
  await d.restart();
  await d.waitFor('One Launch was closed during a switch');
  await d.click('Keep as is');
  await d.waitFor('One Launch was closed during a switch', { absent: true });
  d.check('Keep as is leaves the changed file alone', d.launcherFile(INI) !== original);
  d.check('Keep as is deletes the journal', !existsSync(join(d.dataDir, 'switch.json')));
  d.check('recovery:get is empty after Keep as is', (await d.invoke('recovery:get')).recovery === null);
  await d.shot('after-keep');
  const { snapshots } = await d.invoke('backups:list', { launcher: 'epic' });
  d.check('the snapshots stay in Settings › Backups', snapshots.length === 3, snapshots.map((s) => s.reason).join(' | '));
};
