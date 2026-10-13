// The updater against a loopback feed (ONELAUNCH_UPDATE_FEED, unpackaged only) signed with a throwaway key: no traffic
// while automatic updates are off, refusals for an unsigned manifest, a tampered installer and a feed that is down,
// then a signed update to "ready", the sidebar card, Restart to update (the installer is stubbed in this mode), and
// a background check once the switch is turned back on, installed at quit. The feed never runs anything it serves.
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { sleep } from '../app-driver.mjs';
import { publicKeyOf, signManifest } from '../../src/main/updates/manifest.ts';
import { skipSetup } from './lib.mjs';

export const name = 'update';
export const options = { fake: 'none' };

const VERSION = '9.9.9';
const FILE = `OneLaunch-${VERSION}-setup.exe`;
const SHARED_STAGING_ID = '00000000-0000-0000-0000-000000000000';
const AUTO = 'Keep One Launch updated automatically';

const { privateKey } = generateKeyPairSync('ed25519');
const installer = randomBytes(256 * 1024);
const file = { url: FILE, sha512: createHash('sha512').update(installer).digest('base64'), size: installer.length };

const requests = [];
let feed = { manifest: null, installer: null, status: 200 };
let server = null;

function manifest({ signed }) {
  const lines = [
    `version: ${VERSION}`,
    'files:',
    `  - url: ${file.url}`,
    `    sha512: ${file.sha512}`,
    `    size: ${file.size}`,
    `path: ${file.url}`,
    `sha512: ${file.sha512}`,
    "releaseDate: '2026-10-01T00:00:00.000Z'",
  ];
  if (signed) {
    const { keyId, signature } = signManifest(VERSION, file, privateKey);
    lines.push(`signature: '${signature}'`, `keyId: '${keyId}'`);
  }
  return `${lines.join('\n')}\n`;
}

export async function before(d) {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    requests.push({ path, headers: req.headers });
    if (feed.status !== 200) {
      res.writeHead(feed.status).end();
      return;
    }
    const body = path === '/latest.yml' ? feed.manifest : path === `/${FILE}` ? feed.installer : null;
    if (body === null) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': Buffer.byteLength(body) }).end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  d.env = { ONELAUNCH_UPDATE_FEED: `http://127.0.0.1:${server.address().port}/`, ONELAUNCH_UPDATE_KEYS: publicKeyOf(privateKey) };
}

export async function after() {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
}

const checkEnabled = () => [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Check for updates' && !b.disabled);
const autoReady = () => {
  const el = document.querySelector('[role="switch"][aria-label="Keep One Launch updated automatically"]');
  return Boolean(el && !el.disabled);
};
const autoOn = () => document.querySelector('[role="switch"][aria-label="Keep One Launch updated automatically"]')?.getAttribute('aria-checked') === 'true';
const autoOff = () => document.querySelector('[role="switch"][aria-label="Keep One Launch updated automatically"]')?.getAttribute('aria-checked') === 'false';

async function checkNow(d) {
  await d.waitFor(checkEnabled, { timeoutMs: 10_000 });
  await d.click('Check for updates');
}

async function openSettings(d) {
  await d.click('Settings');
  await d.waitFor('Check for updates');
  await d.waitFor(autoReady);
}

async function setAuto(d, on) {
  await d.click(AUTO);
  await d.waitFor(on ? autoOn : autoOff);
  d.check(`automatic updates are stored ${on ? 'on' : 'off'}`, (await d.invoke('settings:getAll')).settings['updates.auto'] === String(on));
}

export default async (d) => {
  await skipSetup(d);
  await openSettings(d);
  await setAuto(d, false);
  await d.restart();
  await sleep(17_000);
  d.check('with automatic updates off, nothing reaches the feed on its own', requests.length === 0, `${requests.length} requests`);

  feed = { manifest: manifest({ signed: false }), installer, status: 200 };
  await openSettings(d);
  await checkNow(d);
  await d.waitFor('Could not verify the update', { timeoutMs: 15_000 });
  d.check('an unsigned release is refused before any download', !requests.some((r) => r.path === `/${FILE}`));
  await d.shot('refused-unsigned');

  feed = { manifest: manifest({ signed: true }), installer: randomBytes(installer.length), status: 200 };
  await checkNow(d);
  await d.waitFor('Could not download the update: the downloaded file does not match the release', { timeoutMs: 15_000 });
  d.check('a tampered installer is refused', (await d.invoke('updates:status')).state === 'failed');

  feed = { ...feed, status: 503 };
  await checkNow(d);
  await d.waitFor('Could not check for updates', { timeoutMs: 15_000 });
  d.check('a feed that is down is reported in plain words', await d.has('the update server answered HTTP 503'));
  d.check('no refusal shows the sidebar card', !(await d.has('Update ready')));
  await d.shot('feed-down');

  feed = { manifest: manifest({ signed: true }), installer, status: 200 };
  await checkNow(d);
  await d.waitFor(`${VERSION} is ready`, { timeoutMs: 30_000 });
  await d.waitFor('Update ready', { timeoutMs: 5_000 });
  await d.shot('ready');
  await d.viewport(960, 600);
  await d.shot('ready-960x600');
  await d.viewport(null);
  await d.key('b', { ctrl: true });
  await sleep(400);
  await d.shot('ready-sidebar-collapsed');
  await d.key('b', { ctrl: true });
  const manifestRequests = requests.filter((r) => r.path === '/latest.yml');
  const staging = [...new Set(requests.map((r) => r.headers['x-user-staging-id']).filter((v) => v !== undefined))];
  d.check(
    'the only staging id any request carries is the one every copy shares',
    manifestRequests.length > 0 && manifestRequests.every((r) => r.headers['x-user-staging-id'] === SHARED_STAGING_ID) && staging.length === 1,
    staging.join(','),
  );
  d.check('no per-install id file is written', !existsSync(join(d.dataDir, '.updaterId')));

  await d.click(`Restart to install One Launch ${VERSION}`);
  const code = await d.waitForExit({ timeoutMs: 20_000 });
  d.check('Restart to update quits cleanly', code === 0, `code=${code}`);
  const afterRestart = d.readLog();
  d.check('it hands over to the installer, asking for a relaunch', /update install \{[^}]*"relaunch":true/.test(afterRestart));
  d.check('the test feed never runs the installer', afterRestart.includes('update install (test feed, installer not run)'));

  await d.restart();
  await openSettings(d);
  await setAuto(d, true);
  await d.waitFor('Update ready', { timeoutMs: 45_000 });
  d.check('turning automatic updates on checks in the background', true);
  const code2 = await d.close();
  d.check('quitting ends the app with exit code 0', code2 === 0, `code=${code2}`);
  d.check('with automatic updates on, a ready update installs at quit without a relaunch', /update install \{[^}]*"relaunch":false/.test(d.readLog()));
};
