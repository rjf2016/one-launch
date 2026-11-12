import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadOrigins } from './data.mjs';
import { TYPESCRIPT_VERSION, walkSource } from './source.mjs';

export const SHOTS_DIR = 'ui/shots';
export const EXPECTED_DIR = 'l2/expected';

const NON_TEXT_ATTRIBUTES = /^(aria-.*|title|alt|placeholder)$/;
const MAX_LINES = 12;
const LAUNCHER_WORDS = { steam: /steam/i, epic: /epic/i, battlenet: /battle.?net/i, riot: /riot/i };
// Data that wins over an equal source string unless that string is shown to flow into an element around the run. What a capture typed or the simulator wrote often repeats copy (a capture clicks a button by its label), so those never do.
const OUTRANKS_COPY = new Set(['fixture', 'count', 'version', 'clock', 'path', 'relative-time', 'date', 'fingerprint']);

export function readSidecars(out) {
  return readdirSync(join(out, SHOTS_DIR))
    .filter((name) => name.endsWith('.layout.json'))
    .sort()
    .map((name) => ({ path: `${SHOTS_DIR}/${name}`, sidecar: JSON.parse(readFileSync(join(out, SHOTS_DIR, name), 'utf8')) }));
}

export function readStepTitles(out) {
  const titles = new Map();
  for (const name of readdirSync(join(out, EXPECTED_DIR))
    .filter((n) => n.endsWith('.json'))
    .sort()) {
    const expected = JSON.parse(readFileSync(join(out, EXPECTED_DIR, name), 'utf8'));
    for (const event of expected.events ?? []) {
      if (event.k !== 'job') continue;
      for (const [id, , title] of event.steps ?? []) {
        const key = `${id}\u0000${title}`;
        if (!titles.has(key)) titles.set(key, { id, title, scripts: new Set() });
        titles.get(key).scripts.add(name.replace(/\.json$/, ''));
      }
    }
  }
  return [...titles.values()].map((t) => ({ id: t.id, title: t.title, scripts: [...t.scripts].sort() }));
}

const MAX_SPLITS = 16;

