import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../lib/out.mjs';

export const COMPILED_CSS_DIR = 'out/renderer/assets';
export const COMPILED_CSS_NAME = 'assets/renderer.css';

export function compiledCss() {
  const names = readdirSync(join(repoRoot, COMPILED_CSS_DIR)).filter((n) => /^index-[\w-]+\.css$/.test(n));
  if (names.length !== 1) throw new Error(`expected one ${COMPILED_CSS_DIR}/index-*.css, found ${names.length}`);
  return { built: `${COMPILED_CSS_DIR}/${names[0]}`, path: join(repoRoot, COMPILED_CSS_DIR, names[0]) };
}

export const signatureOf = (element) => `${element.tag} ${[...new Set(element.cls.split(/\s+/).filter(Boolean))].sort().join(' ')}`.trim();

const byCount = (a, b) => b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

function tally(map, key, make) {
  if (!map.has(key)) map.set(key, { key, count: 0, ...make() });
  const item = map.get(key);
  item.count += 1;
  return item;
}

// What the sidecars saw, grouped: each element by its tag and the set of classes on it, each text run by its font and colour.
export function aggregateStyles(sidecars) {
  const signatures = new Map();
  const text = new Map();
  for (const { path, sidecar } of sidecars) {
    for (const element of sidecar.elements) {
      const item = tally(signatures, signatureOf(element), () => ({
        tag: element.tag,
        classes: signatureOf(element).split(' ').slice(1),
        roles: new Map(),
        styles: new Map(),
        shots: new Set(),
      }));
      item.roles.set(element.role, (item.roles.get(element.role) ?? 0) + 1);
      const style = JSON.stringify(element.style);
      item.styles.set(style, (item.styles.get(style) ?? 0) + 1);
      item.shots.add(path);
    }
    for (const run of sidecar.text) {
      const key = JSON.stringify({
        font: run.font,
        color: run.color,
        ...(run.tracking !== undefined ? { tracking: run.tracking } : {}),
        ...(run.deco ? { deco: run.deco } : {}),
      });
      tally(text, key, () => JSON.parse(key));
    }
  }
  const sortedEntries = (map) => [...map].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return {
    signatures: [...signatures.values()].sort(byCount).map((item) => ({
      signature: item.key,
      tag: item.tag,
      classes: item.classes,
      count: item.count,
      shots: item.shots.size,
      roles: Object.fromEntries(sortedEntries(item.roles)),
      styles: sortedEntries(item.styles).map(([style, count]) => ({ count, style: JSON.parse(style) })),
    })),
    text: [...text.values()].sort(byCount).map(({ key, ...rest }) => rest),
  };
}
