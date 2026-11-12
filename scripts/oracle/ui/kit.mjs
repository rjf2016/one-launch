import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Driver, materializeScenario, repoRoot, sleep } from '../../app-driver.mjs';
import { ORACLE_CLOCK } from '../lib/clock.mjs';
import { compileSchema, formatError } from '../lib/json-schema.mjs';
import { writeArtefact } from '../lib/out.mjs';
import { createUserPathScanner } from '../lib/user-paths.mjs';
import { pngSize, pngStats } from './png.mjs';
import { DEFAULT_SIZE, sizesOf, stemOf, SHOTS_DIR } from './rows.mjs';
import { AGED_PATTERN, SNAPSHOT_PARAMS, buildSidecar, sidecarStrings, sidecarText } from './sidecar.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const PRELOAD = join(here, 'main-preload.cjs');
const { installClock, markerName, CLOCK_KEY, OFFSET_ENV, CONTROL_ENV, HOOKED_MARKER } = require(PRELOAD);

export { ORACLE_CLOCK, sleep };
export const LOCALE = 'en-US';
export const TIMEZONE = 'UTC';
export const SCENARIOS_DIR = join(here, 'scenarios');

// A covered or minimised window stops producing frames; with these it paints as if it were in front.
const SWITCHES = [
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  '--disable-features=CalculateNativeWinOcclusion',
  '--force-color-profile=srgb',
];

const validateSidecar = compileSchema(JSON.parse(readFileSync(join(here, '..', 'schemas', 'layout-sidecar.schema.json'), 'utf8')));

export function scratchBase() {
  const base = resolve(process.env.ORACLE_SCRATCH ?? join(repoRoot, '..', 'oracle-scratch'));
  if (/[\\/]Users[\\/]/i.test(`${base}\\`)) throw new Error(`ORACLE_SCRATCH must name a folder outside any user profile, not ${base}`);
  if (`${base}\\`.toLowerCase().startsWith(`${repoRoot}\\`.toLowerCase())) throw new Error('ORACLE_SCRATCH must be outside the Electron repo');
  mkdirSync(base, { recursive: true });
  return base;
}

function freePort() {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
}

async function browserProcessId(port) {
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((open, fail) => {
    ws.onopen = open;
    ws.onerror = () => fail(new Error('could not open the browser target'));
  });
  try {
    const { processInfo } = await new Promise((done, fail) => {
      ws.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (msg.id !== 1) return;
        if (msg.error) fail(new Error(msg.error.message));
        else done(msg.result);
      };
      ws.send(JSON.stringify({ id: 1, method: 'SystemInfo.getProcessInfo' }));
    });
    return processInfo.find((p) => p.type === 'browser')?.id ?? null;
  } finally {
    ws.close();
  }
}

async function removeFolder(folder) {
  for (let i = 0; i < 20 && existsSync(folder); i += 1) {
    try {
      rmSync(folder, { recursive: true, force: true });
    } catch {
      await sleep(500);
    }
  }
  if (existsSync(folder)) throw new Error(`could not empty ${folder}; is a capture still running on it?`);
}

const PAGE_SETUP = `(${installClock.toString()})(__OFFSET__, ${JSON.stringify(CLOCK_KEY)});
(() => {
  if (window.__oracleUi) return;
  const state = { freezeIntervals: false };
  const realSetInterval = window.setInterval.bind(window);
  window.setInterval = (fn, ms, ...args) => realSetInterval(() => { if (!state.freezeIntervals) fn(...args); }, ms);
  Object.defineProperty(window, '__oracleUi', { value: state });
})();`;

const SETTLE = `(async () => {
  const frame = () => new Promise((done) => {
    let over = false;
    const end = () => { if (!over) { over = true; done(); } };
    requestAnimationFrame(() => requestAnimationFrame(end));
    setTimeout(end, 400);
  });
  await document.fonts.ready;
  const inView = (img) => { const r = img.getBoundingClientRect(); return r.width > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth; };
  const pending = [...document.images].filter((img) => !img.complete && inView(img)).length;
  let finished = 0;
  const paused = new Set();
  for (const animation of document.getAnimations()) {
    const timing = animation.effect && animation.effect.getComputedTiming ? animation.effect.getComputedTiming() : {};
    if (timing.iterations === Infinity || !Number.isFinite(timing.endTime)) {
      if (animation.playState !== 'paused' || animation.currentTime !== 0) { animation.pause(); animation.currentTime = 0; }
      paused.add(animation.animationName || animation.transitionProperty || 'animation');
    } else if (animation.playState !== 'finished') {
      try { animation.finish(); finished += 1; } catch { /* an animation without an end cannot be finished */ }
    }
  }
  await frame();
  const marks = [...document.querySelectorAll('*')].length + ':' + document.body.innerText.length;
  return { pending, finished, paused: [...paused].sort(), marks };
})()`;

