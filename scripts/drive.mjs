// Runs one scenario against the built app on a fresh scratch folder.
//   node scripts/drive.mjs scripts/scenarios/views.mjs --shots=<folder>
//   node scripts/drive.mjs scripts/scenarios/<scenario>.mjs [--packaged] [--fake[=<name|folder>]] [--knobs=<json>] [--keep] [--shots=<dir>] [--port=<n>] [--hold[=<minutes>]]
// Unpackaged runs need `npx electron-vite build` first; --packaged needs `npm run build` and never combines with --fake.
// --hold keeps the app up at the scenario's end state for an interactive look over CDP (see the run-one-launch skill).
// .claude/settings.json lets an agent run this on scripts/scenarios/ without asking, so it imports from nowhere else and starts only the repo's own builds.
import { realpathSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, repoRoot, runScenario } from './app-driver.mjs';

const USAGE =
  'Usage: node scripts/drive.mjs scripts/scenarios/<scenario>.mjs [--packaged] [--fake[=<name|folder>]] [--knobs=<json>] [--keep] [--shots=<dir>] [--port=<n>] [--hold[=<minutes>]]';

function refuse(message) {
  console.error(message);
  process.exit(2);
}

function scenarioFile(arg) {
  const scenarios = realpathSync.native(join(repoRoot, 'scripts', 'scenarios'));
  let file;
  try {
    file = realpathSync.native(resolve(arg));
  } catch {
    return refuse(`Not found: ${arg}`);
  }
  if (extname(file) !== '.mjs' || dirname(file).toLowerCase() !== scenarios.toLowerCase()) {
    return refuse(`${arg} is not a scenario file directly in scripts/scenarios/. An ad hoc scenario goes there as adhoc-<name>.mjs (gitignored).`);
  }
  return file;
}

const { positional, flags } = parseArgs(process.argv.slice(2));
if (!positional[0]) refuse(USAGE);
if (flags.exe !== undefined)
  refuse('--exe is not supported: the driver starts only the electron.exe in node_modules or, with --packaged, dist/win-unpacked/One Launch.exe.');
const hold = flags.hold === undefined ? undefined : flags.hold === true ? true : Number(flags.hold);
if (hold !== undefined && hold !== true && !(hold > 0)) refuse('--hold takes minutes: --hold or --hold=<minutes>');
const mod = await import(pathToFileURL(scenarioFile(positional[0])).href);
if (typeof mod.default !== 'function') refuse(`${positional[0]} does not export a default async function`);
const { failures } = await runScenario(mod, {
  packaged: flags.packaged ? true : undefined,
  hold,
  // A bare --fake keeps a scenario's own folder (first-run.mjs names "none"); --fake=<name> overrides it.
  fake: flags.fake === true && mod.options?.fake ? undefined : flags.fake,
  knobs: typeof flags.knobs === 'string' ? JSON.parse(flags.knobs) : undefined,
  keep: flags.keep ? true : undefined,
  shots: typeof flags.shots === 'string' ? flags.shots : undefined,
  port: typeof flags.port === 'string' ? Number(flags.port) : undefined,
});
process.exit(failures === 0 ? 0 : 1);
