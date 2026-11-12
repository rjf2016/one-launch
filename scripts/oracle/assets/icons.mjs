import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { repoRoot } from '../lib/out.mjs';

const require = createRequire(join(repoRoot, 'package.json'));

export const ICONS_DIR = 'assets/icons';
export const LUCIDE_DIR = `${ICONS_DIR}/lucide`;

export function packageVersion(name) {
  return JSON.parse(readFileSync(require.resolve(`${name}/package.json`), 'utf8')).version;
}

// Each icon as the app's own React and lucide-react render it with no props: the package defaults (24 px, stroke 2, currentColor).
export function renderLucide(names) {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const lucide = require('lucide-react');
  const out = new Map();
  for (const name of names) {
    const Icon = lucide[name];
    if (!Icon) throw new Error(`lucide-react ${packageVersion('lucide-react')} has no export named ${name}`);
    out.set(name, `${renderToStaticMarkup(React.createElement(Icon))}\n`);
  }
  return out;
}

export function iconIndex(lucideImports, svgs) {
  const byName = new Map();
  for (const imp of lucideImports) {
    if (!byName.has(imp.imported)) byName.set(imp.imported, { imports: [], uses: [] });
    const item = byName.get(imp.imported);
    item.imports.push({ file: imp.file, line: imp.line, ...(imp.local !== imp.imported ? { as: imp.local } : {}) });
    item.uses.push(...imp.uses);
  }
  const names = [...byName.keys()].sort();
  return names.map((name) => {
    const { imports, uses } = byName.get(name);
    const svg = svgs.get(name);
    const lucideClass = /class="([^"]*)"/.exec(svg)?.[1] ?? '';
    const sizes = [...new Set(uses.filter((u) => u.as === 'element').map((u) => sizeOf(u.props)))].sort();
    const strokes = [...new Set(uses.filter((u) => u.as === 'element' && u.props.strokeWidth !== undefined).map((u) => String(u.props.strokeWidth)))].sort();
    return {
      name,
      file: `${LUCIDE_DIR}/${name}.svg`,
      class: lucideClass,
      imports: imports.sort(byPlace),
      uses: uses.sort(byPlace),
      sizes,
      strokeWidths: strokes,
    };
  });
}

const byPlace = (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line);

// How big the icon is drawn: a Tailwind size class on it, a size prop, or the 24 px default.
function sizeOf(props) {
  if (props.size !== undefined) return `size=${props.size}`;
  const cls = typeof props.className === 'string' ? props.className : '';
  const m = /(?:^|\s)(size-[\w.[\]]+|[hw]-[\w.[\]]+)/.exec(cls);
  if (m) return m[1];
  if (cls.startsWith('{')) return `className=${cls}`;
  return 'none on the element';
}
