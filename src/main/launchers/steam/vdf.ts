/**
 * Parser for Valve's text KeyValues format ("VDF"), which Steam uses for loginusers.vdf,
 * libraryfolders.vdf, and appmanifest_*.acf. Values are strings or nested blocks; keys are
 * case-insensitive. No dependencies: the format is small and the files are tiny.
 */

export type VdfValue = string | VdfObject;
export type VdfObject = { [key: string]: VdfValue };

export class VdfParseError extends Error {
  readonly code = 'VDF_PARSE';
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`${message} (line ${line})`);
    this.name = 'VdfParseError';
  }
}

type Token = { kind: 'string'; value: string; quoted: boolean; line: number } | { kind: 'open' | 'close'; line: number };

const BARE_TOKEN_END = /[\s{}"]/;
/** Steam's files nest four or five blocks deep. The limit turns a file of nothing but "{" into a parse error instead of a stack overflow. */
const MAX_DEPTH = 64;

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const n = text.length;
  let i = 0;
  let line = 1;

  while (i < n) {
    const ch = text[i]!;
    if (ch === '\n') {
      line++;
      i++;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\uFEFF') {
      i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '{') {
      tokens.push({ kind: 'open', line });
      i++;
      continue;
    }
    if (ch === '}') {
      tokens.push({ kind: 'close', line });
      i++;
      continue;
    }
    if (ch === '"') {
      const startLine = line;
      let out = '';
      i++;
      for (;;) {
        if (i >= n) throw new VdfParseError('Unterminated string', startLine);
        const c = text[i]!;
        if (c === '"') {
          i++;
          break;
        }
        if (c === '\\') {
          const e = text[i + 1];
          if (e === undefined) throw new VdfParseError('Unterminated string', startLine);
          // Steam writes escaped backslashes and quotes ("D:\\Games\\Steam"). Unknown escapes are kept
          // verbatim so a single-backslash path written by another tool survives untouched.
          if (e === '\\' || e === '"') out += e;
          else if (e === 'n') out += '\n';
          else if (e === 't') out += '\t';
          else if (e === 'r') out += '\r';
          else out += c + e;
          i += 2;
          continue;
        }
        if (c === '\n') line++;
        out += c;
        i++;
      }
      tokens.push({ kind: 'string', value: out, quoted: true, line: startLine });
      continue;
    }
    let j = i;
    while (j < n && !BARE_TOKEN_END.test(text[j]!)) j++;
    tokens.push({ kind: 'string', value: text.slice(i, j), quoted: false, line });
    i = j;
  }
  return tokens;
}

/** Objects are created without a prototype so a hostile key like "__proto__" cannot pollute anything. */
function newObject(): VdfObject {
  return Object.create(null) as VdfObject;
}

export function parseVdf(text: string): VdfObject {
  const tokens = tokenize(text);
  let pos = 0;

  const parseBlock = (into: VdfObject, openedAt: number | null, depth: number): void => {
    while (pos < tokens.length) {
      const t = tokens[pos]!;
      if (t.kind === 'close') {
        if (openedAt === null) throw new VdfParseError('Unexpected "}"', t.line);
        pos++;
        return;
      }
      if (t.kind !== 'string') throw new VdfParseError('Unexpected "{" where a key was expected', t.line);
      // #base / #include directives reference other files; skip the directive and its argument.
      if (!t.quoted && t.value.startsWith('#')) {
        pos += 2;
        continue;
      }
      const key = t.value;
      pos++;
      const v = tokens[pos];
      if (!v) throw new VdfParseError(`Key "${key}" has no value`, t.line);
      if (v.kind === 'open') {
        if (depth >= MAX_DEPTH) throw new VdfParseError('Blocks are nested too deeply', v.line);
        pos++;
        const child = newObject();
        into[key] = child;
        parseBlock(child, v.line, depth + 1);
      } else if (v.kind === 'string') {
        pos++;
        into[key] = v.value;
      } else {
        throw new VdfParseError(`Key "${key}" has no value`, t.line);
      }
      // Platform conditionals such as [$WIN32] may trail a value; ignore them.
      const cond = tokens[pos];
      if (cond && cond.kind === 'string' && !cond.quoted && cond.value.startsWith('[')) pos++;
    }
    if (openedAt !== null) throw new VdfParseError('Missing "}" for block opened', openedAt);
  };

  const root = newObject();
  parseBlock(root, null, 0);
  return root;
}

/** Case-insensitive lookup; exact match wins when both exist. */
export function vdfGet(obj: VdfObject, key: string): VdfValue | undefined {
  if (key in obj) return obj[key];
  const lower = key.toLowerCase();
  for (const k of Object.keys(obj)) {
    if (k.toLowerCase() === lower) return obj[k];
  }
  return undefined;
}

export function vdfHas(obj: VdfObject, key: string): boolean {
  return vdfGet(obj, key) !== undefined;
}

export function vdfString(obj: VdfObject, key: string): string | undefined {
  const v = vdfGet(obj, key);
  return typeof v === 'string' ? v : undefined;
}

export function vdfObject(obj: VdfObject, key: string): VdfObject | undefined {
  const v = vdfGet(obj, key);
  return v !== undefined && typeof v === 'object' ? v : undefined;
}

/** Integer value, or null when missing or not a number. Safe up to 2^53 (Steam sizes fit). */
export function vdfInt(obj: VdfObject, key: string): number | null {
  const s = vdfString(obj, key);
  if (s === undefined || !/^-?\d+$/.test(s.trim())) return null;
  const n = Number(s.trim());
  return Number.isSafeInteger(n) ? n : null;
}

export function vdfFlag(obj: VdfObject, key: string): boolean {
  return vdfString(obj, key)?.trim() === '1';
}
