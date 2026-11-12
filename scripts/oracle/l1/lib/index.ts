import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'vitest';
import { listFiles, sha256 } from '../../lib/bundle.mjs';
import { ORACLE_CLOCK } from '../../lib/clock.mjs';
import { compileSchema, formatError } from '../../lib/json-schema.mjs';
import { DEFAULT_OUT, resolveOut, writeArtefact } from '../../lib/out.mjs';
import { decodeValue, encodeValue, errorRecord, type Encoded } from './encode';
import { mutate, MUTATION_NAMES, Rng, type MutationName, type TextEncoding } from './corpus';
import { ADVERSARIAL, AREAS, formatHeader, ID, INLINE_MAX, NAME, parseOrigin } from './grammar.mjs';

export { EncodeError, encodeValue } from './encode';
export { MUTATIONS, MUTATION_NAMES, mutate, Rng, type MutationName, type TextEncoding } from './corpus';
export { INLINE_MAX } from './grammar.mjs';

export type Decoder = 'bytes' | 'utf8' | 'utf8+strip-bom' | 'utf16le' | 'utf16le+strip-bom' | 'latin1';
export type OriginKind = 'fixture' | 'test' | 'corpus' | 'adversarial';
export type AdversarialClass = (typeof ADVERSARIAL)[number];

export interface Origin {
  kind: OriginKind;
  ref: string;
}

export interface Case {
  id: string;
  origin: Origin;
  args: unknown[];
  expect?: 'out' | 'error';
}

export interface VectorFile {
  area: string;
  function: string;
  source: string;
  name?: string;
  decode?: Record<number, Decoder>;
  clock?: boolean;
  note: string;
  call: (...args: any[]) => unknown;
  cases: Case[] | (() => Case[] | Promise<Case[]>);
}

const MARK = Symbol('l1-input');

interface FileInput {
  [MARK]: 'file';
  path: string;
}
interface BytesInput {
  [MARK]: 'bytes';
  bytes: Buffer;
}
interface GeneratedInput {
  [MARK]: 'input';
  area: string;
  name: string;
  bytes: Buffer;
}
export type Input = FileInput | BytesInput | GeneratedInput;

const isInput = (value: unknown): value is Input => typeof value === 'object' && value !== null && MARK in value;

export const BUNDLE_ENV = 'ORACLE_BUNDLE';
export const bundleRoot = (): string => resolve(process.env[BUNDLE_ENV] ?? DEFAULT_OUT);

function bundlePath(path: string): string {
  if (!/^[^/\\]+(\/[^/\\]+)*$/.test(path) || path.split('/').includes('..')) throw new Error(`${path}: not a bundle path (relative, forward slashes)`);
  if (path.startsWith('l1/')) throw new Error(`${path}: an input under l1/ is made by input(), never read back with file()`);
  return join(bundleRoot(), path);
}

export function bundleBytes(path: string): Buffer {
  const at = bundlePath(path);
  if (!existsSync(at)) throw new Error(`${path} is not in the bundle at ${BUNDLE_ENV} (or the default bundle)`);
  return readFileSync(at);
}

export function file(path: string): FileInput {
  bundleBytes(path);
  return { [MARK]: 'file', path };
}

export function bytes(data: Uint8Array | readonly number[]): BytesInput {
  const buffer = Buffer.from(data as Uint8Array);
  if (buffer.length > INLINE_MAX) throw new Error(`${buffer.length} bytes is over the inline limit of ${INLINE_MAX}; use input()`);
  return { [MARK]: 'bytes', bytes: buffer };
}

export const text = (value: string, encoding: 'utf8' | 'utf16le' | 'latin1' = 'utf8'): BytesInput => {
  if (!value.isWellFormed()) throw new Error('text() takes well-formed strings; build bytes() for a lone surrogate');
  return bytes(Buffer.from(value, encoding));
};

export function input(area: string, name: string, data: Uint8Array): GeneratedInput {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(name)) throw new Error(`input name ${name}: letters, digits, . _ - and / only`);
  if (/\.json$/i.test(name)) throw new Error(`input name ${name}: never .json, every l1/**/*.json is read as a vector file`);
  return { [MARK]: 'input', area, name, bytes: Buffer.from(data) };
}

export const fixture = (path: string, change?: string): Origin => origin('fixture', change ? `${path} | ${change}` : path);
export const fromTest = (file: string, ...titles: string[]): Origin => origin('test', [file, ...titles].join(' > '));
export const adversarial = (kind: AdversarialClass, what: string): Origin => origin('adversarial', `${kind}: ${what}`);

function origin(kind: OriginKind, ref: string): Origin {
  parseOrigin({ kind, ref });
  return { kind, ref };
}

export interface CorpusSpec {
  seed: number;
  count: number;
  from: { path: string; bytes?: Buffer }[];
  args: (mutated: BytesInput) => unknown[];
  ops?: readonly MutationName[];
  steps?: [number, number];
  encoding?: TextEncoding;
  prefix?: string;
}

const caseSeed = (seed: number, index: number): number => (Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) + Math.imul(index + 1, 0xc2b2ae35)) >>> 0;

export function corpus(spec: CorpusSpec): Case[] {
  const ops = spec.ops ?? MUTATION_NAMES;
  const [min, max] = spec.steps ?? [1, 3];
  const bases = spec.from.map((base) => ({ path: base.path, bytes: base.bytes ?? bundleBytes(base.path) }));
  const prefix = spec.prefix ?? 'corpus';
  return Array.from({ length: spec.count }, (_, index) => {
    const rng = new Rng(caseSeed(spec.seed, index));
    const base = rng.pick(bases);
    const { bytes: mutated, applied } = mutate(base.bytes, rng, ops, rng.between(min, max), spec.encoding ?? 'utf8');
    return {
      id: `${prefix}-${spec.seed}-${index}`,
      origin: origin('corpus', `seed=${spec.seed} index=${index} ops=${applied.join(',')} from=${base.path}`),
      args: spec.args(bytes(mutated)),
    };
  });
}

