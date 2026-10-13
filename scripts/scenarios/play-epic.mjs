// Play an Epic game on a non-current account (a remembered session) against the fake Epic Games Launcher.
import { playThrough } from './lib.mjs';

export const name = 'play-epic';
export const options = { fake: 'all-four' };

export default async (d) => {
  await d.waitFor('Rocket League');
  await playThrough(d, { game: 'Rocket League®', account: 'Alt', launcher: 'epic' });
  const report = d.fakeReport();
  d.check(
    'the game was launched through com.epicgames.launcher://',
    report.opened.some((u) => u.startsWith('com.epicgames.launcher://apps/')),
    report.opened.join(' '),
  );
  d.check(
    'the settings file now holds the remembered session',
    d.launcherFile('localappdata/EpicGamesLauncher/Saved/Config/Windows/GameUserSettings.ini').includes('[RememberMe]'),
  );
  d.check('one snapshot was taken', (await d.invoke('backups:list', { launcher: 'epic' })).snapshots.length === 1);
};
