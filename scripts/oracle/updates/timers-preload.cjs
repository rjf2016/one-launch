// Reaches the app's main process only through NODE_OPTIONS=--require on an update capture; README.md here says what it records.
const FILE_ENV = 'ORACLE_UPDATES_TIMERS';
const OWNER = /\n\s+at UpdateService\.schedule \(/;

function install(file) {
  const fs = require('node:fs');
  const timers = require('node:timers');
  const realSet = timers.setTimeout;
  const realClear = timers.clearTimeout;
  const tracked = new WeakMap();
  let seq = 0;
  const write = (ev, ms) => fs.appendFileSync(file, `${JSON.stringify({ seq: seq++, ev, ms, t: Number(process.hrtime.bigint() / 1000000n) })}\n`);

  function setTimeout(fn, ms, ...args) {
    if (typeof fn !== 'function' || typeof ms !== 'number' || ms < 1000 || !OWNER.test(new Error().stack ?? '')) return realSet(fn, ms, ...args);
    const handle = realSet(
      (...inner) => {
        tracked.delete(handle);
        write('fire', ms);
        return fn(...inner);
      },
      ms,
      ...args,
    );
    tracked.set(handle, ms);
    write('arm', ms);
    return handle;
  }
  function clearTimeout(handle) {
    if (handle && typeof handle === 'object' && tracked.has(handle)) {
      write('clear', tracked.get(handle));
      tracked.delete(handle);
    }
    return realClear(handle);
  }
  // Electron's own start-up wraps timers.setTimeout and copies it onto the global after this file has run, so the module's export is the one to replace.
  timers.setTimeout = setTimeout;
  timers.clearTimeout = clearTimeout;
  globalThis.setTimeout = setTimeout;
  globalThis.clearTimeout = clearTimeout;
}

if (require.main !== module && process.versions.electron && process.env[FILE_ENV]) install(process.env[FILE_ENV]);

module.exports = { FILE_ENV };
