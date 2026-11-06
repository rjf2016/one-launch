// Writes build/THIRD-PARTY-NOTICES.txt (shipped next to the exe) and build/license.txt (the installer's licence page).
//   node scripts/third-party-notices.mjs   writes both files (gitignored); build, build:installer and the workflows run it before electron-builder
//
// What ships is worked out, not listed by hand: the production dependencies in package.json, plus every
// package the source under src/ imports (the renderer bundle carries those), plus what they depend on
// according to package-lock.json. Electron and Chromium bring their own licence files.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOTICES = join(root, 'build', 'THIRD-PARTY-NOTICES.txt');
const LICENCE_PAGE = join(root, 'build', 'license.txt');

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const lf = (text) => text.replace(/\r\n?/g, '\n');

const pkg = readJson(join(root, 'package.json'));
const lock = readJson(join(root, 'package-lock.json'));
const declared = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx|css)$/.test(e.name) ? [full] : [];
  });
}

/** 'react-dom/client' -> 'react-dom', '@scope/name/x' -> '@scope/name'. */
const packageOf = (specifier) =>
  specifier
    .split('/')
    .slice(0, specifier.startsWith('@') ? 2 : 1)
    .join('/');

function importedPackages() {
  const found = new Set();
  const pattern = /(?:from|import)\s+['"]([^'"]+)['"]/g;
  for (const file of sourceFiles(join(root, 'src'))) {
    for (const match of readFileSync(file, 'utf8').matchAll(pattern)) {
      const name = packageOf(match[1]);
      // electron ships as the runtime itself, with LICENSE.electron.txt and LICENSES.chromium.html beside the exe.
      if (declared.has(name) && name !== 'electron') found.add(name);
    }
  }
  return found;
}

/** npm's own lookup: the nearest node_modules above the dependent that holds the package. */
function resolveInLock(name, fromPath) {
  let base = fromPath;
  for (;;) {
    const candidate = `${base ? `${base}/` : ''}node_modules/${name}`;
    if (lock.packages[candidate]) return candidate;
    if (!base) return null;
    const cut = base.lastIndexOf('/node_modules/');
    base = cut === -1 ? '' : base.slice(0, cut);
  }
}

function shippedPackages() {
  const queue = [...new Set([...Object.keys(pkg.dependencies ?? {}), ...importedPackages()])].map((name) => resolveInLock(name, ''));
  const seen = new Set();
  while (queue.length > 0) {
    const path = queue.shift();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const entry = lock.packages[path];
    for (const dep of Object.keys({ ...entry.dependencies, ...entry.optionalDependencies })) queue.push(resolveInLock(dep, path));
  }
  return [...seen];
}

const MIT_TERMS = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

// Packages whose published tarball has no licence file: the licence their package.json declares, written out, keyed by name and that declaration.
const WRITTEN_OUT = {
  'lazy-val': { license: 'MIT', text: `MIT License\n\nCopyright (c) Vladimir Krivosheev\n\n${MIT_TERMS}` },
};

function describe(path) {
  const dir = join(root, path);
  if (!existsSync(dir)) throw new Error(`${path} is in package-lock.json but not installed; run npm ci first`);
  const meta = readJson(join(dir, 'package.json'));
  const licenceFile = readdirSync(dir)
    .filter((f) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(f))
    .sort()[0];
  const written = WRITTEN_OUT[meta.name];
  if (!licenceFile && written?.license !== meta.license) throw new Error(`${meta.name} has no licence file; add its text to this script by hand`);
  const repo = typeof meta.repository === 'string' ? meta.repository : (meta.repository?.url ?? meta.homepage ?? '');
  return {
    name: meta.name,
    version: meta.version,
    licence: typeof meta.license === 'string' ? meta.license : 'see below',
    source: repo.replace(/^git\+/, '').replace(/\.git$/, ''),
    text: licenceFile ? lf(readFileSync(join(dir, licenceFile), 'utf8')).trim() : written.text,
  };
}

function notices() {
  const packages = shippedPackages()
    .map(describe)
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const rule = '='.repeat(78);
  const out = [
    'One Launch: third-party notices',
    '',
    'One Launch is built with the open-source software listed below. Each entry gives',
    'the version that ships in this build and the licence it is used under.',
    '',
    'Generated by scripts/third-party-notices.mjs from package-lock.json; do not edit by hand.',
    '',
    `Packages: ${packages.map((p) => p.name).join(', ')}.`,
    '',
    rule,
    'Electron and Chromium',
    rule,
    '',
    'One Launch runs on Electron, which contains Chromium and Node.js. Their licences',
    'are in LICENSE.electron.txt and LICENSES.chromium.html, in the same folder as',
    'OneLaunch.exe.',
    '',
    rule,
    'SQLite',
    rule,
    '',
    'better-sqlite3 contains SQLite, which its authors have dedicated to the public',
    'domain: https://www.sqlite.org/copyright.html',
    '',
  ];
  for (const p of packages) {
    out.push(rule, `${p.name} ${p.version}`, `Licence: ${p.licence}`);
    if (p.source) out.push(`Source: ${p.source}`);
    out.push(rule, '', p.text, '');
  }
  return `${out.join('\n')}\n`;
}

function licencePage() {
  const own = lf(readFileSync(join(root, 'LICENSE'), 'utf8')).trim();
  return `${own}\n\n----\n\nOne Launch includes third-party software. The licences are installed next to\nOneLaunch.exe: THIRD-PARTY-NOTICES.txt, LICENSE.electron.txt, and\nLICENSES.chromium.html.\n`;
}

const wanted = [
  [NOTICES, notices()],
  [LICENCE_PAGE, licencePage()],
];

for (const [file, text] of wanted) writeFileSync(file, text);
console.log(`Wrote ${wanted.map(([file]) => file).join(' and ')}`);
