import { adversarial, fromTest, vectorFile, type Case } from '../lib/index';
import { UNINSTALLER_NAME, updateAvailability, type InstallInput } from '../../../../src/main/updates/availability';
import { loginItemAvailable } from '../../../../src/main/platform/login-item';

const DIR = 'C:\\Users\\someone\\AppData\\Local\\Programs\\One Launch';
const EXE = `${DIR}\\OneLaunch.exe`;
const UNINSTALLER = `${DIR}\\${UNINSTALLER_NAME}`;

type Location = string | null | { reject: string };

interface Spec {
  testFeed?: boolean;
  isPackaged: boolean;
  dataDirSource: string;
  execPath: string;
  existingFiles: string[];
  location: Location;
}

function install(spec: Spec, log: { fileExists: string[]; locationAsked: number }): InstallInput {
  return {
    isPackaged: spec.isPackaged,
    dataDirSource: spec.dataDirSource as InstallInput['dataDirSource'],
    execPath: spec.execPath,
    fileExists: (path) => {
      log.fileExists.push(path);
      return spec.existingFiles.includes(path);
    },
    perUserInstallLocation: async () => {
      log.locationAsked++;
      const location = spec.location;
      if (location !== null && typeof location === 'object') throw new Error(location.reject);
      return location;
    },
  };
}

const LOCATIONS: [string, Location][] = [
  ['same', DIR],
  ['same-other-case-slash', `${DIR.toUpperCase()}\\`],
  ['elsewhere', 'D:\\Elsewhere'],
  ['null', null],
  ['rejects', { reject: 'reg.exe failed' }],
];
const SOURCES = ['default', 'flag', 'env'];

const AVAILABILITY = 'test/update-availability.test.ts';
const LOGIN = 'test/login-item.test.ts';

function tableOrigin(file: string, spec: Spec, locationId: string): Case['origin'] {
  const base = spec.isPackaged && spec.dataDirSource === 'default' && spec.existingFiles.length > 0;
  if (file === AVAILABILITY) {
    const which = 'which copies may update themselves';
    if (spec.testFeed)
      return spec.isPackaged || spec.dataDirSource !== 'flag' || spec.existingFiles.length > 0
        ? adversarial('other', 'a truth-table row no test names')
        : fromTest(file, which, 'lets an unpackaged test-feed run through without looking at the install');
    if (base && (locationId === 'same' || locationId === 'same-other-case-slash'))
      return fromTest(file, which, 'allows an installed, per-user copy on the default data folder');
    if (base) return fromTest(file, which, 'refuses an install made for all users, whose update would need administrator rights');
    if (locationId === 'same' && !spec.isPackaged && spec.dataDirSource === 'default' && spec.existingFiles.length > 0)
      return fromTest(file, which, 'refuses development runs, scratch data folders and loose copies of the exe');
    if (locationId === 'same' && spec.isPackaged && spec.dataDirSource === 'flag' && spec.existingFiles.length > 0)
      return fromTest(file, which, 'refuses development runs, scratch data folders and loose copies of the exe');
    if (locationId === 'same' && spec.isPackaged && spec.dataDirSource === 'default' && spec.existingFiles.length === 0)
      return fromTest(file, which, 'refuses development runs, scratch data folders and loose copies of the exe');
    return adversarial('other', 'a truth-table row no test names');
  }
  const which = 'loginItemAvailable';
  if (locationId === 'same' && spec.existingFiles.length > 0 && (spec.dataDirSource === 'default' || spec.isPackaged))
    return fromTest(file, which, 'only for a per-user install on the default data folder');
  if (base && locationId === 'null')
    return fromTest(file, which, 'not for a copy no uninstaller will remove, nor for an all-users install whose uninstaller reaches only one account');
  if (locationId === 'same' && spec.isPackaged && spec.dataDirSource === 'default' && spec.existingFiles.length === 0)
    return fromTest(file, which, 'not for a copy no uninstaller will remove, nor for an all-users install whose uninstaller reaches only one account');
  return adversarial('other', 'a truth-table row no test names');
}

function table(file: string, withFeed: boolean): Case[] {
  const cases: Case[] = [];
  for (const testFeed of withFeed ? [false, true] : [false]) {
    for (const isPackaged of [true, false]) {
      for (const dataDirSource of SOURCES) {
        for (const uninstaller of [true, false]) {
          for (const [locationId, location] of LOCATIONS) {
            const spec: Spec = {
              ...(withFeed ? { testFeed } : {}),
              isPackaged,
              dataDirSource,
              execPath: EXE,
              existingFiles: uninstaller ? [UNINSTALLER] : [],
              location,
            };
            const id = [
              withFeed ? `feed-${testFeed ? 1 : 0}` : null,
              `packaged-${isPackaged ? 1 : 0}`,
              `source-${dataDirSource}`,
              `uninstaller-${uninstaller ? 1 : 0}`,
              `location-${locationId}`,
            ]
              .filter(Boolean)
              .join('.');
            cases.push({ id, origin: tableOrigin(file, spec, locationId), args: [spec], expect: 'out' });
          }
        }
      }
    }
  }
  return cases;
}

const pathCase = (id: string, what: string, execPath: string, existingFiles: string[], location: Location, testFeed?: boolean): Case => ({
  id,
  origin: adversarial('other', what),
  args: [{ ...(testFeed === undefined ? {} : { testFeed }), isPackaged: true, dataDirSource: 'default', execPath, existingFiles, location }],
  expect: 'out',
});

