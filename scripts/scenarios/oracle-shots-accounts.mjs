import { sleep } from '../app-driver.mjs';
import { finishDialog, fixture, playThrough, skipSetup, startPlay, watchDialog } from './lib.mjs';

export const area = 'accounts';

export const rows = {
  35: {
    how: 'the Import button is disabled once everything is linked, so the three logins the open Battle.net dialog had selected were imported over IPC (launchers:importAccounts) behind it; its own Import then found nothing new',
  },
  36: { how: 'fault injected in main: accounts:list answers with the error envelope its handler gives for a damaged database' },
  56: {
    how: 'the Riot Client takes 25 polls to exit (processes.shutdownPolls), and a switch to Riot Main was stopped while it closed: the client ends closed, nothing written, after a sign-in by hand without “Stay signed in”',
  },
  62: { how: 'the answer to launchers:rememberedAccounts held in main before Import › From Steam was opened: the dialog is still waiting for the list' },
};

const EPIC_ALT = '2'.repeat(32);
const RIOT_NEW = '44444444-4444-4444-8444-444444444444';
const EPIC_INI = 'localappdata/EpicGamesLauncher/Saved/Config/Windows/GameUserSettings.ini';
const DB_FAULT = { code: 'SQLITE_CORRUPT', message: 'database disk image is malformed' };

const menuOpen = () => document.querySelector('[role="menu"]') !== null;
const dialogOpen = () => document.querySelector('[role="dialog"], [role="alertdialog"]') !== null;
const flashHas = (text) => (document.querySelector('.overflow-y-auto header [role="status"]')?.textContent ?? '').includes(text);
const flashGone = () => !document.querySelector('.overflow-y-auto header [role="status"]')?.textContent;
const sessionChecked = () => {
  const recheck = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Re-check');
  return recheck !== undefined && !recheck.disabled && !document.body.innerText.includes('Checking…');
};
const focusField = (label, select) => {
  const field = [...document.querySelectorAll('label')].find((el) => el.querySelector('span')?.textContent === label);
  const input = field.querySelector('input, textarea');
  input.focus();
  if (select) input.select();
};
const scrollPanel = (title) => {
  const panel = [...document.querySelectorAll('section')].find((el) => el.querySelector('h2')?.textContent === title);
  const page = panel.closest('.overflow-y-auto');
  page.scrollTop += panel.getBoundingClientRect().top - page.querySelector('header').getBoundingClientRect().bottom;
};
const scrollTop = () => {
  document.querySelector('header.sticky').closest('.overflow-y-auto').scrollTop = 0;
};

