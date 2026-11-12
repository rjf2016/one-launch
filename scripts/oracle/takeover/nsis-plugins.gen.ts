import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'vitest';
import { repoRoot, resolveOut, writeArtefact } from '../lib/out.mjs';

const CACHE = join(process.env['LOCALAPPDATA'] ?? '', 'electron-builder', 'Cache');
const TOOLSETS = join(repoRoot, 'node_modules', 'app-builder-lib', 'out', 'toolsets', 'windows.js');
const NSIS = { bundle: 'nsis-3.0.4.1' };
const RESOURCES = { bundle: 'nsis-resources-3.4.1' };
const TEMPLATES = join(repoRoot, 'node_modules', 'app-builder-lib', 'templates', 'nsis');
const ARCH = 'x86-unicode';

const sri = (bytes: Buffer): string => `sha256-${createHash('sha256').update(bytes).digest('base64')}`;

function pinnedArchiveDigest(bundle: string): string {
  const text = readFileSync(TOOLSETS, 'utf8');
  const name = bundle.replace(/\./g, '\\.');
  const m = new RegExp(`getBinFromUrl\\)\\("${name}", "${name}\\.7z", "([0-9a-f]{64})"\\)`).exec(text);
  if (!m) throw new Error(`windows.js pins no checksum for ${bundle}`);
  return `sha256-${Buffer.from(m[1]!, 'hex').toString('base64')}`;
}

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))
    .sort();

function unpacked(bundle: string): string {
  const dir = join(CACHE, bundle);
  const inner = readdirSync(dir, { withFileTypes: true }).find((e) => e.isDirectory() && e.name.startsWith(`${bundle}-`));
  if (!inner) throw new Error(`no unpacked ${bundle} in the electron-builder cache`);
  return join(dir, inner.name);
}

function fileVersions(paths: string[]): string[] {
  const script =
    '$input | ForEach-Object { $v = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($_); "$($v.FileVersion)|$($v.ProductName)|$($v.LegalCopyright)" }';
  const text = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: paths.join('\n'),
    encoding: 'utf8',
    windowsHide: true,
  });
  return text.split(/\r?\n/).slice(0, paths.length);
}

const LICENCES: Record<string, string> = {
  StdUtils: 'LGPL-2.1-or-later as stated in the header that ships with it (templates/nsis/include/StdUtils.nsh:3-19); no licence file beside the DLL',
  nsis7z: 'not stated in any file of the cached bundle; not determined here (wraps 7-Zip code)',
  UAC: 'not stated in any file of the cached bundle; not determined here',
  WinShell: 'not stated in any file of the cached bundle; not determined here',
  nsProcess: 'not stated in any file of the cached bundle; not determined here',
  SpiderBanner: 'not stated in any file of the cached bundle; not determined here',
  nsisunz: 'not stated in any file of the cached bundle; not determined here',
  INetC: 'not stated in any file of the cached bundle; not determined here',
  EmbedHTML: 'not stated in any file of the cached bundle; not determined here',
};
const NSIS_LICENCE = `zlib/libpng, from the COPYING file of the ${NSIS.bundle} bundle ("All NSIS source code, plug-ins ... are licensed under the zlib/libpng license"); LZMA module CPL-1.0, bzip2 module bzip2 licence`;

test('NSIS plugin inventory', () => {
  if (!existsSync(CACHE)) throw new Error('the electron-builder cache is not on this machine; this inventory needs an earlier packaged build');
  const calls = new Map<string, string[]>();
  const sources = [...walk(TEMPLATES).filter((f) => /\.(nsh|nsi)$/.test(f)), join(repoRoot, 'build', 'installer.nsh')];
  for (const file of sources) {
    const rel = file.startsWith(TEMPLATES) ? `templates/${relative(TEMPLATES, file).replace(/\\/g, '/')}` : 'build/installer.nsh';
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .forEach((line, i) => {
        if (/^\s*[;#]/.test(line)) return;
        for (const m of line.matchAll(/(?<![\w$])([A-Za-z]\w*)::(\w+)/g)) {
          const plugin = m[1]!;
          if (!calls.has(plugin)) calls.set(plugin, []);
          calls.get(plugin)!.push(`${rel}:${i + 1} ${m[1]}::${m[2]}`);
        }
      });
  }

  const resources = join(unpacked(RESOURCES.bundle), 'plugins', ARCH);
  const nsis = unpacked(NSIS.bundle);
  const core = join(nsis, 'Plugins', ARCH);
  const entries = [
    ...readdirSync(resources)
      .filter((f) => f.endsWith('.dll'))
      .map((f) => ({
        bundle: RESOURCES.bundle,
        path: join(resources, f),
        shown: `{electron-builder-cache}\\${RESOURCES.bundle}\\<unpacked>\\plugins\\${ARCH}\\${f}`,
      })),
    ...readdirSync(core)
      .filter((f) => f.endsWith('.dll'))
      .map((f) => ({ bundle: NSIS.bundle, path: join(core, f), shown: `{electron-builder-cache}\\${NSIS.bundle}\\<unpacked>\\Plugins\\${ARCH}\\${f}` })),
    ...['Bin\\makensis.exe', 'elevate.exe'].map((f) => ({
      bundle: NSIS.bundle,
      path: join(nsis, f),
      shown: `{electron-builder-cache}\\${NSIS.bundle}\\<unpacked>\\${f}`,
    })),
  ];
  const versions = fileVersions(entries.map((e) => e.path));
  const plugins = entries.map((e, i) => {
    const file = e.path.split('\\').pop()!;
    const name = file.replace(/\.(dll|exe)$/i, '');
    const [fileVersion, productName, copyright] = (versions[i] ?? '||').split('|');
    const key = Object.keys(LICENCES).find((k) => k.toLowerCase() === name.toLowerCase());
    const used = [...calls.entries()].find(([p]) => p.toLowerCase() === name.toLowerCase())?.[1] ?? [];
    return {
      name,
      file,
      bundle: e.bundle,
      location: e.shown,
      digest: sri(readFileSync(e.path)),
      fileVersion: fileVersion || null,
      productName: productName || null,
      legalCopyright: copyright ? copyright.replace(/\s*<[^>]*@[^>]*>/g, '') : null,
      licence: e.bundle === NSIS.bundle ? NSIS_LICENCE : (key && LICENCES[key]) || 'not stated in any file of the cached bundle; not determined here',
      mentionedAt: used,
      vendored: false,
    };
  });
  writeArtefact(resolveOut(), 'takeover/nsis/plugins.json', {
    note: 'No binary is vendored. Digests are SRI strings (sha256- then the standard base64 of the SHA-256), read from the electron-builder cache this machine holds after an earlier packaged build.',
    bundles: [
      {
        name: NSIS.bundle,
        archive: `${NSIS.bundle}.7z`,
        archiveDigest: pinnedArchiveDigest(NSIS.bundle),
        source: 'node_modules/app-builder-lib/out/toolsets/windows.js:154-158',
      },
      {
        name: RESOURCES.bundle,
        archive: `${RESOURCES.bundle}.7z`,
        archiveDigest: pinnedArchiveDigest(RESOURCES.bundle),
        source: 'node_modules/app-builder-lib/out/toolsets/windows.js:159-161',
      },
    ],
    pluginArch: { value: ARCH, source: 'node_modules/app-builder-lib/out/targets/nsis/NsisTarget.js:582-586' },
    plugins,
  });
});
