import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { sha256 } from '../lib/bundle.mjs';
import { repoRoot, writeArtefact } from '../lib/out.mjs';
import { RUNTIME_FILE } from './runtime-files.mjs';
import { buildCopy, markUsed } from './copy.mjs';
import { ICONS_DIR, LUCIDE_DIR, iconIndex, packageVersion, renderLucide } from './icons.mjs';
import { COMPILED_CSS_NAME, aggregateStyles, compiledCss } from './styles.mjs';
import { INDEX_CSS, compareTokens, readTokens } from './tokens.mjs';

const require = createRequire(join(repoRoot, 'package.json'));
const here = import.meta.dirname;

export const ICO_SOURCE = 'dist/.icon-ico/icon.ico';
export const ICO_FILE = `${ICONS_DIR}/app.ico`;
export const WHATS_NEW_SOURCE_DIR = 'src/renderer/src/assets/whats-new';

const strip = ({ id, file, line, col, kind, text, parts, slots, context, process, holder, visible }) => ({
  id,
  file,
  line,
  col,
  kind,
  text,
  ...(parts ? { parts, slots } : {}),
  context,
  process,
  ...(holder ? { holder } : {}),
  visible,
});

export function icoImages(bytes) {
  const count = bytes.readUInt16LE(4);
  const images = [];
  for (let i = 0; i < count; i += 1) {
    const at = 6 + i * 16;
    const size = bytes.readUInt32LE(at + 8);
    const offset = bytes.readUInt32LE(at + 12);
    images.push({
      width: bytes[at] || 256,
      height: bytes[at + 1] || 256,
      bitsPerPixel: bytes.readUInt16LE(at + 6),
      bytes: size,
      png: bytes.subarray(offset, offset + 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    });
  }
  return images;
}

function copyArtefacts(out) {
  const built = buildCopy(out);
  const runs = built.mapping.flatMap((m) => m.runs);
  const count = (pick) => {
    const tally = {};
    for (const item of runs) {
      const key = pick(item);
      if (key) tally[key] = (tally[key] ?? 0) + 1;
    }
    return Object.fromEntries(Object.entries(tally).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)));
  };
  const titlesUse = new Map();
  const titleMap = built.stepTitles.map((step) => {
    const found = built.interpret(step.title, []);
    if (!found) return { ...step, class: 'unmapped' };
    if (found.class === 'data') return { ...step, class: 'data', kind: found.kind, origin: found.origin };
    let sources = found.sources;
    let how = found.how;
    if (how === 'open') {
      // A step title is made in main; of equal adapters', the launcher every script that shows it plays decides.
      const fromMain = sources.filter((s) => s.process === 'main');
      if (fromMain.length > 0 && fromMain.length < sources.length) [sources, how] = [fromMain, fromMain.length === 1 ? 'main' : how];
      const launchers = new Set(step.scripts.map((name) => /^play-(steam|epic|battlenet|riot)$/.exec(name)?.[1] ?? null));
      const only = launchers.size === 1 ? [...launchers][0] : null;
      const named = only ? sources.filter((s) => s.file.startsWith(`src/main/launchers/${only}/`)) : [];
      if (sources.length > 1 && named.length === 1) [sources, how] = [named, 'launcher'];
    }
    const rec = {
      ...step,
      class: 'copy',
      match: found.match,
      how,
      sources: sources.map((s) => ({ id: s.id, file: s.file, line: s.line })),
      ...(found.slots
        ? { slots: found.slots.map((slot) => ({ ...slot, sources: slot.sources?.map((s) => ({ id: s.id, file: s.file, line: s.line })) })) }
        : {}),
      ...(found.pieces ? { separator: found.separator, pieces: found.pieces } : {}),
    };
    markUsed(rec, titlesUse);
    return rec;
  });
  const kept = built.entries.filter((entry) => entry.visible || built.usedBy.has(entry.id) || titlesUse.has(entry.id));
  const strings = kept.map((entry) => ({
    ...strip(entry),
    observed: built.usedBy.get(entry.id) ?? 0,
    ...(titlesUse.has(entry.id) ? { stepTitles: titlesUse.get(entry.id) } : {}),
  }));
  const byKind = {};
  for (const entry of strings) byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1;
  const dataSeen = new Map();
  for (const item of runs) {
    if (item.class !== 'data') continue;
    const key = `${item.kind}\u0000${item.whole ?? item.t}`;
    if (!dataSeen.has(key)) dataSeen.set(key, { text: item.whole ?? item.t, kind: item.kind, what: item.what, origin: item.origin, runs: 0 });
    dataSeen.get(key).runs += 1;
  }
  const observedData = [...dataSeen.values()].sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
  const copy = {
    generator: 'scripts/oracle/assets/assets.gen.ts',
    typescript: built.typescript,
    walked: 'every .ts and .tsx file under src/, without .d.ts',
    counts: {
      strings: strings.length,
      byKind,
      visible: strings.filter((s) => s.visible).length,
      observedInShots: strings.filter((s) => s.observed > 0).length,
      observedData: observedData.length,
      stepTitles: titleMap.length,
    },
    strings,
    observedData,
    stepTitles: titleMap,
  };
  const judgement = built.judgement;
  const map = {
    generator: 'scripts/oracle/assets/assets.gen.ts',
    clock: built.clock,
    counts: {
      sidecars: built.mapping.length,
      runs: runs.length,
      byClass: count((r) => r.class),
      copyByMatch: count((r) => (r.class === 'copy' ? r.match : null)),
      copyByHow: count((r) => (r.class === 'copy' ? r.how : null)),
      dataByKind: count((r) => (r.class === 'data' ? r.kind : null)),
      judgementCalls: judgement.length,
    },
    sidecars: built.mapping,
  };
  return { copy, map };
}

