import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { Driver, repoRoot, sleep } from '../../../app-driver.mjs';
import { resolveOut, writeArtefact } from '../../lib/out.mjs';
import { finishDialog, skipSetup, startPlay, watchDialog } from '../../../scenarios/lib.mjs';
import { pngSize, pngStats } from '../png.mjs';
import {
  APP_WINDOW,
  IDCANCEL,
  MESSAGE_BOX,
  addressOf,
  capture,
  controlsOf,
  gone,
  navigate,
  postClose,
  postCommand,
  pruneNavigation,
  readWindow,
  waitForWindow,
  windowsOf,
} from './native.mjs';
import { pixelDiff } from './pixels.mjs';
import { NOT_PRODUCED, WAIVED } from './waived.mjs';

process.env.ORACLE_SCRATCH ??= join(repoRoot, '..', 'oracle-scratch', 'native');
const { ShotDriver, scratchBase, LOCALE, TIMEZONE } = await import('../kit.mjs');

export const OWNER_DIR = 'ui/owner';
export const INDEX = 'captures.json';
const PACKAGED_EXE = join(repoRoot, 'dist', 'win-unpacked', 'OneLaunch.exe');
const SIZE = [1280, 800];
const CRASH_MESSAGE = 'placeholder: an error thrown on purpose from a timer in the main process';
const FILE_TIME = new Date(2026, 0, 1, 12, 0, 0);
const HANG = { knobs: { epic: { reactMs: 600_000 } } };
const spawned = new Set();

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

function solidPng(width, height, [r, g, b]) {
  const chunk = (type, body) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
    return Buffer.concat([head, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function removeFolder(folder) {
  for (let i = 0; i < 20 && existsSync(folder); i += 1) {
    try {
      rmSync(folder, { recursive: true, force: true });
    } catch {
      await sleep(500);
    }
  }
  if (existsSync(folder)) throw new Error(`could not remove ${folder}`);
}

function placeholderText(text) {
  const root = scratchBase()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\\/g, '[\\\\/]+');
  return text.replace(new RegExp(root, 'gi'), '{scratch}');
}

function verifyPng(file) {
  const png = readFileSync(file);
  const [width, height] = pngSize(png);
  const stats = pngStats(png);
  if (stats.colours < 4 || stats.dominant > 0.995)
    throw new Error(`${file}: a blank image (${stats.colours} colours, ${Math.round(stats.dominant * 100)}% one colour)`);
  return { width, height, colours: stats.colours };
}

async function boxText(pid, hwnd) {
  const { title, elements } = await readWindow(pid, hwnd, ['Text']);
  const { controls } = await controlsOf(pid, hwnd);
  const buttons = controls.filter((c) => c.cls === 'Button').map((c) => c.text.replace(/&/g, ''));
  const message = elements.filter((e) => e.name.trim() !== '').map((e) => placeholderText(e.name));
  return { title, message, buttons };
}

async function dialogText(pid, hwnd) {
  const { title, controls } = await controlsOf(pid, hwnd);
  const label = (id) => controls.find((c) => c.id === id)?.text.replace(/&/g, '') ?? null;
  return { title, message: [], buttons: [label(1), label(2)], fileName: label(1090), fileTypes: [label(1089), label(1136)] };
}

async function mainWindow(pid) {
  const all = (await windowsOf(pid)).filter((w) => w.cls === APP_WINDOW && w.owner === 0 && w.title !== '');
  if (all.length !== 1) throw new Error(`expected one app window of process ${pid}, found ${all.length}`);
  return all[0];
}

async function idle(d, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { status } = await d.invoke('artwork:status');
    if (status.scanned && status.queued === 0 && status.running === 0) return;
    if (Date.now() > deadline) throw new Error('the startup scan and the artwork queue did not finish');
    await sleep(100);
  }
}

async function settle(d) {
  await d.evaluate(`(async () => {
    await document.fonts.ready;
    for (const a of document.getAnimations()) { try { a.finish(); } catch { a.pause(); } }
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  })()`);
  await d.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });
  await sleep(600);
}

