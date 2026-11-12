// Measures the packaged exe for the performance baseline (ticket M0-T10) and writes perf/baseline.json and perf/METHOD.md into the bundle.
//   node scripts/oracle/perf/measure.mjs [--out <bundle>] [--starts=20] [--settle-s=30] [--window-s=60] [--windows=3] [--status-repeats=20]
//   node scripts/oracle/perf/measure.mjs --method-only   copies METHOD.md into the bundle and measures nothing
// Run it after `npm run build`, on an unlocked desktop with nothing covering the app's window. Reads only: it never
// starts a switch, a launch or a launcher; launchers:status is the one launcher call it makes.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from '../../app-driver.mjs';
import { skipSetup, waitForVaultKey } from '../../scenarios/lib.mjs';
import { resolveOut, writeArtefact } from '../lib/out.mjs';
import { readPin } from '../lib/bundle.mjs';
import { Counters, PACKAGED_DIR, PerfDriver, SCRATCH, checkScratch, folderSize, machineFacts, repoRoot, sleep, stats } from './lib.mjs';

const { flags } = parseArgs(process.argv.slice(2));
const num = (name, fallback) => (flags[name] === undefined ? fallback : Number(flags[name]));
const STARTS = num('starts', 20);
const SETTLE_S = num('settle-s', 30);
const WINDOW_S = num('window-s', 60);
const WINDOWS = num('windows', 3);
const STATUS_REPEATS = num('status-repeats', 20);
const STARTUP_LINE_WAIT_MS = 15_000;
const SCAN_WAIT_MS = 120_000;
const PAINT_WAIT_MS = 10_000;
const out = resolveOut(process.argv.slice(2));
const LARGE_DB = join(out, 'fixtures', 'db', 'onelaunch-large-v5.db');
const INSTALLER = join(repoRoot, 'dist', 'OneLaunch-1.0.0-beta.3-setup.exe');
const here = join(repoRoot, 'scripts', 'oracle', 'perf');

checkScratch();
const temp = join(SCRATCH, 'temp');
mkdirSync(temp, { recursive: true });
process.env.TEMP = temp;
process.env.TMP = temp;
const appEnv = { TEMP: temp, TMP: temp };

const STARTUP_LINE = / \[main\] startup (\{.*\})$/;
const PAGE_TIMING = `(() => ({
  origin: performance.timeOrigin,
  visibility: document.visibilityState,
  visibilityEntries: performance.getEntriesByType('visibility-state').map((e) => [e.name, e.startTime]),
  marks: Object.fromEntries(performance.getEntriesByType('mark').map((m) => [m.name, m.startTime])),
  paint: Object.fromEntries(performance.getEntriesByType('paint').map((p) => [p.name, p.startTime])),
}))()`;
const STATUS_CALL = `(async () => {
  const t0 = performance.now();
  const r = await window.oneLaunch.invoke('launchers:status');
  const ms = performance.now() - t0;
  return r.ok
    ? { ms, ok: true, installed: r.data.launchers.filter((l) => l.install !== null).length, answered: r.data.launchers.length }
    : { ms, ok: false, code: r.error.code };
})()`;

