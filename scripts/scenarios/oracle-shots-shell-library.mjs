// Oracle captures of the shell and the Library (rows 1 to 29 of the checklist). Run by scripts/oracle/ui/capture.mjs, not by drive.mjs.
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import { publicKeyOf, signManifest } from '../../src/main/updates/manifest.ts';
import { playThrough, skipSetup, startPlay } from './lib.mjs';

export const area = 'shell-library';

export const rows = {
  1: { how: 'the page reloaded with its script bundle blocked, so the document stays as index.html paints it; the mark is shown with its fade finished' },
  8: { how: 'fault injected over CDP: a builtin the Library calls while it renders is made to throw once' },
  11: { how: 'the answers to artwork:status and launchers:status held in main, then the page reloaded: the Library has heard nothing of the scan yet' },
  14: { how: 'fault injected in main: library:list answers with the error envelope its handler gives for a damaged database' },
  20: { how: 'the bodies of artwork fetches held in main, then every game queued again: the queue stays at four' },
  23: { how: 'the answer to launch:preflight held in main after a click on a poster whose game was launched before' },
};

const VERSION = '9.9.9';
const INSTALLER_NAME = `OneLaunch-${VERSION}-setup.exe`;
const installer = Buffer.alloc(64 * 1024, 7);
let feed = null;

async function startFeed(s) {
  const { privateKey } = generateKeyPairSync('ed25519');
  const file = { url: INSTALLER_NAME, sha512: createHash('sha512').update(installer).digest('base64'), size: installer.length };
  const { keyId, signature } = signManifest(VERSION, file, privateKey);
  const manifest = [
    `version: ${VERSION}`,
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
  feed = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const body = path === '/latest.yml' ? manifest : path === `/${INSTALLER_NAME}` ? installer : null;
    if (body === null) res.writeHead(404).end();
    else res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': Buffer.byteLength(body) }).end(body);
  });
  await new Promise((resolve) => feed.listen(0, '127.0.0.1', resolve));
  s.d.env = { ONELAUNCH_UPDATE_FEED: `http://127.0.0.1:${feed.address().port}/`, ONELAUNCH_UPDATE_KEYS: publicKeyOf(privateKey) };
}

const stopFeed = () => new Promise((resolve) => (feed ? feed.close(resolve) : resolve()));

const searchBox = { selector: 'input[aria-label="Search games"]' };
const listboxOpen = () => document.querySelector('[role="listbox"]') !== null;
const sidebarCollapsed = () => document.querySelector('aside')?.hasAttribute('data-collapsed') === true;

async function search(s, text) {
  await s.d.focus(searchBox);
  await s.d.type(text);
}

async function clearSearch(s) {
  await s.d.click('Clear search');
  await s.d.waitFor(() => document.querySelector('input[aria-label="Search games"]').value === '');
}

async function setPreview(s, on) {
  await s.d.invoke('settings:set', { key: 'dryRun', value: String(on) });
  await s.d.reload();
  await s.d.waitFor('Rocket League');
}

