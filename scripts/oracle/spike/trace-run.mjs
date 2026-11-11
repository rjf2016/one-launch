// Runs the built app with the recording variable set and reads what the hooks wrote to <dataDir>\oracle-trace.jsonl.
//   node scripts/oracle/spike/trace-run.mjs planted                        the redaction check through the real IPC; the first traced run of any session
//   node scripts/oracle/spike/trace-run.mjs <scenario> [--out=<folder>]    a committed fake-launcher scenario, traced; the raw trace is copied to <folder>
//   node scripts/oracle/spike/trace-run.mjs <scenario> --untraced          the same with the variable unset: no trace file may appear
//   node scripts/oracle/spike/trace-run.mjs packaged                       the packaged smoke run with the variable and a fake-launcher folder set: no trace file
// A raw trace holds scratch paths and generated ids, so --out must be outside the repo. Unpackaged runs need `npx electron-vite build`, packaged `npm run build`.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { materializeScenario, parseArgs, repoRoot, runScenario } from '../../app-driver.mjs';
import { compileSchema, formatError } from '../lib/json-schema.mjs';
import { Aliases } from '../lib/normalise.mjs';

const TRACE_ENV = 'ONELAUNCH_ORACLE_TRACE';
const TRACE_FILE = 'oracle-trace.jsonl';
const FAKE_ENV = 'ONELAUNCH_FAKE_LAUNCHERS';
const PLANTED = ['planted-placeholder-create', 'planted-placeholder-setpassword', 'planted-placeholder-vault', 'planted-placeholder-badpayload'];
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

const filesUnder = (dir) =>
  readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));
const tracesUnder = (dir) => filesUnder(dir).filter((f) => /oracle-trace/i.test(f));
const count = (items, key) => items.reduce((acc, item) => ({ ...acc, [key(item)]: (acc[key(item)] ?? 0) + 1 }), {});

