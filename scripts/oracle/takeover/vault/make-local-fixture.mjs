// Writes a machine-local One Launch data folder with placeholder secrets, by letting the real app write it, for the
// same-machine vault cross-read (Electron writes and Rust reads; Rust writes and Electron reads with --read).
//   node make-local-fixture.mjs <new or empty folder> [--electron=<one-launch repo>]
//   node make-local-fixture.mjs --read <folder> [--electron=<one-launch repo>]
// The output is bound by DPAPI to this Windows user on this machine. Never commit it.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const FIXTURE = {
  accounts: [
    { launcher: 'steam', displayName: 'Placeholder One', login: 'placeholder_user_1', password: 'placeholder-password-1' },
    { launcher: 'epic', displayName: 'Placeholder Two', login: 'placeholder_user_2', password: 'placeholder-pässwörd-2-日本語-🎮' },
    {
      launcher: 'battlenet',
      displayName: 'Placeholder Three',
      login: 'placeholder_user_3',
      password: Array.from({ length: 40 }, (_, i) => `placeholder-${String(i).padStart(2, '0')}-ä`).join(''),
    },
    { launcher: 'steam', displayName: 'Placeholder Four', login: 'placeholder_user_4', password: null },
  ],
  secrets: {
    'steamgriddb.apiKey': '',
    'diagnostics.roundtrip': 'placeholder-roundtrip-ünïcødé-🎮',
  },
  probe: { key: 'vault.probe', value: 'one-launch-vault-probe-v1' },
};

const isInside = (parent, child) => {
  const back = relative(parent.toLowerCase(), child.toLowerCase());
  return back === '' || (!back.startsWith('..') && !isAbsolute(back));
};

function isElectronRepo(dir) {
  try {
    return existsSync(join(dir, 'scripts', 'app-driver.mjs')) && JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name === 'one-launch';
  } catch {
    return false;
  }
}

function findElectronRepo(given) {
  const candidates = [given, process.env.ONELAUNCH_ELECTRON_REPO, resolve(here, '..', '..', '..', '..'), resolve(here, '..', '..', '..', '..', 'one-launch')];
  const found = candidates
    .filter(Boolean)
    .map((c) => resolve(c))
    .find(isElectronRepo);
  if (!found) throw new Error('cannot find the one-launch repo; pass --electron=<folder>');
  return found;
}

function findRustRepos(electron) {
  const repos = [resolve(electron, '..', 'one-launch-rs')];
  for (let dir = here; dir !== parse(dir).root; dir = dirname(dir)) if (existsSync(join(dir, 'oracle', 'PIN'))) repos.push(dir);
  return repos;
}

export function checkTarget(target, { electron, mode }) {
  if (!target || !isAbsolute(target)) throw new Error('name the folder as an absolute path');
  const folder = resolve(target);
  if (folder === parse(folder).root) throw new Error('the folder must not be a drive root');
  for (const repo of [electron, ...findRustRepos(electron)]) if (isInside(repo, folder)) throw new Error(`refused: the folder is inside the repo ${repo}`);
  if (/[\\/]Users[\\/]/i.test(`${folder}\\`)) throw new Error('refused: the folder is inside a user profile');
  for (const profile of [homedir(), process.env.USERPROFILE, process.env.APPDATA, process.env.LOCALAPPDATA].filter(Boolean)) {
    if (isInside(resolve(profile), folder)) throw new Error('refused: the folder is inside a user profile');
  }
  if (mode === 'write' && existsSync(folder) && (!statSync(folder).isDirectory() || readdirSync(folder).length > 0))
    throw new Error('refused: the folder exists and is not empty');
  if (mode === 'read' && !existsSync(join(folder, 'data', 'onelaunch.db'))) throw new Error('there is no data\\onelaunch.db in that folder');
  return folder;
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
    const result = await new Promise((done, fail) => {
      ws.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (msg.id !== 1) return;
        if (msg.error) fail(new Error(msg.error.message));
        else done(msg.result);
      };
      ws.send(JSON.stringify({ id: 1, method: 'SystemInfo.getProcessInfo' }));
    });
    return result.processInfo.find((p) => p.type === 'browser')?.id ?? null;
  } finally {
    ws.close();
  }
}

