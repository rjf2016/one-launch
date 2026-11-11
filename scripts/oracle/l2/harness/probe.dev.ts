// One recording of one script, summarised for whoever is writing it: what each invoke was answered with, the job states
// and platform operations in order, and the WARN and ERROR lines. The summary holds scratch paths and generated ids, so
// it goes to the scratch folder and nowhere else.
//   ORACLE_GENERATOR=scripts/oracle/l2/harness/probe.dev.ts ORACLE_L2_SCRIPT=<name> npx vitest run --config scripts/oracle/vitest.config.ts
import '../../lib/clock.setup.mjs';
import './electron-mock';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'vitest';
import { readScript } from './define';
import { runScript, scratchBase } from './runner';

const name = process.env['ORACLE_L2_SCRIPT'] ?? 'play-steam';
const bytes = (_key: string, value: unknown): unknown => (value instanceof Uint8Array ? `<${value.byteLength} bytes>` : value);

interface Reply {
  ok: boolean;
  data?: { preflight?: Record<string, unknown> & { plan: { warnings: string[] } }; job?: { state: string; direct: boolean } };
  error?: { code: string; message: string };
}

function short(reply: Reply): string {
  if (!reply.ok) return `REFUSED ${reply.error?.code}: ${reply.error?.message}`;
  const pf = reply.data?.preflight;
  if (pf) {
    return `ok needsConfirmation=${pf['needsConfirmation']} alreadyActive=${pf['alreadyActive']} running=${pf['launcherRunning']} blocked=${pf['blocked']} dryRun=${pf['dryRun']} warnings=${pf.plan.warnings.length}`;
  }
  if (reply.data?.job) return `ok job ${reply.data.job.state} direct=${reply.data.job.direct}`;
  return `ok ${(JSON.stringify(reply.data, bytes) ?? '').slice(0, 200)}`;
}

test(`probe ${name}`, { timeout: 600_000 }, async () => {
  const script = readScript(name);
  const run = await runScript(script);
  const lines: string[] = [];
  let reply = 0;
  script.steps.forEach((step, i) => {
    lines.push(step.op === 'invoke' ? `step ${i} ${step.channel} -> ${short(run.replies[reply++] as Reply)}` : `step ${i} ${JSON.stringify(step)}`);
  });
  lines.push('');
  const before = new Map<string, string[][]>();
  for (const event of run.value.events) {
    if (event['k'] === 'job') {
      const id = event['job'] as string;
      const steps = event['steps'] as string[][];
      const prev = before.get(id);
      before.set(id, steps);
      const shown = prev
        ? steps
            .filter((s, i) => prev[i]?.[1] !== s[1] || prev[i]?.[3] !== s[3])
            .map((s) => `${s[0]}:${s[1]}(${s[3]!.slice(0, 80)})`)
            .join(' ')
        : steps.map((s) => `${s[0]}:${s[1]}`).join(' ');
      lines.push(
        `${event['seq']} job ${run.ids.get(id)} ${event['state']} [${shown}] att=${event['attention'] ? 'yes' : 'no'} sw=${event['switched']} bk=${event['backupId'] ? 'y' : 'n'} rest=${event['restored']} handOff=${event['handOff']} err=${event['error']}`,
      );
    } else {
      const { seq, k: _k, projectionSha256: _p, sha256: _s, ...rest } = event;
      lines.push(`${seq} ${JSON.stringify(rest).slice(0, 240)}`);
    }
  }
  const log = run.value.final['log'] as { warn: string[]; error: string[] };
  lines.push('', 'LOG', ...log.warn, ...log.error);
  const base = scratchBase();
  writeFileSync(join(base, `probe-${name}.txt`), lines.join('\n'));
  writeFileSync(join(base, `probe-${name}.json`), JSON.stringify(run.value, bytes, 2));
});
