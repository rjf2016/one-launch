import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoRoot } from '../../app-driver.mjs';
import { ShotDriver, sleep } from '../ui/kit.mjs';
import { Feed, closedPort } from './feed.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const TIMERS_PRELOAD = join(here, 'timers-preload.cjs');
const TIMERS_ENV = 'ORACLE_UPDATES_TIMERS';
const SETTLE_MS = 750;
const BUSY = new Set(['checking', 'downloading']);
export const FIRST_CHECK_MS = 15_000;
export const LATE_LIMIT_MS = 5_000;

const OBSERVER = `(() => {
  if (window.__oracleUpdates) return true;
  const box = { seen: [], polls: 0, stop: false, error: null };
  Object.defineProperty(window, '__oracleUpdates', { value: box });
  let last = null;
  (async () => {
    while (!box.stop) {
      try {
        const r = await window.oneLaunch.invoke('updates:status');
        box.polls += 1;
        const text = JSON.stringify(r);
        if (text !== last) { last = text; box.seen.push(r && r.ok ? r.data : { envelope: r }); }
      } catch (e) {
        box.error = String(e);
        await new Promise((done) => setTimeout(done, 5));
      }
    }
  })();
  return true;
})()`;

const LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) (DEBUG|INFO |WARN |ERROR) \[([^\]]+)\] (.*)$/;
const KEPT_SCOPES = new Set(['main:updates', 'main:updater']);
const APP_LINES = [/^update install \(test feed, installer not run\)$/];

function splitMeta(rest) {
  for (let i = rest.indexOf(' {'); i !== -1; i = rest.indexOf(' {', i + 1)) {
    try {
      return { message: rest.slice(0, i), meta: JSON.parse(rest.slice(i + 1)) };
    } catch {
      // that brace belongs to the message
    }
  }
  return { message: rest };
}

export function parseLog(text) {
  const lines = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = LINE.exec(raw);
    if (!m || !KEPT_SCOPES.has(m[3])) continue;
    const level = m[2].trim();
    const exact = m[3] === 'main:updates' || APP_LINES.some((re) => re.test(m[4]));
    lines.push(exact ? { level, scope: m[3], exact, ...splitMeta(m[4]) } : { level, scope: m[3], exact, text: m[4] });
  }
  return lines;
}

function listTree(root, base = root) {
  if (!existsSync(root)) return [];
  const out = [];
  for (const name of readdirSync(root).sort()) {
    const full = join(root, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listTree(full, base));
    else out.push({ path: relative(base, full).replace(/\\/g, '/'), size: st.size });
  }
  return out;
}

function dataFolder(dataDir) {
  const cache = join(dataDir, 'update-cache');
  const info = join(cache, 'pending', 'update-info.json');
  const config = join(dataDir, 'dev-app-update.yml');
  return {
    devAppUpdateYml: existsSync(config) ? readFileSync(config, 'utf8') : null,
    updateCache: listTree(cache).map((f) => ({ ...f, path: `update-cache/${f.path}` })),
    updateInfoJson: existsSync(info) ? JSON.parse(readFileSync(info, 'utf8')) : null,
    updaterIdFile: existsSync(join(dataDir, '.updaterId')),
  };
}

async function removeFolder(folder) {
  for (let i = 0; i < 20 && existsSync(folder); i += 1) {
    try {
      rmSync(folder, { recursive: true, force: true });
    } catch {
      await sleep(500);
    }
  }
}

