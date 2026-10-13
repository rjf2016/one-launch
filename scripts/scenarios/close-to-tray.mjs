// Closing the window keeps One Launch in the system tray by default: the window hides, the app stays up, and a
// second start (a second click on the shortcut) brings the window back. Turning the setting off in Settings ›
// General makes the same close quit. The tray icon itself cannot be clicked over CDP; the second start is the
// drivable way back.
import { sleep } from '../app-driver.mjs';

export const name = 'close-to-tray';

const LABEL = 'Keep running in the system tray';
const trayChecked = (d) => d.evaluate((label) => document.querySelector(`[role="switch"][aria-label="${label}"]`)?.getAttribute('aria-checked'), LABEL);

export default async (d) => {
  await d.click('Settings');
  await d.waitFor(LABEL);
  await d.waitFor(() => !document.querySelector('[role="switch"][aria-label="Keep running in the system tray"]')?.hasAttribute('disabled'));
  d.check('the toggle is on by default', (await trayChecked(d)) === 'true');
  d.check('nothing is stored for it yet', (await d.invoke('settings:getAll')).settings['window.closeToTray'] === undefined);
  await d.shot('settings-general');

  d.closeWindow();
  await sleep(1_500);
  d.check('the app is still up after the close', d.exitCode === null);
  d.check('the window is hidden', (await d.evaluate('document.visibilityState')) === 'hidden');
  d.check('the log says the window went to the tray', d.readLog().includes('window hidden to the tray'));

  const handover = await d.secondInstance();
  d.check('a second start hands over and exits with 0', handover === 0, `code=${handover}`);
  await d.waitFor(() => document.visibilityState === 'visible');
  d.check('the second start brought the window back', (await d.evaluate('document.visibilityState')) === 'visible');
  await d.shot('after-second-start');

  await d.click(LABEL);
  await d.waitFor(() => document.querySelector('[role="switch"][aria-label="Keep running in the system tray"]')?.getAttribute('aria-checked') === 'false');
  d.check('the setting is stored off', (await d.invoke('settings:getAll')).settings['window.closeToTray'] === 'false');
  // A capture right after the flip still shows the old frame; give the toggle its transition.
  await sleep(400);
  await d.shot('settings-tray-off');

  d.closeWindow();
  const code = await d.waitForExit();
  d.check('with the setting off, closing the window quits with 0', code === 0, `code=${code}`);
};