const RECT_OF = `(target, nth) => {
  const roles = 'button, [role="button"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], [role="tab"], [role="switch"], [role="checkbox"], [role="radio"], summary, a[href], label';
  const name = (el) => (el.getAttribute('aria-label') ?? el.textContent ?? '').replace(/\\s+/g, ' ').trim();
  const named = (test) => [...document.querySelectorAll(roles)].filter((el) => test(name(el)));
  const els = typeof target === 'string' ? named((n) => n === target) : target.contains ? named((n) => n.includes(target.contains)) : [...document.querySelectorAll(target.selector)];
  const el = els[nth];
  if (!el) return null;
  el.scrollIntoView({ block: 'nearest' });
  const r = el.getBoundingClientRect();
  return [r.left, r.top, r.width, r.height];
}`;

export class ShotDriver extends Driver {
  constructor(opts) {
    if (opts.packaged) throw new Error('captures run the unpackaged build only');
    super({ ...opts, keep: true, args: [...SWITCHES, ...(opts.args ?? [])] });
    this.slot = opts.slot;
    this.holds = opts.holds ?? [];
    this.clockOffset = null;
  }

  async start() {
    await this.lay();
    this.spawn();
    await this.connect();
  }

  scenarioSource() {
    const folder = (name) => {
      if (isAbsolute(name)) return name;
      const committed = join(repoRoot, 'test', 'fake-launchers', name);
      return existsSync(committed) ? committed : join(SCENARIOS_DIR, name);
    };
    if (typeof this.fake === 'string') return folder(this.fake);
    const scenario = JSON.parse(readFileSync(join(folder(this.fake.from), 'scenario.json'), 'utf8'));
    this.fake.change(scenario);
    const made = join(this.scratch, 'scenario');
    mkdirSync(made);
    writeFileSync(join(made, 'scenario.json'), JSON.stringify(scenario, null, 2));
    return made;
  }

  async lay() {
    if (!existsSync(this.exe)) throw new Error(`Not found: ${this.exe}\nInstall dependencies first: npm ci`);
    if (!existsSync(join(repoRoot, 'out', 'main', 'index.js'))) throw new Error('Build the app first: npx electron-vite build');
    // The driver's own port is a random pick; two captures at once would sooner or later share one and drive each other's app.
    this.port = await freePort();
    this.scratch = join(scratchBase(), this.slot);
    await removeFolder(this.scratch);
    this.dataDir = join(this.scratch, 'data');
    this.controlDir = join(this.scratch, 'control');
    const temp = join(this.scratch, 'temp');
    for (const folder of [this.dataDir, this.controlDir, temp]) mkdirSync(folder, { recursive: true });
    this.shotsDir = join(this.scratch, 'failures');
    for (const name of this.holds) this.mark('hold', name, '');
    if (this.fake) {
      this.launchersDir = join(this.scratch, 'launchers');
      this.scenario = materializeScenario(this.scenarioSource(), this.launchersDir, this.knobs);
    }
    this.clockOffset = Date.parse(ORACLE_CLOCK) - Date.now();
    this.env = {
      ...this.env,
      NODE_OPTIONS: `--require "${PRELOAD.replace(/\\/g, '/')}"`,
      [OFFSET_ENV]: String(this.clockOffset),
      [CONTROL_ENV]: this.controlDir,
      TEMP: temp,
      TMP: temp,
      TZ: TIMEZONE,
    };
  }

  spawn() {
    rmSync(join(this.controlDir, HOOKED_MARKER), { force: true });
    super.spawn();
  }

  mark(kind, name, body) {
    writeFileSync(join(this.controlDir, markerName(kind, name)), body);
  }

  unmark(kind, name) {
    rmSync(join(this.controlDir, markerName(kind, name)), { force: true });
  }

