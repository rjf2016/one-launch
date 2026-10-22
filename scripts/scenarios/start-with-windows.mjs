import { execFileSync } from 'node:child_process';
import { sleep } from '../app-driver.mjs';

export const name = 'start-with-windows';
export const options = { args: ['--start-hidden'] };

const AUTOSTART = 'Start with Windows';
const TRAY = 'Minimize One Launch to System Tray';
const switchState = (d, label) => d.evaluate((l) => document.querySelector(`[role="switch"][aria-label="${l}"]`)?.getAttribute('aria-checked'), label);
const switchEnabled = (d, label) => d.evaluate((l) => document.querySelector(`[role="switch"][aria-label="${l}"]`)?.hasAttribute('disabled') === false, label);
const count = (d, text) => d.readLog().split(text).length - 1;
const lastStartup = (d) => JSON.parse([...d.readLog().matchAll(/\[main\] startup (\{.*\})/g)].at(-1)[1]);
// visibilityState cannot tell: a window created hidden still renders (paintWhenInitiallyHidden), so its page reads visible. Windows names a process's main window only while it is visible.
const windowShown = (d) =>
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${d.child.pid}).MainWindowHandle`], {
    encoding: 'utf8',
  }).trim() !== '0';

async function waitForCount(d, text, n, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (count(d, text) < n && Date.now() < deadline) await sleep(200);
  return count(d, text) >= n;
}

export default async (d) => {
  d.check('the log says it started in the tray', await waitForCount(d, 'started in the tray', 1));
  d.check('the window was never shown', !windowShown(d) && lastStartup(d).windowShownMs === null, `windowShownMs=${lastStartup(d).windowShownMs}`);
  d.check('the app is still up', d.exitCode === null);

  const handover = await d.secondInstance();
  d.check('a second start hands over and exits with 0', handover === 0, `code=${handover}`);
  const shownBy = Date.now() + 3_000;
  while (!windowShown(d) && Date.now() < shownBy) await sleep(200);
  d.check('the second start showed the window', windowShown(d));
  await d.shot('after-second-start');

  await d.click('Settings');
  await d.waitFor(AUTOSTART);
  await d.waitFor(() => !document.querySelector('[role="switch"][aria-label="Start with Windows"]')?.hasAttribute('disabled'));
  d.check('the Start with Windows switch is enabled', await switchEnabled(d, AUTOSTART));
  d.check('it is off', (await switchState(d, AUTOSTART)) === 'false');
  const before = await d.invoke('autostart:status');
  d.check('autostart:status is available and off', before.available === true && before.openAtLogin === false, JSON.stringify(before));
  d.check(
    'it is the first row of General',
    await d.evaluate(() => document.querySelector('[role="switch"]')?.getAttribute('aria-label') === 'Start with Windows'),
  );

  await d.click(AUTOSTART);
  await d.waitFor(() => document.querySelector('[role="switch"][aria-label="Start with Windows"]')?.getAttribute('aria-checked') === 'true');
  const on = await d.invoke('autostart:status');
  d.check('the click turns the login item on', on.openAtLogin === true, JSON.stringify(on));
  // A capture right after the flip still shows the old frame; give the toggle its transition.
  await sleep(400);
  await d.shot('settings-autostart-on');

  await d.click(AUTOSTART);
  await d.waitFor(() => document.querySelector('[role="switch"][aria-label="Start with Windows"]')?.getAttribute('aria-checked') === 'false');
  d.check('a second click turns it off', (await d.invoke('autostart:status')).openAtLogin === false);

  await d.click(TRAY);
  await d.waitFor(() => document.querySelector('[role="switch"][aria-label="Minimize One Launch to System Tray"]')?.getAttribute('aria-checked') === 'false');
  d.check('the tray setting is stored off', (await d.invoke('settings:getAll')).settings['window.closeToTray'] === 'false');

  const startsBefore = count(d, 'started in the tray');
  const copiesBefore = count(d, 'database copied');
  await d.restart();
  d.check(
    'with the tray setting off, the same flag starts the window visible',
    windowShown(d) && lastStartup(d).windowShownMs !== null,
    `windowShownMs=${lastStartup(d).windowShownMs}`,
  );
  d.check('that start ran its deferred block', await waitForCount(d, 'database copied', copiesBefore + 1));
  d.check(
    'the log of that start has no "started in the tray"',
    count(d, 'started in the tray') === startsBefore,
    `before=${startsBefore} after=${count(d, 'started in the tray')}`,
  );
  await d.shot('restart-visible');

  d.closeWindow();
  const code = await d.waitForExit();
  d.check('with the tray setting off, closing the window quits with 0', code === 0, `code=${code}`);
};