const pathCases = (feed: boolean): Case[] => [
  {
    id: 'loose-copy',
    origin: fromTest(
      feed ? AVAILABILITY : LOGIN,
      ...(feed
        ? ['which copies may update themselves', 'refuses development runs, scratch data folders and loose copies of the exe']
        : ['loginItemAvailable', 'not for a copy no uninstaller will remove, nor for an all-users install whose uninstaller reaches only one account']),
    ),
    args: [
      {
        ...(feed ? { testFeed: false } : {}),
        isPackaged: true,
        dataDirSource: 'default',
        execPath: 'D:\\repo\\dist\\win-unpacked\\OneLaunch.exe',
        existingFiles: [UNINSTALLER],
        location: DIR,
      },
    ],
    expect: 'out',
  },
  pathCase(
    'exec-forward-slashes',
    'an execPath with forward slashes: dirname keeps them and join turns them into backslashes before fileExists sees the path',
    'C:/Users/someone/AppData/Local/Programs/One Launch/OneLaunch.exe',
    [UNINSTALLER],
    DIR,
    feed ? false : undefined,
  ),
  pathCase(
    'location-forward-slashes',
    'an install location with forward slashes and a trailing slash still matches',
    EXE,
    [UNINSTALLER],
    'c:/users/someone/appdata/local/programs/one launch/',
    feed ? false : undefined,
  ),
  pathCase('location-padded', 'an install location with spaces around it: samePath trims them', EXE, [UNINSTALLER], `  ${DIR}  `, feed ? false : undefined),
  pathCase(
    'location-vdf-escaped',
    'an install location with doubled backslashes: samePath unescapes them',
    EXE,
    [UNINSTALLER],
    DIR.replace(/\\/g, '\\\\'),
    feed ? false : undefined,
  ),
  pathCase(
    'location-parent',
    'an install location one folder up does not match',
    EXE,
    [UNINSTALLER],
    'C:\\Users\\someone\\AppData\\Local\\Programs',
    feed ? false : undefined,
  ),
  pathCase('location-empty', 'an empty install location counts as none', EXE, [UNINSTALLER], '', feed ? false : undefined),
  pathCase(
    'location-dotdot',
    'an install location with ".." that resolves to the folder matches',
    EXE,
    [UNINSTALLER],
    `${DIR}\\x\\..`,
    feed ? false : undefined,
  ),
  pathCase(
    'location-non-ascii-case',
    'samePath lowercases with toLowerCase, so a folder that differs only by İ and i̇ matches',
    'E:\\İ\\OneLaunch.exe',
    ['E:\\İ\\Uninstall OneLaunch.exe'],
    'e:\\i\u0307',
    feed ? false : undefined,
  ),
  pathCase(
    'uninstaller-case',
    'fileExists is asked the exact joined path; a stub that knows it in another case says no',
    EXE,
    [UNINSTALLER.toLowerCase()],
    DIR,
    feed ? false : undefined,
  ),
  pathCase('exec-at-root', 'an execPath at a drive root', 'D:\\OneLaunch.exe', ['D:\\Uninstall OneLaunch.exe'], 'D:\\', feed ? false : undefined),
];

const NOTE_INPUT =
  "call builds the InstallInput from arg0 = { isPackaged, dataDirSource, execPath, existingFiles, location }: fileExists(p) is existingFiles.includes(p) and records p; perUserInstallLocation() resolves to location (a string or null), or rejects with new Error(location.reject) when location is { reject }, and records that it was asked. The result is projected to { result, fileExists: [every path asked, in order], locationAsked: how many times the location was read }, so the Rust port is checked on the path it builds (dirname of execPath joined with 'Uninstall OneLaunch.exe', win32) and on what it does not ask.";
const NOTE_TABLE =
  'The table is every combination of isPackaged, dataDirSource (default, flag, env), the uninstaller present or not, and five install locations (the exe folder, the same in upper case with a trailing separator, another folder, null, a rejection); ids name each input. Paths are under the placeholder profile C:\\Users\\someone (test/update-availability.test.ts uses another name; the bundle scan accepts only placeholders).';

async function run(spec: Spec, fn: (input: InstallInput) => Promise<unknown>): Promise<unknown> {
  const log = { fileExists: [] as string[], locationAsked: 0 };
  const result = await fn(install(spec, log));
  return { result, fileExists: log.fileExists, locationAsked: log.locationAsked };
}

vectorFile({
  area: 'core',
  function: 'updateAvailability',
  source: 'src/main/updates/availability.ts',
  note: [
    'arg0 also carries testFeed, passed as the AvailabilityInput field of that name (src/main/index.ts sets it when ONELAUNCH_UPDATE_FEED gave a test feed).',
    NOTE_INPUT,
    `${NOTE_TABLE} With testFeed on and off: 120 rows.`,
  ].join('\n'),
  call: (spec: Spec) => run(spec, (input) => updateAvailability({ ...input, testFeed: spec.testFeed ?? false })),
  cases: [...table(AVAILABILITY, true), ...pathCases(true)],
});

vectorFile({
  area: 'core',
  function: 'loginItemAvailable',
  source: 'src/main/platform/login-item.ts',
  note: [NOTE_INPUT, `${NOTE_TABLE} 60 rows.`].join('\n'),
  call: (spec: Spec) => run(spec, loginItemAvailable),
  cases: [...table(LOGIN, false), ...pathCases(false)],
});
