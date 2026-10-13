// Closing the window while a switch runs, through the caption button's path (WM_CLOSE, see Driver.closeWindow),
// with "Keep running in the system tray" off (on, the default, a close only hides the window; see close-to-tray.mjs).
// The prompt is native, so the scenario answers it through knobs.json: "Keep running" leaves the app and the
// switch where they are; "Quit anyway" aborts the switch and exits with 0, the journal settled. The fake Epic
// launcher never signs in, so the switch is parked in "Sign in" meanwhile.
import { sleep } from '../app-driver.mjs';
import { finishDialog, journalExists, startPlay, watchDialog } from './lib.mjs';

const HANG = { knobs: { epic: { reactMs: 600_000 } } };

export const name = 'quit-during-switch';
export const options = { fake: 'all-four', knobs: { ...HANG, quitDuringSwitch: 'keep' } };

export default async (d) => {
  await d.waitFor('Rocket League');
  await d.invoke('settings:set', { key: 'window.closeToTray', value: 'false' });

  await startPlay(d, { game: 'Rocket League®', account: 'Alt', tag: 'keep' });
  await watchDialog(d, { until: (t) => t.includes('Sign in…'), tag: 'keep' });
  d.closeWindow();
  await sleep(2_000);
  d.check('Keep running: the app is still up', d.exitCode === null && (await d.evaluate('1 + 1')) === 2);
  d.check('Keep running: the prompt was answered by the scenario', d.readLog().includes('"answer":"keep"'));
  d.check('Keep running: the switch is still running', await d.has('Sign in…'));
  await d.shot('kept-running');
  await d.click('Stop');
  await watchDialog(d, { until: (t) => t.includes('Nothing was rolled back'), tag: 'keep' });
  await finishDialog(d, 'keep');

  await d.restart({ knobs: { ...HANG, quitDuringSwitch: 'quit' } });
  await d.waitFor('Rocket League');
  await startPlay(d, { game: 'Rocket League®', account: 'Alt', tag: 'quit' });
  await watchDialog(d, { until: (t) => t.includes('Sign in…'), tag: 'quit' });
  await d.shot('before-quit');
  d.closeWindow();
  const code = await d.waitForExit();
  d.check('Quit anyway: the app exits with 0', code === 0, `code=${code}`);
  const log = d.readLog();
  d.check('Quit anyway: the prompt was answered by the scenario', log.includes('"answer":"quit"'));
  d.check('Quit anyway: the switch was stopped before the window went', log.includes('quit confirmed during a switch') && log.includes('"state":"cancelled"'));
  d.check('Quit anyway: the journal settled', !journalExists(d));
};
