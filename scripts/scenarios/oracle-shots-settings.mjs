import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sleep } from '../app-driver.mjs';
import { publicKeyOf, signManifest } from '../../src/main/updates/manifest.ts';
import { playThrough, skipSetup, waitForVaultKey } from './lib.mjs';

export const area = 'settings';

export const rows = {
  122: {
    how: 'the answer to autostart:status held in main, then Settings opened again: the toggle is off and disabled, as it is for a copy that cannot start with Windows. On fake launchers the login item is in memory and always available, so the answer "unavailable" itself cannot be had',
  },
  124: {
    how: 'automatic updates seeded off in the scenario and switched on for the shot, which puts the first check 15 s away; the session fails if that check began before the shot was done',
  },
  125: { how: 'the loopback feed holds its answer to the request for latest.yml' },
  127: {
    how: 'the loopback feed sends 524288 of the 1048576 installer bytes, one more byte 1.5 s later so that the updater reports its progress, and holds the rest',
  },
  131: {
    owner:
      'only a packaged exe gives the custom-data-folder reason (every unpackaged run answers "development" first), and a capture never starts the packaged or the installed exe',
  },
  133: { how: 'the answer to launchers:status held in main, then the page reloaded and the Launchers tab opened: the page has heard of no launcher yet' },
  136: {
    how: 'planted file: the fake Battle.net.config padded with spaces to 4194305 bytes, one over the limit for a launcher file, so the Battle.net health check throws LAUNCHER_FILE. A UTF-16 config does not throw; it only fails one health check, and the row gets no Needs attention pill',
  },
  137: {
    how: 'steam.path written into the scratch database with node:sqlite while the app was stopped, naming the fake Steam folder: settings:set refuses the key, and the native picker that sets it cannot be driven',
  },
  138: {
    how: 'fault injected in main: launchers:locate answers with the NOT_A_LAUNCHER envelope its handler gives for a wrong exe, so the native file picker never opens',
  },
  143: { how: 'the bodies of artwork fetches held in main, then Refresh all: the queue stays at four' },
  157: {
    how: 'the chromium folder of the scratch data folder (it holds the wrapped key) deleted between two starts, after the first start had stored the seeded passwords and sign-ins',
  },
  159: {
    how: 'the answer to vault:status held in main before the reset is confirmed: the banner and its note go when that answer arrives, and Status reads Checking… until then',
  },
  160: {
    how: 'planted file: chromium/Local State in the scratch data folder, written before the first start with an os_crypt.encrypted_key that is not a DPAPI key, so safeStorage reports that encryption is unavailable. The seed of this session has no password and no saved sign-in, which could not have been encrypted',
  },
  162: { how: 'fault injected in main: settings:set answers with the error envelope of a read-only database' },
  163: {
    skipped:
      'the Developer panel is loaded only when import.meta.env.DEV is set, which is the dev server (electron-vite dev); the build in out/ has no such chunk, and a capture must not start the dev server',
  },
};

const TRAY = 'Minimize One Launch to System Tray';
const AUTOSTART = 'Start with Windows';
const AUTO_UPDATE = 'Keep One Launch updated automatically';
const KEY_FIELD = { selector: 'input[aria-label="SteamGridDB API key"]' };
const PLACEHOLDER_KEY = 'placeholderkey0000000000';
const BATTLENET_CONFIG = ['appdata', 'Battle.net', 'Battle.net.config'];
const MAX_LAUNCHER_FILE_BYTES = 4 * 1024 * 1024;

const NEXT_VERSION = '9.9.9';
const INSTALLER_NAME = `OneLaunch-${NEXT_VERSION}-setup.exe`;
const installer = Buffer.alloc(1024 * 1024, 7);
const HELD_AT = installer.length / 2;
const feed = { server: null, privateKey: null, status: 200, version: NEXT_VERSION, manifestGate: null, installerGate: null };