async function until(d, fn, ...args) {
  const deadline = Date.now() + 10_000;
  while (!(await d.evaluate(fn, ...args))) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${fn.toString().slice(0, 80)} ${JSON.stringify(args)}`);
    await sleep(50);
  }
}

async function flashShot(s, id, text, alsoText = null) {
  await until(s.d, flashHas, text);
  if (alsoText) await s.d.waitFor(alsoText, { everyMs: 50 });
  await s.shot(id);
  if (!(await s.d.evaluate(flashHas, text))) throw new Error(`row ${id}: the flash had gone before the shot was taken`);
  await s.d.waitFor(flashGone, { timeoutMs: 12_000 });
}

async function openList(d, marker) {
  await d.click('Accounts');
  await d.waitFor(marker);
}

async function openAccount(d, login) {
  await openList(d, login);
  await d.click({ contains: login });
  await d.waitFor('Danger zone');
}

async function openMenu(d, trigger) {
  await d.click(trigger);
  await d.waitFor(menuOpen);
}

async function closeMenu(d, trigger) {
  await d.click(trigger);
  await d.waitFor(menuOpen, { absent: true });
}

async function addAccount(d, launcher) {
  await openMenu(d, 'Add account');
  await d.click(launcher);
  await d.waitFor(`New ${launcher} account`);
}

async function importFrom(d, item) {
  await openMenu(d, 'Import');
  await d.click({ contains: item });
  await d.waitFor(dialogOpen);
}

async function typeInto(d, label, text, { select = false } = {}) {
  await d.evaluate(focusField, label, select);
  await d.type(text);
}

async function leaveByShortcut(d, question) {
  await d.evaluate(() => document.activeElement?.blur());
  await d.key('1', { ctrl: true });
  await d.waitFor(question);
}

async function showPanel(d, title) {
  await d.evaluate(scrollPanel, title);
}

async function openSavedSignIn(d, login, marker) {
  await openAccount(d, login);
  await d.waitFor(marker);
  await d.waitFor(sessionChecked);
  await showPanel(d, 'Saved sign-in');
}

export const sessions = [
  {
    name: 'list',
    fake: 'all-four',
    async run(s) {
      const { d } = s;
      await d.waitFor('Rocket League');
      await openList(d, 'user_1');

      await openMenu(d, 'Import');
      await s.shot(32);
      await closeMenu(d, 'Import');

      await openMenu(d, 'Add account');
      await s.shot(33);
      await closeMenu(d, 'Add account');

      await d.click('Library');
      await d.waitFor('Rocket League');
      s.fail('accounts:list', DB_FAULT);
      await d.click('Accounts');
      await d.waitFor('Could not load accounts');
      await s.shot(36);
      s.mend('accounts:list');
      await d.click('Library');
      await d.waitFor('Rocket League');

      await playThrough(d, { game: 'Rocket League', account: 'Persona One', launcher: 'steam' });
      await openList(d, 'Used just now');
      await s.shot(30);
    },
  },
  {
    name: 'empty',
    fake: 'none',
    async run(s) {
      const { d } = s;
      await skipSetup(d);
      await openList(d, 'No accounts yet');
      await s.shot(31);

      await importFrom(d, 'From Steam');
      await d.waitFor('Could not read Steam');
      await s.shot(65);
    },
  },
  {
    name: 'import',
    fake: 'all-four',
    async run(s) {
      const { d } = s;
      await d.waitFor('Rocket League');
      await openList(d, 'user_1');

      s.hold('launchers:rememberedAccounts');
      await importFrom(d, 'From Steam');
      await d.waitFor('Reading loginusers.vdf…');
      await s.shot(62);
      s.release('launchers:rememberedAccounts');
      await d.waitFor('2 selected');
      await s.shot(60);

      await d.click('Import 2');
      await flashShot(s, 34, 'Imported 2 accounts from Steam', 'user_2');

      await importFrom(d, 'From Steam');
      await d.waitFor('Everything here is already in One Launch.');
      await s.shot(64);
      await d.click('Cancel');
      await d.waitFor(dialogOpen, { absent: true });

      await importFrom(d, 'From Battle.net');
      await d.waitFor('3 selected');
      await s.shot(61);

      const { accounts } = await d.invoke('launchers:rememberedAccounts', { launcher: 'battlenet' });
      const selected = accounts.filter((a) => a.linkedAccountId === null).map((a) => a.launcherUid || a.login);
      await d.invoke('launchers:importAccounts', { launcher: 'battlenet', launcherUids: selected });
      await d.click('Import 3');
      await flashShot(s, 35, 'Nothing new to import', 'saved5@example.com');
    },
  },
  {
    name: 'import-empty',
    fake: {
      from: 'all-four',
      change(scenario) {
        scenario.files['steam/config/loginusers.vdf'] = { inline: '"users"\n{\n}\n' };
      },
    },
    async run(s) {
      const { d } = s;
      await d.waitFor('Rocket League');
      await openList(d, 'user_1');
      await importFrom(d, 'From Steam');
      await d.waitFor('Steam has not remembered any account on this PC yet.');
      await s.shot(63);
    },
  },
  {
    name: 'create',
    fake: 'all-four',
    async run(s) {
      const { d } = s;
      await d.waitFor('Rocket League');
      await openList(d, 'user_1');

      await addAccount(d, 'Steam');
      await s.shot(37);

      await typeInto(d, 'Display name', 'Test Persona');
      await leaveByShortcut(d, 'Leave without creating this account?');
      await s.shot(41);
      await d.click('Leave');
      await d.waitFor('Rocket League');

      // From the first real click on, a button focused by script draws no focus ring, so the rows reached by keyboard come before it.
      await openList(d, 'user_1');
      await addAccount(d, 'Steam');
      await s.mouseClick({ contains: 'Advanced' });
      await d.waitFor('SteamID64');
      await showPanel(d, 'Launcher account id');
      await s.shot(40);
      await d.click('Cancel');
      await d.waitFor('user_1');

      await addAccount(d, 'Steam');
      await s.mouseClick('Create account');
      await d.waitFor('Login is required.');
      await s.shot(39);
      await d.click('Cancel');
      await d.waitFor('user_1');

      await addAccount(d, 'Riot Games');
      await s.shot(38);
      await d.click('Cancel');
      await d.waitFor('user_1');

      await addAccount(d, 'Steam');
      await typeInto(d, 'Display name', 'Test Persona');
      await typeInto(d, 'Login', 'user_9');
      await d.click('Create account');
      await flashShot(s, 43, 'Account created. Pick a game in the Library and press Play.', 'Danger zone');
    },
  },
  {
    name: 'edit',
    fake: 'all-four',
    async run(s) {
      const { d } = s;
      await d.waitFor('Rocket League');

      await openAccount(d, 'alt@example.com');
      await d.waitFor(sessionChecked);
      await s.shot(42);
      await d.click('Forget saved sign-in');
      await d.waitFor('Yes, forget it');
      await showPanel(d, 'Saved sign-in');
      await s.shot(55);
      await d.click('Cancel');
      await d.waitFor('Yes, forget it', { absent: true });

      await openAccount(d, 'user_3');
      await showPanel(d, 'Password');
      await s.shot(47);
      await d.click('Remove');
      await d.waitFor('Confirm remove');
      await s.shot(49);
      await d.click('Cancel');
      await d.waitFor('Confirm remove', { absent: true });
      await d.click('Copy password');
      await flashShot(s, 50, 'Password copied');

      await d.click({ contains: 'Advanced' });
      await d.waitFor('Press Preview to see the steps.');
      await d.click('Preview');
      await d.waitFor('steps would run');
      await showPanel(d, 'Switch preview');
      await s.shot(57);
      await d.click({ contains: 'Advanced' });
      await d.waitFor('steps would run', { absent: true });

      await d.click('Delete account');
      await d.waitFor('Yes, delete');
      await showPanel(d, 'Danger zone');
      await s.shot(59);
      await d.click('Cancel');
      await d.waitFor('Yes, delete', { absent: true });

      await openAccount(d, 'new@example.com');
      await d.waitFor('Epic Games Launcher is signed in as');
      await d.waitFor(sessionChecked);
      await d.click({ contains: 'Advanced' });
      await d.waitFor('Press Preview to see the steps.');
      await d.click('Preview');
      await d.waitFor('Needs credentials');
      await showPanel(d, 'Switch preview');
      await s.shot(58);

      await openAccount(d, 'user_1');
      await d.click('Store password');
      await d.waitFor(() => document.querySelector('input[type="password"]') !== null);
      await showPanel(d, 'Password');
      await s.shot(48);
      await d.click('Cancel');
      await d.waitFor(() => document.querySelector('input[type="password"]') !== null, { absent: true });
      await d.evaluate(scrollTop);

      await typeInto(d, 'Display name', 'Test Persona', { select: true });
      await d.waitFor('Discard');
      await s.shot(44);
      await leaveByShortcut(d, 'Leave without saving?');
      await s.shot(46);
      await d.click('Stay');
      await d.waitFor(dialogOpen, { absent: true });

      // A script click leaves the focus in the field, which Save disables for a moment: whether the field keeps it is then a race.
      await s.mouseClick('Save changes');
      await flashShot(s, 45, 'Saved');
    },
  },
  {
    name: 'session-saved',
    fake: 'all-four',
    async run(s) {
      const { d } = s;
      await d.waitFor('Rocket League');
      await playThrough(d, { game: 'Rocket League®', account: 'Alt', launcher: 'epic' });
      await openSavedSignIn(d, 'alt@example.com', 'Last used for a switch just now.');
      await s.shot(51);
    },
  },
  {
    name: 'session-not-saved',
    fake: {
      from: 'all-four',
      change(scenario) {
        scenario.files[EPIC_INI] = { inline: fixture('epic/GameUserSettings.ini').replace(/^Data=.*\r?\n/gm, '') };
        delete scenario.onDisk.epic;
      },
    },
    async run(s) {
      const { d } = s;
      await d.waitFor('Rocket League');
      await openSavedSignIn(d, 'new@example.com', 'Nobody');
      await s.shot(52);
    },
  },
  {
    name: 'session-stale',
    fake: 'all-four',
    knobs: { knobs: { epic: { expired: [EPIC_ALT] } } },
    async run(s) {
      const { d } = s;
      await d.waitFor('Rocket League');
      await startPlay(d, { game: 'Rocket League®', account: 'Alt', tag: 'stale' });
      await watchDialog(d, { until: (t) => t.includes('Stop waiting'), tag: 'stale' });
      await d.click('Stop waiting');
      await watchDialog(d, { until: (t) => t.includes('Stopped waiting'), tag: 'stale' });
      await finishDialog(d, 'stale');
      await openSavedSignIn(d, 'alt@example.com', 'Saved, but needs a fresh sign-in');
      await s.shot(53);
    },
  },
  {
    name: 'session-unlinked',
    fake: 'unowned',
    async run(s) {
      const { d } = s;
      await d.waitFor('Rocket League');
      await openSavedSignIn(d, 'alt@example.com', 'An account not yet linked in One Launch');
      await s.shot(54);
    },
  },
  {
    name: 'riot-not-kept',
    fake: 'all-four',
    knobs: { knobs: { riot: { signInWhenAskedMs: 500, signInAs: RIOT_NEW, staySignedIn: false } }, processes: { shutdownPolls: 25 } },
    async run(s) {
      const { d } = s;
      await d.waitFor('VALORANT');
      await d.invoke('settings:set', { key: 'riot.pressPlay', value: 'false' });
      await startPlay(d, { game: 'VALORANT', account: 'Riot New', tag: 'riot-new' });
      await watchDialog(d, { until: (t) => t.includes('Press Play in the Riot Client window'), tag: 'riot-new' });
      await finishDialog(d, 'riot-new');

      await openAccount(d, 'riot_main');
      await d.click('Switch to this account');
      await d.waitFor('Switch Riot Games to Riot Main');
      await d.click('Switch');
      await watchDialog(d, { until: (t) => /^Close .+…$/m.test(t), tag: 'riot-main' });
      await d.click('Stop');
      await watchDialog(d, { until: (t) => t.includes('Nothing had been changed'), tag: 'riot-main' });
      await finishDialog(d, 'riot-main');

      const { accounts } = await d.invoke('accounts:list');
      const riotNew = accounts.find((a) => a.login === 'riot_new');
      for (let polls = 0; (await d.invoke('sessions:get', { accountId: riotNew.id })).state.launcherRunning; polls += 1) {
        if (polls > 200) throw new Error('the Riot Client never finished closing');
      }

      await openSavedSignIn(d, 'riot_new', 'Stay signed in');
      await s.shot(56);
    },
  },
];
