/**
 * Just enough INI handling for Unreal-style GameUserSettings.ini: [Section] headers, key=value
 * lines, CRLF or LF. Rewrites touch only the lines they are asked to and keep every other byte,
 * including line endings, blank lines between sections, and section order.
 */

export interface IniLayout {
  lines: string[];
  eol: '\r\n' | '\n';
  trailingNewline: boolean;
}

export function splitIni(text: string): IniLayout {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = text.endsWith('\n');
  const body = trailingNewline ? text.slice(0, -eol.length) : text;
  return { lines: body === '' ? [] : body.split(/\r?\n/), eol, trailingNewline };
}

export function joinIni(layout: IniLayout): string {
  const text = layout.lines.join(layout.eol);
  return layout.trailingNewline || layout.lines.length === 0 ? `${text}${layout.eol}` : text;
}

/** A UTF-8 BOM on the first line is tolerated; the header line itself is never rewritten, so the BOM survives. */
const HEADER = /^\uFEFF?\[(.+)\]\s*$/;
const ENTRY = /^([^=\s][^=]*?)=(.*)$/;

export interface IniSection {
  name: string;
  /** Index of the header line. */
  start: number;
  /** Index one past the last line belonging to the section (the next header, or the end). */
  end: number;
}

export function findSections(lines: readonly string[]): IniSection[] {
  const out: IniSection[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = HEADER.exec(lines[i]!);
    if (!m) continue;
    if (out.length > 0) out[out.length - 1]!.end = i;
    out.push({ name: m[1]!, start: i, end: lines.length });
  }
  return out;
}

export function sectionNames(text: string): string[] {
  return findSections(splitIni(text).lines).map((s) => s.name);
}

/** The first section with this name, as key → value (last occurrence of a key wins). Null when absent. */
export function readSection(text: string, name: string): Record<string, string> | null {
  const { lines } = splitIni(text);
  const section = findSections(lines).find((s) => s.name === name);
  if (!section) return null;
  const out: Record<string, string> = {};
  for (let i = section.start + 1; i < section.end; i++) {
    const m = ENTRY.exec(lines[i]!);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

export interface IniChange {
  key: string;
  /** 1-based line number in the new text. */
  line: number;
  before: string | null;
  after: string | null;
}

/**
 * Sets (value) or removes (null) keys inside one section, creating the section at the end of the
 * file when it does not exist. Existing key lines are replaced in place; new keys go after the
 * section's last entry, before its trailing blank lines. Returns the raw before/after values, which
 * the caller must mask before showing anyone.
 */
export function rewriteSection(text: string, name: string, entries: Record<string, string | null>): { text: string; changes: IniChange[]; noop: boolean } {
  const layout = splitIni(text);
  const lines = [...layout.lines];
  const changes: IniChange[] = [];
  let section = findSections(lines).find((s) => s.name === name);

  if (!section) {
    if (Object.values(entries).every((v) => v === null)) return { text, changes, noop: true };
    if (lines.length > 0 && lines[lines.length - 1]!.trim() !== '') lines.push('');
    section = { name, start: lines.length, end: lines.length + 1 };
    lines.push(`[${name}]`);
    lines.push('');
    section.end = lines.length;
  }

  for (const [key, value] of Object.entries(entries)) {
    const existing: number[] = [];
    for (let i = section.start + 1; i < section.end; i++) {
      const m = ENTRY.exec(lines[i]!);
      if (m && m[1] === key) existing.push(i);
    }
    if (value === null) {
      for (const i of [...existing].reverse()) {
        changes.push({ key, line: i + 1, before: lines[i]!.slice(key.length + 1), after: null });
        lines.splice(i, 1);
        section.end--;
      }
      continue;
    }
    const line = `${key}=${value}`;
    if (existing.length > 0) {
      const first = existing[0]!;
      const before = lines[first]!.slice(key.length + 1);
      if (before !== value) changes.push({ key, line: first + 1, before, after: value });
      lines[first] = line;
      for (const i of existing.slice(1).reverse()) {
        lines.splice(i, 1);
        section.end--;
      }
      continue;
    }
    let at = section.end;
    while (at > section.start + 1 && lines[at - 1]!.trim() === '') at--;
    lines.splice(at, 0, line);
    section.end++;
    changes.push({ key, line: at + 1, before: null, after: value });
  }

  const next = joinIni({ ...layout, lines });
  return { text: next, changes, noop: next === text };
}