function gate() {
  let open;
  const wait = new Promise((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

function manifestFor(version) {
  const file = { url: INSTALLER_NAME, sha512: createHash('sha512').update(installer).digest('base64'), size: installer.length };
  const { keyId, signature } = signManifest(version, file, feed.privateKey);
  return [
    `version: ${version}`,
    'files:',
    `  - url: ${file.url}`,
    `    sha512: ${file.sha512}`,
    `    size: ${file.size}`,
    `path: ${file.url}`,
    `sha512: ${file.sha512}`,
    "releaseDate: '2026-10-01T00:00:00.000Z'",
    `signature: '${signature}'`,
    `keyId: '${keyId}'`,
    '',
  ].join('\n');
}

async function startFeed(s) {
  feed.privateKey = generateKeyPairSync('ed25519').privateKey;
  feed.server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (feed.status !== 200) {
      res.writeHead(feed.status).end();
    } else if (path === '/latest.yml') {
      await feed.manifestGate?.wait;
      const body = manifestFor(feed.version);
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': Buffer.byteLength(body) }).end(body);
    } else if (path === `/${INSTALLER_NAME}`) {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': installer.length });
      res.write(installer.subarray(0, HELD_AT));
      // The updater reports progress at most once a second, and only when bytes arrive: this byte is what makes it say 50%.
      await sleep(1_500);
      res.write(installer.subarray(HELD_AT, HELD_AT + 1));
      await feed.installerGate?.wait;
      res.end(installer.subarray(HELD_AT + 1));
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => feed.server.listen(0, '127.0.0.1', resolve));
  s.d.env = { ONELAUNCH_UPDATE_FEED: `http://127.0.0.1:${feed.server.address().port}/`, ONELAUNCH_UPDATE_KEYS: publicKeyOf(feed.privateKey) };
}

function stopFeed() {
  if (!feed.server) return Promise.resolve();
  feed.manifestGate?.open();
  feed.installerGate?.open();
  feed.server.closeAllConnections();
  return new Promise((resolve) => feed.server.close(resolve));
}

function switchIs(label, checked, enabled) {
  const el = document.querySelector(`[role="switch"][aria-label="${label}"]`);
  return el !== null && el.getAttribute('aria-checked') === String(checked) && el.disabled === !enabled;
}

function generalListed() {
  const tray = document.querySelector('[role="switch"][aria-label="Minimize One Launch to System Tray"]');
  const text = document.querySelector('[role="tabpanel"]')?.innerText ?? '';
  return tray !== null && !tray.disabled && /· (Off for this copy|Not checked yet)/.test(text);
}

function playListed() {
  const signIn = document.querySelector('[role="switch"][aria-label="Steam automatic sign-in"]');
  return signIn !== null && !signIn.disabled;
}

function launchersListed() {
  const recheck = [...document.querySelectorAll('[role="tabpanel"] button')].find((b) => b.textContent.trim() === 'Re-check');
  return recheck !== undefined && !recheck.disabled && document.querySelector('[role="tabpanel"] .animate-pulse') === null;
}

function artworkListed() {
  return /\d+ done/.test(document.querySelector('[role="tabpanel"]')?.innerText ?? '');
}

function launcherSkeleton() {
  return document.querySelectorAll('[role="tabpanel"] [aria-hidden="true"] .animate-pulse').length > 0;
}

function backupsListed() {
  const counts = [...document.querySelectorAll('[role="tabpanel"] section section > button')].map((b) => b.textContent);
  const keep = document.querySelector('[role="tabpanel"] button[aria-haspopup="listbox"]');
  return counts.length === 4 && counts.every((text) => /\d+ snapshots?$/.test(text)) && keep !== null && !keep.disabled;
}

function advancedListed() {
  const text = document.querySelector('[role="tabpanel"]')?.innerText ?? '';
  const menus = [...document.querySelectorAll('[role="tabpanel"] button[aria-haspopup="listbox"]')];
  return text.includes('Electron ') && !text.includes('Checking…') && menus.length === 3 && menus.every((b) => !b.disabled);
}

function paste(selector, text) {
  const clipboardData = new DataTransfer();
  clipboardData.setData('text', text);
  document.querySelector(selector).dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
}

const scrollToEnd = () => document.querySelector('[role="tabpanel"]').scrollIntoView({ block: 'end', behavior: 'instant' });
const listboxOpen = () => document.querySelector('[role="listbox"]') !== null;
const restoreRefused = () => document.querySelector('[role="alertdialog"] p.text-danger') !== null;

async function until(d, fn, args = [], timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await d.evaluate(fn, ...args))) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${fn.name}(${args.map((a) => JSON.stringify(a)).join(', ')})`);
    await sleep(100);
  }
}

const LISTED = {
  General: [generalListed],
  Launchers: [launchersListed, playListed],
  Artwork: [artworkListed],
  Backups: [backupsListed],
  Advanced: [advancedListed],
};

async function openSettings(d, tab = 'General') {
  await d.click('Settings');
  await d.click(tab);
  for (const listed of LISTED[tab]) await d.waitFor(listed);
}

async function queueShown(s) {
  await s.idle();
  const { status } = await s.d.invoke('artwork:status');
  await s.d.waitFor(`${status.completed} done${status.failed > 0 ? ` · ${status.failed} not found` : ''}`);
  await s.d.waitFor('in progress', { absent: true });
}

async function openMenu(s, id, name) {
  await s.d.click(name);
  await s.d.waitFor(listboxOpen);
  await s.shot(id);
  await s.d.key('Escape');
  await s.d.waitFor(listboxOpen, { absent: true });
  await s.d.evaluate(() => document.activeElement?.blur());
}

export const sessions = [
  {
    name: 'general',
    async run(s) {
      const { d } = s;
      await openSettings(d);
      await until(d, switchIs, [AUTOSTART, false, true]);
      await s.shot(121);
      await s.shot(130);

      await d.click(AUTOSTART);
      await until(d, switchIs, [AUTOSTART, true, true]);
      await s.shot(123);
      await d.click(AUTOSTART);
      await until(d, switchIs, [AUTOSTART, false, true]);

      s.hold('autostart:status');
      await d.click('Library');
      await d.waitFor('Rocket League');
      await openSettings(d);
      await until(d, switchIs, [AUTOSTART, false, false]);
      await s.shot(122);
      s.release('autostart:status');
      await until(d, switchIs, [AUTOSTART, false, true]);

      s.fail('settings:set', { code: 'SQLITE_READONLY', message: 'attempt to write a readonly database' });
      await d.click(TRAY);
      await d.waitFor('Could not save the setting: attempt to write a readonly database');
      await until(d, switchIs, [TRAY, true, true]);
      await s.shot(162);
      s.mend('settings:set');

      await d.click(TRAY);
      await until(d, switchIs, [TRAY, false, true]);
      await openSettings(d, 'Launchers');
      await d.waitFor('Needs Minimize One Launch to System Tray, in General.');
      await until(d, switchIs, ['Hide One Launch after Play', false, false]);
      await s.shot(139);
    },
  },
  {
    name: 'launchers',
    async run(s) {
      const { d } = s;
      s.hold('launchers:status');
      await d.reload();
      await d.click('Settings');
      await d.click('Launchers');
      await d.waitFor(launcherSkeleton);
      await d.waitFor(playListed);
      await s.shot(133);
      s.release('launchers:status');
      await d.waitFor(launchersListed);
      await s.shot(132);

      await d.click({ contains: 'Steam' });
      await d.waitFor('Found automatically.');
      await s.shot(134);
    },
  },
  {
    name: 'no-launchers',
    fake: 'none',
    async run(s) {
      const { d } = s;
      await skipSetup(d);
      await openSettings(d, 'Launchers');
      await d.waitFor('Not installed');
      await s.shot(135);

      s.fail('launchers:locate', { code: 'NOT_A_LAUNCHER', message: 'That file is not Steam. Choose steam.exe in the folder Steam is installed in.' });
      await d.click('Locate…');
      await d.waitFor('That file is not Steam.');
      await s.shot(138);
      s.mend('launchers:locate');
    },
  },
  {
    name: 'needs-attention',
    prepare(s) {
      const file = join(s.d.launchersDir, ...BATTLENET_CONFIG);
      const config = readFileSync(file);
      writeFileSync(file, Buffer.concat([config, Buffer.alloc(MAX_LAUNCHER_FILE_BYTES + 1 - config.length, ' ')]));
    },
    async run(s) {
      const { d } = s;
      await openSettings(d, 'Launchers');
      await d.waitFor('Needs attention');
      await d.click({ contains: 'Battle.net' });
      await d.waitFor('Too large to be a launcher file');
      await s.shot(136);
    },
  },
  {
    name: 'chosen-folder',
    async run(s) {
      const { d } = s;
      await d.waitFor('Rocket League');
      await s.stop();
      const db = new DatabaseSync(join(d.dataDir, 'onelaunch.db'));
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
        'steam.path',
        d.launcherPath('steam'),
      );
      db.close();
      await s.restart();
      await openSettings(d, 'Launchers');
      await d.click({ contains: 'Steam' });
      await d.waitFor('You chose this folder.');
      await s.shot(137);
    },
  },
  {
    name: 'artwork',
    async run(s) {
      const { d } = s;
      await openSettings(d, 'Artwork');
      await queueShown(s);
      await s.shot(140);

      await d.click('Rescan');
      await d.waitFor('Library rescanned:');
      await queueShown(s);
      await s.shot(144);

      await d.focus(KEY_FIELD);
      await d.type('abc');
      await d.key('Enter');
      await d.waitFor('That does not look like a SteamGridDB API key');
      await s.shot(142);
    },
  },
  {
    name: 'artwork-key',
    async run(s) {
      const { d } = s;
      await openSettings(d, 'Artwork');
      await queueShown(s);
      await d.focus(KEY_FIELD);
      await d.evaluate(paste, KEY_FIELD.selector, PLACEHOLDER_KEY);
      await d.waitFor('Key saved.');
      await d.waitFor(() => document.querySelector('button[aria-label="Remove key"]') !== null);
      await queueShown(s);
      await s.shot(141);
    },
  },
  {
    name: 'artwork-busy',
    async run(s) {
      const { d } = s;
      await openSettings(d, 'Artwork');
      await queueShown(s);
      s.hold('fetch');
      await d.click('Refresh all');
      await d.waitFor('Re-fetching artwork for');
      const { status } = await d.invoke('artwork:status');
      await d.waitFor(`${status.queued + status.running} in progress · ${status.completed} done`);
      await s.shot(143);
      s.release('fetch');
      await s.idle();
    },
  },
  {
    name: 'backups',
    async run(s) {
      const { d } = s;
      await d.waitFor('Rocket League');
      await openSettings(d, 'Backups');
      await d.click({ contains: 'Steam' });
      await d.waitFor('No snapshots yet.');
      await s.shot(146);
      await openMenu(s, 151, 'Snapshots to keep: 20 (default)');

      await d.click('Library');
      await d.waitFor('Rocket League');
      await playThrough(d, { game: 'Rocket League', account: 'Persona Three', launcher: 'steam' });
      await openSettings(d, 'Backups');
      await d.click({ contains: '1 snapshot' });
      await d.waitFor('Before switching to Persona Three');
      await s.shot(145);

      await d.click('Restore');
      await d.waitFor('Restore this snapshot');
      await s.shot(148);
      await d.click('Restore this snapshot');
      await d.waitFor(restoreRefused);
      await s.shot(149);
      await d.click('Cancel');

      await s.stop();
      await s.restart();
      await openSettings(d, 'Backups');
      await d.click({ contains: '1 snapshot' });
      await d.click('Restore');
      await d.waitFor('Restore this snapshot');
      await d.click('Restore this snapshot');
      await d.waitFor('Restored snapshot');
      await s.shot(150);
    },
  },
  {
    name: 'backups-kept',
    fake: 'unowned',
    async run(s) {
      const { d } = s;
      await d.waitFor('Rocket League');
      await playThrough(d, { game: 'Rocket League®', account: 'Alt', launcher: 'epic' });
      await openSettings(d, 'Backups');
      await d.click({ contains: '1 snapshot' });
      await d.waitFor('Kept');
      await s.shot(147);
    },
  },
  {
    name: 'advanced',
    async run(s) {
      const { d } = s;
      await openSettings(d, 'Advanced');
      await s.shot(152);

      await d.click('Preview mode');
      await until(d, switchIs, ['Preview mode', true, true]);
      await d.waitFor('Preview mode is on');
      await s.shot(153);
      await d.click('Preview mode');
      await until(d, switchIs, ['Preview mode', false, true]);
      await d.waitFor('Preview mode is on', { absent: true });

      await openMenu(s, 154, 'Epic launch link: Catalog link (default)');
      await openMenu(s, 155, 'Battle.net launch: Launch command (default)');

      await d.evaluate(scrollToEnd);
      await openMenu(s, 161, 'Log level: Info');
      await d.click('Run test');
      await d.waitFor('Passed in');
      await s.shot(156);
    },
  },
  {
    name: 'vault-key-lost',
    async run(s) {
      const { d } = s;
      await waitForVaultKey(d);
      await s.stop();
      rmSync(join(d.dataDir, 'chromium'), { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
      await s.restart();
      await openSettings(d, 'Advanced');
      await d.waitFor('Key lost');
      await s.shot(157);

      await d.click('Clear stored passwords and sign-ins…');
      await d.waitFor('Yes, clear them');
      await s.shot(158);

      s.hold('vault:status');
      await d.click('Yes, clear them');
      await d.waitFor('Removed ');
      await s.shot(159);
      s.release('vault:status');
      await d.waitFor('Working');
    },
  },
  {
    name: 'vault-unavailable',
    fake: {
      from: 'all-four',
      change(scenario) {
        for (const account of scenario.seed.accounts) delete account.password;
        scenario.seed.sessions = [];
      },
    },
    prepare(s) {
      const profile = join(s.d.dataDir, 'chromium');
      mkdirSync(profile, { recursive: true });
      writeFileSync(join(profile, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: Buffer.from('not a key').toString('base64') } }));
    },
    async run(s) {
      const { d } = s;
      await openSettings(d, 'Advanced');
      await d.waitFor('Unavailable · passwords and sign-ins cannot be stored');
      await s.shot(160);
    },
  },
  {
    name: 'updates',
    fake: {
      from: 'all-four',
      change(scenario) {
        scenario.seed.settings['updates.auto'] = 'false';
      },
    },
    before: startFeed,
    after: stopFeed,
    async run(s) {
      const { d } = s;
      await openSettings(d);
      await d.waitFor('Not checked yet');
      feed.status = 503;
      await d.click(AUTO_UPDATE);
      await until(d, switchIs, [AUTO_UPDATE, true, true]);
      await s.shot(124);
      if ((await d.invoke('updates:status')).state !== 'idle') throw new Error('the first background check began before the shot of the idle state was done');
      await d.waitFor('Check failed', { timeoutMs: 40_000 });
      await s.shot(129);

      feed.status = 200;
      feed.version = (await d.invoke('app:info')).version;
      await d.click('Check for updates');
      await d.waitFor('Up to date');
      await s.shot(126);

      feed.version = NEXT_VERSION;
      feed.manifestGate = gate();
      feed.installerGate = gate();
      await d.click('Check for updates');
      await d.waitFor('Checking…');
      await s.shot(125);
      feed.manifestGate.open();
      await d.waitFor(`Downloading ${NEXT_VERSION} · 50%`, { timeoutMs: 30_000 });
      await s.shot(127);
      feed.installerGate.open();
      await d.waitFor(`${NEXT_VERSION} is ready`, { timeoutMs: 30_000 });
      await s.shot(128);
      // With automatic updates off, quitting leaves the downloaded file where it is instead of handing it to the (stubbed) installer.
      await d.invoke('settings:set', { key: 'updates.auto', value: 'false' });
    },
  },
];