export async function generateAssets(out, { WHATS_NEW, BrandMark }) {
  const { copy, map } = copyArtefacts(out);
  writeArtefact(out, 'assets/copy.json', copy);
  writeArtefact(out, 'assets/copy-map.json', map);

  const { walkSource } = await import('./source.mjs');
  const walk = walkSource();
  const names = [...new Set(walk.lucide.map((l) => l.imported))].sort();
  const svgs = renderLucide(names);
  for (const [name, svg] of svgs) writeArtefact(out, `${LUCIDE_DIR}/${name}.svg`, svg);
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const brand = `${renderToStaticMarkup(React.createElement(BrandMark))}\n`;
  writeArtefact(out, `${ICONS_DIR}/brand-mark.svg`, brand);
  for (const name of ['icon.svg', 'icon-mono.svg']) writeArtefact(out, `${ICONS_DIR}/build-${name}`, readFileSync(join(repoRoot, 'build', name)));
  const ico = existsSync(join(repoRoot, ICO_SOURCE)) ? readFileSync(join(repoRoot, ICO_SOURCE)) : null;
  if (ico) writeArtefact(out, ICO_FILE, ico);
  writeArtefact(out, `${ICONS_DIR}/index.json`, {
    lucide: {
      package: 'lucide-react',
      version: packageVersion('lucide-react'),
      react: packageVersion('react'),
      reactDom: packageVersion('react-dom'),
      rendered: 'react-dom/server renderToStaticMarkup of each export with no props: the package defaults (24 px box, stroke 2, currentColor)',
      distinctImports: names.length,
      icons: iconIndex(walk.lucide, svgs),
    },
    brandMark: {
      file: `${ICONS_DIR}/brand-mark.svg`,
      source: 'src/renderer/src/components/BrandMark.tsx, rendered with no className',
      same: [`${ICONS_DIR}/build-icon-mono.svg`],
    },
    buildIcons: ['icon.svg', 'icon-mono.svg'].map((name) => ({ file: `${ICONS_DIR}/build-${name}`, source: `build/${name}` })),
    appIco: ico
      ? {
          file: ICO_FILE,
          source: ICO_SOURCE,
          from: 'an existing packaged build output (electron-builder writes it from build/icon.png); not rebuilt here',
          sha256: sha256(ico),
          images: icoImages(ico),
        }
      : null,
    tray: { folder: `${ICONS_DIR}/tray`, made: 'by capture.mjs (tray.cjs under Electron); see tray/tray.json' },
  });

  const tokens = readTokens();
  const runtimePath = join(out, RUNTIME_FILE);
  const runtime = existsSync(runtimePath) ? JSON.parse(readFileSync(runtimePath, 'utf8')) : null;
  writeArtefact(out, 'assets/tokens.json', {
    source: INDEX_CSS,
    tokens: runtime ? compareTokens(tokens.tokens, runtime) : tokens.tokens,
    themeAliases: tokens.aliases,
    body: tokens.body,
    focusVisible: tokens.focusVisible,
    runtime: runtime ? { file: RUNTIME_FILE, electron: runtime.electron, body: runtime.body } : null,
  });

  const { readSidecars } = await import('./copy.mjs');
  const css = compiledCss();
  const cssBytes = readFileSync(css.path);
  writeArtefact(out, COMPILED_CSS_NAME, cssBytes);
  writeArtefact(out, 'assets/styles.json', {
    from: 'the elements and text runs of every layout sidecar under ui/shots',
    compiledCss: { file: COMPILED_CSS_NAME, built: css.built, sha256: sha256(cssBytes) },
    states: 'assets/states.json',
    ...aggregateStyles(readSidecars(out)),
  });

  const images = [];
  for (const release of WHATS_NEW) {
    if (!release.image) continue;
    const bytes = readFileSync(join(repoRoot, WHATS_NEW_SOURCE_DIR, release.image.file));
    writeArtefact(out, `assets/whats-new/${release.image.file}`, bytes);
    images.push({ file: `assets/whats-new/${release.image.file}`, source: `${WHATS_NEW_SOURCE_DIR}/${release.image.file}`, sha256: sha256(bytes) });
  }
  writeArtefact(out, 'assets/whats-new.json', {
    source: 'src/shared/whats-new-releases.ts (WHATS_NEW), newest first',
    dateFormat:
      'formatReleaseDate in src/renderer/src/components/WhatsNewDialog.tsx: toLocaleDateString with year numeric, month long, day numeric (en-US: "October 15, 2026")',
    releases: WHATS_NEW,
    images,
  });

  const licence = readFileSync(join(repoRoot, 'LICENSE'), 'utf8').replace(/\r\n/g, '\n');
  writeArtefact(out, 'assets/LICENSE.txt', licence);
  const licencePage = readFileSync(join(repoRoot, 'build', 'license.txt'), 'utf8').replace(/\r\n/g, '\n');
  writeArtefact(out, 'assets/installer-licence-page.txt', licencePage);
  writeArtefact(out, 'assets/notices.json', {
    licence: { file: 'assets/LICENSE.txt', source: 'LICENSE', spdx: 'MIT' },
    electronInstallerPage: {
      file: 'assets/installer-licence-page.txt',
      source: 'build/license.txt as scripts/third-party-notices.mjs last wrote it (gitignored, not run here)',
      shape: 'the MIT licence, a line of four dashes, then where the third-party licences are installed',
    },
    rustInstallerMustCarry: [
      'The MIT licence text of One Launch, exactly as assets/LICENSE.txt holds it.',
      'Where the program is installed (the install folder), so the user can find the licence files next to the exe.',
    ],
    notCarried:
      'The Electron build lists npm packages, Electron and Chromium (THIRD-PARTY-NOTICES.txt, LICENSE.electron.txt, LICENSES.chromium.html). Those are specific to the npm build; the design says the Rust installer carries only the MIT text and the install location.',
  });

  writeArtefact(out, 'assets/README.md', readFileSync(join(here, 'bundle', 'README.md')));
}
