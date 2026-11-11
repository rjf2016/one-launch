import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SCHEMA_NAMES, SCHEMA_SOURCE, schemaFile } from './lib/bundle.mjs';
import { compileSchema } from './lib/json-schema.mjs';
import { resolveOut, writeArtefact } from './lib/out.mjs';

const out = resolveOut();
const wanted = new Set(SCHEMA_NAMES.map(schemaFile));
for (const file of wanted) {
  const source = readFileSync(join(SCHEMA_SOURCE, file));
  compileSchema(JSON.parse(source.toString('utf8')));
  writeArtefact(out, `schemas/${file}`, source);
}
const dir = join(out, 'schemas');
for (const entry of readdirSync(dir)) if (!wanted.has(entry)) rmSync(join(dir, entry), { recursive: true });
console.log(`${wanted.size} schemas written to ${dir}`);