const round = (v, digits = 1) => (typeof v === 'number' ? Math.round(v * 10 ** digits) / 10 ** digits : null);
const git = (args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();

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

/** The page's timing once the library frame mark and both paint entries are in (paint entries carry presentation times and land a few frames late), or what is there after the wait. */
async function pageTiming(d) {
  const deadline = Date.now() + PAINT_WAIT_MS;
  for (;;) {
    const page = await d.evaluate(PAGE_TIMING);
    const complete =
      page.marks['startup:library-frame'] !== undefined && page.paint['first-paint'] !== undefined && page.paint['first-contentful-paint'] !== undefined;
    if (complete || Date.now() > deadline) return { ...page, complete };
    await sleep(100);
  }
}

async function waitForScan(d) {
  const deadline = Date.now() + SCAN_WAIT_MS;
  while (!(await d.invoke('artwork:status')).status.scanned) {
    if (Date.now() > deadline) throw new Error('the startup library scan did not finish');
    await sleep(250);
  }
}

const FILETIME_EPOCH_MS = 11_644_473_600_000;
const fileTimeToEpochMs = (ft) => Number(BigInt(ft) / 10_000n) - FILETIME_EPOCH_MS;

/** One start's marks, each in ms from the process's creation as main records it; the page's marks are moved onto the same origin. */
async function measureStart(d, counters, n, role) {
  const lines = await waitForStartupLines(d, n);
  const outside = await counters.of([d.child.pid]);
  const page = await pageTiming(d);
  const { startup, electron, chrome, node, version } = await d.invoke('app:info');
  const marks = lines.length === n ? lines[n - 1] : {};
  const created = typeof marks.creationEpochMs === 'number' ? marks.creationEpochMs : null;
  const fromPage = (t) => (typeof t === 'number' && created !== null ? round(page.origin + t - created) : null);
  const createdOutside = outside.processes[0]?.creationFileTime ? fileTimeToEpochMs(outside.processes[0].creationFileTime) : null;
  const sample = {
    n,
    role,
    visibility: page.visibility,
    visibilityEntries: page.visibilityEntries.map(([name, t]) => [name, fromPage(t)]),
    startupLineFound: lines.length === n,
    pageMarksComplete: page.complete,
    spawnToCreatedMs: created === null ? null : created - d.spawnedAt,
    spawnToCreatedOutsideMs: createdOutside === null ? null : createdOutside - d.spawnedAt,
    spawnToDriverReadyMs: d.readyAt - d.spawnedAt,
    marks: {
      processToNodeMs: startup.processToNodeMs,
      moduleLoadedMs: marks.moduleLoadedMs ?? null,
      readyMs: marks.readyMs ?? null,
      dbMs: marks.dbMs ?? null,
      vaultMs: marks.vaultMs ?? null,
      ipcMs: marks.ipcMs ?? null,
      windowCreatedMs: marks.windowCreatedMs ?? null,
      windowShownMs: startup.windowShownMs,
      didFinishLoadMs: startup.didFinishLoadMs,
      readyToShowMs: startup.readyToShowMs,
      pageNavigationStartMs: fromPage(0),
      pageModuleMs: fromPage(page.marks['startup:module']),
      pagePrefetchedMs: fromPage(page.marks['startup:prefetched']),
      pageRenderMs: fromPage(page.marks['startup:render']),
      pageFirstCommitMs: fromPage(page.marks['startup:first-commit']),
      pageFirstPaintMs: fromPage(page.paint['first-paint']),
      pageFirstContentfulPaintMs: fromPage(page.paint['first-contentful-paint']),
      pageLibraryDataMs: fromPage(page.marks['startup:library-data']),
      pageLibraryFrameMs: fromPage(page.marks['startup:library-frame']),
    },
  };
  const { pageLibraryFrameMs: frame, pageFirstContentfulPaintMs: fcp, pageLibraryDataMs: data, pageFirstPaintMs: fp } = sample.marks;
  sample.interactiveMs = typeof frame === 'number' && typeof fcp === 'number' ? Math.max(frame, fcp) : null;
  sample.libraryDataBeforeFirstPaint = typeof data === 'number' && typeof fp === 'number' ? data <= fp : null;
  sample.interactiveFromSpawnMs =
    sample.interactiveMs === null || sample.spawnToCreatedMs === null ? null : round(sample.interactiveMs + sample.spawnToCreatedMs);
  const ms = (v) => (typeof v === 'number' ? `${Math.round(v)}` : 'n/a');
  console.log(
    `  start ${n} (${role}, page ${page.visibility}): created +${ms(sample.spawnToCreatedMs)}  ready ${ms(sample.marks.readyMs)}  ipc ${ms(sample.marks.ipcMs)}  shown ${ms(sample.marks.windowShownMs)}  fcp ${ms(sample.marks.pageFirstContentfulPaintMs)}  library frame ${ms(sample.interactiveMs)} ms`,
  );
  return { sample, versions: { version, electron, chrome, node } };
}

async function statusCall(d) {
  const r = await d.evaluate(STATUS_CALL);
  if (!r.ok) throw new Error(`launchers:status answered ${r.code}`);
  return { ms: round(r.ms, 2), installed: r.installed, answered: r.answered };
}

function summarise(processSample) {
  const byType = {};
  for (const p of processSample) {
    const t = (byType[p.type] ??= { processes: 0, workingSet: 0, privateWorkingSet: 0, privateBytes: 0 });
    t.processes += 1;
    t.workingSet += p.workingSet;
    t.privateWorkingSet += p.privateWorkingSet ?? 0;
    t.privateBytes += p.privateBytes;
  }
  const total = { processes: 0, workingSet: 0, privateWorkingSet: 0, privateBytes: 0 };
  for (const t of Object.values(byType)) for (const k of Object.keys(total)) total[k] += t[k];
  return { byType, total };
}

/** Snapshots at the start and end of each window: CDP's process list with cpuTime, and per-pid counters for exactly those pids. */
async function sampleIdle(d, counters, label) {
  const snaps = [];
  for (let k = 0; k <= WINDOWS; k += 1) {
    const cdp = await d.browser.processes();
    const ctr = await counters.of(cdp.list.map((p) => p.pid));
    const byPid = new Map(ctr.processes.map((p) => [p.pid, p]));
    const processes = cdp.list.map((p) => {
      const c = byPid.get(p.pid) ?? {};
      return {
        type: p.type,
        pid: p.pid,
        cpuTimeS: p.cpuTime,
        creationFileTime: c.creationFileTime ?? null,
        kernel100ns: c.kernel100ns ?? null,
        user100ns: c.user100ns ?? null,
        workingSet: c.workingSet ?? null,
        privateWorkingSet: c.privateWorkingSet ?? null,
        privateBytes: c.privateBytes ?? null,
        error: c.error ?? null,
      };
    });
    snaps.push({ cdpAt: cdp.at, countersAt: ctr.at, processes });
    if (k < WINDOWS) await sleep(WINDOW_S * 1000);
  }
  const windows = [];
  for (let k = 0; k < WINDOWS; k += 1) {
    const a = snaps[k];
    const b = snaps[k + 1];
    const wallS = (b.cdpAt - a.cdpAt) / 1000;
    const wallCountersS = (b.countersAt - a.countersAt) / 1000;
    const before = new Map(a.processes.map((p) => [`${p.pid}:${p.creationFileTime}`, p]));
    const byType = {};
    const total = { cdpCpuS: 0, osCpuS: 0 };
    const unmatched = [];
    for (const p of b.processes) {
      const q = before.get(`${p.pid}:${p.creationFileTime}`);
      if (!q) {
        unmatched.push({ type: p.type, end: 'only at the end' });
        continue;
      }
      const cdpCpuS = p.cpuTimeS - q.cpuTimeS;
      const osCpuS = p.kernel100ns === null || q.kernel100ns === null ? null : (p.kernel100ns + p.user100ns - q.kernel100ns - q.user100ns) / 1e7;
      const t = (byType[p.type] ??= { processes: 0, cdpCpuS: 0, osCpuS: 0 });
      t.processes += 1;
      t.cdpCpuS += cdpCpuS;
      t.osCpuS += osCpuS ?? 0;
      total.cdpCpuS += cdpCpuS;
      total.osCpuS += osCpuS ?? 0;
    }
    for (const p of a.processes)
      if (!b.processes.some((x) => x.pid === p.pid && x.creationFileTime === p.creationFileTime)) unmatched.push({ type: p.type, end: 'only at the start' });
    const pct = (s, w) => round((s / w) * 100, 3);
    windows.push({
      wallS: round(wallS, 3),
      byType: Object.fromEntries(
        Object.entries(byType).map(([type, t]) => [
          type,
          {
            processes: t.processes,
            cdpCpuS: round(t.cdpCpuS, 4),
            osCpuS: round(t.osCpuS, 4),
            cdpPctOfCore: pct(t.cdpCpuS, wallS),
            osPctOfCore: pct(t.osCpuS, wallCountersS),
          },
        ]),
      ),
      total: {
        cdpCpuS: round(total.cdpCpuS, 4),
        osCpuS: round(total.osCpuS, 4),
        cdpPctOfCore: pct(total.cdpCpuS, wallS),
        osPctOfCore: pct(total.osCpuS, wallCountersS),
      },
      unmatched,
    });
  }
  const memory = snaps.map((s) => summarise(s.processes));
  console.log(
    `  ${label}: cpu ${windows.map((w) => `${w.total.cdpPctOfCore}%`).join(' / ')} of one core; private working set ${memory.map((m) => `${(m.total.privateWorkingSet / 2 ** 20).toFixed(1)}`).join(' / ')} MiB`,
  );
  const raw = snaps.map((s) => ({
    cdpAt: s.cdpAt,
    countersAt: s.countersAt,
    processes: s.processes.map(({ pid: _pid, creationFileTime: _c, ...rest }) => rest),
  }));
  return { windows, memory, raw };
}

async function idleSession(d, counters, label) {
  await waitForScan(d);
  const result = { visibleBefore: await d.evaluate('document.visibilityState') };
  await sleep(SETTLE_S * 1000);
  result.visible = await sampleIdle(d, counters, `${label} visible`);
  result.visibleAfter = await d.evaluate('document.visibilityState');
  result.closePosted = await counters.closeWindows(d.child.pid);
  await d.waitFor(() => document.visibilityState === 'hidden', { timeoutMs: 15_000 });
  result.hiddenToTrayLogged = d.readLog().includes('window hidden to the tray');
  result.appStillUp = d.exitCode === null;
  await sleep(SETTLE_S * 1000);
  result.hidden = await sampleIdle(d, counters, `${label} hidden`);
  result.hiddenAfter = await d.evaluate('document.visibilityState');
  return result;
}

function aggregateIdle(session) {
  const state = (s) => ({
    cpuPctOfCore: {
      total: stats(s.windows.map((w) => w.total.cdpPctOfCore)),
      totalFromOsCounters: stats(s.windows.map((w) => w.total.osPctOfCore)),
      byType: Object.fromEntries(Object.keys(s.windows[0].byType).map((type) => [type, stats(s.windows.map((w) => w.byType[type]?.cdpPctOfCore ?? null))])),
    },
    memoryBytes: {
      privateWorkingSet: stats(s.memory.map((m) => m.total.privateWorkingSet)),
      workingSet: stats(s.memory.map((m) => m.total.workingSet)),
      privateBytes: stats(s.memory.map((m) => m.total.privateBytes)),
      byType: Object.fromEntries(
        Object.keys(s.memory[0].byType).map((type) => [
          type,
          {
            privateWorkingSet: stats(s.memory.map((m) => m.byType[type]?.privateWorkingSet ?? null)),
            workingSet: stats(s.memory.map((m) => m.byType[type]?.workingSet ?? null)),
            privateBytes: stats(s.memory.map((m) => m.byType[type]?.privateBytes ?? null)),
          },
        ]),
      ),
    },
  });
  return { visible: state(session.visible), hidden: state(session.hidden) };
}

async function screenState(d) {
  return d.evaluate(`(() => {
    const text = document.body.innerText;
    return {
      setupGuide: text.includes('Welcome to One Launch'),
      libraryHeading: [...document.querySelectorAll('h1, h2')].some((h) => h.textContent.trim() === 'Library'),
      whatsNew: text.includes("What's New") || text.includes('What’s New'),
      dialogs: document.querySelectorAll('[role="dialog"], [role="alertdialog"]').length,
      devicePixelRatio: window.devicePixelRatio,
      screen: [screen.width, screen.height],
      inner: [innerWidth, innerHeight],
    };
  })()`);
}

function powerState() {
  const ps = execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Add-Type -AssemblyName System.Windows.Forms; $p = [System.Windows.Forms.SystemInformation]::PowerStatus; "$($p.PowerLineStatus) $($p.BatteryChargeStatus)"',
    ],
    { encoding: 'utf8', windowsHide: true },
  ).trim();
  const [powerLine, ...battery] = ps.split(' ');
  const scheme = /\(([^)]+)\)\s*\*?\s*$/.exec(execFileSync('powercfg', ['/getactivescheme'], { encoding: 'utf8', windowsHide: true }).trim());
  return { powerLine, battery: battery.join(' '), powerScheme: scheme ? scheme[1] : null };
}