const schema = compileSchema(JSON.parse(readFileSync(new URL('../../schemas/vector.schema.json', import.meta.url), 'utf8')));
const clockInstalled = (): boolean => Boolean((Date as unknown as Record<symbol, unknown>)[Symbol.for('one-launch.oracle-clock')]);
const generatedInputs = new Map<string, string>();

function decodeArg(value: unknown, decoder: Decoder | undefined, where: string): unknown {
  if (decoder === undefined) {
    if (Buffer.isBuffer(value)) throw new Error(`${where} is bytes; declare decode for it ('bytes' or an encoding)`);
    return value;
  }
  if (!Buffer.isBuffer(value)) throw new Error(`${where} is declared ${decoder} but is not bytes`);
  if (decoder === 'bytes') return value;
  const [encoding, strip] = decoder.split('+') as [BufferEncoding, string | undefined];
  const decoded = value.toString(encoding);
  return strip ? decoded.replace(/^﻿/, '') : decoded;
}

async function build(spec: VectorFile, out: string): Promise<Record<string, unknown>> {
  if (!AREAS.includes(spec.area) && spec.area !== 'example') throw new Error(`area ${spec.area} is not one of ${AREAS.join(', ')}`);
  const name = spec.name ?? spec.function;
  if (!NAME.test(name)) throw new Error(`vector name ${name}: letters, digits, . _ - only`);
  if (!spec.note || spec.note.trim() === '') throw new Error(`${name}: the note says what the vector is`);
  if (spec.clock && !clockInstalled()) throw new Error(`${name}: clock is set, so import ../../lib/clock.setup.mjs before the app code`);
  const decode = spec.decode ?? {};
  const header = formatHeader({ decode, clock: spec.clock ? ORACLE_CLOCK : null });
  const cases = typeof spec.cases === 'function' ? await spec.cases() : spec.cases;
  const seen = new Set<string>();
  const written: Record<string, unknown>[] = [];

  for (const item of cases) {
    if (!ID.test(item.id)) throw new Error(`${name}: case id ${item.id} does not match ${ID}`);
    if (seen.has(item.id)) throw new Error(`${name}: case id ${item.id} is used twice`);
    seen.add(item.id);
    parseOrigin(item.origin);
    const where = `${name}/${item.id}`;
    const files = new Map<string, Buffer>();
    const hook = (value: unknown, path: string): Encoded | undefined => {
      if (value instanceof Uint8Array) {
        if (value.length > INLINE_MAX) throw new Error(`${where}${path}: ${value.length} bytes is over the inline limit of ${INLINE_MAX}; use input()`);
        return undefined;
      }
      if (!isInput(value)) return undefined;
      if (value[MARK] === 'bytes') return { $bytes: value.bytes.toString('base64') };
      if (value[MARK] === 'file') {
        const data = bundleBytes(value.path);
        files.set(value.path, data);
        return { $file: value.path, sha256: sha256(data) };
      }
      if (value.area !== spec.area) throw new Error(`${where}${path}: input() for area ${value.area} in a ${spec.area} vector`);
      const rel = `l1/${value.area}/files/${value.name}`;
      const digest = sha256(value.bytes);
      if (generatedInputs.has(rel) && generatedInputs.get(rel) !== digest) throw new Error(`${rel} is made twice with different bytes`);
      if (!generatedInputs.has(rel)) writeArtefact(out, rel, value.bytes);
      generatedInputs.set(rel, digest);
      files.set(rel, value.bytes);
      return { $file: rel, sha256: digest };
    };
    const args = encodeValue(item.args, 'args', hook) as Encoded[];
    const live = (decodeValue(args, (path) => files.get(path)!) as unknown[]).map((value, i) => decodeArg(value, decode[i], `${where} arg${i}`));

    const record: Record<string, unknown> = { id: item.id, origin: { kind: item.origin.kind, ref: item.origin.ref }, args };
    let result: unknown;
    let threw = false;
    try {
      result = spec.call(...live);
      if (result !== null && typeof result === 'object' && typeof (result as { then?: unknown }).then === 'function') result = await result;
    } catch (error) {
      threw = true;
      result = error;
    }
    if (item.expect && item.expect !== (threw ? 'error' : 'out')) {
      const detail = threw && result instanceof Error ? `${result.name}: ${result.message}` : 'a value';
      throw new Error(`${where}: expected ${item.expect === 'out' ? 'a value' : 'an error'}, got ${detail}`);
    }
    if (threw) record.error = errorRecord(result, 'error');
    else record.out = encodeValue(result, 'out');
    written.push(record);
  }

  const value = { function: spec.function, source: spec.source, note: `${header}\n${spec.note.trim()}`, cases: written };
  const errors = schema(value);
  if (errors.length > 0) throw new Error(`${name}: not a valid vector file:\n${errors.slice(0, 10).map(formatError).join('\n')}`);
  return value;
}

export function vectorFile(spec: VectorFile): void {
  const rel = `l1/${spec.area}/${spec.name ?? spec.function}.json`;
  test(rel, async () => {
    const out = resolveOut([]);
    writeArtefact(out, rel, await build(spec, out));
  });
}

export const listBundle = (dir: string): string[] => listFiles(bundlePath(dir)).map((path) => `${dir}/${path}`);
