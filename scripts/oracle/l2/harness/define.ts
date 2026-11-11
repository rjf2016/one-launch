import './electron-mock';
import { mkdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { ORACLE_CLOCK } from '../../lib/clock.mjs';
import { compileSchema, formatError } from '../../lib/json-schema.mjs';
import { resolveOut, writeArtefact } from '../../lib/out.mjs';
import type { TransientState } from './events';
import { runScript, scratchBase, type RawRun, type ReplayScript } from './runner';
import { stabilise } from './stabilise';

const L2 = resolve(import.meta.dirname, '..');
const SCHEMAS = resolve(L2, '..', 'schemas');
export const RUNS = Math.max(2, Number(process.env['ORACLE_L2_RUNS'] ?? 5));

const schema = (name: string) => compileSchema(JSON.parse(readFileSync(join(SCHEMAS, `${name}.schema.json`), 'utf8')));

export function readScript(name: string): ReplayScript {
  const script = JSON.parse(readFileSync(join(L2, 'scripts', `${name}.json`), 'utf8')) as ReplayScript;
  const errors = schema('replay-script')(script);
  if (errors.length > 0) throw new Error(`scripts/${name}.json does not fit the replay-script schema: ${formatError(errors[0])}`);
  return script;
}

const printable = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) => (item instanceof Uint8Array ? `<${item.byteLength} bytes>` : item), 2);

export interface ReplayOptions {
  /** Step index to the error code its invoke is answered with. Every other invoke must succeed, so a script cannot go wrong unnoticed. */
  refused?: Record<number, string>;
  /** Job states the simulator holds for less than one poll of the adapter. They are taken out of every recording, and the report says how many recordings showed each. */
  transient?: TransientState[];
  /** A script with a long wait in it says so. */
  timeoutMs?: number;
}

/**
 * Records one script RUNS times on the harness and writes its script, expectation and normalisation report into the
 * bundle, but only when every recording normalises to the same value.
 */
export function defineReplay(name: string, options: ReplayOptions = {}): void {
  test(`replay ${name}: ${RUNS} recordings normalise to one expectation`, { timeout: options.timeoutMs ?? 300_000 }, async () => {
    const out = resolveOut();
    const script = readScript(name);
    const invokes = script.steps.flatMap((step, index) => (step.op === 'invoke' ? [index] : []));
    const wanted = invokes.map((index) => options.refused?.[index] ?? 'ok');

    const runs: RawRun[] = [];
    for (let i = 0; i < RUNS; i += 1) {
      const run = await runScript(script, { transient: options.transient ?? [] });
      expect(run.answers, `recording ${i + 1}: what each invoke was answered with`).toEqual(wanted);
      runs.push(run);
    }

    const result = stabilise(runs);
    const report = {
      script: name,
      recordings: RUNS,
      clock: ORACLE_CLOCK,
      transient: options.transient ?? [],
      volatile: result.volatile,
      normalised: result.normalised,
      normalisedNotVolatile: result.normalisedNotVolatile,
      volatileNotNormalised: result.volatileNotNormalised,
    };
    if (!result.stable) {
      const kept = join(scratchBase(), `unstable-${name}`);
      mkdirSync(kept, { recursive: true });
      runs.forEach((run, i) => writeFileSync(join(kept, `recording-${i + 1}.json`), printable(run.value)));
      writeFileSync(join(kept, 'report.json'), printable({ ...report, structural: result.structural, unexplained: result.unexplained }));
      throw new Error(
        `${name}: the recordings do not normalise to one value. Differing shape at ${JSON.stringify(result.structural)}; differing values at ${JSON.stringify(result.unexplained)}. The recordings are in ${kept}.`,
      );
    }
    expect(result.volatileNotNormalised, 'a path that differed between recordings and that no rule changed').toEqual([]);
    expect(
      result.normalisedNotVolatile.filter((f) => !(f.rule === 'enc' && result.emptyEncColumns.includes(f.path))),
      'a rule changed a path the recordings agreed on, other than writing { present: false } for an empty *_enc column',
    ).toEqual([]);

    const errors = schema('replay-expectation')(result.value);
    expect(errors.map(formatError), 'the expectation against its schema').toEqual([]);

    writeArtefact(out, `l2/scripts/${name}.json`, script);
    writeArtefact(out, `l2/expected/${name}.json`, result.value);
    writeArtefact(out, `l2/normalisation/${name}.json`, report);
    for (const run of runs) rmSync(run.scratch, { recursive: true, force: true });
    try {
      rmdirSync(scratchBase());
    } catch {
      // another script's recordings are still in it
    }
  });
}
