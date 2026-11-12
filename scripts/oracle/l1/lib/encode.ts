export type Encoded = null | boolean | number | string | Encoded[] | { [key: string]: Encoded };

export class EncodeError extends Error {
  readonly path: string;

  constructor(path: string, what: string) {
    super(`${path}: ${what} cannot be recorded; project it explicitly in the generator and say so in the note`);
    this.name = 'EncodeError';
    this.path = path;
  }
}

const SPECIAL: [number, string][] = [
  [NaN, 'NaN'],
  [Infinity, 'Infinity'],
  [-Infinity, '-Infinity'],
];

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value !== 'object') return `a ${typeof value}`;
  const name = (Object.getPrototypeOf(value) as { constructor?: { name?: string } } | null)?.constructor?.name;
  return name ? `a ${name}` : 'an object';
}

function isPlain(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === null || proto === Object.prototype;
}

// Assignment would run the __proto__ setter and lose a key of that name; a defined property keeps it as data.
function put<T>(target: { [key: string]: T }, key: string, value: T): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

export const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');

export type Hook = (value: unknown, path: string) => Encoded | undefined;

export function encodeValue(value: unknown, path: string, hook?: Hook): Encoded {
  const hooked = hook?.(value, path);
  if (hooked !== undefined) return hooked;
  if (value === undefined) return { $undefined: true };
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Object.is(value, -0)) return { $number: '-0' };
    for (const [special, name] of SPECIAL) if (Object.is(value, special)) return { $number: name };
    return value;
  }
  if (typeof value === 'string') {
    if (value.isWellFormed()) return value;
    return { $utf16: Array.from({ length: value.length }, (_, i) => value.charCodeAt(i)) };
  }
  if (typeof value !== 'object') throw new EncodeError(path, describe(value));
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new EncodeError(path, 'an invalid Date');
    if (Object.getPrototypeOf(value) !== Date.prototype) throw new EncodeError(path, describe(value));
    return { $date: value.toISOString() };
  }
  if (value instanceof Uint8Array) {
    const proto = Object.getPrototypeOf(value) as unknown;
    if (proto !== Uint8Array.prototype && proto !== Buffer.prototype) throw new EncodeError(path, describe(value));
    return { $bytes: toBase64(value) };
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw new EncodeError(path, describe(value));
    const out: Encoded[] = [];
    for (let i = 0; i < value.length; i += 1) {
      if (!Object.hasOwn(value, i)) throw new EncodeError(`${path}/${i}`, 'a hole in a sparse array');
      out.push(encodeValue(value[i], `${path}/${i}`, hook));
    }
    return out;
  }
  if (!isPlain(value)) throw new EncodeError(path, describe(value));
  if (Object.getOwnPropertySymbols(value).length > 0) throw new EncodeError(path, 'an object with symbol keys');
  const out: { [key: string]: Encoded } = {};
  for (const key of Object.keys(value)) {
    const at = `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
    if (key.startsWith('$')) throw new EncodeError(at, 'a key starting with $');
    put(out, key, encodeValue((value as Record<string, unknown>)[key], at, hook));
  }
  return out;
}

const NUMBERS: Record<string, number> = { NaN, Infinity, '-Infinity': -Infinity, '-0': -0 };

export function decodeValue(value: Encoded, readFile: (path: string, sha256: string) => Buffer): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => decodeValue(item, readFile));
  const keys = Object.keys(value);
  const only = keys.length === 1 ? keys[0] : null;
  if (only === '$undefined') return undefined;
  if (only === '$number') return NUMBERS[value.$number as string];
  if (only === '$utf16') return (value.$utf16 as number[]).map((unit) => String.fromCharCode(unit)).join('');
  if (only === '$date') return new Date(value.$date as string);
  if (only === '$bytes') return Buffer.from(value.$bytes as string, 'base64');
  if (keys.length === 2 && keys.includes('$file') && keys.includes('sha256')) return readFile(value.$file as string, value.sha256 as string);
  const out: Record<string, unknown> = {};
  for (const key of keys) put(out, key, decodeValue(value[key]!, readFile));
  return out;
}

export function errorRecord(thrown: unknown, path: string): { [key: string]: Encoded } {
  if (!(thrown instanceof Error)) return { name: '(not an Error)', message: '', value: encodeValue(thrown, `${path}/value`) };
  const record: { [key: string]: Encoded } = { name: String(thrown.name), message: String(thrown.message) };
  for (const key of Object.keys(thrown)) {
    if (key === 'name' || key === 'message' || key === 'stack') continue;
    const at = `${path}/${key}`;
    if (key.startsWith('$')) throw new EncodeError(at, 'a key starting with $');
    put(record, key, encodeValue((thrown as unknown as Record<string, unknown>)[key], at));
  }
  return record;
}
