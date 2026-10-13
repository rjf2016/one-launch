// Starts electron-vite dev (hot reload) on a fresh scratch folder against fake launchers, with the CDP port open for an
// interactive look (`agent-browser connect <port>`): a renderer edit shows in the window without a rebuild.
//   npm run dev:fake [-- --fake=<name|folder>] [--knobs=<json>] [--port=<n>] [--keep]
// The run ends when the app quits (close its window, or `agent-browser eval "window.close()"`); the scratch folder is
// deleted then unless --keep. Unpackaged only, like every fake run; the real data folder is never touched.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeScenario, parseArgs, repoRoot, sleep } from './app-driver.mjs';

const DEFAULT_PORT = 9334;

const { flags } = parseArgs(process.argv.slice(2));
const fake = typeof flags.fake === 'string' ? flags.fake : 'all-four';
const port = typeof flags.port === 'string' ? Number(flags.port) : DEFAULT_PORT;
if (!(port > 0)) {
  console.error('--port takes a number');
  process.exit(2);
}

const scratch = mkdtempSync(join(tmpdir(), 'onelaunch-dev-'));
const dataDir = join(scratch, 'data');
mkdirSync(dataDir);
const launchersDir = join(scratch, 'launchers');
materializeScenario(fake, launchersDir, typeof flags.knobs === 'string' ? JSON.parse(flags.knobs) : null);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (key.startsWith('ONELAUNCH_UPDATE_')) delete env[key];
env.REMOTE_DEBUGGING_PORT = String(port);
env.ONELAUNCH_DATA_DIR = dataDir;
env.ONELAUNCH_FAKE_LAUNCHERS = launchersDir;

console.log(
  `Dev run with hot reload, fake launchers: ${fake}\n  scratch ${scratch}\n  CDP port ${port}: agent-browser connect ${port}\nThe run ends when the app quits.`,
);
const child = spawn(process.execPath, [join(repoRoot, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), 'dev'], {
  env,
  cwd: repoRoot,
  stdio: 'inherit',
});
child.on('exit', async (code) => {
  if (!flags.keep) {
    // Chromium can hold its profile for a moment after the exit.
    for (let i = 0; i < 10 && existsSync(scratch); i++) {
      try {
        rmSync(scratch, { recursive: true, force: true });
      } catch {
        await sleep(500);
      }
    }
  }
  if (existsSync(scratch)) console.log(`Scratch kept: ${scratch}`);
  process.exit(code ?? 1);
});