async function unpackaged(slot, { knobs = null, args = [] } = {}) {
  const d = new ShotDriver({ name: `native-${slot}`, slot, fake: 'all-four', knobs, args, readyText: 'Library' });
  await d.lay();
  d.spawn();
  spawned.add(d.child.pid);
  await d.connect();
  await d.viewport(null);
  await idle(d);
  return d;
}

async function endDriver(d) {
  if (d.child && d.exitCode === null) {
    const code = await Promise.race([d.close(), sleep(25_000).then(() => 'timeout')]);
    if (code === 'timeout' || d.exitCode === null) await d.killHard();
  }
  d.ws?.close();
  d.ws = null;
  await removeFolder(d.scratch);
  return d.exitCode;
}

async function pickerFolder(d, kind) {
  const folder = join(d.scratch, 'Placeholder files');
  mkdirSync(folder, { recursive: true });
  if (kind === 'exe') for (const n of [1, 2]) writeFileSync(join(folder, `placeholder-${n}.exe`), '');
  else {
    writeFileSync(join(folder, 'placeholder-1.png'), solidPng(64, 96, [74, 98, 168]));
    writeFileSync(join(folder, 'placeholder-2.png'), solidPng(64, 96, [168, 98, 74]));
  }
  for (const name of readdirSync(folder)) utimesSync(join(folder, name), FILE_TIME, FILE_TIME);
  return folder;
}

async function filePicker(d, file, folder, titlePattern) {
  const pid = d.child.pid;
  const box = await waitForWindow(pid, MESSAGE_BOX, { title: titlePattern });
  await navigate(pid, box.hwnd, folder);
  const deadline = Date.now() + 15_000;
  while (!(await addressOf(pid, box.hwnd)).some((a) => resolve(a).toLowerCase() === resolve(folder).toLowerCase())) {
    if (Date.now() > deadline) throw new Error('the file dialog did not move to the placeholder folder');
    await sleep(250);
  }
  const pruned = await pruneNavigation(pid, box.hwnd);
  await sleep(1_500);
  const text = await dialogText(pid, box.hwnd);
  const size = await capture(pid, box.hwnd, file);
  await postCommand(pid, box.hwnd, IDCANCEL);
  if (!(await gone(pid, box.hwnd))) throw new Error('the file dialog did not close on Cancel');
  return { text, size, pruned };
}

