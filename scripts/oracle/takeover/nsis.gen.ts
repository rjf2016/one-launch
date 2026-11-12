import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'vitest';
import { repoRoot, resolveOut, writeArtefact } from '../lib/out.mjs';
import { INSTALLER_GUID } from '../../../src/main/updates/availability';

const TEMPLATES = join(repoRoot, 'node_modules', 'app-builder-lib', 'templates', 'nsis');
const BUILDER_PACKAGE = join(repoRoot, 'node_modules', 'app-builder-lib', 'package.json');
const ELECTRON_BUILDER_NS = '50e065bc-3134-11e6-9bab-38c9862bdaf3';
const NSIS_TARGET = 'node_modules/app-builder-lib/out/targets/nsis/NsisTarget.js';

// Templates recorded by digest instead of copied; drop an entry to vendor that file.
const HELD_BACK: Record<string, { licence: string; why: string }> = {
  'include/StdUtils.nsh': {
    licence: 'LGPL-2.1-or-later, as its header (lines 3-19) states',
    why: "Its licence header carries the plug-in author's real contact address, and whether an LGPL file is vendored here is the owner's decision; read it from node_modules/app-builder-lib/templates/nsis/include/StdUtils.nsh in the Electron repo at the pin.",
  },
};

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))
    .sort();

