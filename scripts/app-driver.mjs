// Drives the built app over the Chrome DevTools Protocol with nothing but Node: starts it on a fresh
// scratch data folder (and, with `fake`, against fake launchers), evaluates in the page, clicks, types,
// takes screenshots, reads the log, restarts or kills it, and reports PASS/FAIL lines.
// Used by scripts/drive.mjs, scripts/smoke-packaged.mjs, and every file in scripts/scenarios/.
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ELECTRON_EXE = join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
const PACKAGED_EXE = join(repoRoot, 'dist', 'win-unpacked', 'One Launch.exe');
const UNPACKAGED_MAIN = join(repoRoot, 'out', 'main', 'index.js');
const FAKE_LAUNCHERS_DIR = join(repoRoot, 'test', 'fake-launchers');
const FIXTURES_DIR = join(repoRoot, 'test', 'fixtures');
const DEFAULT_FAKE = 'all-four';

const VIRTUAL_KEYS = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Shift: 16,
  Control: 17,
  Alt: 18,
  Escape: 27,
  Space: 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
};
for (let i = 1; i <= 12; i++) VIRTUAL_KEYS[`F${i}`] = 111 + i;

const stamp = () => new Date().toISOString().slice(11, 19).replace(/:/g, '');
const slug = (s) =>
  s
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase() || 'shot';
const describe = (cond) => (typeof cond === 'string' ? JSON.stringify(cond) : cond.toString().replace(/\s+/g, ' ').slice(0, 120));
const literal = (v) => (v === undefined ? 'undefined' : JSON.stringify(v));

/** `--name=value` becomes flags.name = 'value', `--name` becomes flags.name = true, the rest is positional. */
export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (const a of argv) {
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq === -1) flags[a.slice(2)] = true;
    else flags[a.slice(2, eq)] = a.slice(eq + 1);
  }
  return { positional, flags };
}

/**
 * Splits one `--args` value into Chromium switches the way a shell would: whitespace separates, a "…" or '…' span keeps
 * its spaces and loses its quotes (a path with spaces: --trace-startup-file="C:\trace files\startup.json"). No escapes,
 * so a Windows path reads as typed. An unclosed quote throws.
 */
export function splitSwitches(text) {
  const out = [];
  let current = null;
  let quote = null;
  for (const ch of text) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current ??= '';
    } else if (/\s/.test(ch)) {
      if (current !== null) out.push(current);
      current = null;
    } else {
      current = (current ?? '') + ch;
    }
  }
  if (quote !== null) throw new Error(`--args has an unclosed ${quote} quote: ${text}`);
  if (current !== null) out.push(current);
  return out;
}

/**
 * Copies a committed scenario (test/fake-launchers/<name>, or an absolute folder) into `launchersDir`:
 * scenario.json as is, every entry of its `files` map materialized, and `knobs.json` when knobs are given.
 * The app only ever sees the copy, so a run can never modify the committed fixtures.
 */
export function materializeScenario(source, launchersDir, knobs = null) {
  const dir = isAbsolute(source) ? source : join(FAKE_LAUNCHERS_DIR, source);
  const file = join(dir, 'scenario.json');
  if (!existsSync(file)) throw new Error(`No scenario.json in ${dir}`);
  const scenario = JSON.parse(readFileSync(file, 'utf8'));
  mkdirSync(launchersDir, { recursive: true });
  const rootVdf = launchersDir.replace(/\\/g, '\\\\');
  for (const [rel, spec] of Object.entries(scenario.files ?? {})) {
    const target = resolve(launchersDir, rel);
    if (!target.toLowerCase().startsWith(launchersDir.toLowerCase())) throw new Error(`scenario file escapes the folder: ${rel}`);
    mkdirSync(dirname(target), { recursive: true });
    if (typeof spec === 'string' && spec.startsWith('@fixtures/')) {
      const fixture = join(FIXTURES_DIR, spec.slice('@fixtures/'.length));
      if (!existsSync(fixture)) throw new Error(`fixture missing for ${rel}: ${fixture}`);
      copyFileSync(fixture, target);
    } else if (typeof spec === 'string') {
      writeFileSync(target, spec);
    } else if (spec && typeof spec.inline === 'string') {
      writeFileSync(target, spec.inline.replaceAll('{root:vdf}', rootVdf).replaceAll('{root}', launchersDir));
    } else {
      throw new Error(`unknown file spec for ${rel}`);
    }
  }
  copyFileSync(file, join(launchersDir, 'scenario.json'));
  if (knobs) writeFileSync(join(launchersDir, 'knobs.json'), JSON.stringify(knobs, null, 2));
  return scenario;
}

