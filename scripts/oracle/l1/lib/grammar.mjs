export const AREAS = ['steam', 'epic', 'battlenet', 'riot', 'core'];
export const ID = /^[a-z0-9][a-z0-9._-]*$/;
export const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const INLINE_MAX = 64 * 1024;
export const ENCODINGS = ['utf8', 'utf16le', 'latin1'];
export const ADVERSARIAL = [
  'unicode-digit',
  'unicode-space',
  'word-boundary',
  'utf16-length',
  'parseint',
  'lone-surrogate',
  'locale-compare',
  'utf8-decode',
  'case-mapping',
  'number',
  'json',
  'date',
  'regex',
  'sort',
  'other',
];

const DECODER = /^(?:bytes|(utf8|utf16le|latin1)(\+strip-bom)?)$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function formatDecoder(decoder) {
  if (!DECODER.test(decoder) || decoder === 'latin1+strip-bom') throw new Error(`not a decoder: ${decoder}`);
  return decoder;
}

export function formatHeader({ decode, clock = null }) {
  const items = Object.entries(decode)
    .map(([index, decoder]) => [Number(index), formatDecoder(decoder)])
    .sort((a, b) => a[0] - b[0])
    .map(([index, decoder]) => `arg${index}=${decoder}`);
  if (clock !== null && !INSTANT.test(clock)) throw new Error(`not an instant: ${clock}`);
  return `decode: ${items.length === 0 ? 'none' : items.join(' ')}${clock === null ? '' : ` clock: ${clock}`}`;
}

export function parseHeader(note) {
  const line = (note ?? '').split('\n')[0];
  const match = /^decode: (none|arg\d+=\S+(?: arg\d+=\S+)*)(?: clock: (\S+))?$/.exec(line);
  if (!match) throw new Error(`the note's first line is not a decode line: ${JSON.stringify(line)}`);
  const decode = {};
  if (match[1] !== 'none') {
    for (const item of match[1].split(' ')) {
      const [, index, decoder] = /^arg(0|[1-9]\d*)=(.+)$/.exec(item) ?? [];
      if (index === undefined) throw new Error(`bad decode item ${item}`);
      if (Object.hasOwn(decode, index)) throw new Error(`arg${index} is decoded twice`);
      decode[index] = formatDecoder(decoder);
    }
  }
  if (match[2] !== undefined && !INSTANT.test(match[2])) throw new Error(`bad clock ${match[2]}`);
  return { decode, clock: match[2] ?? null };
}

export function parseOrigin({ kind, ref }) {
  if (typeof ref !== 'string' || ref.trim() === '' || ref !== ref.trim()) throw new Error('the ref is empty or has outer spaces');
  if (kind === 'fixture') {
    const [path, ...rest] = ref.split(' | ');
    if (path.includes('\\') || path.startsWith('/') || /^[A-Za-z]:/.test(path)) throw new Error(`fixture path ${path} is not relative with forward slashes`);
    return { kind, path, change: rest.length === 0 ? null : rest.join(' | ') };
  }
  if (kind === 'test') {
    const [main, ...rest] = ref.split(' | ');
    const [file, ...titles] = main.split(' > ');
    if (!/^test\/.+\.test\.tsx?$/.test(file)) throw new Error(`test file ${file} is not test/**/*.test.ts(x)`);
    if (titles.length === 0 || titles.some((title) => title === '')) throw new Error('no test title after the file');
    return { kind, file, titles, change: rest.length === 0 ? null : rest.join(' | ') };
  }
  if (kind === 'corpus') {
    const match = /^seed=(0|[1-9]\d*) index=(0|[1-9]\d*)(?: (.+))?$/.exec(ref);
    if (!match) throw new Error('a corpus ref starts with seed=<n> index=<n>');
    return { kind, seed: Number(match[1]), index: Number(match[2]), rest: match[3] ?? null };
  }
  if (kind === 'adversarial') {
    const match = /^([a-z0-9-]+): (.+)$/.exec(ref);
    if (!match || !ADVERSARIAL.includes(match[1])) throw new Error(`an adversarial ref starts with one of ${ADVERSARIAL.join(', ')} and ": "`);
    return { kind, class: match[1], text: match[2] };
  }
  throw new Error(`unknown origin kind ${kind}`);
}
