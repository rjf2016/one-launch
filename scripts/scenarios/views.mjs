// Screenshots of every view at the default and the minimum window size, plus the library's search, sort menu,
// and card menu by keyboard. The check for any renderer change. Runs against fake launchers (--fake) or, read-only,
// against whatever this PC has; on a folder with no accounts it screenshots and skips the setup guide, then seeds
// three placeholder accounts over IPC.
import { sleep } from '../app-driver.mjs';
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

  // A launcher that signs in from a saved sign-in shows the Saved sign-in panel; read-only against a real client.
  const withPanel = accounts.find((a) => a.launcher === 'riot') ?? accounts.find((a) => a.launcher === 'epic' || a.launcher === 'battlenet');
  if (withPanel) {
    await d.click('Accounts');
    await d.waitFor(withPanel.displayName);
    await d.click({ contains: withPanel.displayName });
    await d.waitFor('Saved sign-in');
    await d.viewport(1280, 1500);
    await d.shot('account-detail-saved-sign-in');
    await d.viewport(null);
  }

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

  const SETTINGS_TABS = [
    ['General', 'Minimize One Launch to System Tray'],
    ['Launchers', 'Re-check'],
    ['Artwork', 'Fetch artwork automatically'],
    ['Backups', 'Snapshots to keep'],
    ['Advanced', 'Launching'],
  ];
  const openTab = async (tab, marker) => {
    await d.click(tab);
    await d.waitFor(marker);
    // The strip's colour transition is still running when the panel's text appears.
    await sleep(200);
  };

  await d.click('Settings');
  await d.waitFor('Minimize One Launch to System Tray');
  await d.shot('settings');
  for (const [tab, marker] of SETTINGS_TABS.slice(1)) {
    await openTab(tab, marker);
    await d.shot(`settings-${tab.toLowerCase()}`);
  }

  // The narrowest a row ever gets: the minimum window with the sidebar held open.
  await d.viewport(960, 600);
  await d.key('b', { ctrl: true });
  await d.waitFor(() => document.querySelector('aside')?.hasAttribute('data-collapsed') === false);
  for (const [tab, marker] of SETTINGS_TABS) {
    await openTab(tab, marker);
    await d.shot(`settings-${tab.toLowerCase()}-960x600`);
    const wrapped = await d.evaluate(() =>
      [...document.querySelectorAll('[role="tabpanel"] .text-xs.text-muted')]
        .filter((el) => {
          const cs = getComputedStyle(el);
          return el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) > parseFloat(cs.lineHeight) + 1;
        })
        .map((el) => el.textContent),
    );
    d.check(`${tab}: no hint or description wraps at 960 px with the sidebar open`, wrapped.length === 0, wrapped.join(' | '));
  }
  await d.viewport(null);

  await d.focus('General');
  await d.key('ArrowRight');
  d.check(
    'ArrowRight on a settings tab selects and focuses the next one',
    await d.evaluate(() => {
      const el = document.activeElement;
      return el?.getAttribute('role') === 'tab' && el.textContent === 'Launchers' && el.getAttribute('aria-selected') === 'true';
    }),
  );
  await d.click('General');
  await d.waitFor('Minimize One Launch to System Tray');

  const hasNotes = await d.evaluate(() => {
    const button = document.querySelector('button[aria-label="Show what\'s new"]');
    return button !== null && !button.disabled;
  });
  if (hasNotes) {
    await d.click("Show what's new");
    await d.waitFor(() => document.querySelector('[role="dialog"][aria-labelledby="whats-new-title"]') !== null);
    await sleep(900);
    await d.shot('whats-new');
    await d.viewport(960, 600);
    await d.shot('whats-new-960x600');
    await d.viewport(null);
    await d.key('Escape');
    await d.waitFor(() => document.querySelector('[role="dialog"][aria-labelledby="whats-new-title"]') !== null, { absent: true });
  }
};