// The ways the template's fixed parts sit in the text in order, first part at the start and last at the end. A slot whose
// possible strings are known (the copy that flows into it) tries those first; any slot can also run to the next fixed part.
export function* fillSlots(parts, text, choices = []) {
  if (!text.startsWith(parts[0])) return;
  const last = parts[parts.length - 1];
  if (!text.endsWith(last) || text.length < parts[0].length + last.length) return;
  const stop = text.length - last.length;
  let given = 0;
  function* place(k, pos, values) {
    const slot = k - 1;
    const next = parts[k];
    const final = k === parts.length - 1;
    const ends = new Set();
    for (const choice of choices[slot] ?? []) if (text.startsWith(choice, pos) && pos + choice.length <= stop) ends.add(pos + choice.length);
    if (final) ends.add(stop);
    else if (next !== '')
      for (let at = text.indexOf(next, pos); at !== -1 && at + next.length <= stop && ends.size < 24; at = text.indexOf(next, at + 1)) ends.add(at);
    else for (let at = pos; at <= stop && ends.size < 24; at += 1) if (at === pos || at === stop || text[at] === ' ' || text[at - 1] === ' ') ends.add(at);
    for (const end of [...ends].sort((a, b) => a - b)) {
      if (given >= MAX_SPLITS) return;
      if (final) {
        if (end === stop) {
          given += 1;
          yield [...values, text.slice(pos, end)];
        }
        continue;
      }
      if (!text.startsWith(next, end)) continue;
      yield* place(k + 1, end + next.length, [...values, text.slice(pos, end)]);
    }
  }
  if (parts.length === 1) {
    if (text === parts[0]) yield [];
    return;
  }
  yield* place(1, parts[0].length, []);
}
const staticLength = (entry) => entry.parts.join('').replace(/\s/g, '').length;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// The value kinds that are not copy, by their shape. Each says what produced it.
function dataByShape(value, ctx, inputs = false) {
  const v = value;
  if (/^[▸▾•] $/.test(v))
    return { kind: 'marker', what: 'a disclosure or list marker Chromium draws', origin: { browser: '::marker of a <summary> or a list item' } };
  if (/^\d+\. $/.test(v)) return { kind: 'marker', what: 'an ordered-list number Chromium draws', origin: { browser: '::marker of an <ol> item' } };
  // A path alone, not a sentence that holds one: no clause breaks, no words between its parts.
  if (/^[A-Za-z]:[\\/]/.test(v) && /oracle-scratch/i.test(v) && !/[.,;:]\s|\s\(|\s(and|or|the|into|of|to|for|from)\s/i.test(v))
    return {
      kind: 'path',
      what: 'a path under the capture scratch folder',
      origin: { scratch: 'ORACLE_SCRATCH, the folder the capture laid the fake launchers and the data folder in' },
    };
  if (/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/.test(v))
    return { kind: 'clock', what: 'snapshot id: the time the snapshot was taken', origin: { clock: ctx.clock } };
  if (/^[A-Z][a-z]{2} \d{1,2}, \d{4},?( \d{1,2}:\d{2} [AP]M)?$/.test(v) || /^\d{1,2}:\d{2}(:\d{2})? [AP]M$/.test(v))
    return { kind: 'clock', what: 'a stored time formatted with toLocale* in en-US, UTC', origin: { clock: ctx.clock } };
  const long = /^([A-Z][a-z]+) (\d{1,2}), (\d{4})$/.exec(v);
  if (long && MONTHS.includes(long[1])) {
    const iso = `${long[3]}-${String(MONTHS.indexOf(long[1]) + 1).padStart(2, '0')}-${long[2].padStart(2, '0')}`;
    const source = ctx.byText.get(iso)?.[0];
    if (source) return { kind: 'date', what: `the date ${iso} formatted in en-US`, origin: { file: source.file, line: source.line, value: iso } };
    return { kind: 'clock', what: 'a date formatted in en-US', origin: { clock: ctx.clock } };
  }
  if (
    /^(\d+ (second|minute|hour|day|week|month|year)s? ago|in \d+ (second|minute|hour|day|week|month|year)s?|yesterday|tomorrow|last (week|month|year)|next (week|month|year))$/.test(
      v,
    )
  )
    return { kind: 'relative-time', what: 'Intl.RelativeTimeFormat of a stored time against the oracle clock', origin: { clock: ctx.clock } };
  if (v === ctx.appVersion) return { kind: 'version', what: 'the app version', origin: { file: 'package.json', field: 'version' } };
  if (/^\d{1,3}$/.test(v)) return { kind: 'count', what: 'a number the app computed from what it holds', origin: { computed: true } };
  if (/^[0-9a-f]{4}$/i.test(v)) {
    const tail = [...ctx.origins.values].find(([value, where]) => where.kind === 'fixture' && value.length >= 8 && value.endsWith(v));
    if (tail)
      return {
        kind: 'fixture',
        what: 'the last characters of an id the fake launchers hold',
        origin: { file: tail[1].file, line: tail[1].line, tailOf: tail[0].length },
      };
  }
  const found = ctx.origins.values.get(v);
  // What a capture typed or the simulator wrote is looked for only once no copy fits: a capture names on-screen copy to wait for it.
  if (found && (inputs || found.kind === 'fixture')) return { kind: found.kind, what: found.what, origin: { file: found.file, line: found.line } };
  if (/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(v))
    return { kind: 'version', what: 'a runtime version', origin: { runtime: 'process.versions of the running app' } };
  if (/^-?\d+(\.\d+)?%?$/.test(v)) return { kind: 'count', what: 'a number the app computed from what it holds', origin: { computed: true } };
  if (/^[0-9a-f]{8}$/.test(v)) return { kind: 'fingerprint', what: 'a short hash the app computed from a stored session', origin: { computed: true } };
  return null;
}

// Last resort for launcher text shown as read: the run is a verbatim piece of a fixture or simulator line, or one with the
// app's redaction mark (…) where the line holds a value. Only for text that is not prose of the app's own.
function dataByContent(value, ctx) {
  const v = value.trim();
  if (v.length < 4) return null;
  const structured = /["\t=\\]/.test(v) || /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(v) || v.includes('…');
  if (!structured) return null;
  const re = v.includes('…')
    ? new RegExp(
        v
          .split('…')
          .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('[^\'"\\s]+'),
      )
    : null;
  for (const [file, text] of ctx.origins.texts) {
    const group = ctx.origins.groupOf.get(file);
    if (group.kind !== 'fixture' && group.kind !== 'launcher-output') continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const hit = re ? re.exec(lines[i]) : lines[i].includes(v) ? [v] : null;
      if (hit)
        return {
          kind: group.kind,
          what: re ? `${group.what}, with a value the app masks as …` : group.what,
          origin: { file, line: i + 1, ...(re ? { masked: true } : {}) },
        };
    }
  }
  return null;
}

// Every source string a mapped run leans on, at any depth: its own, its slots', the pieces of a join.
export function markUsed(rec, usedBy) {
  for (const source of rec.sources ?? []) usedBy.set(source.id, (usedBy.get(source.id) ?? 0) + 1);
  for (const slot of rec.slots ?? []) markUsed(slot, usedBy);
  for (const piece of rec.pieces ?? []) markUsed(piece, usedBy);
}

export function buildCopy(out) {
  const walk = walkSource();
  const origins = loadOrigins();
  const sidecars = readSidecars(out);
  const clock = sidecars[0]?.sidecar.clock ?? null;

  const entries = walk.strings.slice().sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.pos - b.pos || a.end - b.end));
  entries.forEach((entry, i) => {
    entry.id = `s${String(i + 1).padStart(4, '0')}`;
  });
  const textCapable = (entry) =>
    !entry.hidden &&
    !entry.log &&
    entry.process !== 'simulator' &&
    !(entry.attribute !== undefined && /^[a-z]/.test(entry.element ?? '') && NON_TEXT_ATTRIBUTES.test(entry.attribute));

  const byText = new Map();
  const byUpper = new Map();
  const byTrim = new Map();
  const templates = [];
  for (const entry of entries) {
    if (!textCapable(entry)) continue;
    if (entry.parts) {
      const longest = entry.parts.reduce((a, b) => (b.length > a.length ? b : a), '');
      if (entry.slots.length > 0) templates.push({ entry, longest, bare: staticLength(entry) === 0, tiny: staticLength(entry) <= 2 });
      continue;
    }
    if (!byText.has(entry.text)) byText.set(entry.text, []);
    byText.get(entry.text).push(entry);
    const trimmed = entry.text.trim().replace(/\s+/g, ' ');
    if (trimmed !== entry.text) {
      if (!byTrim.has(trimmed)) byTrim.set(trimmed, []);
      byTrim.get(trimmed).push(entry);
    }
    const upper = entry.text.trim().replace(/\s+/g, ' ').toUpperCase();
    if (upper !== entry.text.trim()) {
      if (!byUpper.has(upper)) byUpper.set(upper, []);
      byUpper.get(upper).push(entry);
    }
  }
  const ctx = { clock, appVersion: origins.appVersion, origins, byText };
  // Equal as rendered: CSS drops the space at the edge of a flex item or a line, and collapses runs of white space.
  const exactOf = (text) => {
    const same = byText.get(text);
    if (same) return { entries: same };
    const trimmed = byTrim.get(text.trim().replace(/\s+/g, ' '));
    if (trimmed && text.trim() !== '') return { entries: trimmed, whitespace: 'collapsed' };
    const plain = byText.get(text.trim());
    if (plain && text.trim() !== '') return { entries: plain, whitespace: 'collapsed' };
    return { entries: [] };
  };

  const reachCache = new Map();
  const reachOf = (entry) => {
    if (!reachCache.has(entry)) reachCache.set(entry, walk.reachOf(entry));
    return reachCache.get(entry);
  };

  const anchorCache = new Map();
  // The source elements a rendered element can be: same tag, and every class the source always gives it is on it.
  const sourceElementsOf = (element) => {
    if (!element.cls || !element.tag || element.tag.startsWith('::')) return [];
    const key = `${element.tag}\u0000${element.cls}`;
    if (anchorCache.has(key)) return anchorCache.get(key);
    const tokens = new Set(element.cls.split(/\s+/).filter(Boolean));
    let best = 0;
    let found = [];
    for (const source of walk.elements) {
      if (source.tag !== element.tag || !source.classes || source.classes.required.length === 0) continue;
      if (!source.classes.required.every((t) => tokens.has(t))) continue;
      const score = source.classes.required.length + source.classes.optional.filter((t) => tokens.has(t)).length;
      const exact = source.classes.complete && source.classes.required.length === tokens.size;
      if (score < 2 && !exact) continue;
      if (score > best) {
        best = score;
        found = [source];
      } else if (score === best) found.push(source);
    }
    anchorCache.set(key, found);
    return found;
  };
  const sitesByFile = new Map();
  const sitesOf = (entry) => {
    if (!sitesByFile.has(entry)) {
      const map = new Map();
      for (const site of reachOf(entry)) {
        if (!map.has(site.file)) map.set(site.file, []);
        map.get(site.file).push(site.pos);
      }
      for (const list of map.values()) list.sort((a, b) => a - b);
      sitesByFile.set(entry, map);
    }
    return sitesByFile.get(entry);
  };
  const inside = (list, start, end) => {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid] < start) lo = mid + 1;
      else hi = mid;
    }
    return lo < list.length && list[lo] < end;
  };
  const reachesInto = (entry, spans) => {
    const map = sitesOf(entry);
    return spans.some((span) => map.has(span.file) && inside(map.get(span.file), span.start, span.end));
  };

  const distinct = (list) => {
    const seen = new Map();
    for (const entry of list) if (!seen.has(entry.id)) seen.set(entry.id, entry);
    return [...seen.values()];
  };

  // Narrow equal-text candidates to the one rendered here, by the rendered elements around the run, innermost first.
  function byAnchors(candidates, anchors) {
    let left = distinct(candidates);
    if (left.length <= 1) return { left, how: 'unique' };
    for (const anchor of anchors) {
      if (anchor.spans.length === 0) continue;
      const hits = left.filter((entry) => reachesInto(entry, anchor.spans));
      if (hits.length > 0 && hits.length < left.length) {
        left = hits;
        if (left.length === 1) return { left, how: 'anchor', anchor: anchor.label };
      }
    }
    return { left, how: left.length === 1 ? 'anchor' : 'open' };
  }
  const reachesAnyAnchor = (candidates, anchors) =>
    candidates.some((entry) => anchors.some((anchor) => anchor.spans.length > 0 && reachesInto(entry, anchor.spans)));

  const anchorKey = (anchors) => anchors.map((a) => a.key).join('|');
  const slotCache = new Map();
  // Below the top level the elements around the run no longer narrow anything worth the cost, so nested results are shared.
  function slotValue(template, k, value, anchors, depth) {
    const key = JSON.stringify([template.entry.id, k, value, depth, depth === 0 ? anchorKey(anchors) : '']);
    if (!slotCache.has(key)) slotCache.set(key, slotValueFresh(template, k, value, anchors, depth));
    return slotCache.get(key);
  }

  function slotValueFresh(template, k, value, anchors, depth) {
    if (value === '') return { name: template.entry.slots[k], value, class: 'empty' };
    const span = template.entry.slotSpans?.[k];
    const inSlot = (entry) => span && reachOf(entry).some((site) => site.file === template.entry.file && span.start <= site.pos && site.pos < span.end);
    const exact = exactOf(value).entries.filter((entry) => entry !== template.entry);
    const flowing = exact.filter(inSlot);
    if (flowing.length > 0) {
      const narrowed = byAnchors(flowing, anchors);
      return {
        name: template.entry.slots[k],
        value,
        class: 'copy',
        match: 'exact',
        how: 'slot-flow',
        sources: narrowed.left.map(cite),
      };
    }
    const data = dataByShape(value, ctx);
    if (data) return { name: template.entry.slots[k], value, class: 'data', ...data };
    if (exact.length > 0) {
      const narrowed = byAnchors(exact, anchors);
      // A renderer slot filled from main can only be reached over IPC, which the flow analysis does not cross.
      const fromMain = narrowed.left.every((entry) => entry.process === 'main');
      const how = template.entry.process === 'renderer' && fromMain ? 'ipc' : template.entry.process === 'main' && fromMain ? 'main' : narrowed.how;
      return { name: template.entry.slots[k], value, class: 'copy', match: 'exact', how, sources: narrowed.left.map(cite) };
    }
    const upper = byUpper.get(value);
    if (upper) return { name: template.entry.slots[k], value, class: 'copy', match: 'transform', transform: 'uppercase', sources: distinct(upper).map(cite) };
    const joined = /\.join\((['"`])(.*?)\1\)\s*$/.exec(template.entry.slots[k]);
    if (joined && depth < 2 && value.includes(joined[2])) {
      const pieces = value.split(joined[2]).map((piece) => pieceValue(piece, anchors, depth + 1));
      if (pieces.every((piece) => piece.class !== 'unclassified'))
        return { name: template.entry.slots[k], value, class: 'copy', match: 'join', separator: joined[2], pieces };
    }
    const nested = depth < 2 ? templateMatch(value, anchors, template.entry, depth + 1, { key: `${template.entry.id}:${k}`, test: inSlot }) : null;
    if (nested)
      return {
        name: template.entry.slots[k],
        value,
        class: 'copy',
        match: 'template',
        how: inSlot(nested.template.entry)
          ? 'slot-flow'
          : nested.template.entry.process === 'main' && template.entry.process !== 'simulator'
            ? template.entry.process === 'renderer'
              ? 'ipc'
              : 'main'
            : nested.how,
        sources: [cite(nested.template.entry)],
        slots: nested.slots,
      };
    const input = dataByShape(value, ctx, true);
    if (input) return { name: template.entry.slots[k], value, class: 'data', ...input };
    return { name: template.entry.slots[k], value, class: 'unclassified' };
  }

  // One item of an array the code joined into a slot: copy, a template, or data.
  function pieceValue(value, anchors, depth) {
    const exact = exactOf(value).entries;
    const data = dataByShape(value, ctx);
    if (data) return { value, class: 'data', ...data };
    if (exact.length > 0) {
      const narrowed = byAnchors(exact, anchors);
      return { value, class: 'copy', match: 'exact', how: narrowed.how, sources: narrowed.left.map(cite) };
    }
    const nested = templateMatch(value, anchors, null, depth);
    if (nested)
      return {
        value,
        class: 'copy',
        match: 'template',
        how: nested.how,
        sources: [nested.template.entry, ...(nested.alternatives ?? [])].map(cite),
        slots: nested.slots,
      };
    const input = dataByShape(value, ctx, true);
    if (input) return { value, class: 'data', ...input };
    return { value, class: 'unclassified' };
  }

  const plainEntries = entries.filter((entry) => textCapable(entry) && !entry.parts);
  const flowCache = new Map();
  // The copy that can flow into each slot of a template: its literals reach a place inside the slot's expression.
  const flowsInto = (template) => {
    if (!flowCache.has(template)) {
      const spans = template.entry.slotSpans ?? [];
      const found = spans.map(() => new Set());
      for (const entry of plainEntries) {
        const map = sitesOf(entry);
        const list = map.get(template.entry.file);
        if (!list) continue;
        spans.forEach((span, k) => {
          if (inside(list, span.start, span.end)) found[k].add(entry.text);
        });
      }
      flowCache.set(
        template,
        found.map((set) => [...set].sort((a, b) => b.length - a.length || (a < b ? -1 : 1))),
      );
    }
    return flowCache.get(template);
  };

  const candidateCache = new Map();
  const candidatesFor = (text) => {
    if (!candidateCache.has(text))
      candidateCache.set(
        text,
        templates.filter((template) => text.includes(template.longest)),
      );
    return candidateCache.get(text);
  };

  function classifySplit(template, values, anchors, depth) {
    const slots = [];
    for (let k = 0; k < values.length; k += 1) {
      const slot = slotValue(template, k, values[k], anchors, depth);
      if (slot.class === 'unclassified') return null;
      // A template of slots and little else says almost nothing by itself: each piece of copy in it must be shown to flow into its slot.
      if (template.tiny && slot.class === 'copy' && slot.how !== 'slot-flow' && !((slot.how === 'ipc' || slot.how === 'main') && !template.bare)) return null;
      slots.push(slot);
    }
    if (template.bare && !slots.some((slot) => slot.how === 'slot-flow')) return null;
    return slots;
  }

  const nestedCache = new Map();
  function templateMatch(text, anchors, except = null, depth = 0, prefer = null) {
    if (depth === 0) return templateMatchFresh(text, anchors, except, depth, prefer);
    const key = JSON.stringify([text, except?.id ?? '', depth, prefer?.key ?? '']);
    if (!nestedCache.has(key)) nestedCache.set(key, templateMatchFresh(text, anchors, except, depth, prefer));
    return nestedCache.get(key);
  }

  function templateMatchFresh(text, anchors, except, depth, prefer) {
    const scored = [];
    for (const template of candidatesFor(text)) {
      if (template.entry === except) continue;
      const choices = template.bare || template.entry.parts.includes('') ? flowsInto(template) : [];
      if (template.bare && !choices.some((list) => list.some((choice) => choice !== '' && text.includes(choice)))) continue;
      for (const values of fillSlots(template.entry.parts, text, choices)) {
        const slots = classifySplit(template, values, anchors, depth);
        if (!slots) continue;
        scored.push({ template, values, slots });
        break;
      }
    }
    if (scored.length === 0) return null;
    scored.sort((a, b) => staticLength(b.template.entry) - staticLength(a.template.entry));
    const top = staticLength(scored[0].template.entry);
    const level = scored.filter((hit) => staticLength(hit.template.entry) === top);
    const flowOf = (hit) => hit.slots.filter((slot) => slot.how === 'slot-flow').length;
    // Equal fixed text: the template more of whose slots are shown to be filled by what is on screen.
    const most = Math.max(...level.map(flowOf));
    const best = level.filter((hit) => flowOf(hit) === most);
    if (best.length === 1 && level.length > 1) return { ...best[0], how: 'flow' };
    if (best.length === 1) return { ...best[0], how: 'unique' };
    const preferred = prefer ? best.filter((hit) => prefer.test(hit.template.entry)) : [];
    if (preferred.length === 1) return { ...preferred[0], how: 'slot-flow' };
    const narrowed = byAnchors(
      best.map((hit) => hit.template.entry),
      anchors,
    );
    const chosen = best.filter((hit) => narrowed.left.includes(hit.template.entry));
    // Only a template of the same shape is an alternative: the slots found for the first must fill it as well.
    const shape = JSON.stringify(chosen[0].template.entry.parts);
    const alike = chosen
      .slice(1)
      .filter((hit) => JSON.stringify(hit.template.entry.parts) === shape && JSON.stringify(hit.values) === JSON.stringify(chosen[0].values));
    return { ...chosen[0], how: chosen.length === 1 || alike.length > 0 ? narrowed.how : 'first', alternatives: alike.map((hit) => hit.template.entry) };
  }

  const cite = (entry) => ({ id: entry.id, file: entry.file, line: entry.line });

  // Sentences the code put side by side (an array joined with a space): each one copy or a template on its own.
  function joinOfSentences(text, anchors) {
    const cuts = [...text.matchAll(/[.!?…] (?=[A-Z])/g)].map((m) => m.index + 1);
    if (cuts.length === 0 || cuts.length > 3) return null;
    const pieces = [];
    let from = 0;
    for (const cut of [...cuts, text.length]) {
      pieces.push(text.slice(from, cut).trim());
      from = cut + 1;
    }
    const parts = pieces.map((piece) => pieceValue(piece, anchors, 1));
    if (parts.some((part) => part.class !== 'copy')) return null;
    return { class: 'copy', match: 'join', how: 'sentences', separator: ' ', sources: parts.flatMap((part) => part.sources), pieces: parts };
  }

  const interpretCache = new Map();
  function interpret(text, anchors) {
    const key = `${text}\u0000${anchors.map((a) => a.key).join('|')}`;
    if (!interpretCache.has(key)) interpretCache.set(key, interpretFresh(text, anchors));
    return interpretCache.get(key);
  }

  // One rendered string, whole: copy (exact, after text-transform, a template), or data, or nothing.
  function interpretFresh(text, anchors) {
    const found = exactOf(text);
    const exact = found.entries;
    const data = dataByShape(text, ctx);
    if (exact.length > 0) {
      if (data && OUTRANKS_COPY.has(data.kind) && !reachesAnyAnchor(exact, anchors)) return { class: 'data', ...data, value: text, over: exact.length };
      const narrowed = byAnchors(exact, anchors);
      return { class: 'copy', match: 'exact', whitespace: found.whitespace, how: narrowed.how, sources: narrowed.left, anchor: narrowed.anchor };
    }
    const lowered = /^[A-Z]/.test(text) ? exactOf(text[0].toLowerCase() + text.slice(1)).entries : [];
    // A capital the code put on a word: a sentence is enough by itself; a single word has to be shown to flow into an element around it.
    if (lowered.length > 0 && !data && (/\s\S/.test(text.trim()) || reachesAnyAnchor(lowered, anchors))) {
      const narrowed = byAnchors(lowered, anchors);
      return {
        class: 'copy',
        match: 'transform',
        transform: 'first letter upper-cased in code',
        how: narrowed.how,
        sources: narrowed.left,
        anchor: narrowed.anchor,
      };
    }
    const upperKey = text.trim().replace(/\s+/g, ' ');
    if (/[A-Z]/.test(text) && text === text.toUpperCase() && byUpper.has(upperKey) && !data) {
      const narrowed = byAnchors(byUpper.get(upperKey), anchors);
      return { class: 'copy', match: 'transform', transform: 'uppercase', how: narrowed.how, sources: narrowed.left, anchor: narrowed.anchor };
    }
    if (data) return { class: 'data', ...data, value: text };
    const template = templateMatch(text, anchors);
    if (template) {
      return {
        class: 'copy',
        match: template.template.entry.kind === 'concat' ? 'join' : 'template',
        how: template.how,
        sources: [template.template.entry, ...(template.alternatives ?? [])],
        slots: template.slots,
      };
    }
    const input = dataByShape(text, ctx, true);
    if (input) return { class: 'data', ...input, value: text };
    const content = dataByContent(text, ctx);
    if (content) return { class: 'data', ...content, value: text };
    const sentences = joinOfSentences(text, anchors);
    if (sentences) return sentences;
    return null;
  }

  // How the next run continues the last: on the next line down, or on the same line straight after it.
  const boundary = (a, b) => {
    if (b.box[1] >= a.box[1] + a.box[3] * 0.5 && b.box[1] <= a.box[1] + a.box[3] * 2.2) return 'line';
    if (Math.abs(b.box[1] - a.box[1]) <= 2 && b.box[0] >= a.box[0] + a.box[2] - 1 && b.box[0] <= a.box[0] + a.box[2] + 8) return 'inline';
    return null;
  };

  function joinVariants(runs, kinds) {
    const join = (sep) => runs.map((run, k) => (k === 0 ? run.t : `${kinds[k - 1] === 'line' ? sep : ''}${run.t}`)).join('');
    const out = [{ text: join(' '), sep: ' ' }];
    if (kinds.includes('line') && !runs.slice(1).some((run) => /^[A-Za-z]:[\\/]/.test(run.t))) out.push({ text: join(''), sep: '' });
    return out;
  }

  const anchorsOf = (run, elements) =>
    elements
      .filter((e) => {
        const [x, y, w, h] = e.box;
        const cx = run.box[0] + run.box[2] / 2;
        const cy = run.box[1] + run.box[3] / 2;
        return cx >= x - 0.5 && cx <= x + w + 0.5 && cy >= y - 0.5 && cy <= y + h + 0.5;
      })
      .map((e) => {
        const spans = sourceElementsOf(e);
        return { area: e.box[2] * e.box[3], label: `${e.role}${e.name ? `:${e.name}` : ''}`, spans, key: spans.map((s) => `${s.file}@${s.start}`).join(',') };
      })
      .sort((a, b) => a.area - b.area);

  const mapping = [];
  const usedBy = new Map();
  const judgement = [];

  for (const { path, sidecar } of sidecars) {
    const runs = sidecar.text;
    const anchorList = runs.map((run) => anchorsOf(run, sidecar.elements));
    const results = new Array(runs.length).fill(null);
    const singles = runs.map((run, i) => interpret(run.t, anchorList[i]));
    for (let i = 0; i < runs.length;) {
      let end = i;
      const kinds = [];
      while (end + 1 < runs.length && end - i + 1 < MAX_LINES) {
        const kind = boundary(runs[end], runs[end + 1]);
        if (!kind) break;
        kinds.push(kind);
        end += 1;
      }
      let placed = false;
      for (let j = end; j > i && !placed; j -= 1) {
        // Runs that each stand on their own are not joined: a group is only for text no single run can be placed by.
        if (singles.slice(i, j + 1).every(Boolean)) continue;
        const within = kinds.slice(0, j - i);
        for (const { text, sep } of joinVariants(runs.slice(i, j + 1), within)) {
          const found = interpret(text, anchorList[i]);
          // A template of little more than its slots joins anything; across runs it has to be all copy.
          if (
            !found ||
            found.how === 'sentences' ||
            (found.match === 'template' && found.sources.every((entry) => staticLength(entry) <= 2) && found.slots.some((slot) => slot.class === 'data'))
          )
            continue;
          const shape = within.every((kind) => kind === 'line') ? 'line' : 'piece';
          for (let k = i; k <= j; k += 1) results[k] = { ...found, line: [k - i + 1, j - i + 1], group: { first: i, text, sep, shape } };
          placed = true;
          break;
        }
      }
      if (placed) {
        i = results[i].group.first + results[i].line[1];
        continue;
      }
      results[i] = singles[i] ?? { class: 'unmapped' };
      i += 1;
    }

    // The same string in each launcher's adapter: the launcher the shot is about (its file name, or the text itself) decides.
    results.forEach((result, i) => {
      if (result.class !== 'copy' || result.how !== 'open' || result.sources.length < 2) return;
      const folders = result.sources.map((entry) => /^src\/main\/launchers\/(\w+)\//.exec(entry.file)?.[1] ?? null);
      if (folders.some((folder) => folder === null) || new Set(folders).size < 2) return;
      const said = `${result.group?.text ?? runs[i].t} ${path}`;
      const named = result.sources.filter((entry, k) => LAUNCHER_WORDS[folders[k]]?.test(said));
      if (named.length === 1) results[i] = { ...result, sources: named, how: 'launcher' };
    });

    // Equal strings no element around the run could tell apart: the nearest neighbour placed in one of their files decides.
    results.forEach((result, i) => {
      if (result.class !== 'copy' || result.how !== 'open' || result.sources.length < 2) return;
      for (let d = 1; d <= 8; d += 1) {
        for (const k of [i - d, i + d]) {
          const near = results[k];
          if (!near || near.class !== 'copy' || near.sources.length !== 1 || near.how === 'open') continue;
          const file = near.sources[0].file;
          const same = result.sources.filter((entry) => entry.file === file);
          if (same.length === 0) continue;
          const line = near.sources[0].line;
          same.sort((a, b) => Math.abs(a.line - line) - Math.abs(b.line - line));
          const closest = same.filter((entry) => Math.abs(entry.line - line) === Math.abs(same[0].line - line));
          if (closest.length === 1) {
            results[i] = { ...result, sources: closest, how: 'neighbour', neighbour: k };
            return;
          }
        }
      }
    });

    const recorded = results.map((result, i) => {
      const run = runs[i];
      const item = { i, t: run.t };
      if (run.volatile) item.volatile = true;
      if (result.class === 'unmapped') return { ...item, class: 'unmapped' };
      if (result.line && result.line[1] > 1) {
        item.line = result.line;
        item.whole = result.group.text;
        if (result.group.sep === '' && result.group.shape === 'line') item.joinedWithout = 'space';
      }
      if (result.class === 'data')
        return { ...item, class: 'data', kind: result.kind, what: result.what, origin: result.origin, ...(result.over ? { equalsCopy: result.over } : {}) };
      const sources = result.sources.map((entry) => (entry.id ? (entry.file ? { id: entry.id, file: entry.file, line: entry.line } : entry) : entry));
      const rec = {
        ...item,
        class: 'copy',
        match: item.line ? result.group.shape : result.match,
        how: result.how,
        sources: sources.map((s) => ({ id: s.id, file: s.file, line: s.line })),
      };
      if (item.line) rec.of = result.match;
      if (result.transform) rec.transform = result.transform;
      if (result.whitespace) rec.whitespace = result.whitespace;
      if (result.slots) rec.slots = result.slots.map((slot) => ({ ...slot, sources: slot.sources?.map((s) => ({ id: s.id, file: s.file, line: s.line })) }));
      if (result.pieces) {
        rec.separator = result.separator;
        rec.pieces = result.pieces;
      }
      if (result.anchor) rec.anchor = result.anchor;
      if (result.neighbour !== undefined) rec.neighbour = result.neighbour;
      markUsed(rec, usedBy);
      if (result.how === 'open' || result.how === 'neighbour' || result.how === 'launcher' || result.how === 'first')
        judgement.push({ sidecar: path, i, t: run.t, how: result.how, sources: rec.sources });
      return rec;
    });
    mapping.push({ sidecar: path, runs: recorded });
  }

  return { walk, entries, origins, mapping, usedBy, judgement, clock, stepTitles: readStepTitles(out), interpret, typescript: TYPESCRIPT_VERSION };
}
