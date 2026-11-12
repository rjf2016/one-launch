import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { test } from 'vitest';
import { DEFAULT_OUT, repoRoot, resolveOut, writeArtefact } from '../lib/out.mjs';
import { MIGRATIONS } from '../../../src/main/db/migrations/index';
import { migrate, openDatabase, type Db } from '../../../src/main/db/index';

const SCRATCH = resolve(process.env['T11_SCRATCH'] ?? join(repoRoot, '..', 'oracle-scratch', 't11'), 'migrations-work');
const OLDEST = 'fixtures/db/onelaunch-v1-oldest.db';

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

function withDatabase<T>(file: string, run: (db: Db) => T): T {
  const db = openDatabase(file);
  try {
    return run(db);
  } finally {
    db.close();
  }
}

test('schema after each migration step', () => {
  const out = resolveOut();
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
  try {
    const steps: unknown[] = [];
    for (const m of MIGRATIONS) {
      const file = join(SCRATCH, `step-v${m.version}.db`);
      const schema = withDatabase(file, (db) => {
        const result = migrate(db, MIGRATIONS.slice(0, m.version));
        if (result.to !== m.version) throw new Error(`step ${m.version} ended at ${result.to}`);
        return dump(db);
      });
      steps.push(schema);
      writeArtefact(out, `takeover/migrations/v${m.version}.json`, { step: `${m.version}_${m.name}`, ...(schema as object) });
    }

    const copy = join(SCRATCH, 'onelaunch-v1-oldest.db');
    copyFileSync(join(DEFAULT_OUT, OLDEST), copy);
    const migrated = withDatabase(copy, (db) => {
      const result = migrate(db);
      return { result, schema: dump(db) };
    });
    const fresh = steps[steps.length - 1];
    writeArtefact(out, 'takeover/migrations/v1-oldest-migrated.json', {
      source: OLDEST,
      migration: migrated.result,
      equalsFreshV5: isDeepStrictEqual(migrated.schema, fresh),
      ...(migrated.schema as object),
    });
  } finally {
    rmSync(SCRATCH, { recursive: true, force: true });
  }
});
