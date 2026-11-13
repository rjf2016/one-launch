import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, 'win.ps1');
const POWERSHELL = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

export const MESSAGE_BOX = '#32770';
export const APP_WINDOW = 'Chrome_WidgetWin_1';
export const IDCANCEL = 2;

const list = (value) => (value === null || value === undefined ? [] : Array.isArray(value) ? value : [value]);

function win(command, pid, opts = {}) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, command, '-ProcessId', String(pid)];
  for (const [key, value] of Object.entries(opts)) args.push(`-${key[0].toUpperCase()}${key.slice(1)}`, String(value));
  return new Promise((done, fail) => {
    execFile(POWERSHELL, args, { windowsHide: true, encoding: 'utf8', timeout: 60_000 }, (err, stdout, stderr) => {
      const text = stdout.trim();
      if (err && !(command === 'wait' && err.code === 3)) {
        fail(new Error(`win.ps1 ${command}: ${(stderr || text || err.message).trim().split(/\r?\n/)[0]}`));
        return;
      }
      done({ timedOut: Boolean(err), value: text === '' ? null : JSON.parse(text) });
    });
  });
}

export async function windowsOf(pid) {
  return list((await win('windows', pid)).value);
}

export async function waitForWindow(pid, cls, { timeoutMs = 20_000, title = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const left = Math.max(1_000, deadline - Date.now());
    const { value } = await win('wait', pid, { class: cls, timeoutMs: left });
    const hit = list(value).find((w) => w.cls === cls && (title === null || title.test(w.title)));
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`no ${cls} window${title ? ` titled ${title}` : ''} of process ${pid} within ${timeoutMs} ms`);
  }
}

export async function gone(pid, hwnd, { timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!(await windowsOf(pid)).some((w) => w.hwnd === hwnd)) return true;
    if (Date.now() > deadline) return false;
  }
}

export async function capture(pid, hwnd, out) {
  return (await win('capture', pid, { hwnd, out })).value;
}

export async function readWindow(pid, hwnd, kinds) {
  const { title, elements } = (await win('read', pid, { hwnd, kinds: kinds.join(',') })).value;
  return { title, elements: list(elements) };
}

export async function controlsOf(pid, hwnd) {
  const { title, controls } = (await win('controls', pid, { hwnd })).value;
  return { title, controls: list(controls) };
}

export async function addressOf(pid, hwnd) {
  return (await controlsOf(pid, hwnd)).controls.filter((c) => c.cls === 'ToolbarWindow32' && c.text.startsWith('Address: ')).map((c) => c.text.slice(9));
}

export async function pruneNavigation(pid, hwnd) {
  return (await win('prune', pid, { hwnd })).value;
}

export async function navigate(pid, hwnd, path) {
  await win('navigate', pid, { hwnd, path });
}

export async function postClose(pid, hwnd) {
  await win('close', pid, { hwnd });
}

export async function postCommand(pid, hwnd, id) {
  await win('command', pid, { hwnd, id });
}
