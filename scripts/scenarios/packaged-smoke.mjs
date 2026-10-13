// The packaged app starts on a scratch folder, answers, opens the setup guide, and quits cleanly. Reads only.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { repoRoot, sleep } from '../app-driver.mjs';

export const name = 'packaged-smoke';
export const label = 'Packaged smoke run';
export const options = { packaged: true };

export default async (d) => {
  const version = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;

  const info = await d.invokeRaw('app:info');
  d.check('app:info answers', info.ok === true);
  d.check('it is the packaged app', info.data?.isPackaged === true);
  d.check(`it is version ${version}`, info.data?.version === version, String(info.data?.version));
  d.check(
    'its data folder is the scratch folder',
    resolve(info.data?.dataDir ?? '').toLowerCase() === resolve(d.dataDir).toLowerCase(),
    String(info.data?.dataDir),
  );
  d.check('it runs against the real launchers', info.data?.platformSource !== 'fake' && !(await d.has('Fake launchers')));

  const status = await d.invokeRaw('launchers:status');
  const rows = status.data?.launchers ?? [];
  d.check('launchers:status answers for all four launchers', status.ok === true && rows.length === 4);
  d.check(
    'no launcher needs attention',
    rows.every((l) => l.attention === null),
    rows.map((l) => `${l.launcher}=${l.attention ? 'attention' : l.install ? 'installed' : 'not installed'}`).join(' '),
  );

  const welcomed = await d.waitFor('Welcome to One Launch').then(
    () => true,
    () => false,
  );
  d.check('a new data folder opens the setup guide', welcomed);
  const art = await d.invokeRaw('artwork:status');
  d.check('artwork:status answers', art.ok === true, JSON.stringify(art.error ?? ''));

  const permissions = await d.evaluate(async () => {
    const state = (name) =>
      navigator.permissions.query({ name }).then(
        (s) => s.state,
        (e) => e.name,
      );
    return [await state('clipboard-read'), await state('notifications'), await state('camera'), await Notification.requestPermission()];
  });
  d.check(
    'the page is refused the clipboard, notifications and the camera, asked or not',
    permissions.every((s) => s === 'denied'),
    permissions.join(' '),
  );

  // The updater starts once the window has painted, which the cold first start of a new build can delay by several seconds.
  const asked = Date.now();
  let update = await d.invoke('updates:status');
  for (let i = 0; i < 150 && update.state === 'idle'; i++) {
    await sleep(200);
    update = await d.invoke('updates:status');
  }
  d.check(
    'updates stay off on a scratch data folder',
    update.state === 'unavailable' && update.reason === 'custom-data-folder',
    `${JSON.stringify(update)} after ${Date.now() - asked} ms`,
  );
  // The updater loads only when a check runs, which never happens here, so look for it in the archive instead.
  const asar = readFileSync(join(dirname(d.exe), 'resources', 'app.asar'));
  d.check(
    'the archive carries electron-updater and the updater chunk',
    asar.includes('"electron-updater":{"files"') && /engine-[\w-]+\.js/.test(asar.subarray(0, 1 << 20).toString('latin1')),
  );

  // Electron's fuse wire: a sentinel, a version byte, the fuse count, then one character per fuse ('0' off, '1' on) in the order of FuseV1Options.
  const exe = readFileSync(d.exe);
  const sentinel = exe.indexOf('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
  const fuses = sentinel === -1 ? '' : exe.subarray(sentinel + 34, sentinel + 34 + exe[sentinel + 33]).toString('latin1');
  d.check(
    'the exe cannot run as Node, takes no NODE_OPTIONS or --inspect, and loads only the integrity-checked archive',
    fuses[0] === '0' && fuses[2] === '0' && fuses[3] === '0' && fuses[4] === '1' && fuses[5] === '1',
    fuses,
  );

  const code = await d.close();
  d.check('closing the window ends the app with exit code 0', code === 0, `code=${code}`);

  d.check('the database is in the scratch folder', existsSync(join(d.dataDir, 'onelaunch.db')));
  d.check('the log says the data folder came from the flag', d.readLog().includes('"dataDirSource":"flag"'));
  d.assertNoErrorLines();
};