function readTrace(d) {
  const file = join(d.dataDir, TRACE_FILE);
  if (!existsSync(file)) return null;
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Each app start numbers its events from 0, so one data folder's file holds one rising run per start. */
function runsOf(events) {
  const runs = [];
  for (const e of events) {
    if (e.seq === 0) runs.push([]);
    runs.at(-1)?.push(e);
  }
  return runs;
}

/** Every event against the `event` definition of the replay-expectation schema: as recorded, and with the job id aliased the way the normaliser will. */
function schemaFit(events) {
  const schema = JSON.parse(readFileSync(join(repoRoot, 'scripts', 'oracle', 'schemas', 'replay-expectation.schema.json'), 'utf8'));
  const validate = compileSchema({ $ref: '#/$defs/event', $defs: schema.$defs });
  const aliases = new Aliases();
  const misfits = (list) =>
    count(
      list.flatMap((e) => validate(e).map((err) => `${e.k}${e.op ? ` ${e.op}` : ''}: ${formatError(err)}`.replace(UUID, '<id>'))),
      (m) => m,
    );
  return { raw: misfits(events), aliased: misfits(events.map((e) => (e.k === 'job' ? { ...e, job: aliases.job(e.job) } : e))) };
}

function describeTrace(d, events) {
  const runs = runsOf(events);
  d.check(
    'seq starts at 0 and rises by one within each app start',
    runs.length > 0 && runs.every((run) => run.every((e, i) => e.seq === i)) && runs.flat().length === events.length,
    `${runs.length} start(s): ${runs.map((r) => r.length).join(', ')} events`,
  );
  console.log(`TRACE kinds ${JSON.stringify(count(events, (e) => e.k))}`);
  console.log(
    `TRACE plat ops ${JSON.stringify(
      count(
        events.filter((e) => e.k === 'plat'),
        (e) => e.op,
      ),
    )}`,
  );
  console.log(
    `TRACE ipc channels ${JSON.stringify(
      count(
        events.filter((e) => e.k === 'ipc'),
        (e) => e.channel,
      ),
    )}`,
  );
  console.log(
    `TRACE job states ${JSON.stringify(
      count(
        events.filter((e) => e.k === 'job'),
        (e) => e.state,
      ),
    )}`,
  );
  const kills = events.filter((e) => e.op === 'proc.kill');
  if (kills.length) console.log(`TRACE kills ${JSON.stringify(kills.map((e) => ({ exe: e.exe, tree: e.tree })))}`);
  const fit = schemaFit(events);
  console.log(`SCHEMA as recorded: ${JSON.stringify(fit.raw)}`);
  console.log(`SCHEMA with job ids aliased: ${JSON.stringify(fit.aliased)}`);
}

function copyOut(d, out) {
  if (!out) return;
  const target = resolve(out);
  const fromRepo = relative(repoRoot, target);
  if (!fromRepo.startsWith('..') && !isAbsolute(fromRepo)) throw new Error('--out must be outside the repo: a raw trace holds scratch paths and generated ids');
  mkdirSync(target, { recursive: true });
  for (const name of [TRACE_FILE, 'fake-platform.json']) if (existsSync(join(d.dataDir, name))) copyFileSync(join(d.dataDir, name), join(target, name));
  console.log(`TRACE copied to ${target}`);
}

/** An after() that throws is only logged by the runner; here it fails the run. */
const checked = (fn) => (d) => {
  try {
    fn(d);
  } catch (err) {
    d.check('the trace could be read', false, err instanceof Error ? err.message : String(err));
  }
};

const planted = {
  name: 'trace-planted',
  label: 'Planted-value redaction run',
  options: { fake: 'all-four' },
  before: (d) => {
    d.env[TRACE_ENV] = '1';
  },
  default: async (d) => {
    await d.shot('kick');
    await d.waitFor('Rocket League');
    const { account } = await d.invoke('accounts:create', { launcher: 'steam', displayName: 'Planted', login: 'planted_placeholder', password: PLANTED[0] });
    d.check('accounts:create stored the planted password', account.hasSecret === true);
    await d.invoke('accounts:setPassword', { id: account.id, password: PLANTED[1] });
    await d.invoke('vault:setSecret', { key: 'diagnostics.roundtrip', value: PLANTED[2] });
    const read = await d.invoke('vault:getSecret', { key: 'diagnostics.roundtrip' });
    d.check('vault:getSecret still answers the page with the stored value', read.value === PLANTED[2]);
    await d.invoke('vault:deleteSecret', { key: 'diagnostics.roundtrip' });
    for (const bad of [PLANTED[3], [PLANTED[3]]]) {
      const answer = await d.invokeRaw('accounts:setPassword', bad);
      d.check(`a ${Array.isArray(bad) ? 'list' : 'bare string'} payload is refused as before`, answer.ok === false && answer.error.code === 'BAD_REQUEST');
    }
    const copied = await d.invoke('accounts:copy', { id: account.id, field: 'password' });
    d.check('the password copy went to the fake clipboard', copied.clearAfterMs > 0 && d.fakeReport().clipboardWrites === 1);
    await d.invoke('autostart:set', { openAtLogin: true });
    await d.invoke('autostart:set', { openAtLogin: false });
    const code = await d.close();
    d.check('closing the window ends the app with exit code 0', code === 0, `code=${code}`);
    // A payload of the wrong shape is logged at ERROR by the registrar; those two lines are this run's own doing.
    d.assertNoErrorLines([/ipc accounts:setPassword failed \{"code":"BAD_REQUEST"/]);
  },
  after: checked((d) => {
    const events = readTrace(d);
    if (!d.check('the run left a trace file', events !== null && events.length > 0)) return;
    const holders = filesUnder(d.dataDir)
      .filter((f) => !relative(d.dataDir, f).startsWith('chromium'))
      .filter((f) => {
        const bytes = readFileSync(f);
        return PLANTED.some((p) => bytes.includes(p) || bytes.includes(Buffer.from(p, 'utf16le')));
      });
    d.check('no file in the data folder holds a planted value', holders.length === 0, holders.map((f) => relative(d.dataDir, f)).join(' '));
    const ipc = (channel) => events.filter((e) => e.k === 'ipc' && e.channel === channel);
    d.check(
      'accounts:create is recorded with the password masked',
      ipc('accounts:create').length === 1 && ipc('accounts:create')[0].req.password === '<redacted>',
    );
    const set = ipc('accounts:setPassword');
    d.check(
      'accounts:setPassword is recorded three times: the field masked, and both bad payloads masked whole',
      set.length === 3 && set[0].req.password === '<redacted>' && set[1].req === '<redacted>' && set[2].req === '<redacted>',
      JSON.stringify(set.map((e) => e.req)).replace(UUID, '<id>'),
    );
    d.check('vault:setSecret is recorded with the value masked', ipc('vault:setSecret').length === 1 && ipc('vault:setSecret')[0].req.value === '<redacted>');
    d.check(
      'vault:getSecret is recorded with the answer masked',
      ipc('vault:getSecret').length === 1 && ipc('vault:getSecret')[0].res.data.value === '<redacted>',
    );
    const ops = events.filter((e) => e.k === 'plat').map((e) => (e.op === 'login.set' ? `login.set:${e.openAtLogin}` : e.op));
    d.check(
      'the clipboard write, its clear at quit and both login-item sets are recorded, in order',
      JSON.stringify(ops.filter((op) => /^(clip|login)\./.test(op))) === JSON.stringify(['clip.write', 'login.set:true', 'login.set:false', 'clip.clear']),
      ops.join(' '),
    );
    describeTrace(d, events);
  }),
};

async function scenario(name, { traced, out }) {
  const mod = await import(pathToFileURL(join(repoRoot, 'scripts', 'scenarios', `${name}.mjs`)).href);
  return {
    ...mod,
    name: `trace-${name}`,
    label: `Scenario ${name}, ${traced ? 'traced' : 'variable unset'}`,
    before: async (d) => {
      if (traced) d.env[TRACE_ENV] = '1';
      else delete process.env[TRACE_ENV];
      await mod.before?.(d);
    },
    after: async (d) => {
      await mod.after?.(d);
      checked((dd) => {
        if (!traced) {
          const found = tracesUnder(dd.scratch);
          dd.check('the run left no trace file anywhere in its scratch folder', found.length === 0, found.map((f) => relative(dd.scratch, f)).join(' '));
          return;
        }
        const events = readTrace(dd);
        if (!dd.check('the run left a trace file', events !== null && events.length > 0)) return;
        describeTrace(dd, events);
        copyOut(dd, out);
      })(d);
    },
  };
}

async function packaged() {
  const mod = await import(pathToFileURL(join(repoRoot, 'scripts', 'scenarios', 'packaged-smoke.mjs')).href);
  const fakeDir = mkdtempSync(join(tmpdir(), 'onelaunch-spike-fake-'));
  materializeScenario('all-four', fakeDir);
  return {
    ...mod,
    label: 'Packaged build with the recording variable and a fake-launcher folder set',
    before: (d) => {
      d.env[TRACE_ENV] = '1';
      d.env[FAKE_ENV] = fakeDir;
    },
    after: checked((d) => {
      rmSync(fakeDir, { recursive: true, force: true });
      const env = d.childEnv();
      d.check('the app was started with both variables set', env[TRACE_ENV] === '1' && env[FAKE_ENV] === fakeDir);
      d.check('the log says the platform is the real one', d.readLog().includes('"platformSource":"real"'));
      const found = tracesUnder(d.scratch);
      d.check('the packaged build left no trace file anywhere in its scratch folder', found.length === 0, found.map((f) => relative(d.scratch, f)).join(' '));
      d.check('and no fake-platform.json either', !existsSync(join(d.dataDir, 'fake-platform.json')));
    }),
  };
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const what = positional[0];
if (!what || !/^[a-z-]+$/.test(what)) {
  console.error('usage: node scripts/oracle/spike/trace-run.mjs planted | packaged | <scenario> [--untraced] [--out=<folder>]');
  process.exit(2);
}
const mod =
  what === 'planted'
    ? planted
    : what === 'packaged'
      ? await packaged()
      : await scenario(what, { traced: !flags.untraced, out: typeof flags.out === 'string' ? flags.out : null });
const { failures } = await runScenario(mod, what === 'packaged' ? { packaged: true } : { fake: mod.options?.fake ?? true });
process.exit(failures === 0 ? 0 : 1);
