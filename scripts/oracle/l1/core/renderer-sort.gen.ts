import { adversarial, Rng, vectorFile, type AdversarialClass, type Case } from '../lib/index';
import { LOCALE_NOTE } from './renderer/locale';
import { sortAccounts } from '../../../../src/renderer/src/views/AccountsView';
import { lastPlayedOf } from '../../../../src/renderer/src/components/GameCard';

const LONE = '\uD800';

const account = (id: string, displayName: string, lastUsedAt: string | null = null) => ({
  id,
  launcher: 'steam',
  displayName,
  login: `login_${id}`,
  hasSecret: false,
  hasSession: false,
  launcherUid: null,
  tags: [],
  notes: '',
  lastUsedAt,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const NAME_PAIRS: [string, string, string, AdversarialClass][] = [
  ['case', 'alpha', 'Alpha', 'locale-compare'],
  ['case-order', 'b', 'A', 'locale-compare'],
  ['upper-lower', 'B', 'a', 'locale-compare'],
  ['accent', 'e', '\u00E9', 'locale-compare'],
  ['accent-word', 'resume', 'r\u00E9sum\u00E9', 'locale-compare'],
  ['combining', '\u00E9', 'e\u0301', 'locale-compare'],
  ['digits', 'Account 2', 'Account 10', 'locale-compare'],
  ['digit-letter', '9', 'a', 'locale-compare'],
  ['arabic-indic-digit', '3', '\u0663', 'unicode-digit'],
  ['fullwidth-digit', '3', '\uFF13', 'unicode-digit'],
  ['hyphen', 'a-b', 'ab', 'locale-compare'],
  ['space', 'a b', 'ab', 'locale-compare'],
  ['underscore', '_x', 'x', 'locale-compare'],
  ['punctuation-order', '!', '#', 'locale-compare'],
  ['dot-vs-letter', '.a', 'a', 'locale-compare'],
  ['sharp-s', 'stra\u00DFe', 'strasse', 'locale-compare'],
  ['ae-ligature', '\u00C6', 'AE', 'locale-compare'],
  ['fi-ligature', '\uFB01', 'fi', 'locale-compare'],
  ['dotted-capital-i', '\u0130', 'I', 'locale-compare'],
  ['dotless-i', '\u0131', 'i', 'locale-compare'],
  ['fullwidth-letter', '\uFF41', 'a', 'locale-compare'],
  ['math-script', '\u{1D49C}', 'A', 'locale-compare'],
  ['emoji-letter', '\u{1F600}', 'a', 'locale-compare'],
  ['two-emoji', '\u{1F600}', '\u{1F601}', 'locale-compare'],
  ['astral-vs-bmp-high', '\u{1F600}', '\uFFFD', 'utf16-length'],
  ['cjk-latin', '\u4E2D', 'z', 'locale-compare'],
  ['hiragana-katakana', '\u3042', '\u30A2', 'locale-compare'],
  ['cyrillic-latin', '\u0430', 'a', 'locale-compare'],
  ['zero-width', 'a\u200Bb', 'ab', 'locale-compare'],
  ['nul', 'a\u0000b', 'ab', 'locale-compare'],
  ['empty-letter', '', 'a', 'locale-compare'],
  ['empty-empty', '', '', 'locale-compare'],
  ['empty-space', '', ' ', 'locale-compare'],
  ['nbsp-space', 'a\u00A0b', 'a b', 'unicode-space'],
  ['prefix', 'Main', 'Main 2', 'locale-compare'],
  ['identical', 'Main', 'Main', 'sort'],
  ['lone-surrogate', `a${LONE}`, 'a', 'lone-surrogate'],
  ['lone-vs-replacement', LONE, '\uFFFD', 'lone-surrogate'],
];

const USED_PAIRS: [string, string | null, string | null, string, AdversarialClass][] = [
  ['used-order', '2026-01-02T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'both used: the later first, by localeCompare with default sensitivity', 'sort'],
  [
    'used-equal',
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z',
    'the same lastUsedAt: 0, so the input order stays and the name is not consulted',
    'sort',
  ],
  [
    'used-ms-vs-none',
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00Z',
    'the same instant written with and without milliseconds: compared as text',
    'locale-compare',
  ],
  ['used-vs-never', '2026-01-01T00:00:00.000Z', null, 'one used, one never: the used one first', 'sort'],
  ['used-empty', '', '2026-01-01T00:00:00.000Z', 'an empty lastUsedAt is falsy: treated as never used', 'other'],
  ['used-unpadded-day', '2026-01-9', '2026-01-10', 'non-ISO text: localeCompare is not numeric, so 9 sorts after 10 when descending', 'locale-compare'],
  ['used-offset', '2026-01-01T05:00:00+05:00', '2026-01-01T00:00:00.000Z', 'the same instant in two offsets: compared as text, not as time', 'date'],
];

const ids = (list: { id: string }[]): string[] => list.map((a) => a.id);

function pairCases(): Case[] {
  const out: Case[] = [];
  for (const [tag, a, b, cls] of NAME_PAIRS) {
    const what = `displayName ${JSON.stringify(a)} against ${JSON.stringify(b)}, both never used: localeCompare(undefined, { sensitivity: 'base' })`;
    out.push({ id: `name-${tag}-ab`, origin: adversarial(cls, `${what}, given in that order`), args: [[account('a', a), account('b', b)]], expect: 'out' });
    out.push({ id: `name-${tag}-ba`, origin: adversarial(cls, `${what}, given reversed`), args: [[account('b', b), account('a', a)]], expect: 'out' });
  }
  for (const [tag, a, b, what, cls] of USED_PAIRS) {
    out.push({ id: `${tag}-ab`, origin: adversarial(cls, `lastUsedAt ${what}`), args: [[account('a', 'Zed', a), account('b', 'Amy', b)]], expect: 'out' });
    out.push({
      id: `${tag}-ba`,
      origin: adversarial(cls, `lastUsedAt ${what}, given reversed`),
      args: [[account('b', 'Amy', b), account('a', 'Zed', a)]],
      expect: 'out',
    });
  }
  return out;
}

const MIXED = [
  account('a01', 'zeta'),
  account('a02', 'Alpha'),
  account('a03', 'alpha'),
  account('a04', '\u00C1lpha'),
  account('a05', 'Account 10'),
  account('a06', 'Account 2'),
  account('a07', '_admin'),
  account('a08', ''),
  account('a09', '\u{1F600} smile'),
  account('a10', '\u4E2D\u6587'),
  account('a11', 'r\u00E9sum\u00E9'),
  account('a12', 'resume'),
  account('a13', 'Main', '2026-03-01T00:00:00.000Z'),
  account('a14', 'Alt', '2026-05-01T00:00:00.000Z'),
  account('a15', 'Smurf', '2026-05-01T00:00:00.000Z'),
  account('a16', 'Old', '2025-12-31T23:59:59.999Z'),
  account('a17', 'Blank', ''),
  account('a18', 'stra\u00DFe'),
  account('a19', 'strasse'),
  account('a20', '\u0130stanbul'),
];

function shuffled<T>(list: T[], seed: number): T[] {
  const rng = new Rng(seed);
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = rng.int(i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

vectorFile({
  area: 'core',
  function: 'sortAccounts',
  source: 'src/renderer/src/views/AccountsView.tsx',
  name: 'renderer.sort.sortAccounts',
  note: [
    LOCALE_NOTE,
    'call returns the ids of the sorted list (sortAccounts copies the list and returns the same account objects, reordered). The comparator: both used, b.lastUsedAt.localeCompare(a.lastUsedAt) with default sensitivity; one used, it goes first; neither, a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }). Array.prototype.sort is stable, so a 0 keeps the input order.',
    'Each pair is given in both orders (-ab, -ba): the same order back twice means the comparator ranks them, the input order back twice means it returns 0.',
    "The Library's name order (LibraryView.tsx, byName inside a useMemo) is the same localeCompare call but is not exported, so it has no vector of its own; its recent order breaks lastPlayed ties by name, which sortAccounts does not do for lastUsedAt.",
  ].join('\n'),
  call: (list: { id: string }[]) => ids(sortAccounts(list as Parameters<typeof sortAccounts>[0])),
  cases: (): Case[] => [
    ...pairCases(),
    {
      id: 'list-mixed',
      origin: adversarial('sort', 'twenty accounts mixing case, accents, digits, punctuation, astral, empty and used ones'),
      args: [MIXED],
      expect: 'out',
    },
    {
      id: 'list-mixed-reversed',
      origin: adversarial('sort', 'the same list reversed: ties come back in the new input order'),
      args: [[...MIXED].reverse()],
      expect: 'out',
    },
    ...[1, 2, 3].map((seed) => ({
      id: `list-mixed-shuffle-${seed}`,
      origin: adversarial('sort', `the same list shuffled with Rng(${seed}) (Fisher-Yates): stable order among ties`),
      args: [shuffled(MIXED, seed)],
      expect: 'out' as const,
    })),
    { id: 'list-empty', origin: adversarial('sort', 'no accounts'), args: [[]], expect: 'out' },
    { id: 'list-one', origin: adversarial('sort', 'one account'), args: [[account('a', 'Solo')]], expect: 'out' },
    {
      id: 'list-all-equal',
      origin: adversarial('sort', 'five names equal under base sensitivity: input order kept'),
      args: [[account('e1', 'alpha'), account('e2', 'ALPHA'), account('e3', '\u00E1lpha'), account('e4', 'Alpha'), account('e5', '\u00C0LPHA')]],
      expect: 'out',
    },
  ],
});

const game = (lastPlayedAt: string | null, launchedAt: string | null | undefined) => ({
  id: 'g',
  launcher: 'steam',
  launcherGameId: '570',
  name: 'Dota 2',
  installPath: 'D:\\Games\\Steam\\steamapps\\common\\dota 2 beta',
  installed: true,
  lastSeenAt: '2026-01-01T00:00:00.000Z',
  needsUpdate: false,
  lastPlayedAt,
  artwork: null,
  artworkError: null,
  lastLaunch: launchedAt === undefined ? null : { accountId: 'a', accountName: 'Alt', launchedAt },
});

const LP: [string, string | null, string | null | undefined, string, AdversarialClass][] = [
  ['neither', null, undefined, 'never played anywhere: null', 'other'],
  ['launcher-only', '2026-01-01T00:00:00.000Z', undefined, "only the launcher's record", 'other'],
  ['one-launch-only', null, '2026-01-02T00:00:00.000Z', 'only a One Launch launch', 'other'],
  ['launcher-newer', '2026-02-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'both, the launcher newer', 'sort'],
  ['one-launch-newer', '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', 'both, One Launch newer', 'sort'],
  ['equal', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'both the same: b, by a > b being false', 'sort'],
  [
    'ms-vs-none',
    '2026-01-01T00:00:00Z',
    '2026-01-01T00:00:00.000Z',
    "the same instant with and without milliseconds: 'Z' > '.' as text, so the shorter form wins",
    'date',
  ],
  ['launcher-empty', '', '2026-01-01T00:00:00.000Z', "an empty launcher record is falsy: One Launch's", 'other'],
  ['launched-empty', '2026-01-01T00:00:00.000Z', '', "an empty launchedAt is not null for ??, but falsy: the launcher's", 'other'],
  ['both-empty', '', '', 'both empty: the empty launchedAt', 'other'],
  ['launched-null', '2026-01-01T00:00:00.000Z', null, 'a launch record with a null launchedAt', 'other'],
  [
    'astral-vs-bmp',
    'a\uFFFF',
    'a\u{1F600}',
    'string > compares UTF-16 code units: U+FFFF is above the surrogate 0xD83D, so the BMP string wins; UTF-8 byte or code point order says the opposite',
    'utf16-length',
  ],
  ['offsets', '2026-01-01T05:00:00+05:00', '2026-01-01T00:00:00.000Z', 'the same instant in two offsets: compared as text', 'date'],
];

vectorFile({
  area: 'core',
  function: 'lastPlayedOf',
  source: 'src/renderer/src/components/GameCard.tsx',
  name: 'renderer.sort.lastPlayedOf',
  note: [
    "arg0 is a Game. lastPlayedOf is the key of the Library's recent order (LibraryView.tsx compares two keys with pb.localeCompare(pa) inside a useMemo that is not exported): the newer of the launcher's lastPlayedAt and the One Launch lastLaunch.launchedAt, by plain string >, which compares UTF-16 code units.",
  ].join('\n'),
  call: lastPlayedOf,
  cases: LP.map(([id, a, b, what, cls]) => ({ id, origin: adversarial(cls, `lastPlayedOf with ${what}`), args: [game(a, b)], expect: 'out' as const })),
});
