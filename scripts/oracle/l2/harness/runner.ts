import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { materializeScenario } from '../../../app-driver.mjs';
import { Aliases, createNormaliser } from '../../lib/normalise.mjs';
import { repoRoot } from '../../lib/out.mjs';
import { isBackupManifest, readBackups, readDb, readJournal, readLauncherFiles, readLog, type Ids } from './capture';
import { describeJob, matches, projectEvents, withDigests, type JobView, type TransientState } from './events';
import { startApp, type App, type TraceEvent } from './instance';
import { digestOf, type TextRule } from './project';
import { installTimerTracking, pause, turn } from './timers';

export type Step =
  | { op: 'invoke'; channel: string; req?: unknown }
  | { op: 'awaitJob'; job: string; until: Record<string, string | boolean | number | null> }
  | { op: 'restart'; knobs?: Record<string, unknown> }
  | { op: 'crash' | 'shutdown' | 'snapshot' };

export interface ReplayScript {
  fake: string;
  knobs?: Record<string, unknown>;
  steps: Step[];
}

export interface RawRun {
  value: { events: Record<string, unknown>[]; final: Record<string, unknown> };
  roots: { launchers: string; data: string };
  aliases: Aliases;
  /** id to alias, for the ids a log line shows only the tail of. */
  ids: Map<string, string>;
  vault: { decrypt: (ciphertext: Buffer) => string };
  /** `ok` or the error code of each invoke, in script order. Never part of an expectation. */
  answers: string[];
  /** The full answers, for whoever writes a script; never written anywhere. */
  replies: unknown[];
  /** How many job events each transient state of the options took out of this recording. */
  transientSeen: number[];
  scratch: string;
}

export interface RunOptions {
  transient?: TransientState[];
}

const GATE_TIMEOUT_MS = 120_000;
const ALIAS_SHAPE = /^@(acct|game|job|backup):/;

/** A folder outside both repos and outside any user profile: the app's logger masks a profile path, and a masked root cannot be told from run to run. */
export function scratchBase(): string {
  const base = resolve(process.env['ORACLE_SCRATCH'] ?? join(repoRoot, '..', 'oracle-scratch'));
  if (/[\\/]Users[\\/]/i.test(`${base}\\`)) throw new Error(`ORACLE_SCRATCH must name a folder outside any user profile, not ${base}`);
  if (`${base}\\`.toLowerCase().startsWith(`${repoRoot}\\`.toLowerCase())) throw new Error('ORACLE_SCRATCH must be outside the Electron repo');
  mkdirSync(base, { recursive: true });
  return base;
}

/** The ids of one recording and the aliases they go by, in both directions. */
export class Names {
  readonly aliases = new Aliases();
  readonly ids = new Map<string, string>();
  private readonly byAlias = new Map<string, string>();

  private keep(id: string, alias: string): void {
    this.ids.set(id, alias);
    this.byAlias.set(alias, id);
  }

  account(id: string, launcher: string, login: string): void {
    this.keep(id, this.aliases.account(id, launcher, login));
  }

  game(id: string, launcher: string, launcherGameId: string): void {
    this.keep(id, this.aliases.game(id, launcher, launcherGameId));
  }

  job(id: string): void {
    this.keep(id, this.aliases.job(id));
  }

  readonly forCapture: Ids = {
    backup: (id, launcher) => this.keep(id, this.aliases.backup(id, launcher)),
    history: (id) => this.keep(id, this.aliases.sequence('history', id)),
    aliasOf: (id) => this.ids.get(id) ?? null,
  };

  idOf(alias: string): string | undefined {
    return this.byAlias.get(alias);
  }

  /** A script's request with every alias turned back into this recording's id. */
  resolve(value: unknown): unknown {
    if (typeof value === 'string') {
      const id = this.byAlias.get(value);
      if (id !== undefined) return id;
      if (ALIAS_SHAPE.test(value)) throw new Error(`${value} names nothing this run knows yet`);
      return value;
    }
    if (Array.isArray(value)) return value.map((item) => this.resolve(item));
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.resolve(item)]));
  }
}