function readTimers(file) {
  if (!file || !existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

export function timerTiming(timers) {
  const arm = timers.find((e) => e.ev === 'arm' && e.ms === FIRST_CHECK_MS);
  const fire = arm ? timers.find((e) => e.ev === 'fire' && e.ms === FIRST_CHECK_MS && e.seq > arm.seq) : null;
  return arm && fire ? fire.t - arm.t : null;
}

export async function recordRun(cond, fx, { slot, timeoutMs = 60_000 }) {
  const states = [];
  const actions = [];
  const results = new Map();
  const marks = [];
  let syncing = true;
  let feed = null;
  let d = null;

  const last = () => states[states.length - 1] ?? null;
  const until = async (test, what, ms = timeoutMs) => {
    const deadline = Date.now() + ms;
    while (!test()) {
      if (Date.now() > deadline) throw new Error(`${cond.name}: timed out waiting for ${what}; last states ${JSON.stringify(states.slice(-3))}`);
      await sleep(10);
    }
  };
  const stateIs = (state) => () => last()?.state === state;
  const act = async (channel, req, at) => {
    await d.invoke(channel, req);
    actions.push({ invoke: channel, req, at });
  };
  const autoOff = (at) => act('settings:set', { key: 'updates.auto', value: 'false' }, at);

  const answer = async (rec) => {
    const f = cond.feed;
    const status = f.status ?? 200;
    if (rec.path === '/latest.yml' || status !== 200) await until(stateIs('checking'), 'checking before the feed answers');
    if (status !== 200) return { status, parts: [] };
    if (rec.path === '/latest.yml') {
      if (cond.autoOffAt === 'manifest' && actions.every((a) => a.req.key !== 'updates.auto')) await autoOff('while the feed holds its answer to latest.yml');
      if (f.manifest === null) return { status: 404, parts: [] };
      return { status: 200, parts: [Buffer.from(f.manifest, 'utf8')] };
    }
    if (rec.path === `/${fx.url}`) {
      await until(stateIs('downloading'), 'downloading before the feed sends the installer');
      const bytes = f.installer;
      if (cond.autoOffAt === 'installer' && actions.every((a) => a.req.key !== 'updates.auto')) {
        await autoOff('while the feed holds its answer to the installer');
        await until(stateIs('idle'), 'idle once the download is cancelled');
        return { hold: 'never answered: the feed keeps holding it after the download was cancelled' };
      }
      if (cond.paced) {
        const third = Math.floor(bytes.length / 3);
        return {
          status: 200,
          parts: [
            bytes.subarray(0, third),
            () => sleep(1200),
            bytes.subarray(third, 2 * third),
            () => until(() => last()?.state === 'downloading' && last().percent > 0, 'a progress report', 10_000),
            bytes.subarray(2 * third),
          ],
        };
      }
      return { status: 200, parts: [bytes] };
    }
    return { status: 404, parts: [] };
  };

  let port;
  if (cond.feed) {
    feed = new Feed(answer, () => marks[marks.length - 1]?.step ?? null);
    port = await feed.listen();
  } else {
    port = await closedPort();
  }

  const timersFile = () => d?.timersFile ?? null;
  const logBytes = () => (d && existsSync(d.logPath()) ? statSync(d.logPath()).size : 0);
  const mark = (step, by) =>
    marks.push({
      step,
      by,
      states: states.length,
      requests: feed?.requests.length ?? 0,
      timers: readTimers(timersFile()).length,
      log: logBytes(),
      actions: actions.length,
    });

  const startedAt = Date.now();
  let syncLoop = null;
  const stopObserving = async () => {
    if (!syncLoop) return;
    await d.evaluate('window.__oracleUpdates.stop = true').catch(() => undefined);
    await sleep(50);
    syncing = false;
    await syncLoop;
    syncLoop = null;
  };
  try {
    d = new ShotDriver({
      name: `updates-${cond.name}`,
      slot,
      fake: 'none',
      env: { ONELAUNCH_UPDATE_FEED: `http://127.0.0.1:${port}/`, ONELAUNCH_UPDATE_KEYS: cond.keys.join(',') },
      readyText: 'Library',
    });
    await d.lay();
    d.timersFile = join(d.controlDir, 'update-timers.jsonl');
    d.env = { ...d.env, NODE_OPTIONS: `${d.env.NODE_OPTIONS} --require "${TIMERS_PRELOAD.replace(/\\/g, '/')}"`, [TIMERS_ENV]: d.timersFile };
    mark('start', 'app start');
    d.spawn();
    await d.connect();
    await d.evaluate(OBSERVER);
    syncLoop = (async () => {
      while (syncing) {
        try {
          states.push(...(await d.evaluate(`window.__oracleUpdates ? window.__oracleUpdates.seen.slice(${states.length}) : []`)));
        } catch {
          // the page is going away
        }
        await sleep(15);
      }
    })();

    for (const step of cond.steps) {
      if (step === 'start') {
        await act('settings:set', { key: 'logLevel', value: 'debug' }, 'before the first check, so that the engine lines reach the log');
        await until(() => states.length > 0 && readTimers(timersFile()).some((e) => e.ev === 'arm'), 'the first-check timer and a first state');
        if (readTimers(timersFile()).some((e) => e.ev === 'fire')) throw new Error(`${cond.name}: the first check fired before the start step was over`);
      } else if (step === 'timer' || step === 'timer-again') {
        mark(step, step === 'timer' ? 'the first-check timer' : 'the timer armed by turning automatic updates on');
        const from = states.length;
        const fired = readTimers(timersFile()).filter((e) => e.ev === 'fire').length;
        await until(
          () => readTimers(timersFile()).filter((e) => e.ev === 'fire').length > fired && states.length > from && !BUSY.has(last().state),
          'the background check to settle',
        );
        await sleep(SETTLE_MS);
      } else if (step === 'auto-on') {
        mark('auto-on', 'settings:set updates.auto true');
        const armed = readTimers(timersFile()).filter((e) => e.ev === 'arm').length;
        await act('settings:set', { key: 'updates.auto', value: 'true' }, 'after the cancelled download');
        await until(() => readTimers(timersFile()).filter((e) => e.ev === 'arm').length > armed, 'a timer armed by turning automatic updates on');
        await sleep(SETTLE_MS);
      } else if (step === 'manual') {
        mark('manual', 'updates:check');
        const from = states.length;
        const res = await d.invoke('updates:check');
        results.set('manual', { answer: res });
        if (BUSY.has(res.state)) await until(() => states.length > from && !BUSY.has(last().state), 'the manual check to settle');
        await sleep(SETTLE_MS);
      } else if (step === 'install') {
        mark('install', 'updates:install');
        await stopObserving();
        await d.evaluate("void window.oneLaunch.invoke('updates:install').catch(() => undefined), true");
        results.set('install', { exit: await d.waitForExit({ timeoutMs: 30_000 }) });
      } else if (step === 'quit') {
        mark('quit', 'window close');
        await stopObserving();
        results.set('quit', { exit: await d.close({ timeoutMs: 30_000 }) });
      } else {
        throw new Error(`unknown step ${step}`);
      }
    }
  } finally {
    syncing = false;
    await syncLoop?.catch(() => undefined);
    if (d?.child && d.exitCode === null) {
      await Promise.race([d.close(), sleep(25_000)]);
      if (d.exitCode === null) await d.killHard();
    }
    await feed?.close();
    await sleep(100);
  }

  const timers = readTimers(timersFile());
  const logText = existsSync(d.logPath()) ? readFileSync(d.logPath()) : Buffer.alloc(0);
  const requests = feed?.requests ?? [];
  const steps = marks.map((m, i) => {
    const next = marks[i + 1];
    const slice = (list, key) => list.slice(m[key], next ? next[key] : undefined);
    const own = slice(actions, 'actions');
    return {
      step: m.step,
      by: m.by,
      ...(own.length ? { actions: own } : {}),
      ...(results.get(m.step) ?? {}),
      states: slice(states, 'states'),
      requests: slice(requests, 'requests'),
      timers: slice(timers, 'timers').map(({ ev, ms }) => ({ ev, ms })),
      log: parseLog(logText.subarray(m.log, next ? next.log : undefined).toString('utf8')),
    };
  });

  const value = { condition: cond.name, steps, dataFolder: dataFolder(d.dataDir) };
  const roots = { data: d.dataDir, scratch: d.scratch, repo: repoRoot };
  const run = { value, roots, port, elapsedMs: Date.now() - startedAt, firstCheckMs: timerTiming(timers) };
  await removeFolder(d.scratch);
  return run;
}