// Evaluated inside the page: the nth element whose accessible name (aria-label, else its text) is exactly `target`, contains `target.contains`, or matches `target.selector`.
const FIND_SRC = `(target, nth) => {
  const roles = 'button, [role="button"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], [role="tab"], [role="switch"], [role="checkbox"], [role="radio"], summary, a[href], label';
  const name = (el) => (el.getAttribute('aria-label') ?? el.textContent ?? '').replace(/\\s+/g, ' ').trim();
  const named = (test) => [...document.querySelectorAll(roles)].filter((el) => test(name(el)));
  const els = typeof target === 'string' ? named((n) => n === target) : target.contains ? named((n) => n.includes(target.contains)) : [...document.querySelectorAll(target.selector)];
  return els[nth] ?? null;
}`;

export class Driver {
  constructor(opts = {}) {
    this.name = opts.name ?? 'scenario';
    this.packaged = Boolean(opts.packaged);
    this.exe = this.packaged ? PACKAGED_EXE : ELECTRON_EXE;
    this.fake = opts.fake === true ? DEFAULT_FAKE : (opts.fake ?? null);
    this.knobs = opts.knobs ?? null;
    this.env = opts.env ?? {};
    this.keep = Boolean(opts.keep);
    this.port = opts.port ?? 9400 + Math.floor(Math.random() * 400);
    this.readyText = opts.readyText ?? 'Library';
    // Extra Chromium switches for one-off measurements (--trace-startup and friends); never the data folder, which this driver owns.
    this.extraArgs = Array.isArray(opts.args) ? opts.args.filter((a) => typeof a === 'string' && a.length > 0) : [];
    if (this.extraArgs.some((a) => a.startsWith('--data-dir')))
      throw new Error('--args must not set --data-dir; the driver always starts the app on its own scratch folder');
    this.shotsDir = resolve(opts.shots ?? join(tmpdir(), 'onelaunch-shots', `${slug(this.name)}-${stamp()}`));
    this.scratch = null;
    this.dataDir = null;
    this.launchersDir = null;
    this.scenario = null;
    this.child = null;
    this.spawnedAt = null;
    this.readyAt = null;
    this.exitCode = null;
    this.exited = null;
    this.stderr = [];
    this.ws = null;
    this.failures = 0;
    this.checks = [];
    this.shots = [];
    this.shotSeq = 0;
    this.errorLinesChecked = false;
  }

  check(name, ok, detail = '') {
    if (!ok) this.failures++;
    this.checks.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
    return ok;
  }

  async start() {
    if (this.fake && this.packaged) throw new Error('the packaged exe never enters fake mode; drop --packaged or --fake');
    if (this.packaged) {
      if (!existsSync(this.exe)) throw new Error(`Not found: ${this.exe}\nBuild it first: npm run build`);
      // A build from before the flag existed would ignore it and open the real data folder. Main is bundled unminified, so the flag's name is in the archive as plain text.
      const asar = join(dirname(this.exe), 'resources', 'app.asar');
      if (!existsSync(asar) || !readFileSync(asar).includes('--data-dir=')) {
        throw new Error(`${this.exe} does not know --data-dir=, so it would use the real data folder. Rebuild it.`);
      }
    } else {
      if (!existsSync(this.exe)) throw new Error(`Not found: ${this.exe}\nInstall dependencies first: npm ci`);
      if (!existsSync(UNPACKAGED_MAIN)) throw new Error(`Not found: ${UNPACKAGED_MAIN}\nBuild it first: npx electron-vite build`);
    }
    this.scratch = mkdtempSync(join(tmpdir(), 'onelaunch-drive-'));
    this.dataDir = join(this.scratch, 'data');
    mkdirSync(this.dataDir);
    if (this.fake) {
      this.launchersDir = join(this.scratch, 'launchers');
      this.scenario = materializeScenario(this.fake, this.launchersDir, this.knobs);
    }
    this.spawn();
    await this.connect();
  }

  /** The child's environment: the caller's, minus anything that would redirect the run, plus the fake launchers when the run has them and what the scenario put in `d.env`. */
  childEnv() {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ONELAUNCH_DATA_DIR;
    for (const key of Object.keys(env)) if (key.startsWith('ONELAUNCH_UPDATE_')) delete env[key];
    if (this.launchersDir) env.ONELAUNCH_FAKE_LAUNCHERS = this.launchersDir;
    else delete env.ONELAUNCH_FAKE_LAUNCHERS;
    return { ...env, ...this.env };
  }

