// Starts the packaged app against a scratch data folder, drives it over the Chrome DevTools Protocol
// with nothing but Node, and checks that it starts, answers, and quits cleanly. Reads only: no switch,
// no launcher start or stop, no write outside the scratch folder. The checks live in scripts/scenarios/packaged-smoke.mjs.
//   node scripts/smoke-packaged.mjs                 dist/win-unpacked/OneLaunch.exe
//   node scripts/smoke-packaged.mjs --keep          leave the scratch folder behind for a look
//   node scripts/smoke-packaged.mjs --shots=<dir>   where a failure's screenshot and log copy go (CI uploads drive-out/)
import { parseArgs, runScenario } from './app-driver.mjs';
import * as scenario from './scenarios/packaged-smoke.mjs';

const { flags } = parseArgs(process.argv.slice(2));
if (flags.exe !== undefined) {
  console.error('--exe is not supported: the smoke run starts only dist/win-unpacked/OneLaunch.exe.');
  process.exit(2);
}
const { failures } = await runScenario(scenario, {
  packaged: true,
  keep: flags.keep ? true : undefined,
  shots: typeof flags.shots === 'string' ? flags.shots : undefined,
});
process.exit(failures === 0 ? 0 : 1);