  async connect(opts) {
    await super.connect(opts);
    const owner = await browserProcessId(this.port);
    if (owner !== this.child.pid) throw new Error(`port ${this.port} answers for another app (process ${owner}), not the one this capture started`);
    if (!existsSync(join(this.controlDir, HOOKED_MARKER))) throw new Error('the capture preload did not reach ipcMain, so nothing could be held');
    await this.send('Page.enable');
    await this.send('Emulation.setLocaleOverride', { locale: LOCALE });
    await this.send('Emulation.setTimezoneOverride', { timezoneId: TIMEZONE });
    await this.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await this.viewport(...DEFAULT_SIZE);
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SETUP.replace('__OFFSET__', String(this.clockOffset)) });
    await this.reload();
  }

  async reload({ bundle = true, readyText = this.readyText } = {}) {
    await this.send('Network.enable');
    await this.send('Network.setBlockedURLs', { urls: bundle ? [] : ['*/assets/index-*.js'] });
    await this.send('Page.reload');
    if (!bundle) {
      await this.waitFor(() => document.readyState === 'complete' && document.querySelector('#root > .boot') !== null, { timeoutMs: 20_000 });
      return;
    }
    const ready = `Boolean(window.oneLaunch && window.__oracleUi && document.readyState === 'complete' && document.body.innerText.includes(${JSON.stringify(readyText)}))`;
    const deadline = Date.now() + 20_000;
    while (!(await this.evaluate(ready).catch(() => false))) {
      if (Date.now() > deadline) throw new Error(`after the reload the page never showed ${JSON.stringify(readyText)}`);
      await sleep(100);
    }
    const drift = await this.evaluate(`Date.now() - ${Date.now() + this.clockOffset}`);
    if (Math.abs(drift) > 5_000) throw new Error(`the page is not on the oracle clock (off by ${drift} ms)`);
  }
}

export class Session {
  constructor({ area, spec, rows, out, slot }) {
    this.area = area;
    this.spec = spec;
    this.rows = rows;
    this.out = out;
    this.taken = [];
    this.d = new ShotDriver({
      name: `ui-${area}-${spec.name}`,
      slot,
      fake: spec.fake ?? 'all-four',
      knobs: spec.knobs ?? null,
      env: spec.env ?? {},
      args: spec.args ?? [],
      holds: spec.holds ?? [],
      readyText: spec.readyText ?? 'Library',
    });
    this.scanner = createUserPathScanner();
  }

  async start() {
    await this.d.lay();
    if (this.spec.prepare) await this.spec.prepare(this);
    this.d.spawn();
    await this.d.connect();
    this.size = DEFAULT_SIZE;
    await this.parkPointer();
    if (this.spec.settle !== false) await this.idle();
  }

  async stop() {
    const code = await this.d.close();
    if (code !== 0) throw new Error(`the app left with ${code}`);
  }

  async idle({ timeoutMs = 60_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { status } = await this.d.invoke('artwork:status');
      if (status.scanned && status.queued === 0 && status.running === 0) return;
      if (Date.now() > deadline) throw new Error('the startup scan and the artwork queue did not finish');
      await sleep(100);
    }
  }

  async restart(opts) {
    await this.d.restart(opts);
    this.size = DEFAULT_SIZE;
    await this.parkPointer();
    if (this.spec.settle !== false) await this.idle();
  }

  async resize(size) {
    if (this.size && this.size[0] === size[0] && this.size[1] === size[1]) return;
    await this.d.viewport(...size);
    this.size = size;
  }

  hold(name) {
    this.d.mark('hold', name, '');
  }

  release(name) {
    this.d.unmark('hold', name);
  }

  fail(channel, error) {
    this.d.mark('fail', channel, JSON.stringify(error));
  }

  mend(channel) {
    this.d.unmark('fail', channel);
  }

  freezeIntervals(on) {
    return this.d.evaluate(`window.__oracleUi.freezeIntervals = ${on ? 'true' : 'false'}`);
  }

  async rectOf(target, { nth = 0, timeoutMs = 5_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rect = await this.d.evaluate(`(${RECT_OF})(${JSON.stringify(target)}, ${nth})`);
      if (rect) return rect;
      if (Date.now() > deadline) throw new Error(`nothing on screen for ${JSON.stringify(target)}`);
      await sleep(100);
    }
  }

  async pointer(x, y) {
    await this.d.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    this.pointerParked = false;
  }

