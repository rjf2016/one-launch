// Reaches the app's main process only through NODE_OPTIONS=--require on a capture run; README.md here has the variables and marker files.
function installClock(offsetMs, key) {
  const RealDate = globalThis.Date;
  if (RealDate[key] !== undefined) return false;
  const now = () => RealDate.now() + offsetMs;
  const OracleDate = function (...args) {
    if (!new.target) return new RealDate(now()).toString();
    return Reflect.construct(RealDate, args.length === 0 ? [now()] : args, new.target);
  };
  OracleDate.prototype = RealDate.prototype;
  Object.defineProperties(OracleDate, { name: { value: 'Date' }, length: { value: 7 } });
  Object.assign(OracleDate, { now, parse: RealDate.parse, UTC: RealDate.UTC, [key]: offsetMs });
  globalThis.Date = OracleDate;
  return true;
}

const CLOCK_KEY = 'one-launch.oracle-ui-clock';
const OFFSET_ENV = 'ORACLE_UI_CLOCK_OFFSET';
const CONTROL_ENV = 'ORACLE_UI_CONTROL';
const HOOKED_MARKER = 'ipc-hooked';
const markerName = (kind, name) => `${kind}-${name.replace(/[^a-z0-9]+/gi, '_')}`;

// Main compares Date.now() with the process's creation time for its startup marks, so that reading moves with the clock.
function shiftCreationTime(offsetMs) {
  const wrap = (real) =>
    function getCreationTime() {
      const at = real.call(process);
      return typeof at === 'number' ? at + offsetMs : at;
    };
  if (typeof process.getCreationTime === 'function') {
    process.getCreationTime = wrap(process.getCreationTime);
    return;
  }
  let current;
  Object.defineProperty(process, 'getCreationTime', {
    configurable: true,
    enumerable: true,
    get: () => current,
    set: (fn) => {
      current = typeof fn === 'function' ? wrap(fn) : fn;
    },
  });
}

function installControl(dir) {
  const fs = require('node:fs');
  const path = require('node:path');
  const { createRequire } = require('node:module');
  const marker = (kind, name) => path.join(dir, markerName(kind, name));
  const wait = async (name) => {
    while (fs.existsSync(marker('hold', name))) await new Promise((resolve) => setTimeout(resolve, 20));
  };

  const holdBody = (proto, method) => {
    const real = proto[method];
    if (typeof real !== 'function') return;
    proto[method] = async function (...args) {
      await wait('fetch');
      return real.apply(this, args);
    };
  };
  for (const method of ['arrayBuffer', 'bytes', 'blob', 'json', 'text']) holdBody(Response.prototype, method);
  holdBody(ReadableStreamDefaultReader.prototype, 'read');

  // Node remembers what a request resolved to per requiring folder, and before Electron's start-up 'electron' is the npm package (or nothing), so each try asks from a new folder.
  const hook = (attempt) => {
    let electron = null;
    try {
      electron = createRequire(path.join(dir, `try-${attempt}`, 'hook.cjs'))('electron');
    } catch {
      return false;
    }
    if (electron === null || typeof electron !== 'object' || !electron.ipcMain) return false;
    const { ipcMain } = electron;
    const handle = ipcMain.handle.bind(ipcMain);
    ipcMain.handle = (channel, listener) =>
      handle(channel, async (event, ...args) => {
        await wait(channel);
        const fault = marker('fail', channel);
        if (fs.existsSync(fault)) return { ok: false, error: JSON.parse(fs.readFileSync(fault, 'utf8')) };
        return listener(event, ...args);
      });
    return true;
  };
  let tries = 0;
  const retry = () => {
    if (hook(tries)) {
      fs.writeFileSync(path.join(dir, HOOKED_MARKER), '');
      return;
    }
    tries += 1;
    if (tries < 5000) setImmediate(retry);
  };
  setImmediate(retry);
}

if (require.main !== module && process.env[OFFSET_ENV] !== undefined) {
  const offsetMs = Number(process.env[OFFSET_ENV]);
  if (!Number.isFinite(offsetMs)) throw new Error(`${OFFSET_ENV} is not a number`);
  if (installClock(offsetMs, CLOCK_KEY)) {
    shiftCreationTime(offsetMs);
    if (process.env[CONTROL_ENV]) installControl(process.env[CONTROL_ENV]);
  }
}

module.exports = { installClock, markerName, CLOCK_KEY, OFFSET_ENV, CONTROL_ENV, HOOKED_MARKER };
