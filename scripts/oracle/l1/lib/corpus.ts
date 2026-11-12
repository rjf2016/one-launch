export class Rng {
  readonly seed: number;
  private state: number;

  constructor(seed: number) {
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error(`a seed is an integer from 0 to 2^32-1, not ${seed}`);
    this.seed = seed;
    this.state = seed;
  }

  // mulberry32: small, fast and the same on every engine, which is all a corpus needs.
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(below: number): number {
    return Math.floor(this.next() * below);
  }

  between(min: number, max: number): number {
    return min + this.int(max - min + 1);
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from an empty list');
    return items[this.int(items.length)]!;
  }
}

export type TextEncoding = 'utf8' | 'utf16le';
export type Mutation = (input: Buffer, rng: Rng, encoding: TextEncoding) => Buffer;

const BOM: Record<TextEncoding, Buffer> = { utf8: Buffer.from([0xef, 0xbb, 0xbf]), utf16le: Buffer.from([0xff, 0xfe]) };
const INTERESTING = [0x00, 0x09, 0x0a, 0x0d, 0x20, 0x22, 0x5c, 0x7b, 0x7d, 0x5b, 0x5d, 0x3d, 0x3a, 0x2c, 0x23, 0x2f, 0x7f, 0x80, 0xff];
const INVALID_UTF8 = [[0xff], [0x80], [0xc0, 0x80], [0xc3], [0xe2, 0x82], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xf0, 0x9f, 0x98]];
const ASTRAL = ['\u{1F600}', '\u{1D7D8}', '\u{10FFFF}', '\u{20000}'];
const LONE: Record<TextEncoding, number[][]> = {
  utf8: [
    [0xed, 0xa0, 0xbd],
    [0xed, 0xb8, 0x80],
  ],
  utf16le: [
    [0x3d, 0xd8],
    [0x00, 0xde],
  ],
};

const at = (input: Buffer, index: number, insert: Buffer | number[], remove = 0): Buffer =>
  Buffer.concat([input.subarray(0, index), Buffer.from(insert), input.subarray(index + remove)]);

const unit = (encoding: TextEncoding): number => (encoding === 'utf16le' ? 2 : 1);
const boundary = (input: Buffer, rng: Rng, encoding: TextEncoding): number => {
  const step = unit(encoding);
  return rng.int(Math.floor(input.length / step) + 1) * step;
};

function lines(input: Buffer, encoding: TextEncoding): Buffer[] {
  const newline = encoding === 'utf16le' ? Buffer.from([0x0a, 0x00]) : Buffer.from([0x0a]);
  const out: Buffer[] = [];
  let start = 0;
  for (;;) {
    let found = input.indexOf(newline, start);
    while (found !== -1 && encoding === 'utf16le' && found % 2 === 1) found = input.indexOf(newline, found + 1);
    if (found === -1) {
      out.push(input.subarray(start));
      return out;
    }
    out.push(input.subarray(start, found + newline.length));
    start = found + newline.length;
  }
}

function swapEol(input: Buffer, encoding: TextEncoding): Buffer {
  const text = input.toString(encoding === 'utf16le' ? 'utf16le' : 'latin1');
  const next = text.includes('\r\n') ? text.replace(/\r\n/g, '\n') : text.replace(/\n/g, '\r\n');
  return Buffer.from(next, encoding === 'utf16le' ? 'utf16le' : 'latin1');
}

export const MUTATIONS = {
  flip: (input, rng) => {
    if (input.length === 0) return input;
    const out = Buffer.from(input);
    const index = rng.int(out.length);
    out[index] = out[index]! ^ (1 << rng.int(8));
    return out;
  },
  insert: (input, rng) =>
    at(
      input,
      rng.int(input.length + 1),
      Array.from({ length: rng.between(1, 4) }, () => rng.pick(INTERESTING)),
    ),
  delete: (input, rng) => {
    if (input.length === 0) return input;
    const index = rng.int(input.length);
    return at(input, index, [], rng.between(1, Math.min(16, input.length - index)));
  },
  'line-duplicate': (input, rng, encoding) => {
    const parts = lines(input, encoding);
    const index = rng.int(parts.length);
    parts.splice(index, 0, parts[index]!);
    return Buffer.concat(parts);
  },
  'line-delete': (input, rng, encoding) => {
    const parts = lines(input, encoding);
    parts.splice(rng.int(parts.length), 1);
    return Buffer.concat(parts);
  },
  'line-swap': (input, rng, encoding) => {
    const parts = lines(input, encoding);
    const a = rng.int(parts.length);
    const b = rng.int(parts.length);
    [parts[a], parts[b]] = [parts[b]!, parts[a]!];
    return Buffer.concat(parts);
  },
  eol: (input, _rng, encoding) => swapEol(input, encoding),
  bom: (input, _rng, encoding) => {
    const bom = BOM[encoding];
    return input.subarray(0, bom.length).equals(bom) ? input.subarray(bom.length) : Buffer.concat([bom, input]);
  },
  truncate: (input, rng, encoding) => input.subarray(0, boundary(input, rng, encoding)),
  'invalid-utf8': (input, rng) => at(input, rng.int(input.length + 1), rng.pick(INVALID_UTF8)),
  astral: (input, rng, encoding) => at(input, boundary(input, rng, encoding), Buffer.from(rng.pick(ASTRAL), encoding)),
  'lone-surrogate': (input, rng, encoding) => at(input, boundary(input, rng, encoding), rng.pick(LONE[encoding])),
} satisfies Record<string, Mutation>;

export type MutationName = keyof typeof MUTATIONS;
export const MUTATION_NAMES = Object.keys(MUTATIONS) as MutationName[];

export function mutate(
  input: Buffer,
  rng: Rng,
  ops: readonly MutationName[],
  steps: number,
  encoding: TextEncoding = 'utf8',
): { bytes: Buffer; applied: MutationName[] } {
  let bytes = Buffer.from(input);
  const applied: MutationName[] = [];
  for (let i = 0; i < steps; i += 1) {
    const op = rng.pick(ops);
    bytes = MUTATIONS[op](bytes, rng, encoding);
    applied.push(op);
  }
  return { bytes, applied };
}
