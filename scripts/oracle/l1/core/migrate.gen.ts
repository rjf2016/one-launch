import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { adversarial, fromTest, vectorFile, type Case } from '../lib/index';
import { repoRoot } from '../../lib/out.mjs';
import { MIGRATIONS } from '../../../../src/main/db/migrations/index';
import { migrate, openDatabase, type Db } from '../../../../src/main/db/index';

const SCRATCH = resolve(process.env['T03_CORE_SCRATCH'] ?? join(repoRoot, '..', 'oracle-scratch', 't03-core'), `migrate-work-${process.pid}`);
const TESTS = 'test/db.test.ts';

const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function dump(db: Db): unknown {
  const master = (
    db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master').all() as { type: string; name: string; tbl_name: string; sql: string | null }[]
  ).sort((a, b) => byCodeUnits(a.type, b.type) || byCodeUnits(a.name, b.name));
  const tables: Record<string, unknown> = {};
  for (const name of master.filter((row) => row.type === 'table').map((row) => row.name)) {
    const quoted = `"${name.replace(/"/g, '""')}"`;
    tables[name] = {
      table_info: db.pragma(`table_info(${quoted})`),
      index_list: db.pragma(`index_list(${quoted})`),
      foreign_key_list: db.pragma(`foreign_key_list(${quoted})`),
    };
  }
  return { user_version: db.pragma('user_version', { simple: true }), master, tables };
}

let serial = 0;

function schemaAt(target: number, from = 0): unknown {
  mkdirSync(SCRATCH, { recursive: true });
  const file = join(SCRATCH, `case-${++serial}.db`);
  const db = openDatabase(file);
  try {
    const steps = [];
    if (from > 0) steps.push(migrate(db, MIGRATIONS.slice(0, from)));
    steps.push(migrate(db, MIGRATIONS.slice(0, target)));
    return { migrations: steps, schema: dump(db) };
  } finally {
    db.close();
    rmSync(SCRATCH, { recursive: true, force: true });
  }
}

const step = (target: number): Case => ({
  id: `fresh-to-v${target}`,
  origin:
    target === MIGRATIONS.length
      ? fromTest(TESTS, 'migrations', 'applies all migrations to a fresh database and is idempotent')
      : adversarial('other', `a fresh database migrated through version ${target} only, the per-step dump`),
  args: [target],
  expect: 'out',
});

vectorFile({
  area: 'core',
  function: 'migrate',
  source: 'src/main/db/index.ts',
  note: [
    'A recorded schema dump, not a function to port: opening a database is not pure. The Rust port runs its own migrations on a fresh file and compares the dump.',
    "arg0 is the target version, arg1 (optional) a version to migrate to first. call opens a new SQLite file in a scratch folder with openDatabase (the app's own open: WAL, foreign_keys ON, quick_check), runs migrate(db, MIGRATIONS.slice(0, arg1)) when arg1 is given and then migrate(db, MIGRATIONS.slice(0, arg0)), dumps the schema, closes the database and deletes the folder. The result is { migrations: [each MigrationResult in order], schema }.",
    'schema is { user_version, master, tables }: every sqlite_master row (type, name, tbl_name, sql) sorted by type then name in UTF-16 code-unit order, and per table PRAGMA table_info, index_list and foreign_key_list. The dump is the one takeover/migrations/v<n>.json holds (M0-T11, same method: a fresh file per step, MIGRATIONS.slice(0, n)), without its step field.',
    'Errors: a database at a version above the list it is given throws DatabaseTooNewError (code DB_TOO_NEW, found, supported). validateMigrations and the foreign-key rebuild guards are reached only with migration lists the app never has; db.ts is a stateful service hand-translated with test/db.test.ts.',
    'gap: src/main/db/index.ts:177:33 if arm, a throw (migrations not contiguous), and 180:66 if arm, a throw (malformed migration): MIGRATIONS is fixed and well formed.',
    'gap: src/main/db/index.ts:162:60 if arm, a throw (foreign keys not switched off, migrate inside a transaction), and 167:31 if arm, a throw (orphaned rows): neither happens on a fresh database with the app own migrations.',
  ].join('\n'),
  call: (target: number, from?: number) => schemaAt(target, from),
  cases: [
    ...Array.from({ length: MIGRATIONS.length + 1 }, (_, v) => step(v)),
    {
      id: 'step-by-step-to-v5',
      origin: fromTest(TESTS, 'migrations', 'applies all migrations to a fresh database and is idempotent | v3 first, then the rest'),
      args: [5, 3],
      expect: 'out',
    },
    { id: 'v4-then-v5', origin: adversarial('other', 'migration 5 alone on a v4 database'), args: [5, 4], expect: 'out' },
    {
      id: 'idempotent-v5',
      origin: fromTest(TESTS, 'migrations', 'applies all migrations to a fresh database and is idempotent | migrate run twice'),
      args: [5, 5],
      expect: 'out',
    },
    { id: 'beyond-list', origin: adversarial('other', 'a target past the last migration applies all five'), args: [9], expect: 'out' },
    {
      id: 'too-new',
      origin: fromTest(TESTS, 'migrations', 'refuses a database written by a newer version | a v5 database given only the first three migrations'),
      args: [3, 5],
      expect: 'error',
    },
  ],
});