  spawn() {
    const args = this.packaged ? [] : [repoRoot];
    args.push(`--remote-debugging-port=${this.port}`, `--data-dir=${this.dataDir}`, ...this.extraArgs);
    const env = this.childEnv();
    this.exitCode = null;
    this.stderr = [];
    this.spawnedAt = Date.now();
    this.child = spawn(this.exe, args, { env, cwd: repoRoot, stdio: ['ignore', 'ignore', 'pipe'] });
    this.child.stderr.on('data', (chunk) => {
      this.stderr.push(...String(chunk).split(/\r?\n/).filter(Boolean));
      if (this.stderr.length > 40) this.stderr.splice(0, this.stderr.length - 40);
    });
    this.exited = new Promise((res) =>
      this.child.on('exit', (code) => {
        this.exitCode = code ?? -1;
        res(this.exitCode);
      }),
    );
  }

  async connect({ timeoutMs = 30_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (this.exitCode === null && Date.now() < deadline) {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${this.port}/json`)).json();
        const page = targets.find((t) => t.type === 'page');
        if (page) {
          await this.open(page.webSocketDebuggerUrl);
          break;
        }
      } catch {
        // not listening yet
      }
      await sleep(250);
    }
    if (this.exitCode !== null) {
      const tail = this.stderr.slice(-5).join('\n');
      throw new Error(`the app exited early with code ${this.exitCode}${tail ? `\n${tail}` : ''}`);
    }
    if (!this.ws) throw new Error('the app never offered a page to debug');
    // The preload runs at document start, so window.oneLaunch exists before the parser has made a <body>; an evaluate can also land while the page is navigating.
    const ready = `Boolean(window.oneLaunch && document.body && document.body.innerText.includes(${JSON.stringify(this.readyText)}))`;
    const readyBy = Date.now() + 20_000;
    let lastError = null;
    for (;;) {
      try {
        if (await this.evaluate(ready)) break;
        lastError = null;
      } catch (err) {
        lastError = err;
      }
      if (Date.now() > readyBy) {
        throw new Error(`the page never showed ${JSON.stringify(this.readyText)}${lastError ? `; last evaluate failed: ${lastError.message}` : ''}`);
      }
      await sleep(250);
    }
    this.readyAt = Date.now();
  }

  async open(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error('could not open the DevTools socket'));
    });
    this.seq = 0;
    this.waiting = new Map();
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      const entry = this.waiting.get(msg.id);
      if (!entry) return;
      this.waiting.delete(msg.id);
      if (msg.error) entry.rej(new Error(msg.error.message));
      else entry.res(msg.result);
    };
    ws.onclose = () => {
      for (const entry of this.waiting.values()) entry.rej(new Error('the DevTools socket closed'));
      this.waiting.clear();
      if (this.ws === ws) this.ws = null;
    };
    this.ws = ws;
  }

  send(method, params = {}) {
    if (!this.ws) return Promise.reject(new Error('not connected to the app'));
    return new Promise((res, rej) => {
      const id = ++this.seq;
      this.waiting.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Runs an expression, or a function applied to JSON-serialisable arguments, in the page and returns its (awaited) value. */
  async evaluate(fnOrExpr, ...args) {
    const expression = typeof fnOrExpr === 'function' ? `(${fnOrExpr.toString()})(${args.map(literal).join(', ')})` : fnOrExpr;
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }

  /** The IPC envelope as the preload returns it: { ok, data } or { ok: false, error }. */
  invokeRaw(channel, req) {
    return this.evaluate(`window.oneLaunch.invoke(${JSON.stringify(channel)}${req === undefined ? '' : `, ${JSON.stringify(req)}`})`);
  }

  /** The IPC answer's data; an error envelope throws an Error carrying `.code`. */
  async invoke(channel, req) {
    const r = await this.invokeRaw(channel, req);
    if (r?.ok) return r.data;
    const err = new Error(`${channel}: ${r?.error?.code ?? 'no envelope'} ${r?.error?.message ?? ''}`.trim());
    err.code = r?.error?.code ?? null;
    throw err;
  }

  text() {
    return this.evaluate('document.body.innerText');
  }

  async has(text) {
    return this.evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`);
  }

  /** Polls until `cond` (page text, or a function evaluated in the page) is truthy, or falsy with `absent`. Returns the value. */
  async waitFor(cond, { timeoutMs = 10_000, everyMs = 200, absent = false } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = typeof cond === 'string' ? await this.has(cond) : await this.evaluate(cond);
      if (absent ? !value : value) return value;
      if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${absent ? 'the absence of ' : ''}${describe(cond)}`);
      await sleep(everyMs);
    }
  }

  /** Polls launch:status until the job reaches `until` (a state, or a predicate on the job). A job that ends in another state throws. */
  async waitForJob(jobId, until, { timeoutMs = 60_000, everyMs = 150 } = {}) {
    const deadline = Date.now() + timeoutMs;
    const done = typeof until === 'function' ? until : (job) => job.state === until;
    for (;;) {
      const { job } = await this.invoke('launch:status', { jobId });
      if (done(job)) return job;
      if (typeof until === 'string' && job.state !== 'running') throw new Error(`job ${jobId} ended ${job.state}, expected ${until}`);
      if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for job ${jobId} to be ${describe(until)}; state ${job.state}`);
      await sleep(everyMs);
    }
  }

  async find(target, nth) {
    return this.evaluate(
      `((find) => { const el = find(${literal(target)}, ${nth}); if (!el) return false; el.scrollIntoView({ block: 'nearest' }); return true; })(${FIND_SRC})`,
    );
  }

  /** Clicks the nth element named `target` (exact accessible name) or matching `{ selector }`. Scrolls it into view first, in its own evaluate, because menus close on scroll. */
  async click(target, { nth = 0, timeoutMs = 5_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (!(await this.find(target, nth))) {
      if (Date.now() > deadline) throw new Error(`nothing to click for ${describe(target)}${nth ? ` [${nth}]` : ''}`);
      await sleep(100);
    }
    await sleep(60);
    const clicked = await this.evaluate(
      `((find) => { const el = find(${literal(target)}, ${nth}); if (!el) return false; el.click(); return true; })(${FIND_SRC})`,
    );
    if (!clicked) throw new Error(`${describe(target)} disappeared before the click`);
  }

  async focus(target, { nth = 0 } = {}) {
    const ok = await this.evaluate(`((find) => { const el = find(${literal(target)}, ${nth}); if (!el) return false; el.focus(); return true; })(${FIND_SRC})`);
    if (!ok) throw new Error(`nothing to focus for ${describe(target)}`);
  }

  /** Types into the focused element the way an IME commit does; React sees an input event. */
  type(text) {
    return this.send('Input.insertText', { text });
  }

  /** A real key press: keyDown and keyUp with the Windows virtual key code. `name` is a key name ("Enter", "ArrowDown", "F2") or one character. */
  async key(name, { ctrl = false, shift = false, alt = false } = {}) {
    const printable = name.length === 1;
    const key = name === 'Space' ? ' ' : name;
    const vk = VIRTUAL_KEYS[name] ?? (printable ? name.toUpperCase().charCodeAt(0) : undefined);
    if (vk === undefined) throw new Error(`unknown key ${name}`);
    const code = printable ? (/[a-z]/i.test(name) ? `Key${name.toUpperCase()}` : /[0-9]/.test(name) ? `Digit${name}` : undefined) : name;
    const modifiers = (alt ? 1 : 0) | (ctrl ? 2 : 0) | (shift ? 8 : 0);
    const text = name === 'Enter' ? '\r' : printable && !ctrl && !alt ? key : undefined;
    const base = { key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers, ...(code ? { code } : {}) };
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(text ? { text, unmodifiedText: text } : {}) });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  /** Renders the page at another size (the window itself stays); `viewport(null)` goes back to the window's size. */
  viewport(width, height) {
    if (width === null) return this.send('Emulation.clearDeviceMetricsOverride');
    return this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  }

  /** Saves a PNG of the page as <shots>/<nn>-<name>.png and returns its path. */
  async shot(name) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    mkdirSync(this.shotsDir, { recursive: true });
    const file = join(this.shotsDir, `${String(++this.shotSeq).padStart(2, '0')}-${slug(name)}.png`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    this.shots.push(file);
    return file;
  }

  /** Samples `sampler` (a function evaluated in the page) every `everyMs` for `forMs`; the way to see an animation or a startup sequence. */
  async timeline(sampler, everyMs, forMs) {
    const t0 = Date.now();
    const samples = [];
    while (Date.now() - t0 <= forMs) {
      samples.push({ t: Date.now() - t0, value: await this.evaluate(sampler) });
      await sleep(everyMs);
    }
    return samples;
  }

  logPath() {
    return join(this.dataDir, 'logs', 'onelaunch.log');
  }

  readLog() {
    const file = this.logPath();
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
  }

  /** ERROR lines in the log, minus those matching one of `allow` (regular expressions). */
  errorLines(allow = []) {
    return this.readLog()
      .split(/\r?\n/)
      .filter((l) => / ERROR /.test(l) && !allow.some((re) => re.test(l)));
  }

  assertNoErrorLines(allow = []) {
    this.errorLinesChecked = true;
    const errors = this.errorLines(allow);
    return this.check('the log has no ERROR line', errors.length === 0, errors.slice(0, 3).join(' | '));
  }

  /** What the fake platform recorded (registry writes, process events, opened URLs, fetches, clipboard writes); null outside fake mode. */
  fakeReport() {
    const file = join(this.dataDir, 'fake-platform.json');
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  }

  launcherPath(rel) {
    if (!this.launchersDir) throw new Error('not a fake-launcher run');
    return join(this.launchersDir, rel);
  }

  launcherFile(rel) {
    return readFileSync(this.launcherPath(rel), 'utf8');
  }

  /**
   * Asks Windows to close the main window (WM_CLOSE, what the caption button sends), so main's close handlers
   * run: with "Minimize One Launch to System Tray" on (the default) the window hides and the app stays up; with it
   * off, during a switch that is the quit prompt. Returns at once; follow with waitForExit(). A renderer-side
   * window.close() or CDP Page.close skips those handlers, which is why close() cannot be used for this.
   */
  closeWindow() {
    if (this.exitCode !== null) return;
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${this.child.pid}).CloseMainWindow() | Out-Null`], {
      stdio: 'ignore',
      windowsHide: true,
    });
  }

  /**
   * Leaves the app up for an interactive look over CDP (`agent-browser connect <port>`) until the stop file appears in
   * the scratch folder, the app exits (quit it from the page), or `minutes` pass. Returns 'stopped', 'exited' or 'timeout'.
   */
  async hold({ minutes = 30 } = {}) {
    const stop = join(this.scratch, 'stop');
    console.log(
      `HOLD  port ${this.port} (agent-browser connect ${this.port}); data ${this.dataDir}${this.launchersDir ? `; fake launchers ${this.launchersDir}` : ''}`,
    );
    console.log(`HOLD  ends when ${stop} exists, when the app quits, or after ${minutes} min`);
    const deadline = Date.now() + minutes * 60_000;
    while (this.exitCode === null && !existsSync(stop) && Date.now() < deadline) await sleep(500);
    return this.exitCode !== null ? 'exited' : existsSync(stop) ? 'stopped' : 'timeout';
  }

  /**
   * Starts a second copy of the app on the same data folder, as a second click on the shortcut would, and returns its
   * exit code (0: it handed over to the running app, which shows its window, and left) or 'timeout'.
   */
  async secondInstance({ timeoutMs = 15_000 } = {}) {
    const args = this.packaged ? [] : [repoRoot];
    args.push(`--data-dir=${this.dataDir}`);
    const child = spawn(this.exe, args, { env: this.childEnv(), cwd: repoRoot, stdio: 'ignore' });
    const exited = new Promise((res) => child.on('exit', (code) => res(code ?? -1)));
    const code = await Promise.race([exited, sleep(timeoutMs).then(() => 'timeout')]);
    if (code === 'timeout') child.kill();
    return code;
  }

  /** The exit code once the app has ended, or 'timeout'. */
  async waitForExit({ timeoutMs = 20_000 } = {}) {
    const code = await Promise.race([this.exited, sleep(timeoutMs).then(() => 'timeout')]);
    if (code !== 'timeout') {
      this.ws?.close();
      this.ws = null;
    }
    return code;
  }

  /** Ends the app through the renderer's window.close() (no quit prompt: a running switch is stopped as "Quit anyway" would) and returns the exit code, or 'timeout' after killing a hung app. */
  async close({ timeoutMs = 20_000 } = {}) {
    if (this.exitCode !== null) return this.exitCode;
    if (this.ws) void this.evaluate('window.close()').catch(() => undefined);
    let code = await Promise.race([this.exited, sleep(timeoutMs).then(() => 'timeout')]);
    if (code === 'timeout') {
      this.child.kill();
      await Promise.race([this.exited, sleep(5_000)]);
    }
    this.ws?.close();
    this.ws = null;
    return code;
  }

  /** Ends the app without any of its quit handlers, as a crash or a power cut would. */
  async killHard() {
    if (this.exitCode !== null) return;
    this.ws?.close();
    this.ws = null;
    this.child.kill();
    const code = await Promise.race([this.exited, sleep(3_000).then(() => 'timeout')]);
    if (code === 'timeout') {
      try {
        execFileSync('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        // already gone
      }
      await Promise.race([this.exited, sleep(5_000)]);
    }
  }

  /** Starts the app again on the same data folder (and the same fake launchers), as a second start would. `knobs` replaces the run's knobs.json first. */
  async restart({ knobs } = {}) {
    if (this.exitCode === null) await this.close();
    if (knobs !== undefined) {
      if (!this.launchersDir) throw new Error('knobs need a fake-launcher run');
      this.knobs = knobs;
      writeFileSync(join(this.launchersDir, 'knobs.json'), JSON.stringify(knobs, null, 2));
    }
    this.spawn();
    await this.connect();
  }

  async cleanup() {
    if (this.exitCode === null) {
      this.child.kill();
      await Promise.race([this.exited, sleep(5_000)]);
    }
    this.ws?.close();
    this.ws = null;
    if (this.failures > 0) {
      mkdirSync(this.shotsDir, { recursive: true });
      for (const [from, to] of [
        [this.logPath(), 'onelaunch.log'],
        [join(this.dataDir, 'fake-platform.json'), 'fake-platform.json'],
      ]) {
        if (existsSync(from)) copyFileSync(from, join(this.shotsDir, to));
      }
    }
    if (this.keep || this.failures > 0) return;
    // Chromium can hold its profile for a moment after the exit.
    for (let i = 0; i < 10; i++) {
      try {
        rmSync(this.scratch, { recursive: true, force: true });
        break;
      } catch {
        await sleep(500);
      }
    }
    if (existsSync(this.scratch)) console.log(`Could not delete ${this.scratch}`);
  }

  summary(label) {
    if (this.shots.length) console.log(`Screenshots:\n${this.shots.map((s) => `  ${s}`).join('\n')}`);
    if (this.scratch && existsSync(this.scratch)) console.log(`Scratch kept: ${this.scratch}`);
    console.log(this.failures === 0 ? `\n${label} passed.` : `\n${label} FAILED (${this.failures}).`);
  }
}

/**
 * Runs a scenario module (`export default async (d) => {...}`, optional `name`, `label`, `options`, and `before(d)` /
 * `after(d)` hooks around the whole run, e.g. for a local server the app must know about at spawn) with the driver:
 * start, the scenario, with `hold` (true or minutes) a wait for an interactive look, then a clean close and the
 * no-ERROR-line check unless the scenario did those itself.
 */
export async function runScenario(mod, opts = {}) {
  const given = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined));
  const options = { ...(mod.options ?? {}), ...given };
  const name = options.name ?? mod.name ?? 'scenario';
  const label = mod.label ?? `Scenario ${name}`;
  const d = new Driver({ ...options, name });
  console.log(`${label}${options.packaged ? ' (packaged)' : ' (unpackaged)'}${d.fake ? `, fake launchers: ${d.fake}` : ''}`);
  try {
    if (mod.before) await mod.before(d);
    await d.start();
    await mod.default(d);
    if (options.hold && d.exitCode === null) {
      const how = await d.hold({ minutes: options.hold === true ? 30 : options.hold });
      if (how === 'exited') d.check('the app quit during the hold with exit code 0', d.exitCode === 0, `code=${d.exitCode}`);
    }
    if (d.exitCode === null) {
      const code = await d.close();
      d.check('closing the window ends the app with exit code 0', code === 0, `code=${code}`);
    }
    if (!d.errorLinesChecked) d.assertNoErrorLines();
  } catch (err) {
    d.failures++;
    console.log(`FAIL  ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    if (d.ws) await d.shot('at-failure').catch(() => undefined);
  } finally {
    if (mod.after) await Promise.resolve(mod.after(d)).catch((err) => console.log(`after() failed: ${err instanceof Error ? err.message : String(err)}`));
    await d.cleanup();
  }
  d.summary(label);
  return { failures: d.failures, shots: d.shots, scratch: d.scratch };
}