const SHOTS = [
  {
    name: 'window-chrome',
    row: null,
    build: 'unpackaged',
    how: 'The unpackaged build on a scratch data folder and the all-four fake launchers, Library open once the startup scan and artwork queue were done, the whole window captured with PrintWindow.',
    async run(file) {
      const d = await unpackaged('chrome');
      try {
        await d.waitFor('Rocket League');
        await settle(d);
        const win = await mainWindow(d.child.pid);
        const size = await capture(d.child.pid, win.hwnd, file);
        return { title: win.title, text: null, size };
      } finally {
        await endDriver(d);
      }
    },
  },
  {
    name: 'native-file-picker-locate',
    row: 167,
    build: 'unpackaged',
    how: 'Settings > Launchers, the Steam row expanded, Locate… clicked over CDP; the dialog moved to a scratch folder of two empty placeholder .exe files through its own file-name field, the pinned folders that are not Windows defaults (and any other non-default entry) removed from the navigation tree of this dialog with TVM_DELETEITEM, captured, then cancelled with IDCANCEL.',
    async run(file) {
      const d = await unpackaged('locate');
      try {
        const folder = await pickerFolder(d, 'exe');
        await d.click('Settings');
        await d.click('Launchers');
        await d.waitFor('Re-check');
        await d.click({ contains: 'Steam' });
        await d.waitFor('Found automatically.');
        await d.click('Locate…');
        const { text, size } = await filePicker(d, file, folder, /^Locate steam\.exe$/);
        await d.waitFor(() => [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Locate…' && !b.disabled));
        if (!(await d.has('Found automatically.'))) throw new Error('the Steam row changed after the cancel');
        return { title: text.title, text, size };
      } finally {
        await endDriver(d);
      }
    },
  },
  {
    name: 'native-file-picker-image',
    row: 168,
    build: 'unpackaged',
    how: "Library, the Rocket League® card's menu > Choose portrait image… clicked over CDP; the dialog moved to a scratch folder of two placeholder PNGs through its own file-name field, the pinned folders that are not Windows defaults (and any other non-default entry) removed from the navigation tree of this dialog with TVM_DELETEITEM, captured, then cancelled with IDCANCEL.",
    async run(file) {
      const d = await unpackaged('image');
      try {
        const folder = await pickerFolder(d, 'png');
        await d.waitFor('Rocket League');
        await d.click('More for Rocket League®');
        await d.waitFor('Choose portrait image…');
        await d.click('Choose portrait image…');
        const { text, size } = await filePicker(d, file, folder, /^Choose an image$/);
        return { title: text.title, text, size };
      } finally {
        await endDriver(d);
      }
    },
  },
  {
    name: 'settings-updates-unavailable-custom-folder',
    row: 131,
    build: 'packaged',
    how: 'The packaged exe started with --data-dir= on a scratch folder (real launchers, read only), the setup guide skipped, Settings > General once updates:status answered custom-data-folder; a CDP screenshot at 1280x800 with en-US and UTC.',
    async run(file) {
      const temp = join(scratchBase(), 'packaged-temp');
      await removeFolder(temp);
      mkdirSync(temp, { recursive: true });
      const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP };
      process.env.TEMP = temp;
      process.env.TMP = temp;
      const d = new Driver({ name: 'native-updates', packaged: true, port: await freePort(), shots: join(temp, 'shots') });
      try {
        d.spawn = ((spawnOriginal) =>
          function () {
            spawnOriginal.call(this);
            spawned.add(this.child.pid);
          })(d.spawn);
        await d.start();
        const info = await d.invoke('app:info');
        if (!info.isPackaged || resolve(info.dataDir).toLowerCase() !== resolve(d.dataDir).toLowerCase())
          throw new Error('not the packaged app on the scratch folder');
        await skipSetup(d);
        const deadline = Date.now() + 30_000;
        let update = await d.invoke('updates:status');
        while (update.state === 'idle' && Date.now() < deadline) {
          await sleep(200);
          update = await d.invoke('updates:status');
        }
        if (update.state !== 'unavailable' || update.reason !== 'custom-data-folder') throw new Error(`updates:status is ${JSON.stringify(update)}`);
        await d.send('Emulation.setLocaleOverride', { locale: LOCALE });
        await d.send('Emulation.setTimezoneOverride', { timezoneId: TIMEZONE });
        await d.send('Emulation.setFocusEmulationEnabled', { enabled: true });
        await d.viewport(...SIZE);
        await d.click('Settings');
        await d.click('General');
        await d.waitFor('Updates are off while One Launch runs from a custom data folder.');
        await settle(d);
        const { data } = await d.send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(file, Buffer.from(data, 'base64'));
        const win = await mainWindow(d.child.pid);
        const [width, height] = pngSize(readFileSync(file));
        return {
          title: win.title,
          text: { title: win.title, message: ['Updates are off while One Launch runs from a custom data folder.'], buttons: [] },
          size: { width, height },
        };
      } finally {
        if (d.child && d.exitCode === null) await d.close();
        await d.cleanup();
        process.env.TEMP = saved.TEMP;
        process.env.TMP = saved.TMP;
        await removeFolder(temp);
      }
    },
  },
  {
    name: 'native-startup-error',
    row: 166,
    build: 'packaged',
    how: 'The packaged exe started with --data-dir= on a scratch folder whose onelaunch.db is a one-line text file; the error box captured from the spawned process, then closed with WM_CLOSE.',
    async run(file) {
      const scratch = join(scratchBase(), 'startup');
      await removeFolder(scratch);
      const dataDir = join(scratch, 'data');
      const temp = join(scratch, 'temp');
      mkdirSync(dataDir, { recursive: true });
      mkdirSync(temp, { recursive: true });
      writeFileSync(join(dataDir, 'onelaunch.db'), 'placeholder: this is a text file, not a SQLite database\n');
      const env = { ...process.env, TEMP: temp, TMP: temp };
      for (const key of Object.keys(env)) if (key === 'ELECTRON_RUN_AS_NODE' || key.startsWith('ONELAUNCH_') || key === 'NODE_OPTIONS') delete env[key];
      const child = spawn(PACKAGED_EXE, [`--data-dir=${dataDir}`], { env, cwd: scratch, stdio: 'ignore' });
      spawned.add(child.pid);
      const exited = new Promise((done) => child.on('exit', (code) => done(code ?? -1)));
      try {
        const box = await waitForWindow(child.pid, MESSAGE_BOX, { timeoutMs: 30_000 });
        await sleep(500);
        const text = await boxText(child.pid, box.hwnd);
        const size = await capture(child.pid, box.hwnd, file);
        await postClose(child.pid, box.hwnd);
        const code = await Promise.race([exited, sleep(15_000).then(() => 'timeout')]);
        if (code !== 1) throw new Error(`the exe left with ${code} after the error box, not 1`);
        return { title: text.title, text, size };
      } finally {
        if (child.exitCode === null) {
          child.kill();
          await Promise.race([exited, sleep(5_000)]);
        }
        await removeFolder(scratch);
      }
    },
  },
  {
    name: 'native-quit-during-switch',
    row: 164,
    build: 'unpackaged',
    how: 'The all-four fake launchers with Epic never signing in, the tray setting off, Play Rocket League® as the Epic account Alt until "Sign in…", WM_CLOSE posted to the app window; the prompt captured, then answered Keep running with WM_CLOSE (its cancel id), the switch stopped from the page.',
    async run(file) {
      const d = await unpackaged('quit', { knobs: HANG });
      const pid = d.child.pid;
      try {
        await d.waitFor('Rocket League');
        await d.invoke('settings:set', { key: 'window.closeToTray', value: 'false' });
        await startPlay(d, { game: 'Rocket League®', account: 'Alt', tag: 'quit' });
        await watchDialog(d, { until: (t) => t.includes('Sign in…'), tag: 'quit' });
        const win = await mainWindow(pid);
        await postClose(pid, win.hwnd);
        const box = await waitForWindow(pid, MESSAGE_BOX, { title: /^A switch is still running$/ });
        await sleep(500);
        const text = await boxText(pid, box.hwnd);
        const size = await capture(pid, box.hwnd, file);
        await postClose(pid, box.hwnd);
        if (!(await gone(pid, box.hwnd))) throw new Error('the prompt did not close on WM_CLOSE');
        await sleep(1_000);
        if (d.exitCode !== null || !(await d.has('Sign in…'))) throw new Error('the app did not keep running');
        await d.click('Stop');
        await watchDialog(d, { until: (t) => t.includes('Nothing was rolled back'), tag: 'quit' });
        await finishDialog(d, 'quit');
        return { title: text.title, text, size };
      } finally {
        await endDriver(d);
      }
    },
  },
  {
    name: 'native-crash-dialog',
    row: 165,
    build: 'unpackaged',
    how: "The unpackaged build on the all-four fake launchers started with Node's inspector on main (--inspect on a free port); a setTimeout that throws evaluated there after checking process.pid is the spawned one, so main's uncaughtException handler showed the dialog; captured, then answered Keep running with WM_CLOSE (its cancel id).",
    async run(file) {
      const inspect = await freePort();
      const d = await unpackaged('crash', { args: [`--inspect=127.0.0.1:${inspect}`] });
      const pid = d.child.pid;
      try {
        await d.waitFor('Rocket League');
        await settle(d);
        const [target] = await (await fetch(`http://127.0.0.1:${inspect}/json/list`)).json();
        if (!target) throw new Error('the inspector offered no target');
        const ws = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((open, fail) => {
          ws.onopen = open;
          ws.onerror = () => fail(new Error('could not open the inspector'));
        });
        let seq = 0;
        const evaluate = (expression) =>
          new Promise((done, fail) => {
            const id = ++seq;
            ws.onmessage = (m) => {
              const msg = JSON.parse(m.data);
              if (msg.id !== id) return;
              if (msg.error || msg.result.exceptionDetails) fail(new Error(JSON.stringify(msg.error ?? msg.result.exceptionDetails)));
              else done(msg.result.result.value);
            };
            ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
          });
        try {
          const owner = await evaluate('process.pid');
          if (owner !== pid) throw new Error(`the inspector answers for process ${owner}, not ${pid}`);
          await evaluate(`setTimeout(() => { throw new Error(${JSON.stringify(CRASH_MESSAGE)}); }, 0); true`);
        } finally {
          ws.close();
        }
        const box = await waitForWindow(pid, MESSAGE_BOX, { title: /^One Launch hit an unexpected error$/ });
        await sleep(500);
        const text = await boxText(pid, box.hwnd);
        const size = await capture(pid, box.hwnd, file);
        await postClose(pid, box.hwnd);
        if (!(await gone(pid, box.hwnd))) throw new Error('the crash dialog did not close on WM_CLOSE');
        await sleep(1_000);
        if (d.exitCode !== null) throw new Error('the app left after Keep running');
        return { title: text.title, text, size };
      } finally {
        await endDriver(d);
      }
    },
  },
];

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const repeat = argv.includes('--repeat');
  const only = argv.includes('--index')
    ? []
    : (argv
        .find((a) => a.startsWith('--only='))
        ?.slice('--only='.length)
        .split(',') ?? null);
  const out = resolveOut(argv);
  const target = repeat ? join(scratchBase(), 'repeat') : join(out, OWNER_DIR);
  mkdirSync(target, { recursive: true });
  const indexFile = join(out, OWNER_DIR, INDEX);
  const index = existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, 'utf8')) : { captures: [] };
  const results = [];
  let failed = 0;
  for (const shot of SHOTS.filter((s) => only === null || only.includes(s.name))) {
    const file = join(target, `${shot.name}.png`);
    rmSync(file, { force: true });
    try {
      const got = await shot.run(file);
      const checked = verifyPng(file);
      const entry = {
        row: shot.row,
        file: `${shot.name}.png`,
        capturedBy: 'agent',
        build: shot.build,
        how: shot.how,
        title: got.title,
        text: got.text,
        width: checked.width,
        height: checked.height,
      };
      results.push(entry);
      console.log(`SHOT  ${entry.file}  ${checked.width}x${checked.height}  ${checked.colours} colours  "${entry.title}"`);
      if (repeat) {
        const before = index.captures.find((c) => c.file === entry.file);
        const bundled = join(out, OWNER_DIR, entry.file);
        if (!before || !existsSync(bundled)) console.log(`REPEAT ${entry.file}: nothing in the bundle to compare with`);
        else {
          const sameText = JSON.stringify(before.text) === JSON.stringify(entry.text) && before.title === entry.title;
          const sameSize = before.width === entry.width && before.height === entry.height;
          const diff = sameSize ? pixelDiff(readFileSync(bundled), readFileSync(file)) : null;
          console.log(
            `REPEAT ${entry.file}: text ${sameText ? 'same' : 'DIFFERS'}, size ${sameSize ? 'same' : `DIFFERS (${before.width}x${before.height})`}${diff ? `, ${diff.count} pixels differ${diff.box ? ` within ${diff.box.join(',')}` : ''}` : ''}`,
          );
          if (!sameText) console.log(`  bundle: ${JSON.stringify(before.text)}\n  now:    ${JSON.stringify(entry.text)}`);
          if (!sameText || !sameSize) failed += 1;
        }
      }
    } catch (err) {
      failed += 1;
      console.log(`FAIL  ${shot.name}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    }
  }
  if (!repeat && (results.length > 0 || argv.includes('--index'))) {
    const kept = index.captures.filter((c) => !results.some((r) => r.file === c.file));
    const order = SHOTS.map((s) => `${s.name}.png`);
    const captures = [...kept, ...results].sort((a, b) => order.indexOf(a.file) - order.indexOf(b.file));
    writeArtefact(out, `${OWNER_DIR}/${INDEX}`, { captures, waived: WAIVED, notProduced: NOT_PRODUCED });
  }
  const left = [...spawned].filter(alive);
  console.log(left.length === 0 ? `PIDS  none of the ${spawned.size} started processes is running` : `PIDS  still running: ${left.join(', ')}`);
  if (left.length > 0) failed += 1;
  process.exitCode = failed === 0 ? 0 : 1;
}

await main();