async function startApp(electron, folder, launchers) {
  const { Driver, materializeScenario } = await import(pathToFileURL(join(electron, 'scripts', 'app-driver.mjs')).href);
  const d = new Driver({ name: 'takeover-fixture', fake: 'none', keep: true, port: await freePort() });
  if (!existsSync(d.exe)) throw new Error(`no Electron at ${d.exe}`);
  if (!existsSync(join(electron, 'out', 'main', 'index.js'))) throw new Error('the unpackaged app is not built (out/main/index.js is missing)');
  d.scratch = folder;
  d.dataDir = join(folder, 'data');
  d.launchersDir = join(folder, launchers);
  rmSync(d.launchersDir, { recursive: true, force: true });
  d.scenario = materializeScenario(d.fake, d.launchersDir, null);
  const temp = join(folder, 'temp');
  for (const dir of [d.dataDir, temp]) mkdirSync(dir, { recursive: true });
  d.shotsDir = join(folder, 'failures');
  d.env = { TEMP: temp, TMP: temp };
  d.spawn();
  try {
    await d.connect();
    const owner = await browserProcessId(d.port);
    if (owner !== d.child.pid) throw new Error(`port ${d.port} answers for another process, not the app this script started`);
  } catch (err) {
    await d.close().catch(() => undefined);
    throw err;
  }
  return d;
}

async function stopApp(d) {
  const code = await d.close();
  if (code !== 0) throw new Error(`the app left with ${code}`);
}

function commitOf(repo) {
  try {
    return execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
  } catch {
    return null;
  }
}

export async function writeFixture(target, { electron = findElectronRepo() } = {}) {
  const folder = checkTarget(target, { electron, mode: 'write' });
  mkdirSync(folder, { recursive: true });
  const { waitForVaultKey } = await import(pathToFileURL(join(electron, 'scripts', 'scenarios', 'lib.mjs')).href);
  const d = await startApp(electron, folder, 'launchers');
  try {
    await waitForVaultKey(d);
    const vault = await d.invoke('vault:status');
    if (!vault.available) throw new Error('the vault is not available in this session');
    for (const a of FIXTURE.accounts) await d.invoke('accounts:create', a);
    for (const [key, value] of Object.entries(FIXTURE.secrets)) await d.invoke('vault:setSecret', { key, value });
    const after = await d.invoke('vault:status');
    if (after.readable !== true) throw new Error('the app does not read its own probe back');
  } finally {
    await stopApp(d);
  }
  if (!readFileSync(join(folder, 'data', 'chromium', 'Local State'), 'utf8').includes('encrypted_key'))
    throw new Error('Local State holds no wrapped key after the app quit');
  const manifest = {
    note: 'Machine-local: every *_enc value is under a key DPAPI-bound to this Windows user on this machine. Placeholder secrets only. Never commit this folder.',
    writtenBy: 'electron',
    electronCommit: commitOf(electron),
    dataDir: 'data',
    ...FIXTURE,
  };
  writeFileSync(join(folder, 'fixture.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { folder, manifest };
}

export async function readFixture(target, { electron = findElectronRepo() } = {}) {
  const folder = checkTarget(target, { electron, mode: 'read' });
  const expected = JSON.parse(readFileSync(join(folder, 'fixture.json'), 'utf8'));
  const d = await startApp(electron, folder, 'launchers-read');
  const results = [];
  const check = (name, ok) => results.push({ name, ok });
  try {
    const vault = await d.invoke('vault:status');
    check('the vault is available', vault.available === true);
    check('the app reads the probe back (vault:status readable)', vault.readable === true);
    const { value } = await d.invoke('vault:getSecret', { key: 'diagnostics.roundtrip' });
    check('diagnostics.roundtrip decrypts to the expected placeholder', value === expected.secrets['diagnostics.roundtrip']);
    const { accounts } = await d.invoke('accounts:list');
    for (const a of expected.accounts) {
      const found = accounts.find((x) => x.launcher === a.launcher && x.login === a.login);
      check(`account ${a.login} is listed with hasSecret ${a.password !== null}`, Boolean(found) && found.hasSecret === (a.password !== null));
    }
  } finally {
    await stopApp(d);
  }
  return results;
}

async function main(argv) {
  const electronArg = argv.find((a) => a.startsWith('--electron='))?.slice('--electron='.length);
  const read = argv.includes('--read');
  const target = argv.find((a) => !a.startsWith('--'));
  const electron = findElectronRepo(electronArg);
  if (read) {
    const results = await readFixture(target, { electron });
    for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
    return results.every((r) => r.ok) ? 0 : 1;
  }
  const { folder, manifest } = await writeFixture(target, { electron });
  console.log(`Wrote ${folder}\\data with ${manifest.accounts.length} accounts and ${Object.keys(manifest.secrets).length} named secrets (placeholders).`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    },
  );
}
