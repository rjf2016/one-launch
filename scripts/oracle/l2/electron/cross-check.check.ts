// Replays five of the scripts through the real Electron app (the unpackaged build, fake launchers, a scratch data
// folder, the recording variable set) and diffs what it did against the harness's expectation, by the oracle's own
// rules. Run it with `node scripts/oracle/l2/cross-check.mjs`, which builds the app first.
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { Driver, repoRoot, sleep } from '../../../app-driver.mjs';
import { waitForVaultKey } from '../../../scenarios/lib.mjs';
import { createNormaliser } from '../../lib/normalise.mjs';
import { resolveOut, writeArtefact } from '../../lib/out.mjs';
import { isBackupManifest, readBackups, readDb, readJournal, readLauncherFiles, readLog } from '../harness/capture';
import { readScript } from '../harness/define';
import { describeJob, matches, projectEvents, withDigests, type JobView } from '../harness/events';
import { Names, scratchBase, type ReplayScript } from '../harness/runner';
import { compare, type Comparison } from './compare';
import { scratchVault } from './scratch-vault';

/**
 * Between them: every op of the script language, all four launchers and every platform operation the 22 scripts record.
 * play-all is the four adapters' whole happy path; rollback a failure after the first write, put back; handover the
 * attention panel, the clipboard, a stop and a timed-out wait; recovery two crashes and three starts; quit-during-switch
 * a restart with new knobs and the shutdown op.
 */
export const CROSS_CHECKED = ['play-all', 'rollback', 'handover', 'recovery', 'quit-during-switch'] as const;

const TRACE_FILE = 'oracle-trace.jsonl';
const GATE_TIMEOUT_MS = 120_000;

type Trace = Record<string, unknown>[];

interface Run {
  d: InstanceType<typeof Driver>;
  names: Names;
  starts: number;
}

const readTrace = (d: Run['d']): Trace => {
  const file = join(d.dataDir, TRACE_FILE);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
};

async function until(what: string, timeoutMs: number, check: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(40);
  }
}

/** A start has done what the harness waits for too: the library scan, the artwork it queued, and the database copy. */
async function settled(run: Run): Promise<void> {
  const { d } = run;
  // Chromium never paints a covered window, and main starts its background work at the first paint. A capture forces one.
  await d.send('Page.captureScreenshot', { format: 'png' });
  await until('the startup scan and the artwork queue', 60_000, async () => {
    const { status } = (await d.invoke('artwork:status')) as { status: { scanned: boolean; queued: number; running: number } };
    return status.scanned && status.queued === 0 && status.running === 0;
  });
  const copies = join(d.dataDir, 'backups', 'db');
  await until('the database copy of this start', 30_000, () => existsSync(copies) && readdirSync(copies).filter((n) => n.endsWith('.db')).length >= run.starts);
  await syncNames(run);
}

async function syncNames({ d, names }: Run): Promise<void> {
  const { accounts } = (await d.invoke('accounts:list')) as { accounts: { id: string; launcher: string; login: string }[] };
  for (const a of accounts) names.account(a.id, a.launcher, a.login);
  const { games } = (await d.invoke('library:list')) as { games: { id: string; launcher: string; launcherGameId: string }[] };
  for (const g of games) names.game(g.id, g.launcher, g.launcherGameId);
}

async function quiet(d: Run['d']): Promise<void> {
  await until('the artwork queue', 60_000, async () => {
    const { status } = (await d.invoke('artwork:status')) as { status: { queued: number; running: number } };
    return status.queued === 0 && status.running === 0;
  });
}

