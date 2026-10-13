// A PC with no launchers, the CI runner's state: the setup guide on a new data folder, each of its five steps, Back,
// finishing into an account form, four "Not installed" rows in Settings, "Show again" and Escape, then a second start
// on the same folder with no guide. The runner checks that the app quits with 0 and logs no ERROR line.
import { sleep } from '../app-driver.mjs';

export const name = 'first-run';
export const options = { fake: 'none' };

const settle = () => sleep(900);
const count = (d, text) => d.evaluate((t) => document.body.innerText.split(t).length - 1, text);

export default async (d) => {
  await d.waitFor('Welcome to One Launch');
  d.check('the guide is a modal dialog', await d.evaluate(() => document.querySelector('[role="dialog"][aria-modal="true"]') !== null));
  await settle();
  await d.shot('welcome');

  await d.click('Get started');
  await d.waitFor('Your launchers');
  const locate = await d.evaluate(() => [...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Locate…').length);
  d.check('every launcher row offers Locate', locate === 4, String(locate));
  d.check('the step says no launcher was found', await d.has('No launcher was found on this PC'));
  await settle();
  await d.shot('launchers');

  await d.click('Continue');
  await d.waitFor('Play switches accounts for you');
  d.check('the Play step shows the five phases', (await d.has('Close Steam')) && (await d.has('Launch Counter-Strike 2')));
  await settle();
  await d.shot('play');

  await d.click('Continue');
  await d.waitFor('Add your accounts');
  d.check('nothing to import without a launcher', await d.has('nothing to import yet'));
  await d.click('Riot Games');
  d.check(
    'a launcher can be picked for adding by hand',
    await d.evaluate(() => document.querySelector('button[aria-pressed="true"]')?.textContent.trim() === 'Riot Games'),
  );
  await settle();
  await d.shot('accounts');

  await d.click('Continue');
  await d.waitFor('Almost there');
  d.check('the last step offers the Riot Games account form', await d.has('Add a Riot Games account'));
  await settle();
  await d.shot('ready');
  await d.click('Back');
  await d.waitFor('Add your accounts');
  await d.click('Continue');
  await d.waitFor('Almost there');
  await d.click('Add a Riot Games account');
  await d.waitFor('Display name');
  d.check('finishing with a launcher closes the guide and opens its account form', !(await d.has('Welcome to One Launch')) && (await d.has('Display name')));
  await settle();
  await d.shot('account-form');

  await d.click('Settings');
  await d.waitFor('Advanced');
  const notInstalled = await count(d, 'Not installed');
  d.check('every launcher row says Not installed', notInstalled >= 4, String(notInstalled));
  await settle();
  await d.shot('settings-no-launchers');
  await d.click('Show again');
  await d.waitFor('Welcome to One Launch');
  d.check('Settings brings the guide back', await d.has('Get started'));
  await d.key('Escape');
  await d.waitFor('Welcome to One Launch', { absent: true });
  d.check('Escape closes it', !(await d.has('Get started')));

  await d.restart();
  await d.waitFor('Rescan');
  await sleep(1000);
  d.check('a second start on the same folder shows no guide', !(await d.has('Welcome to One Launch')));
  await settle();
  await d.shot('second-start');
};
