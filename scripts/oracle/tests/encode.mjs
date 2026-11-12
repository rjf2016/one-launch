export const UNENCODABLE = '$unencodable';

const isPlain = (value) => {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const hasLoneSurrogate = (text) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);

const bytes = (view) => ({ $bytes: Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString('base64') });

function properties(value, seen) {
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (key.startsWith('$')) throw new Error(`a recorded value has a key that starts with $: ${key}`);
    out[key] = encode(item, seen);
  }
  return out;
}

export function encodeError(error, seen = []) {
  if (error === null || typeof error !== 'object') return { $thrown: encode(error, seen) };
  const out = { name: typeof error.name === 'string' ? error.name : 'Error', message: typeof error.message === 'string' ? error.message : String(error) };
  const next = [...seen, error];
  for (const [key, item] of Object.entries(error)) {
    if (key === 'stack' || key === 'name' || key === 'message') continue;
    out[key] = encode(item, next);
  }
  if ('cause' in error && !Object.hasOwn(out, 'cause')) out.cause = encode(error.cause, next);
  return out;
}

// JSON has no undefined, Date, bytes, NaN or lone surrogate; each becomes a $-wrapper so a value reads back exactly.
export function encode(value, seen = []) {
  if (value === undefined) return { $undefined: true };
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return { $number: 'NaN' };
    if (value === Infinity) return { $number: 'Infinity' };
    if (value === -Infinity) return { $number: '-Infinity' };
    if (Object.is(value, -0)) return { $number: '-0' };
    return value;
  }
  if (typeof value === 'string') return hasLoneSurrogate(value) ? { $utf16: Array.from({ length: value.length }, (_, i) => value.charCodeAt(i)) } : value;
  if (typeof value === 'bigint') return { $bigint: value.toString() };
  if (typeof value === 'symbol') return { $symbol: value.description ?? '' };
  if (typeof value === 'function') return { $function: value.name };
  if (seen.includes(value)) return { $circular: true };
  const next = [...seen, value];
  if (value instanceof Date) return { $date: Number.isNaN(value.getTime()) ? null : value.toISOString() };
  if (ArrayBuffer.isView(value)) return bytes(value);
  if (value instanceof ArrayBuffer) return bytes(new Uint8Array(value));
  if (value instanceof Error) return { $error: encodeError(value, seen) };
  if (Array.isArray(value)) return Array.from({ length: value.length }, (_, i) => (i in value ? encode(value[i], next) : { $undefined: true }));
  if (value instanceof Map) return { $map: [...value].map(([key, item]) => [encode(key, next), encode(item, next)]) };
  if (value instanceof Set) return { $set: [...value].map((item) => encode(item, next)) };
  if (typeof value.then === 'function') return { $promise: true };
  if (isPlain(value)) return properties(value, next);
  return { $object: value.constructor?.name ?? 'Object', value: properties(value, next) };
}
