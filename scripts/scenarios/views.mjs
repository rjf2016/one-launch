// Screenshots of every view at the default and the minimum window size, plus the library's search, sort menu,
// and card menu by keyboard. The check for any renderer change. Runs against fake launchers (--fake) or, read-only,
// against whatever this PC has; on a folder with no accounts it screenshots and skips the setup guide, then seeds
// three placeholder accounts over IPC.
import { skipSetup } from './lib.mjs';

export const name = 'views';

const SEED = [
  { launcher: 'steam', displayName: 'Persona One', login: 'user_1' },
  { launcher: 'epic', displayName: 'Alt', login: 'alt@example.com' },
  { launcher: 'battlenet', displayName: 'Saved Three', login: 'saved3@example.com' },
];

export default async (d) => {
  if (!d.fake) await d.invoke('settings:set', { key: 'artwork.autoFetch', value: 'false' });
  if (!(await skipSetup(d, { shot: 'setup-guide' }))) await d.shot('library-first-start');

  let { accounts } = await d.invoke('accounts:list');
  if (accounts.length === 0) {
    for (const a of SEED) await d.invoke('accounts:create', a);
    accounts = (await d.invoke('accounts:list')).accounts;
  }
  d.check('accounts to show', accounts.length > 0, `${accounts.length} accounts`);

  await d.click('Accounts');
  await d.waitFor(accounts[0].displayName);
  await d.shot('accounts');
  await d.click({ contains: accounts[0].displayName });
  await d.waitFor('Display name');
  await d.shot('account-detail');

  await d.click('Library');
  await d.waitFor('Rescan');
  const { games } = await d.invoke('library:list');
  d.check('library answers', Array.isArray(games), `${games.length} games`);
  await d.shot('library');
  await d.viewport(960, 600);
  await d.shot('library-960x600');
  await d.viewport(null);

  await d.focus({ selector: 'input[aria-label="Search games"]' });
  await d.type('a');
  await d.shot('library-search');
  await d.click('Clear search');

  await d.focus({ contains: 'Sort:' });
  await d.key('Enter');
  await d.shot('sort-menu');
  await d.key('Escape');

  if (games.length > 0) {
    await d.focus({ contains: 'More for ' });
    await d.key('Enter');
    d.check('Enter on a card menu button opens the menu', await d.waitFor('Refresh artwork'));
    await d.shot('card-menu');
    await d.key('ArrowDown');
    await d.key('Escape');
    d.check(
      'Escape closes the menu and leaves the button focused',
      await d.evaluate(
        () => !document.body.innerText.includes('Refresh artwork') && (document.activeElement?.getAttribute('aria-label') ?? '').startsWith('More for '),
      ),
    );
  }

  await d.click('Settings');
  await d.waitFor('Advanced');
  await d.shot('settings');
  await d.viewport(960, 600);
  await d.shot('settings-960x600');
  await d.viewport(null);
};