async function replay(name: string, script: ReplayScript): Promise<Comparison> {
  // The driver's scratch folder and Chromium's own temp files go under the neutral scratch base, never a user profile.
  process.env['TEMP'] = process.env['TMP'] = scratchBase();
  const d = new Driver({ name: `l2-${name}`, fake: script.fake, knobs: script.knobs ?? null, env: { ONELAUNCH_ORACLE_TRACE: '1' }, keep: true });
  const run: Run = { d, names: new Names(), starts: 1 };
  const first = new Map<string, JobView>();
  try {
    await d.start();
    await settled(run);
    // A hard kill in a data folder's first seconds loses the vault key, and every stored secret with it.
    if (script.steps.some((step) => step.op === 'crash')) await waitForVaultKey(d);

    for (const [index, step] of script.steps.entries()) {
      const at = `${name} step ${index} (${step.op})`;
      if (step.op === 'invoke') {
        const answer = (await d.invokeRaw(step.channel, step.req === undefined ? undefined : run.names.resolve(step.req))) as {
          ok: boolean;
          data?: { job?: { id: string; state: string; steps: { id: string; status: string; title: string; detail: string }[]; attention: unknown } };
          error?: { code: string };
        };
        if (!answer.ok) throw new Error(`${at}: ${step.channel} was refused with ${answer.error?.code}`);
        if (step.channel === 'launch:start' && answer.data?.job) {
          const job = answer.data.job;
          run.names.job(job.id);
          first.set(job.id, { ...job, steps: job.steps.map((s) => [s.id, s.status, s.title, s.detail]) });
        }
        await syncNames(run);
      } else if (step.op === 'awaitJob') {
        const id = run.names.idOf(step.job);
        if (id === undefined) throw new Error(`${at}: ${step.job} has not been started`);
        const now = (): JobView | undefined => (readTrace(d).findLast((e) => e['k'] === 'job' && e['job'] === id) as JobView | undefined) ?? first.get(id);
        try {
          await until(`${step.job} to be ${JSON.stringify(step.until)}`, GATE_TIMEOUT_MS, () => matches(now(), step.until));
        } catch (error) {
          throw new Error(`${at}: ${(error as Error).message}; it is ${describeJob(now())}`);
        }
      } else if (step.op === 'crash') {
        await d.killHard();
      } else if (step.op === 'shutdown') {
        const code = await d.close();
        if (code !== 0) throw new Error(`${at}: the app left with ${code}`);
      } else if (step.op === 'restart') {
        run.starts += 1;
        await d.restart(step.knobs === undefined ? {} : { knobs: step.knobs });
        await settled(run);
      } else {
        if (d.exitCode === null) {
          await quiet(d);
          await syncNames(run);
          const code = await d.close();
          if (code !== 0) throw new Error(`${at}: the app left with ${code}`);
        }
      }
    }

    const { names } = run;
    const trace = readTrace(d);
    for (const event of trace) {
      if (event['k'] !== 'plat' || event['op'] !== 'file.write') continue;
      const manifest = isBackupManifest(event['path'] as string, d.dataDir);
      if (manifest) names.forCapture.backup(manifest.id, manifest.launcher);
    }
    const vault = scratchVault(d.dataDir);
    const final = {
      db: readDb(d.dataDir, names.forCapture),
      journal: readJournal(d.dataDir),
      backups: readBackups(d.dataDir, names.forCapture, vault.decrypt),
      launcherFiles: readLauncherFiles(d.launchersDir),
      log: readLog(d.dataDir),
    };
    const roots = { launchers: d.launchersDir as string, data: d.dataDir as string };
    const text = createNormaliser({ roots, aliases: names.aliases }).text;
    const expectation = JSON.parse(readFileSync(join(resolveOut(), 'l2', 'expected', `${name}.json`), 'utf8'));
    const report = JSON.parse(readFileSync(join(resolveOut(), 'l2', 'normalisation', `${name}.json`), 'utf8')) as {
      normalised: { path: string; rule: string }[];
    };
    const timePaths = report.normalised.filter((f) => f.rule === 'ts' || f.rule === 'ms').map((f) => f.path);
    return compare(
      expectation,
      { events: projectEvents(trace).events, final: withDigests(final, text) as Record<string, unknown>, roots, aliases: names.aliases, ids: names.ids, vault },
      timePaths,
    );
  } finally {
    if (d.exitCode === null) await d.killHard().catch(() => undefined);
    // The raw trace, the scratch paths and the generated ids go with the folder; nothing of them is kept.
    for (let i = 0; i < 10 && d.scratch && existsSync(d.scratch); i += 1) {
      try {
        rmSync(d.scratch, { recursive: true, force: true });
      } catch {
        await sleep(500);
      }
    }
  }
}

const results = new Map<string, Comparison>();

const only = process.env['ORACLE_L2_ONLY'];

for (const name of CROSS_CHECKED.filter((n) => !only || n === only)) {
  test(`${name} through real Electron diffs to zero against the harness`, { timeout: 600_000 }, async () => {
    const result = await replay(name, readScript(name));
    console.log(
      `${name}: ${result.platEvents} platform events in exact order, ${result.jobEvents} job events as a subsequence of Electron's ${result.jobEventsInElectron}, final state exact; ${result.differences.length} differences; not compared: ${result.notCompared.length}`,
    );
    expect(result.differences).toEqual([]);
    results.set(name, result);
  });
}

test.skipIf(Boolean(only))('the cross-check is on record in the bundle', () => {
  expect([...results.keys()]).toEqual([...CROSS_CHECKED]);
  const electron = (JSON.parse(readFileSync(resolve(repoRoot, 'node_modules', 'electron', 'package.json'), 'utf8')) as { version: string }).version;
  writeArtefact(resolveOut(), 'l2/cross-check.json', {
    electron,
    build: 'unpackaged, fake launchers, scratch data folder, ONELAUNCH_ORACLE_TRACE=1',
    rules: "platform events in exact order; the expectation's job events as a subsequence of the recorded ones; the final state exact",
    scripts: Object.fromEntries(
      [...results].map(([name, result]) => [
        name,
        { platformEvents: result.platEvents, jobEvents: result.jobEvents, differences: result.differences.length, notCompared: result.notCompared },
      ]),
    ),
  });
});