function uuidV5(name: string, namespace: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1')
    .update(Buffer.concat([ns, Buffer.from(name, 'utf8')]))
    .digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function yamlScalar(text: string, key: string, indent = ''): string {
  const m = new RegExp(`^${indent}${key}:\\s*(.+?)\\s*$`, 'm').exec(text);
  if (!m) throw new Error(`electron-builder.yml has no ${key}`);
  return m[1]!.replace(/^'(.*)'$/, '$1');
}

const nsisEscape = (s: string): string =>
  s
    .replace(/\r\n|\r|\n/g, ' ')
    .replace(/\$(?!\{)/g, '$$$$')
    .replace(/"/g, '$\\"');

test('vendored NSIS templates and effective defines', () => {
  const out = resolveOut();
  const files = walk(TEMPLATES);
  const heldBack = [];
  for (const file of files) {
    const rel = relative(TEMPLATES, file).replace(/\\/g, '/');
    const bytes = readFileSync(file);
    const held = HELD_BACK[rel];
    if (!held) {
      writeArtefact(out, `takeover/nsis/templates/${rel}`, bytes);
      continue;
    }
    heldBack.push({
      path: `templates/nsis/${rel}`,
      package: 'app-builder-lib',
      version: (JSON.parse(readFileSync(BUILDER_PACKAGE, 'utf8')) as { version: string }).version,
      bytes: bytes.length,
      digest: `sha256-${createHash('sha256').update(bytes).digest('base64')}`,
      ...held,
    });
  }
  const missing = Object.keys(HELD_BACK).filter((rel) => !heldBack.some((h) => h.path === `templates/nsis/${rel}`));
  if (missing.length > 0) throw new Error(`held-back templates not in the package: ${missing.join(', ')}`);
  writeArtefact(out, 'takeover/nsis/templates-held-back.json', {
    note: 'Templates of the package that are recorded here by digest and not copied under templates/. Every other template is copied byte for byte.',
    files: heldBack,
  });
  writeArtefact(out, 'takeover/nsis/build/installer.nsh', readFileSync(join(repoRoot, 'build', 'installer.nsh')));
  for (const name of ['builder-debug.yml', 'builder-effective-config.yaml'])
    writeArtefact(out, `takeover/nsis/dist/${name}`, readFileSync(join(repoRoot, 'dist', name)));

  const builder = JSON.parse(readFileSync(BUILDER_PACKAGE, 'utf8')) as { version: string; license: string };
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { name: string; version: string; description: string; author: string };
  const yml = readFileSync(join(repoRoot, 'electron-builder.yml'), 'utf8');
  const appId = yamlScalar(yml, 'appId');
  const productName = yamlScalar(yml, 'productName');
  const executableName = yamlScalar(yml, 'executableName');
  const copyright = yamlScalar(yml, 'copyright');
  const artifactName = yamlScalar(yml, 'artifactName', '  ').replace('${version}', pkg.version).replace('${ext}', 'exe');
  const guid = uuidV5(appId, ELECTRON_BUILDER_NS);
  if (guid !== INSTALLER_GUID) throw new Error('the derived GUID is not the one src/main/updates/availability.ts pins');
  if (!/^[-_+0-9a-zA-Z .]+$/.test(executableName)) throw new Error('APP_FILENAME would fall back to the package name');
  const sanitizedName = pkg.name;
  const archive = `${sanitizedName}-${pkg.version}-x64.nsis.7z`;
  const uninstallerOut = `{dist}\\${artifactName.replace(/exe$/, '')}__uninstaller.exe`;

  const at = (line: number | string): string => `${NSIS_TARGET}:${line}`;
  const defines: [string, string | null, string, string][] = [
    ['APP_ID', appId, at(160), 'electron-builder.yml appId'],
    ['APP_GUID', guid, at('157,161'), 'UUIDv5 of appId in the electron-builder namespace; equals INSTALLER_GUID in src/main/updates/availability.ts:7'],
    ['UNINSTALL_APP_KEY', guid.replace(/\\/g, ' - '), at('158,163'), 'the GUID has no backslash, so UNINSTALL_REGISTRY_KEY_2 is not defined (line 176)'],
    ['PRODUCT_NAME', productName, at(164), 'electron-builder.yml productName'],
    ['PRODUCT_FILENAME', executableName, at(165), 'electron-builder.yml executableName'],
    ['APP_FILENAME', executableName, at(166), 'getWindowsInstallationDirName with oneClick false: the product file name, since it matches ^[-_+0-9a-zA-Z .]+$'],
    ['APP_DESCRIPTION', pkg.description, at(167), 'package.json description'],
    ['VERSION', pkg.version, at(168), 'package.json version at the pin; the uninstaller pass gets the same value (no shortVersion)'],
    ['PROJECT_DIR', '{project}', at(169), 'placeholder: the repo folder of the build'],
    ['BUILD_RESOURCES_DIR', '{project}\\build', at(170), 'placeholder: directories.buildResources'],
    ['APP_PACKAGE_NAME', sanitizedName, at(171), 'package.json name'],
    ['MUI_ICON', '{icon}', at('191-198'), 'placeholder: build/installerIcon.ico is absent, so the app icon electron-builder converts to .ico at build time'],
    ['MUI_UNICON', '{icon}', at('191-198'), 'placeholder: as MUI_ICON; no build/uninstallerIcon.ico (line 466)'],
    ['APP_64', `{dist}\\${archive}`, at('79,216-217'), 'placeholder folder: the 7z archive of win-unpacked'],
    ['APP_64_NAME', archive, at('219-220'), ''],
    ['APP_64_HASH', '{archive-sha512-hex-upper}', at('223-224'), 'placeholder: build output'],
    ['APP_64_UNPACKED_SIZE', '{ceil(unpacked-bytes/1024)}', at('227-228'), 'placeholder: build output'],
    ['COMPANY_NAME', pkg.author, at('490-493'), 'package.json author, normalised to {name}; becomes the Publisher value'],
    [
      'APP_INSTALLER_STORE_FILE',
      `${sanitizedName.toLowerCase()}-updater\\installer.exe`,
      at(502),
      'updaterCacheDirName (appInfo.js:126-128) plus CURRENT_APP_INSTALLER_FILE_NAME',
    ],
    ['COMPRESSION_METHOD', '7z', at(509), 'useZip unset'],
    ['MULTIUSER_INSTALLMODE_ALLOW_ELEVATION', null, at('435-437'), 'allowElevation unset'],
    ['INSTALL_MODE_PER_ALL_USERS_REQUIRED', null, at('445-447'), 'oneClick false'],
    ['allowToChangeInstallationDirectory', null, at('448-453'), 'electron-builder.yml nsis.allowToChangeInstallationDirectory'],
    ['SHORTCUT_NAME', productName, at(461), 'shortcutName unset: the sanitised product name'],
    ['UNINSTALL_DISPLAY_NAME', `${productName} ${pkg.version}`, at(473), '${productName} ${version}'],
    ['MUI_WELCOMEFINISHPAGE_BITMAP', '${NSISDIR}\\Contrib\\Graphics\\Wizard\\nsis3-metro.bmp', at('430-434'), 'no build/installerSidebar.bmp'],
    ['MUI_UNWELCOMEFINISHPAGE_BITMAP', '${NSISDIR}\\Contrib\\Graphics\\Wizard\\nsis3-metro.bmp', at('430-434'), 'no build/uninstallerSidebar.bmp'],
    ['ESTIMATED_SIZE', '{round(unpacked-bytes/1024)}', at('256-259'), 'placeholder: build output; always defined, so the installer never calls GetSize'],
    ['COMPRESS', 'auto', at('267-270'), 'compression not store'],
    ['UNINSTALLER_OUT_FILE', uninstallerOut, at('298,349'), 'placeholder folder; present in the final pass only'],
  ];
  const notDefined: [string, string, string][] = [
    ['ONE_CLICK', at('406-408'), 'oneClick false'],
    ['INSTALL_MODE_PER_ALL_USERS', at('439-441'), 'perMachine false'],
    ['DELETE_APP_DATA_ON_UNINSTALL', at('462-464'), 'deleteAppDataOnUninstall false'],
    ['UNINSTALLER_ICON', at('465-472'), 'no build/uninstallerIcon.ico'],
    ['MENU_FILENAME', at('458-460'), 'menuCategory unset'],
    ['DO_NOT_CREATE_DESKTOP_SHORTCUT', at('474-476'), 'createDesktopShortcut unset (FRESH_INSTALL)'],
    ['RECREATE_DESKTOP_SHORTCUT', at('477-479'), 'createDesktopShortcut unset (FRESH_INSTALL)'],
    ['DO_NOT_CREATE_START_MENU_SHORTCUT', at('480-482'), 'createStartMenuShortcut unset'],
    ['HIDE_RUN_AFTER_FINISH', at('419-421'), 'runAfterFinish unset'],
    ['UNINSTALL_REGISTRY_KEY_2', at('176-178'), 'the uninstall key equals the GUID'],
    ['APP_PRODUCT_FILENAME', at('495-497'), 'APP_FILENAME equals the product file name'],
    ['UNINSTALL_URL_HELP / _INFO_ABOUT / _UPDATE_INFO / _README', at('179-183'), 'package.json has no homepage and no repository'],
    ['ENABLE_LOGGING_ELECTRON_BUILDER', at('173-175'), 'customNsisBinary unset'],
    ['MUI_HEADERIMAGE', at('422-429'), 'no build/installerHeader.bmp'],
    ['DISPLAY_LANG_SELECTOR', at('483-485'), 'displayLanguageSelector unset'],
  ];
  const versionKey = (name: string, value: string): string => `/LANG=1033 ${name} "${nsisEscape(value)}"`;
  const commands = {
    OutFile: `"{dist}\\${artifactName}"`,
    VIProductVersion: `${pkg.version.split(/[.-]/).slice(0, 3).join('.')}.0`,
    VIAddVersionKey: [
      versionKey('ProductName', productName),
      versionKey('ProductVersion', pkg.version),
      versionKey('LegalCopyright', copyright),
      versionKey('FileDescription', pkg.description),
      versionKey('FileVersion', pkg.version),
      versionKey('CompanyName', pkg.author),
    ],
    Unicode: true,
    SetCompressor: 'zlib',
  };
  const args = ['-WX', '-INPUTCHARSET', 'UTF8'];
  for (const [name, value] of defines) args.push(value === null ? `-D${name}` : `-D${name}=${nsisEscape(value)}`);
  for (const [name, value] of Object.entries(commands)) for (const v of Array.isArray(value) ? value : [value]) args.push(`-X${name} ${v}`);
  args.push('-');

  writeArtefact(out, 'takeover/nsis/defines.json', {
    derivation:
      'Derived by reading NsisTarget.js at the installed app-builder-lib version with electron-builder.yml and package.json at the pin; no build was run. dist/builder-debug.yml from the earlier build holds only the file patterns (the NSIS script is added to it only when the debug logger is on), so it is not the source of these values.',
    appBuilderLib: { version: builder.version, license: builder.license },
    toolset: {
      makensis: 'nsis-3.0.4.1 (legacy toolset: toolsets.nsis unset), from node_modules/app-builder-lib/out/toolsets/windows.js:154-158',
      plugins:
        'nsis-resources-3.4.1, x86-unicode plugin folder (unicode not false), from node_modules/app-builder-lib/out/toolsets/windows.js:159-161 and NsisTarget.js:582-586',
      cwd: '{templates}',
      script: 'stdin: the header (NsisTarget.js:571-609) followed by computeFinalScript of installer.nsi (NsisTarget.js:610-663)',
    },
    placeholders: {
      '{project}': 'the folder of the Electron repo the build ran in',
      '{dist}': '{project}\\dist',
      '{templates}': '{project}\\node_modules\\app-builder-lib\\templates\\nsis',
      '{icon}': 'the .ico electron-builder converts from build/icon.* into its cache at build time (under the user profile)',
      '{electron-builder-cache}': '%LOCALAPPDATA%\\electron-builder\\Cache (under the user profile): makensis and the plugins',
      '{build-temp}': "electron-builder's temp folder under %TEMP% (under the user profile): the generated messages includes",
      '{archive-sha512-hex-upper}': 'the SHA-512 of the app archive, upper-case hex',
      '{ceil(unpacked-bytes/1024)}': 'the size of win-unpacked in KiB, rounded up',
      '{round(unpacked-bytes/1024)}': 'the size of win-unpacked in KiB, rounded',
    },
    defines: defines.map(([name, value, source, note]) => ({ name, value, source, ...(note ? { note } : {}) })),
    notDefined: notDefined.map(([name, source, why]) => ({ name, source, why })),
    commands,
    commandsSource: `${at('184-189,382-401,260-271')}; VIProductVersion ends in .0 and FileVersion has no build number because the build sets none of BUILD_NUMBER, TRAVIS_BUILD_NUMBER, APPVEYOR_BUILD_NUMBER, CIRCLE_BUILD_NUM, BUILD_BUILDNUMBER, CI_PIPELINE_IID (node_modules/app-builder-lib/out/appInfo.js:34-46,66-86)`,
    uninstallerPass: {
      source: at('277-284,337-381'),
      differences:
        'the same defines and commands plus BUILD_UNINSTALLER (no value); UNINSTALLER_OUT_FILE is the same path; the resulting installer is run once to write the uninstaller (WriteUninstaller in .onInit, installer.nsi:63-65)',
    },
    makensisArgs: { source: at('512-546'), args },
    flags: {
      source: `${at(579)}; node_modules/app-builder-lib/out/targets/nsis/nsisScriptGenerator.js:29-38`,
      names: ['updated', 'force-run', 'keep-shortcuts', 'no-desktop-shortcut', 'delete-app-data', 'allusers', 'currentuser'],
      macro:
        '${StdUtils.TestParameter} $R9 "<flag>" for each; the defines are isUpdated, isForceRun, isKeepShortcuts, isNoDesktopShortcut, isDeleteAppData, isForAllUsers, isForCurrentUser',
    },
  });
});
