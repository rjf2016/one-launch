import { adversarial, fromTest, vectorFile, type Case } from '../lib/index';
import { dataDirFromArgv } from '../../../../src/main/platform/paths';

const TESTS = 'test/paths.test.ts';
const REFUSES = 'refuses a --data-dir= it cannot use instead of falling back to the real folder (A11)';
const MOVES = '--data-dir= moves everything, packaged or not, and wins over the environment variable (A11)';
const EXE = 'C:\\Program Files\\One Launch\\OneLaunch.exe';
const t = (title: string) => fromTest(TESTS, 'app paths (B19)', title);

const lifted: [string, string, string[], 'out' | 'error'][] = [
  ['no-flag', REFUSES, ['x.exe'], 'out'],
  ['flag-without-equals', REFUSES, ['x.exe', '--data-dir', 'D:\\scratch'], 'out'],
  ['forward-slashes', REFUSES, ['x.exe', '--data-dir=D:/scratch/ol'], 'out'],
  ['same-twice', REFUSES, ['x.exe', '--data-dir=D:\\a', '--data-dir=D:\\a'], 'out'],
  ['empty', REFUSES, ['x.exe', '--data-dir='], 'error'],
  ['blank', REFUSES, ['x.exe', '--data-dir=   '], 'error'],
  ['relative', REFUSES, ['x.exe', '--data-dir=scratch'], 'error'],
  ['dot-relative', REFUSES, ['x.exe', '--data-dir=.\\scratch'], 'error'],
  ['drive-only', REFUSES, ['x.exe', '--data-dir=D:'], 'error'],
  ['drive-root', REFUSES, ['x.exe', '--data-dir=D:\\'], 'error'],
  ['unc-share-root', REFUSES, ['x.exe', '--data-dir=\\\\server\\share\\'], 'error'],
  ['two-different', REFUSES, ['x.exe', '--data-dir=D:\\a', '--data-dir=D:\\b'], 'error'],
  ['packaged-exe', MOVES, [EXE, '--data-dir=D:\\scratch\\packaged'], 'out'],
  ['dev-trailing-separator', MOVES, ['electron.exe', '.', '--data-dir=D:\\scratch\\flag\\'], 'out'],
  ['dev-no-flag', MOVES, ['electron.exe', '.'], 'out'],
];

