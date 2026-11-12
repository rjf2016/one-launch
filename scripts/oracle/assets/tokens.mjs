import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../lib/out.mjs';
import { cssColor } from '../ui/sidecar.mjs';

export const INDEX_CSS = 'src/renderer/src/index.css';

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

function block(text, opener) {
  const start = text.indexOf(opener);
  if (start === -1) throw new Error(`${INDEX_CSS} has no ${opener} block`);
  const open = text.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return { body: text.slice(open + 1, i), offset: open + 1 };
    }
  }
  throw new Error(`${INDEX_CSS}: ${opener} is not closed`);
}

function declarations(text, { body, offset }) {
  const out = [];
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g))
    out.push({ name: m[1], value: m[2].trim().replace(/\s+/g, ' '), line: lineOf(text, offset + m.index) });
  return out;
}

const kindOf = (name) =>
  name.startsWith('--color-')
    ? 'color'
    : name.startsWith('--radius-')
      ? 'radius'
      : name.startsWith('--shadow-')
        ? 'shadow'
        : name.startsWith('--font-')
          ? 'font'
          : 'other';

const hexOf = (value) => {
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
  if (/^#[0-9a-f]{8}$/i.test(value)) return value.toLowerCase().replace(/ff$/, '');
  if (/^#[0-9a-f]{4}$/i.test(value)) return `#${[...value.slice(1)].map((c) => c + c).join('')}`.toLowerCase().replace(/ff$/, '');
  if (/^#[0-9a-f]{3}$/i.test(value)) return `#${[...value.slice(1)].map((c) => c + c).join('')}`.toLowerCase();
  return cssColor(value);
};

export const fontList = (value) =>
  value
    .split(',')
    .map((family) => family.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);

export function shadowLayers(value) {
  const layers = [];
  let depth = 0;
  let current = '';
  for (const ch of value) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      layers.push(current.trim());
      current = '';
    } else current += ch;
  }
  if (current.trim()) layers.push(current.trim());
  return layers.map((layer) => {
    const colour = /(#[0-9a-f]{3,8}|(?:rgba?|oklab|oklch|color)\([^)]*\))/i.exec(layer);
    const rest = layer.replace(colour?.[0] ?? '', ' ');
    const lengths = [...rest.matchAll(/-?\d*\.?\d+(px)?/g)].map((m) => Number.parseFloat(m[0]));
    while (lengths.length < 4) lengths.push(0);
    return { inset: /\binset\b/.test(layer), x: lengths[0], y: lengths[1], blur: lengths[2], spread: lengths[3], color: colour ? hexOf(colour[0]) : '#000000' };
  });
}

// The design tokens as index.css writes them: the palette on :root, and what @theme inline adds (fonts, the panel radius and shadow).
export function readTokens() {
  const text = readFileSync(join(repoRoot, INDEX_CSS), 'utf8').replace(/\r\n/g, '\n');
  const root = declarations(text, block(text, ':root'));
  const theme = declarations(text, block(text, '@theme inline'));
  const tokens = [];
  for (const d of root) tokens.push({ name: d.name, kind: kindOf(d.name), value: d.value, line: d.line, where: ':root' });
  for (const d of theme) {
    if (/^var\(--[\w-]+\)$/.test(d.value)) continue;
    tokens.push({ name: d.name, kind: kindOf(d.name), value: d.value, line: d.line, where: '@theme inline' });
  }
  const aliases = theme.filter((d) => /^var\(--[\w-]+\)$/.test(d.value)).map((d) => d.name);
  for (const token of tokens) {
    if (token.kind === 'color') token.hex = hexOf(token.value);
    if (token.kind === 'font') token.families = fontList(token.value);
    if (token.kind === 'radius') token.px = Number.parseFloat(token.value);
    if (token.kind === 'shadow') token.layers = shadowLayers(token.value);
  }
  const base = block(text, '@layer base');
  const bodyRule = /body\s*\{([^}]*)\}/.exec(base.body);
  const baseRules = {};
  for (const m of (bodyRule?.[1] ?? '').matchAll(/([\w-]+)\s*:\s*([^;]+);/g)) baseRules[m[1]] = m[2].trim();
  const focus = /:focus-visible\s*\{([^}]*)\}/.exec(base.body);
  const focusRules = {};
  for (const m of (focus?.[1] ?? '').matchAll(/([\w-]+)\s*:\s*([^;]+);/g)) focusRules[m[1]] = m[2].trim();
  return { tokens, aliases, body: baseRules, focusVisible: focusRules };
}

const sameLayers = (a, b) => a.length === b.length && a.every((layer, i) => JSON.stringify(layer) === JSON.stringify(b[i]));
const sameList = (a, b) => a.length === b.length && a.every((item, i) => item === b[i]);

// One token against what the running page gave for it. A colour is compared as #rrggbb(aa), a shadow layer by layer, a font
// list family by family, a radius in px: the browser writes each in its own notation.
export function compareToken(token, seen) {
  if (!seen) return { equal: false, how: 'not read from the page' };
  if (token.kind === 'color') {
    const computed = cssColor(seen.computed);
    const custom = seen.custom ? hexOf(seen.custom) : null;
    return {
      equal: computed === token.hex && (custom === null || custom === token.hex),
      how: 'getComputedStyle colour and the custom property, both as #rrggbb(aa)',
      computedHex: computed,
      customHex: custom,
    };
  }
  if (token.kind === 'radius') {
    const px = Number.parseFloat(seen.computed);
    return { equal: px === token.px, how: 'border-top-left-radius in px', computedPx: px };
  }
  if (token.kind === 'shadow') {
    const empty = (layer) => /^#[0-9a-f]{6}00$/.test(layer.color) && layer.x === 0 && layer.y === 0 && layer.blur === 0 && layer.spread === 0;
    const layers = shadowLayers(seen.computed).filter((layer) => !empty(layer));
    return {
      equal: sameLayers(layers, token.layers),
      how: 'box-shadow layer by layer (colour as hex, offsets, blur, spread, inset), without the transparent zero-size layers Tailwind composes a shadow with',
      computedLayers: layers,
    };
  }
  if (token.kind === 'font') {
    const families = fontList(seen.computed);
    return { equal: sameList(families, token.families), how: 'font-family family by family, quotes dropped', computedFamilies: families };
  }
  return { equal: seen.custom === token.value, how: 'the custom property as text' };
}

export function compareTokens(tokens, runtime) {
  const byName = new Map(runtime.tokens.map((t) => [t.name, t]));
  return tokens.map((token) => {
    const seen = byName.get(token.name);
    return { ...token, runtime: { custom: seen?.custom ?? null, computed: seen?.computed ?? null, via: seen?.via ?? null, ...compareToken(token, seen) } };
  });
}
