// Helpers shared by the fake-launcher scenarios.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot, sleep } from '../app-driver.mjs';

export const LAUNCHER_NAMES = { steam: 'Steam', epic: 'Epic Games', battlenet: 'Battle.net', riot: 'Riot Games' };

/** A committed fixture's text, for byte-for-byte comparisons with the launcher files a run leaves behind. */
export function fixture(rel) {
  return readFileSync(join(repoRoot, 'test', 'fixtures', rel), 'utf8');
}

/**
 * Waits until Chromium has written the safeStorage key to chromium\Local State, which happens a few seconds
 * into a data folder's first session. A hard kill before that loses the key, and with it every stored secret.
 */
export async function waitForVaultKey(d, { timeoutMs = 30_000 } = {}) {
  const file = join(d.dataDir, 'chromium', 'Local State');
  const deadline = Date.now() + timeoutMs;
  while (!(existsSync(file) && readFileSync(file, 'utf8').includes('encrypted_key'))) {
    if (Date.now() > deadline) throw new Error(`the vault key was not written to ${file} within ${timeoutMs} ms`);
    await sleep(500);
  }
}

/**
 * Closes the setup guide a fresh data folder opens over the Library (no account yet and the guide never dismissed; the
 * all-four seed has it dismissed already). With `shot`, screenshots it first. Returns whether there was one to close.
 */
export async function skipSetup(d, { shot = null } = {}) {
  const [{ accounts }, { settings }] = await Promise.all([d.invoke('accounts:list'), d.invoke('settings:getAll')]);
  if (accounts.length > 0 || settings['firstRun.dismissed'] === 'true') return false;
  await d.waitFor('Welcome to One Launch');
  if (shot) {
    await sleep(900);
    await d.shot(shot);
  }
  await d.click('Skip setup');
  await d.waitFor('Welcome to One Launch', { absent: true });
  return true;
}

export function journalExists(d) {
  return existsSync(join(d.dataDir, 'switch.json'));
}

export function readJournal(d) {
  const file = join(d.dataDir, 'switch.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

/** Clicks Play on a game card, picks an account, takes a screenshot of the picker, and presses Play. */
export async function startPlay(d, { game, account, tag }) {
  await d.click(`Play ${game}`);
  await d.waitFor(() => /Pick the account to use|Play as /.test(document.body.innerText));
  await d.click({ contains: account });
  await d.waitFor(`Play as ${account}`);
  await d.shot(`${tag}-pick`);
  await d.click('Play');
}

/**
 * Follows the launch dialog until `until(text)` holds: answers the confirm stage once (screenshot first),
 * screenshots the first running state, and fails on "Try again" unless `until` matched the same text.
 * Returns the dialog text.
 */
export async function watchDialog(d, { until, tag, timeoutMs = 60_000 }) {
  const deadline = Date.now() + timeoutMs;
  let running = false;
  let confirmed = false;
  for (;;) {
    const text = await d.text();
    if (until(text)) return text;
    if (!confirmed && / and continue\b/.test(text)) {
      await d.shot(`${tag}-confirm`);
      await d.click({ contains: ' and continue' });
      confirmed = true;
    } else if (!confirmed && text.includes('Continue') && !text.includes('Checking')) {
      await d.shot(`${tag}-confirm`);
      await d.click('Continue');
      confirmed = true;
    }
    if (!running && text.includes('Show details')) {
      running = true;
      await d.shot(`${tag}-running`);
    }
    if (text.includes('Try again')) {
      await d.shot(`${tag}-failed`);
      throw new Error(
        `the switch ended: ${text.split('\n').find((l) => /put back|could not be put back|Nothing had been changed|only the game launch|Stopped|gave up/.test(l)) ?? 'see the screenshot'}`,
      );
    }
    if (Date.now() > deadline) throw new Error(`the dialog did not reach the expected state within ${timeoutMs} ms`);
    await sleep(250);
  }
}

/** Screenshots the finished dialog, presses Done, and returns the dialog's final text. */
export async function finishDialog(d, tag) {
  await d.shot(`${tag}-done`);
  const text = await d.text();
  await d.click('Done');
  await d.waitFor('Done', { absent: true });
  return text;
}

/**
 * Clicks Play on a game card, picks an account, presses Play, answers a confirm stage if one appears, and
 * waits for the dialog to finish. Returns the outcome text ('Launched as', 'Switched to', or the failure sentence).
 */
export async function playThrough(d, { game, account, launcher, tag = launcher, timeoutMs = 60_000, expect = 'Launched as' }) {
  await startPlay(d, { game, account, tag });
  await watchDialog(d, { until: (text) => text.includes(expect), tag, timeoutMs });
  return finishDialog(d, tag);
}

/**
 * Switches a launcher to an account without launching a game: opens the account's page from the Accounts view
 * (by its login, which is unique across launchers), presses Switch to this account, confirms the dialog once if
 * it asks, and waits for it to finish. Returns the dialog's final text ('Switched to', or the failure sentence).
 */
export async function switchThrough(d, { account, login, launcher, tag = `${launcher}-switch`, timeoutMs = 60_000, expect = 'Switched to' }) {
  await d.click('Accounts');
  await d.waitFor(login);
  await d.click({ contains: login });
  await d.waitFor('Switch to this account');
  await d.click('Switch to this account');
  await d.waitFor(`Switch ${LAUNCHER_NAMES[launcher]} to ${account}`);
  await d.shot(`${tag}-pick`);
  await d.click('Switch');
  await watchDialog(d, { until: (text) => text.includes(expect), tag, timeoutMs });
  return finishDialog(d, tag);
}

/** The newest successful launch of a game (one row per game and account pair), or null. */
export async function recentFor(d, game) {
  const { recent } = await d.invoke('launch:recent', { limit: 50 });
  return recent.find((l) => l.gameName === game) ?? null;
}