const extra: [string, Case['origin'], string[], 'out' | 'error'][] = [
  ['empty-argv', adversarial('other', 'an empty argv'), [], 'out'],
  ['flag-anywhere', adversarial('other', 'the flag is read from any position, the first included'), ['--data-dir=D:\\first', 'x.exe'], 'out'],
  ['flag-case', adversarial('case-mapping', 'the prefix is case-sensitive: --DATA-DIR= is not the flag'), ['x.exe', '--DATA-DIR=D:\\a'], 'out'],
  ['flag-lookalike', adversarial('other', '--data-directory= and -data-dir= are not the flag'), ['x.exe', '--data-directory=D:\\a', '-data-dir=D:\\b'], 'out'],
  [
    'value-trimmed',
    adversarial('unicode-space', 'the value is trimmed with JS trim, U+00A0 and U+FEFF included'),
    ['x.exe', '--data-dir=\u00a0\ufeff D:\\scratch\\ol \u3000'],
    'out',
  ],
  [
    'value-nel-not-trimmed',
    adversarial('unicode-space', 'JS trim keeps U+0085, so the value is not absolute'),
    ['x.exe', '--data-dir=\u0085D:\\scratch'],
    'error',
  ],
  ['same-after-trim', adversarial('unicode-space', 'two values equal after trim count as one'), ['x.exe', '--data-dir=D:\\a', '--data-dir= D:\\a '], 'out'],
  [
    'differ-by-case',
    adversarial('case-mapping', 'the same folder in another case counts as two folders'),
    ['x.exe', '--data-dir=D:\\a', '--data-dir=d:\\A'],
    'error',
  ],
  [
    'differ-by-trailing-separator',
    adversarial('other', 'the same folder with a trailing separator counts as two folders: values are compared before normalising'),
    ['x.exe', '--data-dir=D:\\a', '--data-dir=D:\\a\\'],
    'error',
  ],
  [
    'three-values-one-different',
    adversarial('other', 'two equal values and one different'),
    ['x.exe', '--data-dir=D:\\a', '--data-dir=D:\\a', '--data-dir=D:\\c'],
    'error',
  ],
  ['dotdot-to-root', adversarial('other', '".." that climbs to the drive root is refused as the drive'), ['x.exe', '--data-dir=D:\\a\\..'], 'error'],
  ['dotdot-resolved', adversarial('other', '".." inside the path is resolved'), ['x.exe', '--data-dir=D:\\a\\b\\..\\c\\.\\'], 'out'],
  ['many-trailing-separators', adversarial('other', 'several trailing separators are all dropped'), ['x.exe', '--data-dir=D:\\a\\\\\\'], 'out'],
  ['forward-trailing', adversarial('other', 'a trailing forward slash'), ['x.exe', '--data-dir=D:/a/'], 'out'],
  ['unc-folder', adversarial('other', 'a folder on a UNC share is accepted'), ['x.exe', '--data-dir=\\\\server\\share\\scratch'], 'out'],
  ['unc-share-no-slash', adversarial('other', 'a UNC share without a trailing separator is its root'), ['x.exe', '--data-dir=\\\\server\\share'], 'error'],
  ['rooted-no-drive', adversarial('other', 'a path rooted on the current drive is absolute for win32'), ['x.exe', '--data-dir=\\scratch'], 'out'],
  ['forward-rooted', adversarial('other', 'a forward-slash rooted path'), ['x.exe', '--data-dir=/scratch/ol'], 'out'],
  ['bare-backslash', adversarial('other', 'a lone backslash is the root'), ['x.exe', '--data-dir=\\'], 'error'],
  ['drive-relative', adversarial('other', 'D:scratch is drive-relative, not absolute'), ['x.exe', '--data-dir=D:scratch'], 'error'],
  ['long-path-prefix', adversarial('other', 'the \\\\?\\ prefix'), ['x.exe', '--data-dir=\\\\?\\D:\\scratch'], 'out'],
  ['quoted-value', adversarial('other', 'quotes are part of the value, so it is not absolute'), ['x.exe', '--data-dir="D:\\scratch"'], 'error'],
  ['equals-in-value', adversarial('other', 'only the first = belongs to the flag'), ['x.exe', '--data-dir=D:\\a=b'], 'out'],
  ['non-ascii', adversarial('case-mapping', 'non-ASCII and astral characters are kept'), ['x.exe', '--data-dir=E:\\Ünï\\😀'], 'out'],
  ['lone-surrogate', adversarial('lone-surrogate', 'a lone surrogate in the folder name is kept'), ['x.exe', '--data-dir=E:\\a\ud800'], 'out'],
  [
    'profile-folder',
    adversarial('other', 'the default data folder named explicitly'),
    ['x.exe', '--data-dir=C:\\Users\\someone\\AppData\\Roaming\\OneLaunch'],
    'out',
  ],
];

vectorFile({
  area: 'core',
  function: 'dataDirFromArgv',
  source: 'src/main/platform/paths.ts',
  note: [
    'arg0 is the process argv (configureAppPaths passes process.argv). Paths are win32 throughout (the module uses node:path win32 explicitly).',
    "Errors are DataDirFlagError, a subclass that sets no name of its own, so the recorded name is 'Error'; the Rust side tells it by message.",
  ].join('\n'),
  call: dataDirFromArgv,
  cases: [
    ...lifted.map(([id, title, argv, expect]) => ({ id, origin: t(title), args: [argv], expect })),
    ...extra.map(([id, origin, argv, expect]) => ({ id, origin, args: [argv], expect })),
  ],
});
