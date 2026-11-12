const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const DIGIT = new Map([...B64].map((char, i) => [char, i]));

export function decodeMappings(mappings) {
  const segments = [];
  let source = 0;
  let line = 0;
  let column = 0;
  mappings.split(';').forEach((group, genLine) => {
    let genCol = 0;
    for (const segment of group.split(',')) {
      if (segment === '') continue;
      const fields = [];
      let value = 0;
      let shift = 0;
      for (const char of segment) {
        const digit = DIGIT.get(char);
        if (digit === undefined) throw new Error(`bad source map character ${char}`);
        value += (digit & 31) << shift;
        if (digit & 32) shift += 5;
        else {
          fields.push(value & 1 ? -(value >>> 1) : value >>> 1);
          value = 0;
          shift = 0;
        }
      }
      genCol += fields[0];
      if (fields.length < 4) continue;
      source += fields[1];
      line += fields[2];
      column += fields[3];
      segments.push({ genLine, genCol, source, line, column });
    }
  });
  return segments;
}

export function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

export function positionOf(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return { line: low, column: offset - starts[low] };
}

const INLINE = /\/\/# sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,([A-Za-z0-9+/=]+)/g;

// vitest runs a module as `'use strict';async (...)=>{{` + code + `\n}}`, and the inline map describes `code` alone.
export function executedScript(source) {
  const match = [...source.matchAll(INLINE)].at(-1);
  if (!match) return null;
  const head = source.indexOf(')=>{{');
  if (!source.startsWith("'use strict';async (") || head === -1) return null;
  const prefix = head + ')=>{{'.length;
  const map = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
  const starts = lineStarts(source);
  const byOriginal = new Map();
  const byLine = new Map();
  for (const segment of decodeMappings(map.mappings)) {
    if (segment.source !== 0) continue;
    const offset = starts[segment.genLine] + segment.genCol + (segment.genLine === 0 ? prefix : 0);
    const key = `${segment.line}:${segment.column}`;
    if (!byOriginal.has(key) || byOriginal.get(key) > offset) byOriginal.set(key, offset);
    if (!byLine.has(segment.line)) byLine.set(segment.line, []);
    byLine.get(segment.line).push({ column: segment.column, offset });
  }
  for (const list of byLine.values()) list.sort((a, b) => a.column - b.column || a.offset - b.offset);
  return { source, starts, map, prefix, byOriginal, byLine, sources: map.sources ?? [], content: map.sourcesContent?.[0] ?? null };
}

const WORD = /[\w$]/;
const SNAP = 40;
const ALIASES = { undefined: ['undefined', 'void 0'] };

function candidateOffset(script, line, column, endLine, endColumn) {
  const exact = script.byOriginal.get(`${line}:${column}`);
  if (exact !== undefined) return exact;
  for (let at = line; at <= endLine; at += 1) {
    const found = (script.byLine.get(at) ?? []).find((item) => (at > line || item.column >= column) && (at < endLine || item.column < endColumn));
    if (found) return found.offset;
  }
  const before = (script.byLine.get(line) ?? []).filter((item) => item.column <= column).at(-1);
  return before ? before.offset + (column - before.column) : null;
}

// The composed map is off by a character here and there, so the offset is moved onto the anchor's first token, and an anchor whose token is not near is left unmeasured.
export function generatedOffset(script, line, column, endLine, endColumn, tokens) {
  const candidate = candidateOffset(script, line, column, endLine, endColumn);
  if (candidate === null) return null;
  if (!tokens || tokens.length === 0) return candidate;
  const at = positionOf(script.starts, candidate);
  const lineStart = script.starts[at.line];
  const text = script.source.slice(lineStart, script.starts[at.line + 1] ?? script.source.length);
  let best = null;
  for (const form of tokens.flatMap((token) => ALIASES[token] ?? [token])) {
    const word = WORD.test(form[0]);
    for (let i = text.indexOf(form); i !== -1; i = text.indexOf(form, i + 1)) {
      if (word && ((i > 0 && WORD.test(text[i - 1])) || WORD.test(text[i + form.length] ?? ''))) continue;
      if (best === null || Math.abs(i - at.column) < Math.abs(best - at.column)) best = i;
    }
  }
  return best !== null && Math.abs(best - at.column) <= SNAP ? lineStart + best : null;
}

export function paintCounts(length, functions) {
  const counts = new Int32Array(length).fill(-1);
  const ranges = functions.flatMap((fn) => fn.ranges).sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
  for (const range of ranges) counts.fill(range.count, range.startOffset, Math.min(range.endOffset, length));
  return counts;
}
