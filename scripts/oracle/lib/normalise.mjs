import { createHash } from 'node:crypto';
import { pathPattern } from './path-pattern.mjs';

export const TS = '<ts>';
export const MS = '<ms>';

const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}[:-]\d{2}[:-]\d{2}(?:\.\d{1,3})?Z/g;
const MS_KEY = /(?:^ms|Ms|_ms)$/;
const ENC_KEY = /_enc$/;
const ALIAS = /^@[a-z]+:\S(?:.*\S)?$/;

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const segment = (key) => key.replace(/~/g, '~0').replace(/\//g, '~1');
const isPlain = (value) => {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};
const isBufferJson = (value) => isPlain(value) && value.type === 'Buffer' && Array.isArray(value.data) && Object.keys(value).length === 2;

export class Aliases {
  #byId = new Map();
  #byAlias = new Map();
  #counters = new Map();
  #pattern = null;

  set(id, alias) {
    if (typeof id !== 'string' || id.length < 8) throw new Error(`${alias}: an aliased id is a string of at least 8 characters`);
    if (!ALIAS.test(alias)) throw new Error(`not an alias: ${alias}`);
    const known = this.#byId.get(id);
    if (known !== undefined) {
      if (known !== alias) throw new Error(`${alias}: that id is already aliased as ${known}`);
      return alias;
    }
    if (this.#byAlias.has(alias)) throw new Error(`${alias} already names another id`);
    this.#byId.set(id, alias);
    this.#byAlias.set(alias, id);
    this.#pattern = null;
    return alias;
  }

  named(kind, id, ...parts) {
    if (parts.length === 0 || parts.some((part) => typeof part !== 'string' || part === ''))
      throw new Error(`@${kind}: every alias part is a non-empty string`);
    return this.set(id, `@${kind}:${parts.join(':')}`);
  }

  sequence(kind, id, ...scope) {
    const prefix = `@${[kind, ...scope].join(':')}:`;
    const known = this.#byId.get(id);
    if (known !== undefined) {
      if (!known.startsWith(prefix) || !/^\d+$/.test(known.slice(prefix.length))) throw new Error(`${prefix}n: that id is already aliased as ${known}`);
      return known;
    }
    const n = (this.#counters.get(prefix) ?? 0) + 1;
    const alias = this.set(id, `${prefix}${n}`);
    this.#counters.set(prefix, n);
    return alias;
  }

  account(id, launcher, login) {
    return this.named('acct', id, launcher, login);
  }

  game(id, launcher, launcherGameId) {
    return this.named('game', id, launcher, launcherGameId);
  }

  job(id) {
    return this.sequence('job', id);
  }

  backup(id, launcher) {
    return this.sequence('backup', id, launcher);
  }

  get(id) {
    return this.#byId.get(id) ?? null;
  }

  get size() {
    return this.#byId.size;
  }

  apply(text) {
    if (this.#byId.size === 0) return text;
    if (this.#pattern === null) {
      const ids = [...this.#byId.keys()].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
      this.#pattern = new RegExp(`(?<![0-9A-Za-z])(?:${ids.map(escape).join('|')})(?![0-9A-Za-z])`, 'g');
    }
    return text.replace(this.#pattern, (id) => this.#byId.get(id));
  }
}

function rootRules(roots) {
  return Object.entries(roots)
    .map(([name, path]) => {
      if (!/^[a-z][A-Za-z]*$/.test(name)) throw new Error(`root name ${JSON.stringify(name)}: letters only, lower-case first`);
      if (typeof path !== 'string' || !/^[A-Za-z]:[\\/]/.test(path)) throw new Error(`root {${name}} must be an absolute Windows path`);
      return { path, placeholder: `{${name}}`, pattern: new RegExp(pathPattern(path), 'gi') };
    })
    .sort((a, b) => b.path.length - a.path.length);
}

const sortFields = (fields) => [...fields].sort((a, b) => (a.path === b.path ? (a.rule < b.rule ? -1 : 1) : a.path < b.path ? -1 : 1));

// <ts> and <ms> apply only at the paths in `volatile` (from measureVolatile), so a fixed timestamp or timing is never masked.
export function createNormaliser({ roots = {}, aliases = new Aliases(), vault = null, volatile = [] } = {}) {
  const rules = rootRules(roots);
  const volatilePaths = new Set(volatile);
  const fields = new Map();
  const note = (path, rule) => fields.set(`${path}\u0000${rule}`, { path, rule });

  const text = (value, path) => {
    let out = value;
    for (const rule of rules) out = out.replace(rule.pattern, rule.placeholder);
    if (out !== value && path !== null) note(path, 'root');
    const aliased = aliases.apply(out);
    if (aliased !== out && path !== null) note(path, 'alias');
    return aliased;
  };

  const project = (value, path) => {
    note(path, 'enc');
    if (value === null) return { present: false, plaintextSha256: null };
    if (!vault) throw new Error(`${path}: an *_enc value needs the harness vault to project`);
    const bytes = Buffer.from(value instanceof Uint8Array ? value : value.data);
    return { present: true, plaintextSha256: createHash('sha256').update(vault.decrypt(bytes), 'utf8').digest('hex') };
  };

  const walk = (value, path, key) => {
    if (key !== null && ENC_KEY.test(key)) {
      if (value === null || value instanceof Uint8Array || (typeof value === 'object' && isBufferJson(value))) return project(value, path);
      throw new Error(`${path}: an *_enc value is bytes or null`);
    }
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error(`${path}: not a JSON number`);
      if (volatilePaths.has(path) && key !== null && MS_KEY.test(key)) {
        note(path, 'ms');
        return MS;
      }
      return value;
    }
    if (typeof value === 'string') {
      const out = text(value, path);
      if (!volatilePaths.has(path)) return out;
      const stamped = out.replace(ISO_TIMESTAMP, TS);
      if (stamped !== out) note(path, 'ts');
      return stamped;
    }
    if (Array.isArray(value)) return value.map((item) => walk(item, `${path}/*`, key));
    if (typeof value !== 'object' || value instanceof Uint8Array || !isPlain(value)) throw new Error(`${path}: not a JSON value`);
    const out = {};
    for (const [name, item] of Object.entries(value)) {
      if (item === undefined) continue;
      const renamed = text(name, null);
      const next = `${path}/${segment(renamed)}`;
      if (renamed !== name) note(next, 'key');
      if (Object.hasOwn(out, renamed)) throw new Error(`${next}: two keys normalise to the same name`);
      out[renamed] = walk(item, next, name);
    }
    return out;
  };

  return {
    normalise: (value) => walk(value, '', null),
    text: (value) => text(value, null),
    fields: () => sortFields(fields.values()),
  };
}

const kindOf = (value) => (value === null ? 'null' : Array.isArray(value) ? 'array' : value instanceof Uint8Array ? 'bytes' : typeof value);

export function measureVolatile(recordings) {
  if (!Array.isArray(recordings) || recordings.length < 2) throw new Error('measuring what varies takes at least two recordings');
  const volatile = new Set();
  const structural = new Set();

  const visit = (items, path) => {
    const kind = kindOf(items[0]);
    if (items.some((item) => kindOf(item) !== kind)) {
      structural.add(path);
      return;
    }
    if (kind === 'array') {
      if (items.some((item) => item.length !== items[0].length)) {
        structural.add(path);
        return;
      }
      items[0].forEach((_, i) =>
        visit(
          items.map((item) => item[i]),
          `${path}/*`,
        ),
      );
      return;
    }
    if (kind === 'object') {
      const keys = Object.keys(items[0]).sort();
      if (items.some((item) => Object.keys(item).sort().join('\u0000') !== keys.join('\u0000'))) {
        structural.add(path);
        return;
      }
      for (const key of keys)
        visit(
          items.map((item) => item[key]),
          `${path}/${segment(key)}`,
        );
      return;
    }
    const same = kind === 'bytes' ? (item) => Buffer.compare(item, items[0]) === 0 : (item) => item === items[0];
    if (!items.every(same)) volatile.add(path);
  };

  visit(recordings, '');
  return { volatile: [...volatile].sort(), structural: [...structural].sort() };
}

export function normaliseRuns(runs) {
  if (!Array.isArray(runs) || runs.length < 2) throw new Error('normalising takes at least two recordings of the same script');
  const pass = (volatile) =>
    runs.map(({ value, roots, aliases, vault }) => {
      const normaliser = createNormaliser({ roots, aliases, vault, volatile });
      return { value: normaliser.normalise(value), fields: normaliser.fields() };
    });
  const measured = measureVolatile(pass([]).map((run) => run.value));
  const final = pass(measured.volatile);
  const left = measureVolatile(final.map((run) => run.value));
  const fields = new Map();
  for (const run of final) for (const field of run.fields) fields.set(`${field.path}\u0000${field.rule}`, field);
  const structural = [...new Set([...measured.structural, ...left.structural])].sort();
  return {
    value: final[0].value,
    fields: sortFields(fields.values()),
    volatile: measured.volatile,
    structural,
    unexplained: left.volatile,
    stable: structural.length === 0 && left.volatile.length === 0,
  };
}