async function gpuFacts(d) {
  const info = await d.browser.send('SystemInfo.getInfo');
  return info.gpu.devices.map((g) => ({
    vendor: g.vendorString || null,
    device: g.deviceString || null,
    driverVersion: g.driverVersion || null,
    active: g.active ?? null,
  }));
}

const sri = (bytes) => `sha256-${createHash('sha256').update(bytes).digest('base64')}`;

async function run() {
  const pin = readPin(out);
  const commit = git(['rev-parse', 'HEAD']);
  const record = {
    ticket: 'M0-T10',
    measured: {
      pin: pin.commit,
      pinVersion: pin.version,
      branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
      branchCommit: commit,
      srcDiffStatFromPin: git(['diff', '--stat', pin.commit, '--', 'src']).split(/\r?\n/),
      srcDirty: git(['status', '--porcelain', '--', 'src']) !== '',
      exe: 'dist/win-unpacked/OneLaunch.exe',
    },
    parameters: { warmStarts: STARTS, settleS: SETTLE_S, windowS: WINDOW_S, windows: WINDOWS, statusRepeats: STATUS_REPEATS, percentile: 'nearest rank' },
  };

  const counters = await Counters.start();
  const drivers = [];
  try {
    console.log('Primer start (the first after the build; discarded)');
    const primer = new PerfDriver({ name: 'primer', folder: join(SCRATCH, 'primer'), env: appEnv });
    drivers.push(primer);
    await primer.start();
    const primed = await measureStart(primer, counters, 1, 'primer');
    record.machine = { ...machineFacts(), gpu: await gpuFacts(primer), ...powerState() };
    record.app = primed.versions;
    record.discarded = [primed.sample];
    await primer.close();

    console.log('Warm series');
    const d = new PerfDriver({ name: 'warm', folder: join(SCRATCH, 'warm'), env: appEnv });
    drivers.push(d);
    await d.start();
    record.discarded.push((await measureStart(d, counters, 1, 'first start on an empty folder')).sample);
    await d.invoke('settings:set', { key: 'artwork.autoFetch', value: 'false' });
    const guide = await skipSetup(d);
    await waitForVaultKey(d);
    await waitForScan(d);
    record.warmFolderSetup = { setupGuideSkipped: guide, artworkAutoFetch: 'false', vaultKeyOnDisk: true, firstScanDone: true };
    const warm = [];
    const statusFirst = [];
    for (let i = 2; i <= STARTS + 1; i += 1) {
      await d.restart();
      const { sample } = await measureStart(d, counters, i, 'warm');
      await waitForScan(d);
      const first = await statusCall(d);
      sample.launchersStatusFirstCallMs = first.ms;
      statusFirst.push(first);
      warm.push(sample);
    }
    record.warmFolderScreen = { ...(await screenState(d)), libraryEmpty: (await d.invoke('library:list')).games.length === 0 };
    const repeated = [];
    for (let i = 0; i < STATUS_REPEATS; i += 1) {
      repeated.push(await statusCall(d));
      await sleep(250);
    }
    console.log('Idle, warm folder');
    const warmIdle = await idleSession(d, counters, 'warm folder');
    const code = await d.close();
    record.warmFolderExitCode = code;

    console.log('Idle, large fixture database');
    const large = new PerfDriver({ name: 'large', folder: join(SCRATCH, 'large'), seedDb: LARGE_DB, env: appEnv });
    drivers.push(large);
    await large.start();
    const largeFirst = await measureStart(large, counters, 1, 'first start on the large database');
    record.discarded.push(largeFirst.sample);
    const [vaultFirst, accountsFirst, libraryFirst] = await Promise.all([
      large.invoke('vault:status'),
      large.invoke('accounts:list'),
      large.invoke('library:list'),
    ]);
    const largeFirstState = {
      vaultReadable: vaultFirst.readable,
      accounts: accountsFirst.accounts.length,
      installedGamesBeforeTheFirstScan: libraryFirst.games.length,
      screen: await screenState(large),
    };
    await large.invoke('settings:set', { key: 'artwork.autoFetch', value: 'false' });
    await waitForVaultKey(large);
    await waitForScan(large);
    await large.restart();
    const largeWarm = await measureStart(large, counters, 2, 'warm start on the large database');
    const vaultWarm = await large.invoke('vault:status');
    const largeWarmScreen = await screenState(large);
    const accountsWarm = await large.invoke('accounts:list');
    const largeIdle = await idleSession(large, counters, 'large database');
    record.largeDbExitCode = await large.close();
    const largeErrors = large.errorLines();
    record.largeDb = {
      fixture: 'fixtures/db/onelaunch-large-v5.db',
      firstStart: largeFirstState,
      warmStart: largeWarm.sample,
      stateWhileMeasured: {
        vaultReadable: vaultWarm.readable,
        accounts: accountsWarm.accounts.length,
        screen: largeWarmScreen,
        errorLines: largeErrors.length,
        errorLineIsTheUnreadableVault: largeErrors.every((l) => l.includes('stored secrets cannot be decrypted')),
      },
    };

    const marks = Object.keys(warm[0].marks);
    record.warmStart = {
      interactiveMark: 'max(pageLibraryFrameMs, pageFirstContentfulPaintMs)',
      libraryDataBeforeFirstPaintInEveryStart: warm.every((s) => s.libraryDataBeforeFirstPaint === true),
      fromProcessCreationMs: {
        interactive: stats(warm.map((s) => s.interactiveMs)),
        ...Object.fromEntries(marks.map((m) => [m, stats(warm.map((s) => s.marks[m]))])),
      },
      spawnToCreatedMs: stats(warm.map((s) => s.spawnToCreatedMs)),
      interactiveFromSpawnMs: stats(warm.map((s) => s.interactiveFromSpawnMs)),
      visibility: warm.map((s) => s.visibility),
      allVisible: warm.every((s) => s.visibility === 'visible' && s.visibilityEntries.every(([name]) => name === 'visible')),
      samples: warm,
    };
    record.idle = {
      warmFolder: { summary: aggregateIdle(warmIdle), session: warmIdle },
      largeDb: { summary: aggregateIdle(largeIdle), session: largeIdle },
    };
    record.launchersStatus = {
      installedLaunchers: statusFirst[0].installed,
      answeredLaunchers: statusFirst[0].answered,
      firstCallPerStartMs: stats(statusFirst.map((s) => s.ms)),
      repeatedCallsMs: stats(repeated.map((s) => s.ms)),
      firstCallSamples: statusFirst.map((s) => s.ms),
      repeatedSamples: repeated.map((s) => s.ms),
      installedCountSteady: [...statusFirst, ...repeated].every((s) => s.installed === statusFirst[0].installed),
    };
  } finally {
    for (const drv of drivers) await drv.cleanup().catch(() => undefined);
    counters.stop();
  }

  const unpacked = folderSize(PACKAGED_DIR);
  const part = (rel) => {
    const p = join(PACKAGED_DIR, rel);
    if (!existsSync(p)) return null;
    return statSync(p).isDirectory() ? folderSize(p) : { bytes: statSync(p).size, files: 1, folders: 0 };
  };
  const installer = readFileSync(INSTALLER);
  record.install = {
    unpacked: { path: 'dist/win-unpacked', ...unpacked },
    parts: {
      'OneLaunch.exe': part('OneLaunch.exe'),
      'resources/app.asar': part('resources/app.asar'),
      'resources/app.asar.unpacked': part('resources/app.asar.unpacked'),
      locales: part('locales'),
    },
    installer: {
      file: 'dist/OneLaunch-1.0.0-beta.3-setup.exe',
      bytes: installer.length,
      digest: sri(installer),
      provenance: 'the owner’s release build of 1.0.0-beta.3, built before the pin; not built by this ticket',
    },
  };

  writeFileSync(join(SCRATCH, 'baseline.raw.json'), `${JSON.stringify(record, null, 2)}\n`);
  writeArtefact(out, 'perf/baseline.json', record);
  writeArtefact(out, 'perf/METHOD.md', readFileSync(join(here, 'METHOD.md')));
  copyFileSync(join(SCRATCH, 'baseline.raw.json'), join(SCRATCH, 'baseline.last.json'));
  console.log(`\nWrote ${join(out, 'perf', 'baseline.json')}`);
}

if (flags['method-only']) writeArtefact(out, 'perf/METHOD.md', readFileSync(join(here, 'METHOD.md')));
else await run();
