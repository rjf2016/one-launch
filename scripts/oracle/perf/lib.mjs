import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { cpus, release, totalmem } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Driver, repoRoot, sleep } from '../../app-driver.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export { repoRoot, sleep };
export const SCRATCH = resolve(process.env.T10_SCRATCH ?? join(repoRoot, '..', 'oracle-scratch', 't10'));
export const PACKAGED_DIR = join(repoRoot, 'dist', 'win-unpacked');

const isInside = (parent, child) => {
  const back = relative(resolve(parent).toLowerCase(), resolve(child).toLowerCase());
  return back !== '' && !back.startsWith('..') && !isAbsolute(back);
};

export function checkScratch() {
  if (/[\\/]Users[\\/]/i.test(`${SCRATCH}\\`) || isInside(repoRoot, SCRATCH) || isInside(join(repoRoot, '..', 'one-launch-rs'), SCRATCH))
    throw new Error(`the scratch folder must be outside both repos and any user profile: ${SCRATCH}`);
  mkdirSync(SCRATCH, { recursive: true });
  return SCRATCH;
}

export async function removeUnderScratch(folder) {
  if (!isInside(SCRATCH, folder)) throw new Error(`refusing to remove ${folder}: not under ${SCRATCH}`);
  for (let i = 0; i < 20 && existsSync(folder); i += 1) {
    try {
      rmSync(folder, { recursive: true, force: true });
    } catch {
      await sleep(500);
    }
  }
  if (existsSync(folder)) throw new Error(`could not empty ${folder}`);
}

export function freePort() {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
}

export class BrowserTarget {
  static async open(port) {
    const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const ws = new WebSocket(webSocketDebuggerUrl);
    await new Promise((done, fail) => {
      ws.onopen = done;
      ws.onerror = () => fail(new Error('could not open the browser target'));
    });
    return new BrowserTarget(ws);
  }

  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.waiting = new Map();
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      const entry = this.waiting.get(msg.id);
      if (!entry) return;
      this.waiting.delete(msg.id);
      if (msg.error) entry.fail(new Error(msg.error.message));
      else entry.done(msg.result);
    };
    ws.onclose = () => {
      for (const entry of this.waiting.values()) entry.fail(new Error('the browser target closed'));
      this.waiting.clear();
    };
  }

  send(method, params = {}) {
    return new Promise((done, fail) => {
      const id = ++this.seq;
      this.waiting.set(id, { done, fail });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async processes() {
    const at = Date.now();
    const { processInfo } = await this.send('SystemInfo.getProcessInfo');
    return { at, list: processInfo.map((p) => ({ type: p.type, pid: p.id, cpuTime: p.cpuTime })) };
  }

  close() {
    this.ws.close();
  }
}

/**
 * The packaged exe on a data folder this tooling lays itself (under the scratch folder, optionally seeded with a
 * database), a debug port from a free-port probe, and a check after every connect that the browser process behind
 * that port is the child this driver spawned.
 */
export class PerfDriver extends Driver {
  constructor({ folder, seedDb = null, ...opts }) {
    super({ ...opts, packaged: true, keep: true });
    this.folder = folder;
    this.seedDb = seedDb;
    this.browser = null;
  }

  async start() {
    const asar = join(PACKAGED_DIR, 'resources', 'app.asar');
    if (!existsSync(this.exe)) throw new Error(`Not found: ${this.exe}; run npm run build`);
    if (!existsSync(asar) || !readFileSync(asar).includes('--data-dir=')) throw new Error(`${this.exe} does not know --data-dir=; rebuild it`);
    await removeUnderScratch(this.folder);
    this.scratch = this.folder;
    this.dataDir = join(this.folder, 'data');
    mkdirSync(this.dataDir, { recursive: true });
    this.shotsDir = join(this.folder, 'failures');
    if (this.seedDb) copyFileSync(this.seedDb, join(this.dataDir, 'onelaunch.db'));
    this.port = await freePort();
    this.spawn();
    await this.connect();
  }

  async connect(opts) {
    await super.connect(opts);
    this.browser?.close();
    this.browser = await BrowserTarget.open(this.port);
    const { list } = await this.browser.processes();
    const owners = list.filter((p) => p.type === 'browser');
    if (owners.length !== 1 || owners[0].pid !== this.child.pid)
      throw new Error(
        `port ${this.port} answers for another process (${owners.map((p) => p.pid).join(', ')}), not the one this run spawned (${this.child.pid})`,
      );
  }

  async close(opts) {
    this.browser?.close();
    this.browser = null;
    return super.close(opts);
  }

  async cleanup() {
    this.browser?.close();
    this.browser = null;
    if (this.exitCode === null) {
      this.child.kill();
      await Promise.race([this.exited, sleep(5_000)]);
    }
    this.ws?.close();
    this.ws = null;
  }
}

/** One long-lived PowerShell that opens a process by id (query-limited access) for its counters, or posts WM_CLOSE to a process's own top-level windows. */
export class Counters {
  static async start() {
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'proc-counters.ps1')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const c = new Counters(child);
    const first = await c.next();
    if (!first.ready) throw new Error('the counter helper did not start');
    return c;
  }

  constructor(child) {
    this.child = child;
    this.buffer = '';
    this.lines = [];
    this.waiters = [];
    this.stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      let i;
      while ((i = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, i).trim();
        this.buffer = this.buffer.slice(i + 1);
        if (!line) continue;
        const waiter = this.waiters.shift();
        if (waiter) waiter(line);
        else this.lines.push(line);
      }
    });
    child.stderr.on('data', (chunk) => (this.stderr += chunk));
  }

  next(timeoutMs = 60_000) {
    const line = this.lines.shift();
    if (line !== undefined) return Promise.resolve(JSON.parse(line));
    return new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`the counter helper did not answer${this.stderr ? `: ${this.stderr.slice(0, 300)}` : ''}`)), timeoutMs);
      this.waiters.push((l) => {
        clearTimeout(timer);
        done(JSON.parse(l));
      });
    });
  }

  async ask(command) {
    this.child.stdin.write(`${command}\n`);
    const reply = await this.next();
    if (!reply.ok) throw new Error(`counter helper: ${reply.error}`);
    return reply;
  }

  async of(pids) {
    const at = Date.now();
    const { processes } = await this.ask(`counters ${pids.map((p) => Number(p)).join(' ')}`);
    return { at, processes };
  }

  async closeWindows(pid) {
    return (await this.ask(`close ${Number(pid)}`)).posted;
  }

  stop() {
    this.child.stdin.end();
  }
}

export function median(values) {
  const v = values.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** Nearest-rank percentile: the smallest sample with at least p percent of the samples at or below it. */
export function percentile(values, p) {
  const v = values.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  if (v.length === 0) return null;
  return v[Math.max(0, Math.ceil((p / 100) * v.length) - 1)];
}

export function stats(values) {
  const v = values.filter((x) => typeof x === 'number');
  if (v.length === 0) return { n: 0, min: null, median: null, p95: null, max: null };
  return { n: v.length, min: Math.min(...v), median: median(v), p95: percentile(v, 95), max: Math.max(...v) };
}

export function folderSize(dir) {
  let bytes = 0;
  let files = 0;
  let folders = 0;
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) {
        folders += 1;
        walk(p);
      } else if (entry.isFile()) {
        files += 1;
        bytes += statSync(p).size;
      }
    }
  };
  walk(dir);
  return { bytes, files, folders };
}

export function machineFacts() {
  const list = cpus();
  return {
    cpuModel: list[0]?.model.trim() ?? null,
    logicalCores: list.length,
    memoryBytes: totalmem(),
    windows: release(),
  };
}