export const sessions = [
  {
    name: 'default',
    fake: 'all-four',
    async run(s) {
      const { d } = s;
      await d.waitFor('Rocket League');

      await d.reload({ bundle: false });
      await s.shot(1);
      await d.reload();
      await d.waitFor('Rocket League');

      await s.shot(2);
      await s.shot(4);
      await s.shot(9);
      await s.shot(24);
      await s.shot(25);

      await s.hover('Play Overwatch');
      await s.shot(22, { keepPointer: true });

      await s.mouseClick('Play Overwatch', { button: 'right' });
      await d.waitFor('Refresh artwork');
      await s.shot(28, { keepPointer: true });
      await d.key('Escape');
      await d.waitFor('Refresh artwork', { absent: true });
      await s.parkPointer();

      await d.click('Filter');
      await d.waitFor(listboxOpen);
      await s.shot(18);
      await d.key('Escape');
      await d.waitFor(listboxOpen, { absent: true });

      await d.click({ contains: 'Sort:' });
      await d.waitFor(listboxOpen);
      await s.shot(19);
      await d.key('Escape');
      await d.waitFor(listboxOpen, { absent: true });

      await search(s, 'rock');
      await d.waitFor('Overwatch', { absent: true });
      await s.shot(17);
      await clearSearch(s);
      await search(s, 'xyz');
      await d.waitFor('No games match');
      await s.shot(15);
      await clearSearch(s);

      await d.evaluate(() => document.activeElement?.blur());
      await d.key('b', { ctrl: true });
      await d.waitFor(sidebarCollapsed);
      await s.shot(3);
      await d.key('b', { ctrl: true });
      await d.waitFor(sidebarCollapsed, { absent: true });

      await setPreview(s, true);
      await d.waitFor('Preview mode is on');
      await s.shot(5);
      await setPreview(s, false);

      s.fail('library:list', { code: 'SQLITE_CORRUPT', message: 'database disk image is malformed' });
      await d.reload();
      await d.waitFor('Could not load the library');
      await s.shot(14);
      s.mend('library:list');
      await d.reload();
      await d.waitFor('Rocket League');

      // React renders a second time before it gives up on a tree, so the throw has to last past the first one.
      await d.evaluate(() => {
        window.realLocaleCompare = String.prototype.localeCompare;
        String.prototype.localeCompare = function () {
          throw new TypeError("Cannot read properties of undefined (reading 'name')");
        };
      });
      await d.click({ contains: 'Sort:' });
      await d.waitFor(listboxOpen);
      await d.click('Name');
      await d.waitFor('Something went wrong in the interface');
      await d.evaluate(() => {
        String.prototype.localeCompare = window.realLocaleCompare;
      });
      await s.shot(8);
    },
  },
  {
    name: 'played',
    fake: 'all-four',
    async run(s) {
      const { d } = s;
      await d.waitFor('Rocket League');
      await d.invoke('settings:set', { key: 'play.hideToTray', value: 'false' });

      await playThrough(d, { game: 'Rocket League', account: 'Persona One', launcher: 'steam', tag: 'first' });
      await d.waitFor(() => document.querySelectorAll('button[title^="Play Rocket League as "]').length === 1);
      await s.shot(10);

      await playThrough(d, { game: 'Rocket League', account: 'Persona Three', launcher: 'steam', tag: 'second' });
      await d.waitFor(() => document.querySelectorAll('button[title^="Play Rocket League as "]').length === 2);
      await s.shot(29);

      s.hold('launch:preflight');
      await d.click('Play Rocket League');
      await d.waitFor(() => document.querySelector('button[aria-label="Play Rocket League"]')?.getAttribute('aria-busy') === 'true');
      await s.shot(23);
      s.release('launch:preflight');
      await d.waitFor('Play as Persona Three');
    },
  },
  {
    name: 'removed-account',
    fake: 'all-four',
    async run(s) {
      const { d } = s;
      await d.waitFor('Rocket League');
      await playThrough(d, { game: 'Rocket League', account: 'Persona Three', launcher: 'steam', tag: 'play' });
      const { accounts } = await d.invoke('accounts:list');
      await d.invoke('accounts:delete', { id: accounts.find((a) => a.displayName === 'Persona Three').id });
      await d.reload();
      await d.waitFor('removed account');
      await s.shot(27);
    },
  },
  {
    name: 'update',
    fake: 'all-four',
    knobs: { knobs: { steam: { selfUpdateMs: -1 } }, timing: { steam: { updateMs: 180_000 } } },
    before: startFeed,
    after: stopFeed,
    async run(s) {
      const { d } = s;
      await d.waitFor('Rocket League');
      const { state } = await d.invoke('updates:status');
      if (state !== 'ready' && state !== 'checking' && state !== 'downloading') await d.invoke('updates:check');
      await d.waitFor('Update ready', { timeoutMs: 60_000 });
      await s.shot(6);

      await startPlay(d, { game: 'Rocket League', account: 'Persona Three', tag: 'held' });
      await d.waitFor(() => [...document.querySelectorAll('button')].some((b) => /^(Hide|Continue)$| and continue$/.test(b.textContent.trim())), {
        timeoutMs: 20_000,
      });
      if (!(await d.has('Hide'))) await d.click({ contains: 'ontinue' });
      await d.waitFor(() => [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Hide'), { timeoutMs: 20_000 });
      await d.click('Hide');
      await d.waitFor('Switching to Persona Three');
      await s.shot(7);
    },
  },
  {
    name: 'no-launchers',
    fake: 'none',
    async run(s) {
      const { d } = s;
      await skipSetup(d);
      await d.waitFor('No launchers found');
      await s.shot(12);

      s.hold('artwork:status');
      s.hold('launchers:status');
      await d.reload();
      await d.waitFor('Scanning your launchers');
      await s.shot(11);
      s.release('artwork:status');
      s.release('launchers:status');
      await d.waitFor('No launchers found');
    },
  },
  {
    name: 'no-games',
    fake: 'no-games',
    async run(s) {
      await s.d.waitFor('No games found');
      await s.shot(13);
    },
  },
  {
    name: 'steam-no-game',
    fake: 'steam-no-game',
    async run(s) {
      const { d } = s;
      await d.waitFor('Overwatch');
      await d.click('Filter');
      await d.waitFor(listboxOpen);
      await d.click({ contains: 'Steam (0)' });
      await d.waitFor('No Steam games installed');
      await s.shot(16);
    },
  },
  {
    name: 'riot-no-icon',
    fake: 'riot-no-icon',
    async run(s) {
      const { d } = s;
      await d.waitFor('VALORANT');
      await d.waitFor('Add a free key for missing covers', { timeoutMs: 20_000 });
      await s.shot(21);
      await s.shot(26);
    },
  },
  {
    name: 'artwork-held',
    fake: 'all-four',
    async run(s) {
      const { d } = s;
      await d.waitFor('Rocket League');
      s.hold('fetch');
      await d.invoke('artwork:refresh', { gameId: null, force: true });
      await d.waitFor('Fetching artwork (4)', { timeoutMs: 20_000 });
      await s.shot(20);
      s.release('fetch');
      await s.idle();
    },
  },
];
