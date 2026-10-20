// The packaged exe's startup timings, from the moment it was spawned to the painted library: a first start on an
// empty folder, then two warm starts on the same folder (the user's everyday case: migrated database, games in it,
// Chromium's code and shader caches filled). Reads only. Run it after `npm run build`; the first run after a build
// is the one Defender scans the new exe on, so measure from the second run and compare medians over several runs.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sleep } from '../app-driver.mjs';
import { skipSetup, waitForVaultKey } from './lib.mjs';

export const name = 'startup-timing';
export const label = 'Startup timing (packaged)';
export const options = { packaged: true };

const STARTUP_LINE = / \[main\] startup (\{.*\})$/;

/** Main writes its startup line once the first paint and the page load have both happened; an occluded or locked desktop can hold the paint back for seconds. */
const STARTUP_LINE_WAIT_MS = 15_000;

/** The renderer's own marks (lib/startup.ts) and paint entries, all relative to its navigation start. */
const PAGE_TIMING = `(() => ({
  origin: performance.timeOrigin,
  visibility: document.visibilityState,
  marks: Object.fromEntries(performance.getEntriesByType('mark').map((m) => [m.name, m.startTime])),
  paint: Object.fromEntries(performance.getEntriesByType('paint').map((p) => [p.name, p.startTime])),
}))()`;

function startupLines(d) {
  return d
    .readLog()
    .split(/\r?\n/)
    .map((l) => STARTUP_LINE.exec(l))
    .filter(Boolean)
    .map((m) => JSON.parse(m[1]));
}

async function waitForStartupLines(d, n) {
  const deadline = Date.now() + STARTUP_LINE_WAIT_MS;
  for (;;) {
    const lines = startupLines(d);
    if (lines.length >= n || Date.now() > deadline) return lines;
    await sleep(100);
  }
}

function codeCacheEntries(d) {
  const dir = join(d.dataDir, 'chromium', 'Code Cache', 'js');
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((f) => f !== 'index' && f !== 'index-dir').length;
}

async function measure(d, n) {
  const lines = await waitForStartupLines(d, n);
  const { startup } = await d.invoke('app:info');
  const page = await d.evaluate(PAGE_TIMING);
  d.check(`start ${n}: the log has ${n} startup line(s) within ${STARTUP_LINE_WAIT_MS / 1000} s`, lines.length === n, `${lines.length}`);
  const marks = lines.length === n ? lines[n - 1] : {};
  const created = typeof marks.creationEpochMs === 'number' ? marks.creationEpochMs : null;
  const fromPage = (t) => (typeof t === 'number' && created !== null ? Math.round(page.origin + t - created) : null);

  const rows = [
    ['spawn -> process created', created === null ? null : Math.round(created - d.spawnedAt)],
    ['-> app code (processToNodeMs)', startup.processToNodeMs],
    ['-> main module evaluated', marks.moduleLoadedMs],
    ['-> ready', marks.readyMs],
    ['-> database open', marks.dbMs],
    ['-> vault probed', marks.vaultMs],
    ['-> IPC registered', marks.ipcMs],
    ['-> window created', marks.windowCreatedMs],
    ['-> window shown', startup.windowShownMs],
    ['-> interface loaded (didFinishLoadMs)', startup.didFinishLoadMs],
    ['-> first paint (readyToShowMs)', startup.readyToShowMs],
    ['-> page: navigation start', fromPage(0)],
    ['-> page: first module', fromPage(page.marks['startup:module'])],
    ['-> page: startup data prefetched', fromPage(page.marks['startup:prefetched'])],
    ['-> page: render called', fromPage(page.marks['startup:render'])],
    ['-> page: first commit', fromPage(page.marks['startup:first-commit'])],
    ['-> page: first contentful paint', fromPage(page.paint['first-contentful-paint'])],
    ['-> page: library data rendered', fromPage(page.marks['startup:library-data'])],
    ['-> page: library frame presented', fromPage(page.marks['startup:library-frame'])],
  ];
  console.log(
    `    start ${n}${n === 1 ? ' (empty folder)' : ' (warm folder)'}${page.visibility === 'visible' ? '' : ` (page ${page.visibility}: an occluded window paints late or never)`}:`,
  );
  for (const [text, ms] of rows) console.log(`      ${text.padEnd(44)} ${typeof ms === 'number' ? `${ms} ms` : 'n/a'}`);
  console.log(`      ${'renderer code cache entries'.padEnd(44)} ${codeCacheEntries(d)}`);

  d.check(`start ${n}: startup metrics count from process creation`, startup.processToNodeMs !== null);
  d.check(
    `start ${n}: the window was shown before the interface loaded`,
    typeof startup.windowShownMs === 'number' && typeof startup.didFinishLoadMs === 'number' && startup.windowShownMs < startup.didFinishLoadMs,
    `${startup.windowShownMs} < ${startup.didFinishLoadMs}`,
  );
  d.check(
    `start ${n}: IPC handlers were registered before the interface loaded`,
    typeof marks.ipcMs === 'number' && typeof startup.didFinishLoadMs === 'number' && marks.ipcMs <= startup.didFinishLoadMs,
    `${marks.ipcMs} <= ${startup.didFinishLoadMs}`,
  );
  return { startup, marks, fcp: fromPage(page.paint['first-contentful-paint']), libraryData: fromPage(page.marks['startup:library-data']) };
}

export default async (d) => {
  const first = await measure(d, 1);
  // Starts 2 and 3 are the everyday start: the guide dismissed, the first scan done, no artwork downloads competing, and the vault key on disk (a restart before Chromium writes it would lose it).
  await d.invoke('settings:set', { key: 'artwork.autoFetch', value: 'false' });
  await skipSetup(d);
  await waitForVaultKey(d);
  await d.restart();
  await measure(d, 2);
  await d.restart();
  const third = await measure(d, 3);

  const delta = (a, b) => (typeof a === 'number' && typeof b === 'number' ? `${b - a >= 0 ? '+' : ''}${b - a} ms` : 'n/a');
  console.log('    start 3 vs start 1:');
  console.log(`      ${'interface loaded'.padEnd(44)} ${delta(first.startup.didFinishLoadMs, third.startup.didFinishLoadMs)}`);
  console.log(`      ${'first paint'.padEnd(44)} ${delta(first.startup.readyToShowMs, third.startup.readyToShowMs)}`);
  console.log(`      ${'first contentful paint'.padEnd(44)} ${delta(first.fcp, third.fcp)}`);
  console.log(`      ${'library data rendered'.padEnd(44)} ${delta(first.libraryData, third.libraryData)}`);

  const code = await d.close();
  d.check('closing the window ends the app with exit code 0', code === 0, `code=${code}`);
  d.assertNoErrorLines();
};