  async parkPointer() {
    await this.d.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });
    this.pointerParked = true;
  }

  async hover(target, opts) {
    const [x, y, w, h] = await this.rectOf(target, opts);
    await this.pointer(x + w / 2, y + h / 2);
  }

  async mouseClick(target, { button = 'left', ...opts } = {}) {
    const [x, y, w, h] = await this.rectOf(target, opts);
    const at = { x: x + w / 2, y: y + h / 2, button, clickCount: 1 };
    await this.pointer(at.x, at.y);
    await this.d.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, buttons: button === 'right' ? 2 : 1 });
    await this.d.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, buttons: 0 });
  }

  async wheel(x, y, deltaY) {
    await this.d.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY });
    this.pointerParked = false;
  }

  async settle({ timeoutMs = 15_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    let calm = 0;
    for (;;) {
      const now = await this.d.evaluate(SETTLE);
      calm = now.pending === 0 && now.finished === 0 && last !== null && last.marks === now.marks ? calm + 1 : 0;
      last = now;
      if (calm >= 2) return now;
      if (Date.now() > deadline) throw new Error(`the page did not settle: ${JSON.stringify(now)}`);
      await sleep(60);
    }
  }

  async shot(id, { volatile = [], aged = false, keepPointer = false } = {}) {
    const row = this.rows.find((r) => r.id === id);
    if (!row) throw new Error(`row ${id} is not in the checklist`);
    if (row.area !== this.area) throw new Error(`row ${id} belongs to ${row.area ?? 'the owner'}, not to ${this.area}`);
    if (this.pointerParked === false && !keepPointer) await this.parkPointer();
    const scratchRoot = new RegExp(
      scratchBase()
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\\\\/g, '[\\\\/]+'),
      'i',
    );
    for (const { size, suffix } of sizesOf(row)) {
      await this.resize(size);
      const stem = stemOf(row, suffix);
      let sidecar = null;
      let png = null;
      for (let attempt = 0; attempt < 4 && sidecar === null; attempt += 1) {
        const settled = await this.settle();
        const snapshot = await this.d.send('DOMSnapshot.captureSnapshot', SNAPSHOT_PARAMS);
        const ax = await this.d.send('Accessibility.getFullAXTree');
        const { data } = await this.d.send('Page.captureScreenshot', { format: 'png' });
        const after = await this.settle();
        if (after.marks !== settled.marks) continue;
        png = Buffer.from(data, 'base64');
        sidecar = buildSidecar({
          snapshot,
          ax,
          meta: { id, name: `${row.name}${suffix}`, viewport: size, locale: LOCALE, tz: TIMEZONE, clock: ORACLE_CLOCK, paused: settled.paused },
          volatile: [scratchRoot, ...volatile, ...(aged ? [AGED_PATTERN] : [])],
        });
      }
      if (sidecar === null) throw new Error(`row ${id} (${stem}): the page kept changing under the capture`);
      this.verify(stem, size, png, sidecar, aged);
      writeArtefact(this.out, `${SHOTS_DIR}/${stem}.png`, png);
      writeArtefact(this.out, `${SHOTS_DIR}/${stem}.layout.json`, sidecarText(sidecar));
      this.taken.push({ id, stem, size });
      console.log(`SHOT  ${stem}  ${size.join('x')}  ${sidecar.text.length} text runs, ${sidecar.elements.length} elements`);
    }
    await this.resize(DEFAULT_SIZE);
    if (!keepPointer) await this.parkPointer();
  }

  verify(stem, size, png, sidecar, aged) {
    const [width, height] = pngSize(png);
    if (width !== size[0] || height !== size[1]) throw new Error(`${stem}: the PNG is ${width}x${height}, not ${size.join('x')}`);
    const stats = pngStats(png);
    if (stats.colours < 4) throw new Error(`${stem}: a blank shot (${stats.colours} colours)`);
    if (sidecar.text.length === 0 && sidecar.elements.length === 0) throw new Error(`${stem}: an empty sidecar`);
    const errors = validateSidecar(JSON.parse(JSON.stringify(sidecar)));
    if (errors.length > 0) throw new Error(`${stem}: the sidecar does not fit its schema: ${errors.slice(0, 3).map(formatError).join('; ')}`);
    for (const value of sidecarStrings(sidecar)) {
      const hits = this.scanner.scanText(value);
      if (hits.length > 0) throw new Error(`${stem}: text in the shot holds a user path (${hits[0].kind} ${hits[0].masked})`);
    }
    if (!aged) {
      const old = sidecar.text.find((run) => AGED_PATTERN.test(run.t));
      if (old) throw new Error(`${stem}: "${old.t}" will read differently on the next capture; take the shot within a minute of the event, or pass aged`);
    }
  }

  async end({ failed }) {
    const d = this.d;
    if (d.child && d.exitCode === null) {
      if (failed && d.ws) await d.shot('at-failure').catch(() => undefined);
      await Promise.race([d.close(), sleep(25_000)]);
      if (d.exitCode === null) await d.killHard();
    }
    d.ws?.close();
    d.ws = null;
    if (failed) {
      console.log(`Scratch kept for a look: ${d.scratch}`);
      return;
    }
    await removeFolder(d.scratch).catch((err) => console.log(String(err.message)));
  }
}

export async function runSession({ area, spec, rows, out, slot }) {
  const s = new Session({ area, spec, rows, out, slot });
  let error = null;
  try {
    if (spec.before) await spec.before(s);
    await s.start();
    await spec.run(s);
  } catch (err) {
    error = err instanceof Error ? err : new Error(String(err));
    console.log(`FAIL  ${area}/${spec.name}: ${error.stack ?? error.message}`);
    if (s.d.stderr.length > 0) console.log(s.d.stderr.slice(-5).join('\n'));
  } finally {
    if (spec.after) await Promise.resolve(spec.after(s)).catch((err) => console.log(`after() failed: ${err.message}`));
    await s.end({ failed: error !== null });
  }
  return { name: spec.name, taken: s.taken, error };
}