/** One recording of a script: every start, step and gate, then the events with one rising sequence and the final state read back from disk. */
export async function runScript(script: ReplayScript, options: RunOptions = {}): Promise<RawRun> {
  installTimerTracking();
  const scratch = mkdtempSync(join(scratchBase(), 'l2-'));
  const dataDir = join(scratch, 'data');
  const launchersDir = join(scratch, 'launchers');
  mkdirSync(dataDir);
  materializeScenario(script.fake, launchersDir, script.knobs ?? null);

  const names = new Names();
  const recorded: TraceEvent[] = [];
  const written = new Map<TraceEvent, Buffer>();
  const jobs = new Map<string, JobView>();
  let wake: (() => void) | null = null;
  let lastWrite: Buffer | null = null;

  const record = (event: TraceEvent): void => {
    recorded.push(event);
    if (event.k === 'job') jobs.set(event['job'] as string, event as unknown as JobView);
    if (event.k === 'plat' && event['op'] === 'file.write') {
      if (lastWrite) written.set(event, lastWrite);
      lastWrite = null;
      const manifest = isBackupManifest(event['path'] as string, dataDir);
      if (manifest) names.forCapture.backup(manifest.id, manifest.launcher);
    }
    wake?.();
  };

  let app: App | null = null;
  const syncNames = (): void => {
    if (!app?.alive) return;
    for (const a of app.accounts()) names.account(a.id, a.launcher, a.login);
    for (const g of app.games()) names.game(g.id, g.launcher, g.launcherGameId);
  };
  const start = async (): Promise<void> => {
    app = await startApp({
      launchersDir,
      dataDir,
      graveyard: join(scratch, 'after-the-end'),
      record,
      onWrite: (data) => {
        lastWrite = Buffer.from(data);
      },
    });
    await app.settled();
    syncNames();
  };
  const live = (what: string): App => {
    if (!app?.alive) throw new Error(`${what}: the app is not running; a restart comes first`);
    return app;
  };

  const answers: string[] = [];
  const replies: unknown[] = [];
  let final: Record<string, unknown> | null = null;
  await start();

  try {
    for (const [index, step] of script.steps.entries()) {
      const at = `step ${index} (${step.op})`;
      if (final !== null) throw new Error(`${at}: snapshot is the last step`);
      if (step.op === 'invoke') {
        const answer = await live(at).invoke(step.channel, step.req === undefined ? undefined : names.resolve(step.req));
        answers.push(answer.ok ? 'ok' : (answer.error?.code ?? 'no code'));
        replies.push(answer);
        if (answer.ok && step.channel === 'launch:start') {
          const job = (
            answer.data as { job: { id: string; state: string; steps: { id: string; status: string; title: string; detail: string }[]; attention: unknown } }
          ).job;
          names.job(job.id);
          if (!jobs.has(job.id)) jobs.set(job.id, { ...job, steps: job.steps.map((s) => [s.id, s.status, s.title, s.detail]) });
        }
        syncNames();
      } else if (step.op === 'awaitJob') {
        live(at);
        const id = names.idOf(step.job);
        if (id === undefined) throw new Error(`${at}: ${step.job} has not been started`);
        const deadline = Date.now() + GATE_TIMEOUT_MS;
        while (!matches(jobs.get(id), step.until)) {
          if (Date.now() > deadline) throw new Error(`${at}: ${step.job} never reached ${JSON.stringify(step.until)}; it is ${describeJob(jobs.get(id))}`);
          await Promise.race([new Promise<void>((done) => (wake = done)), pause(250)]);
        }
        wake = null;
        // The app code that reported the state runs on to its next wait before the script acts on it.
        await turn();
        if (!matches(jobs.get(id), step.until)) throw new Error(`${at}: ${step.job} left ${JSON.stringify(step.until)} at once; gate on a state that lasts`);
        syncNames();
      } else if (step.op === 'crash') {
        live(at).crash();
      } else if (step.op === 'shutdown') {
        await live(at).quit();
      } else if (step.op === 'restart') {
        if (app!.alive) await app!.quit();
        if (step.knobs !== undefined) writeFileSync(join(launchersDir, 'knobs.json'), JSON.stringify(step.knobs, null, 2));
        await start();
      } else {
        if (app!.alive) {
          await app!.quiet();
          syncNames();
          await app!.quit();
        }
        final = {
          db: readDb(dataDir, names.forCapture),
          journal: readJournal(dataDir),
          backups: readBackups(dataDir, names.forCapture, (ciphertext) => app!.vault.decrypt(ciphertext)),
          launcherFiles: readLauncherFiles(launchersDir),
          registry: app!.registry(),
          log: readLog(dataDir),
        };
      }
    }
  } catch (error) {
    // A script that went wrong leaves no live instance behind, and says where its jobs were.
    if (app?.alive) app.crash();
    const trail = recorded
      .filter((event) => event.k === 'job')
      .slice(-8)
      .map((event) => `${names.ids.get(event['job'] as string)} ${describeJob(event as unknown as JobView)}`);
    throw new Error([error instanceof Error ? error.message : String(error), 'The last job states:', ...trail].join('\n'), { cause: error });
  }
  if (final === null) throw new Error('the script has no snapshot step');

  const roots = { launchers: launchersDir, data: dataDir };
  const text: TextRule = createNormaliser({ roots, aliases: names.aliases }).text;
  const { events, transientSeen } = projectEvents(recorded, {
    transient: options.transient ?? [],
    extra: (event) => {
      const data = written.get(event as TraceEvent);
      return data ? { projectionSha256: digestOf(data, text).projectionSha256 } : {};
    },
  });

  return {
    value: { events, final: withDigests(final, text) as Record<string, unknown> },
    roots,
    aliases: names.aliases,
    ids: names.ids,
    vault: app!.vault,
    answers,
    replies,
    transientSeen,
    scratch,
  };
}
