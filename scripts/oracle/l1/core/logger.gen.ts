import { adversarial, fixture, fromTest, vectorFile, type Case } from '../lib/index';
import { forgetAccountNames, formatLine, redactAccountNames, redactString, redactValue } from '../../../../src/main/services/logger';
import type { LogLevel } from '../../../../src/shared/models';

const TESTS = 'test/logger.test.ts';
const t = (...titles: string[]) => fromTest(TESTS, ...titles);

type Names = (string | null | undefined)[];

function names(list: Names): void {
  forgetAccountNames();
  redactAccountNames(list);
}

const MAKE = '%make';

// Builds what JSON cannot carry from a marker object { "%make": kind, ...params }; every other value is walked as it is.
function build(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(build);
  if (value === null || typeof value !== 'object' || Buffer.isBuffer(value) || value instanceof Date) return value;
  const record = value as Record<string, unknown>;
  const kind = record[MAKE];
  if (kind === undefined) return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, build(v)]));
  switch (kind) {
    case 'error': {
      const error = new Error(record['message'] as string);
      if (typeof record['name'] === 'string') error.name = record['name'];
      error.stack = 'stack' in record ? (record['stack'] as string | undefined) : `${error.name}: ${error.message}`;
      if ('code' in record) (error as Error & { code?: unknown }).code = record['code'];
      if ('extra' in record) Object.assign(error, build(record['extra']));
      return error;
    }
    case 'zero-bytes':
      return Buffer.alloc(record['length'] as number);
    case 'function':
      return () => undefined;
    case 'symbol':
      return Symbol(record['description'] as string);
    case 'bigint':
      return BigInt(record['value'] as string);
    case 'map':
      return new Map(record['entries'] as [unknown, unknown][]);
    case 'uint16':
      return new Uint16Array(record['values'] as number[]);
    case 'boxed-string':
      return new String(record['value'] as string);
    case 'self': {
      const object = build(record['value']) as Record<string, unknown>;
      object[record['key'] as string] = object;
      return object;
    }
    case 'shared': {
      const inner = build(record['value']);
      return Object.fromEntries((record['keys'] as string[]).map((k) => [k, inner]));
    }
    case 'throwing-getter': {
      const object: Record<string, unknown> = { before: 'kept' };
      Object.defineProperty(object, record['key'] as string, {
        enumerable: true,
        get() {
          throw new Error('getter failed');
        },
      });
      return object;
    }
    case 'to-json': {
      const object = build(record['value']) as Record<string, unknown>;
      object['toJSON'] = () => record['returns'];
      return object;
    }
    default:
      throw new Error(`unknown ${MAKE} kind ${String(kind)}`);
  }
}

function project(value: unknown): unknown {
  if (typeof value === 'bigint') return { '%bigint': value.toString() };
  if (Array.isArray(value)) return value.map(project);
  if (value !== null && typeof value === 'object' && !Buffer.isBuffer(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, project(v)]));
  return value;
}

const BUILD_NOTE =
  "A value that JSON cannot carry is given as a marker object { \"%make\": kind, ... } that call builds before the export runs; every other object and array is walked and rebuilt as it is. Kinds: zero-bytes (Buffer.alloc(length), for a top-level Buffer, which would otherwise need a decode entry), error (new Error(message); name set when given; stack set to the given value, or to `${name}: ${message}` when absent, so no real stack with machine paths is recorded; code and the properties of extra assigned), function (() => undefined), symbol (Symbol(description)), bigint (BigInt(value)), map (new Map(entries)), uint16 (new Uint16Array(values)), boxed-string (new String(value)), self (the built value with value[key] pointing back at itself), shared (one built value under every name in keys: the same object twice, not a cycle), throwing-getter ({ before: 'kept' } plus an enumerable getter at key that throws Error('getter failed')), to-json (the built value with a toJSON method returning returns).";

const NAMES_NOTE =
  "Global state: the logger's account-name list. call first runs forgetAccountNames() and then redactAccountNames(arg0) (arg0 is the list of names a caller would have handed over: null, undefined, short, long, duplicate and stop-list names included), so every case starts from exactly that list and nothing carries over between cases. The list's own limits (3 to 256 UTF-16 units after trim and toLowerCase, at most 2000 names, a stop list of launcher words) are redactAccountNames's, reached through this argument.";

const FREEMAN = ['gordon_f', 'Dr. Freeman (main)', null, undefined, ''];
const many = (n: number) => Array.from({ length: n }, (_, i) => `name_${String(i).padStart(4, '0')}`);
const JWT_LIKE = 'eyJabcdefgh.ijklmnopqr.stuvwxyz01';

const stringCases: Case[] = [
  ...(
    [
      ['kv-password', 'login failed password=hunter2 for user bob'],
      ['kv-token-colon', 'token: abc123def'],
      ['kv-json-apikey', '"apiKey": "sk-live-123"'],
      ['kv-api-key-amp', 'api_key=xyz&other=1'],
    ] as const
  ).map(([id, input]) => ({ id, origin: t('redactString', 'redacts key=value credentials in free text'), args: [[], input], expect: 'out' as const })),
  { id: 'steam-login', origin: t('redactString', 'redacts Steam -login command lines'), args: [[], 'spawn steam.exe -login someuser s3cret!'], expect: 'out' },
  { id: 'ini-data', origin: t('redactString', 'redacts INI Data= blobs'), args: [[], '[RememberMe]\nData=QUJDREVGR0g='], expect: 'out' },
  {
    id: 'jwt',
    origin: t(
      'redactString',
      'redacts JWTs and long opaque blobs | a JWT-shaped value with an 8-character first segment, since the bundle scan refuses a real-looking JWT',
    ),
    args: [[], `bearer ${JWT_LIKE}`],
    expect: 'out',
  },
  { id: 'long-blob', origin: t('redactString', 'redacts JWTs and long opaque blobs'), args: [[], `blob ${'A1b2'.repeat(16)} end`], expect: 'out' },
  { id: 'long-word', origin: t('redactString', 'redacts JWTs and long opaque blobs'), args: [[], `name ${'A'.repeat(64)} end`], expect: 'out' },
  {
    id: 'email',
    origin: t('redactString', 'redacts email addresses and SteamID64s, including inside error messages'),
    args: [[], 'Sign in to it as some.one+tag@example.co.uk, then capture again.'],
    expect: 'out',
  },
  {
    id: 'steamid',
    origin: t('redactString', 'redacts email addresses and SteamID64s, including inside error messages'),
    args: [[], 'SteamID64 76561198000000001 is not in loginusers.vdf'],
    expect: 'out',
  },
  {
    id: 'short-numbers-stay',
    origin: t('redactString', 'redacts email addresses and SteamID64s, including inside error messages'),
    args: [[], 'appid 252950 and pid 76561198 stay'],
    expect: 'out',
  },
  {
    id: 'profile-path-spaced-name',
    origin: t(
      'redactString',
      'masks the Windows user name in a profile path, raw, JSON-escaped, or with forward slashes, including in an error stack (H5) | the user folder %Jo Smith% (a placeholder the bundle scan accepts) for Jo Smith',
    ),
    args: [[], 'data folder C:\\Users\\%Jo Smith%\\AppData\\Roaming\\OneLaunch'],
    expect: 'out',
  },
  {
    id: 'profile-path-forward',
    origin: t(
      'redactString',
      'masks the Windows user name in a profile path, raw, JSON-escaped, or with forward slashes, including in an error stack (H5) | the user folder someone for jo',
    ),
    args: [[], 'c:/users/someone/AppData/Local/Temp'],
    expect: 'out',
  },
  {
    id: 'profile-path-json-escaped',
    origin: t(
      'redactString',
      'masks the Windows user name in a profile path, raw, JSON-escaped, or with forward slashes, including in an error stack (H5) | the JSON-escaped form on its own',
    ),
    args: [[], '{"dataDir":"C:\\\\Users\\\\someone\\\\AppData\\\\Roaming\\\\OneLaunch"}'],
    expect: 'out',
  },
  {
    id: 'uuid-lower',
    origin: t('redactString', 'masks a UUID to its tail, since a Riot account id is one, and leaves ordinary paths and ids alone'),
    args: [[], 'scanned D:\\Games\\Steam\\steamapps\\appmanifest_252950.acf for job 8f3c1a2b-0000-4000-8000-00000000abcd'],
    expect: 'out',
  },
  {
    id: 'uuid-upper',
    origin: t('redactString', 'masks a UUID to its tail, since a Riot account id is one, and leaves ordinary paths and ids alone'),
    args: [[], 'account 8f3c1a2b-0000-4000-8000-00000000ABCD done'],
    expect: 'out',
  },
  {
    id: 'hex-name-stays',
    origin: t(
      'redactString',
      'masks a UUID to its tail, since a Riot account id is one, and leaves ordinary paths and ids alone | a periodic 32-hex manifest name, since the bundle scan refuses a random-looking one',
    ),
    args: [[], 'C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests\\ABCDEF0123456789ABCDEF0123456789.item'],
    expect: 'out',
  },
  {
    id: 'names-before-handover',
    origin: t('account names', 'masks a name once it has been handed over, in messages, errors, and metadata, whatever its case'),
    args: [[], 'Steam rejected the stored password for gordon_f.'],
    expect: 'out',
  },
  {
    id: 'names-after-handover',
    origin: t('account names', 'masks a name once it has been handed over, in messages, errors, and metadata, whatever its case'),
    args: [FREEMAN, 'Steam rejected the stored password for gordon_f. Update it on the account page.'],
    expect: 'out',
  },
  {
    id: 'names-any-case',
    origin: t('account names', 'masks a name once it has been handed over, in messages, errors, and metadata, whatever its case'),
    args: [FREEMAN, 'Steam signed in as GORDON_F instead of someone.'],
    expect: 'out',
  },
  {
    id: 'names-whole-only',
    origin: t('account names', 'matches whole names only and ignores names too short to be safe to mask'),
    args: [['bob', 'al', 'Main', 'Steam', 'maine'], 'bobsled and bob and mainWindow and main, al, Steam, Maine'],
    expect: 'out',
  },
  {
    id: 'names-in-path',
    origin: t('account names', 'matches whole names only and ignores names too short to be safe to mask'),
    args: [['bob', 'al', 'Main', 'Steam', 'maine'], 'D:\\Saves\\bob\\slot1'],
    expect: 'out',
  },
  {
    id: 'names-from-db-and-loginusers',
    origin: t(
      'account names',
      'is fed by the accounts table and by loginusers.vdf, so a name is covered from the moment it is read | the names handed over directly',
    ),
    args: [['crowbar_77', 'Weekend smurf', 'headcrab_9', 'Lamarr'], 'switch to crowbar_77 (Weekend smurf) failed; Steam signed in as headcrab_9 (Lamarr)'],
    expect: 'out',
  },
  {
    id: 'names-regex-special',
    origin: adversarial('regex', 'a name with regex metacharacters is matched literally: a.b masks a.b, not axb'),
    args: [['a.b', 'c+d'], 'a.b axb c+d ccd'],
    expect: 'out',
  },
  {
    id: 'names-longest-first',
    origin: adversarial('regex', 'overlapping names: the longer one is tried first'),
    args: [['gordon', 'gordon freeman'], 'gordon freeman and gordon'],
    expect: 'out',
  },
  {
    id: 'names-trimmed',
    origin: adversarial('unicode-space', 'a name is trimmed with JS trim (U+00A0 and U+FEFF included) before it is stored'),
    args: [['\u00a0\ufeffkleiner\u3000'], 'by kleiner'],
    expect: 'out',
  },
  { id: 'cap-name-min-at', origin: adversarial('utf16-length', 'a name of 3 characters is kept'), args: [['abc'], 'abc ab'], expect: 'out' },
  { id: 'cap-name-min-over', origin: adversarial('utf16-length', 'a name of 2 characters is ignored'), args: [['ab'], 'abc ab'], expect: 'out' },
  {
    id: 'cap-name-max-at',
    origin: adversarial('utf16-length', 'a name of 256 UTF-16 units is kept'),
    args: [['n'.repeat(256)], `x ${'n'.repeat(256)} y`],
    expect: 'out',
  },
  {
    id: 'cap-name-max-over',
    origin: adversarial('utf16-length', 'a name of 257 UTF-16 units is ignored'),
    args: [['n'.repeat(257)], `x ${'n'.repeat(257)} y`],
    expect: 'out',
  },
  {
    id: 'cap-name-max-astral-at',
    origin: adversarial('utf16-length', 'an astral character counts two units: 254 letters and one emoji is 256 units, kept'),
    args: [[`${'n'.repeat(254)}😀`], `x ${'n'.repeat(254)}😀 y`],
    expect: 'out',
  },
  {
    id: 'cap-name-max-astral-over',
    origin: adversarial('utf16-length', 'an astral character counts two units: 255 letters and one emoji is 257 units, ignored'),
    args: [[`${'n'.repeat(255)}😀`], `x ${'n'.repeat(255)}😀 y`],
    expect: 'out',
  },
  {
    id: 'cap-name-max-lowercase-grows',
    origin: adversarial('case-mapping', 'İ lowercases to two units, so İ plus 255 letters is 257 units after toLowerCase and is ignored'),
    args: [[`İ${'n'.repeat(255)}`], `x i\u0307${'n'.repeat(255)} y`],
    expect: 'out',
  },
  { id: 'cap-names-count-at', origin: adversarial('other', 'the 2000th name is still stored'), args: [many(2000), 'by name_1999'], expect: 'out' },
  { id: 'cap-names-count-over', origin: adversarial('other', 'the 2001st name is dropped'), args: [many(2001), 'by name_1999 and name_2000'], expect: 'out' },
  {
    id: 'cap-names-count-duplicates',
    origin: adversarial('other', 'duplicates and stop words do not count towards the 2000 names'),
    args: [[...many(1999), 'name_0000', 'steam', 'late_name'], 'by late_name'],
    expect: 'out',
  },
  {
    id: 'names-stop-list',
    origin: adversarial('other', 'every stop-list label in any case is ignored'),
    args: [
      [
        'Epic Games',
        'BATTLE.NET',
        'Riot Client',
        'valorant',
        'Default',
        'Test',
        'User',
        'account',
        'alt',
        'blizzard',
        'battlenet',
        'riot games',
        'riot',
        'epic',
      ],
      'Epic Games BATTLE.NET Riot Client valorant default test user account alt blizzard battlenet riot games riot epic',
    ],
    expect: 'out',
  },
  {
    id: 'names-dotless-i',
    origin: adversarial(
      'case-mapping',
      'İstanbul is stored lowercased as i + U+0307, which JS /i never matches against İ, so the name as written stays unmasked',
    ),
    args: [['İstanbul'], 'from İstanbul and i\u0307stanbul'],
    expect: 'out',
  },
  {
    id: 'names-sharp-s',
    origin: adversarial('case-mapping', 'JS /i without u does not fold ß to ẞ (U+1E9E); a Unicode simple case fold does'),
    args: [['straße'], 'STRASSE STRAẞE Straße'],
    expect: 'out',
  },
  {
    id: 'names-kelvin',
    origin: adversarial('case-mapping', 'JS /i without u does not match k against the Kelvin sign U+212A; a Unicode fold does'),
    args: [['kleiner'], '\u212Aleiner and KLEINER'],
    expect: 'out',
  },
  {
    id: 'names-non-ascii-neighbour',
    origin: adversarial('word-boundary', 'the name guard is the ASCII class [A-Za-z0-9_], so a name next to é is still masked'),
    args: [['gordon_f'], 'égordon_fé'],
    expect: 'out',
  },
  {
    id: 'names-lone-surrogate',
    origin: adversarial('lone-surrogate', 'a lone surrogate next to a name does not stop the match'),
    args: [['gordon_f'], 'x\ud800gordon_f\udc00'],
    expect: 'out',
  },

  {
    id: 'kv-word-boundary-non-ascii',
    origin: adversarial('word-boundary', 'JS \\b is ASCII, so password=x right after é is still a key; a Unicode \\b sees no boundary'),
    args: [[], 'épassword=hunter2'],
    expect: 'out',
  },
  {
    id: 'kv-word-boundary-underscore',
    origin: adversarial('word-boundary', 'my_password=x has no \\b before password and is left alone'),
    args: [[], 'my_password=hunter2 mypassword=hunter2 my-password=hunter2'],
    expect: 'out',
  },
  {
    id: 'kv-value-stops-at-feff',
    origin: adversarial('unicode-space', 'JS \\s includes U+FEFF, so the value stops there; a Unicode White_Space class does not'),
    args: [[], 'password=abc\ufeffdef'],
    expect: 'out',
  },
  {
    id: 'kv-value-runs-over-nel',
    origin: adversarial('unicode-space', 'JS \\s excludes U+0085 (NEL), so the value runs on; a Unicode White_Space class stops'),
    args: [[], 'password=abc\u0085def'],
    expect: 'out',
  },
  {
    id: 'kv-value-stops-at-nbsp',
    origin: adversarial('unicode-space', 'U+00A0 and U+3000 are \\s in JS and end the value'),
    args: [[], 'token=abc\u00a0def token=ghi\u3000jkl'],
    expect: 'out',
  },
  {
    id: 'kv-long-s',
    origin: adversarial('case-mapping', 'JS /i without u never folds ſ (U+017F) to s, so paſſword is not a key; a Unicode fold would match it'),
    args: [[], 'paſſword=hunter2'],
    expect: 'out',
  },
  {
    id: 'kv-kelvin',
    origin: adversarial('case-mapping', 'api_\u212Aey with the Kelvin sign is not apikey in JS'),
    args: [[], 'api_\u212Aey=abc'],
    expect: 'out',
  },
  { id: 'kv-upper', origin: adversarial('case-mapping', 'ASCII case-insensitive keys'), args: [[], 'PASSWORD=x Token:y COOKIE = z'], expect: 'out' },
  {
    id: 'kv-every-key',
    origin: adversarial('regex', 'every key the free-text rule knows, with = and : and quotes'),
    args: [
      [],
      'pass=a passwd=b passphrase=c pwd=d secret=e token=f api-key=g apikey=h authorization=i cookie=j session=k refresh_token=l access-token=m credential=n credentials=o private_key=p',
    ],
    expect: 'out',
  },
  {
    id: 'kv-value-terminators',
    origin: adversarial('regex', 'the value ends at a quote, comma, semicolon, ampersand or closing brace'),
    args: [[], 'token=a,b token=c;d token=e&f token=g}h token=i\'j token=k"l'],
    expect: 'out',
  },
  { id: 'kv-empty-value', origin: adversarial('regex', 'a key with nothing after the separator is left alone'), args: [[], 'password= next'], expect: 'out' },
  {
    id: 'ini-data-spaces',
    origin: adversarial('unicode-space', 'Data = with spaces, and Data=\\u2028 where \\S stops'),
    args: [[], 'Data = blob1\nData=\u2028tail\nMetaData=x'],
    expect: 'out',
  },
  {
    id: 'steam-login-tabs',
    origin: adversarial('unicode-space', '-login with tabs and an ideographic space as separators'),
    args: [[], 'steam.exe -LOGIN\tuser\u3000secret rest'],
    expect: 'out',
  },
  {
    id: 'jwt-segment-min-at',
    origin: adversarial('regex', 'each JWT segment needs 8 characters: 8, 8, 8 is redacted'),
    args: [[], 'x eyJabcdefgh.abcdefgh.abcdefgh y'],
    expect: 'out',
  },
  {
    id: 'jwt-segment-min-over',
    origin: adversarial('regex', 'a last segment of 7 characters is not a JWT'),
    args: [[], 'x eyJabcdefgh.abcdefgh.abcdefg y'],
    expect: 'out',
  },
  {
    id: 'jwt-lookbehind',
    origin: adversarial('regex', 'a JWT glued to a word character or dash is not matched by the JWT rule'),
    args: [[], `a${JWT_LIKE} -${JWT_LIKE} é${JWT_LIKE}`],
    expect: 'out',
  },
  {
    id: 'cap-email-local-at',
    origin: adversarial('regex', 'a 64-character local part is masked whole'),
    args: [[], `${'l'.repeat(64)}@example.com`],
    expect: 'out',
  },
  {
    id: 'cap-email-local-over',
    origin: adversarial('regex', 'a 65-character local part: the match starts one character in'),
    args: [[], `${'l'.repeat(65)}@example.com`],
    expect: 'out',
  },
  { id: 'cap-email-label-at', origin: adversarial('regex', 'a 63-character domain label is masked'), args: [[], `a@${'d'.repeat(63)}.example`], expect: 'out' },
  {
    id: 'cap-email-label-over',
    origin: adversarial('regex', 'a 64-character first label: the domain match ends after 63, so the address is not masked whole'),
    args: [[], `a@${'d'.repeat(64)}.example`],
    expect: 'out',
  },
  { id: 'email-no-dot', origin: adversarial('regex', 'an address without a dot in the domain stays'), args: [[], 'a@localhost'], expect: 'out' },
  {
    id: 'steamid-arabic-digits',
    origin: adversarial('unicode-digit', 'JS \\d is ASCII, so 7656119 followed by Arabic-Indic digits is not a SteamID64'),
    args: [[], 'id 7656119٠١٢٣٤٥٦٧٨٩ end'],
    expect: 'out',
  },
  {
    id: 'steamid-boundaries',
    origin: adversarial('word-boundary', 'a SteamID64 inside a longer run of digits or letters is left; next to é it is masked'),
    args: [[], 'x765611980000000011 a76561198000000001 é76561198000000001é'],
    expect: 'out',
  },
  {
    id: 'uuid-boundary-non-ascii',
    origin: adversarial('word-boundary', 'a UUID next to é: JS \\b is ASCII, so it is masked'),
    args: [[], 'é8f3c1a2b-0000-4000-8000-00000000abcdé'],
    expect: 'out',
  },
  {
    id: 'uuid-glued',
    origin: adversarial('word-boundary', 'a UUID glued to letters is not masked'),
    args: [[], 'x8f3c1a2b-0000-4000-8000-00000000abcd'],
    expect: 'out',
  },
  {
    id: 'profile-path-long-s',
    origin: adversarial('case-mapping', 'C:\\Uſers\\name: JS /i without u does not fold ſ to s, so it is not a profile path; a Unicode fold would mask it'),
    args: [[], 'C:\\Uſers\\{name}\\x'],
    expect: 'out',
  },
  {
    id: 'profile-path-many-separators',
    origin: adversarial('regex', 'repeated and mixed separators after the drive and after Users'),
    args: [[], 'D:\\/\\USERS//\\someone\\x and e:/Users/Public'],
    expect: 'out',
  },
  {
    id: 'profile-path-name-stops',
    origin: adversarial('regex', 'the name ends at \\ / : * ? " < > | or a line break'),
    args: [[], 'C:\\Users\\someone:stream C:\\Users\\<user>\\x C:\\Users\\someone\nnext'],
    expect: 'out',
  },
  { id: 'cap-long-run-at', origin: adversarial('regex', 'a 48-character run with a digit is redacted'), args: [[], `x ${'a'.repeat(47)}1 y`], expect: 'out' },
  { id: 'cap-long-run-over', origin: adversarial('regex', 'a 47-character run with a digit stays'), args: [[], `x ${'a'.repeat(46)}1 y`], expect: 'out' },
  {
    id: 'long-run-padding',
    origin: adversarial('regex', 'up to two = after the run are taken with it'),
    args: [[], `x ${'a1'.repeat(24)}=== y`],
    expect: 'out',
  },
  {
    id: 'long-run-arabic-digit',
    origin: adversarial('unicode-digit', 'the digit check is ASCII \\d; Arabic-Indic digits are not in the run class at all'),
    args: [[], `x ${'a'.repeat(47)}٣ y`],
    expect: 'out',
  },
  {
    id: 'order-email-before-path',
    origin: adversarial('other', 'rules run in a fixed order: an email inside a profile path, a UUID inside a long run'),
    args: [[], 'C:\\Users\\%a@b.example%\\x 8f3c1a2b-0000-4000-8000-00000000abcd0123456789abcdefghij'],
    expect: 'out',
  },
  { id: 'empty', origin: adversarial('other', 'the empty string'), args: [[], ''], expect: 'out' },
  {
    id: 'lone-surrogates',
    origin: adversarial('lone-surrogate', 'lone surrogates pass through untouched'),
    args: [[], 'a\ud800b\udfffc password=\ud83d'],
    expect: 'out',
  },
  {
    id: 'not-a-string',
    origin: adversarial('other', 'a non-string input throws from String.prototype.replace being missing'),
    args: [[], 42],
    expect: 'error',
  },
  {
    id: 'undefined-input',
    origin: t('formatLine', 'drops a line it cannot redact instead of writing it as it came | redactString itself on undefined'),
    args: [[], undefined],
    expect: 'error',
  },
  {
    id: 'fixture-loginusers-names',
    origin: fixture('fixtures/launchers/steam/loginusers.vdf', 'its account and persona names handed over, then a message naming them'),
    args: [['user_1', 'user_2', 'user_3'], 'signed in as user_1, then User_2, not user_30'],
    expect: 'out',
  },
];

vectorFile({
  area: 'core',
  function: 'redactString',
  source: 'src/main/services/logger.ts',
  note: [
    'arg1 is the text to redact, an in-memory string (a log message or a serialised value), not file text.',
    NAMES_NOTE,
    'call: (arg0, arg1) => { forgetAccountNames(); redactAccountNames(arg0); return redactString(arg1); }.',
    'The bundle scan refuses a real-looking JWT, a non-placeholder user folder, a random 32-hex value and an email outside the example domains; the cases lifted from test/logger.test.ts that held one use a placeholder of the same shape, and their origin says so.',
  ].join('\n'),
  call: (list: Names, input: string) => {
    names(list);
    return redactString(input);
  },
  cases: stringCases,
});

const valueCases: Case[] = [
  {
    id: 'sensitive-keys-any-depth',
    origin: t('redactValue', 'replaces values under sensitive keys at any depth'),
    args: [[], { login: 'bob', password: 'hunter2', nested: { apiKey: 'k', secret_enc: Buffer.from('x'), list: [{ token: 't' }] } }, undefined],
    expect: 'out',
  },
  {
    id: 'cycle',
    origin: t('redactValue', 'summarises buffers and survives cycles and errors'),
    args: [[], { [MAKE]: 'self', value: { a: 1 }, key: 'self' }, undefined],
    expect: 'out',
  },
  {
    id: 'buffer',
    origin: t('redactValue', 'summarises buffers and survives cycles and errors'),
    args: [[], { [MAKE]: 'zero-bytes', length: 10 }, undefined],
    expect: 'out',
  },
  {
    id: 'error',
    origin: t('redactValue', 'summarises buffers and survives cycles and errors'),
    args: [[], { [MAKE]: 'error', message: 'bad password=abc' }, undefined],
    expect: 'out',
  },
  {
    id: 'every-sensitive-key',
    origin: adversarial('regex', 'every key the sensitive-key rule names, case-insensitive and anchored'),
    args: [
      [],
      Object.fromEntries(
        [
          'pass',
          'password',
          'passwd',
          'passphrase',
          'pwd',
          'secret',
          'secret_enc',
          'token',
          'api_key',
          'api-key',
          'apikey',
          'APIKEY',
          'authorization',
          'auth',
          'cookie',
          'session',
          'session_id',
          'session-blob',
          'sessiondata',
          'refresh_token',
          'access-token',
          'credential',
          'credentials',
          'private_key',
          'remember_me',
          'value_enc',
          'data',
          'Data',
          'DATA',
          'tokens',
          'my_token',
          'password2',
          'authority',
          'metadata',
        ].map((k) => [k, 'v']),
      ),
      undefined,
    ],
    expect: 'out',
  },
  {
    id: 'sensitive-key-object-value',
    origin: adversarial('other', 'an object under a sensitive key is replaced whole, not walked'),
    args: [[], { session: { id: 1, nested: { x: 2 } }, ok: { data: [1, 2] } }, undefined],
    expect: 'out',
  },
  {
    id: 'strings-redacted',
    origin: adversarial('other', 'strings anywhere are passed through redactString, account names included'),
    args: [['gordon_f'], { msg: 'gordon_f token=abc', list: ['a@b.example', 'C:\\Users\\someone\\x'] }, undefined],
    expect: 'out',
  },
  {
    id: 'primitives',
    origin: adversarial('number', 'numbers, booleans, null and undefined come back as they are'),
    args: [[], { n: 1.5, z: -0, nan: Number.NaN, inf: Number.POSITIVE_INFINITY, t: true, f: false, nil: null, undef: undefined }, undefined],
    expect: 'out',
  },
  { id: 'top-null', origin: adversarial('other', 'null at the top'), args: [[], null, undefined], expect: 'out' },
  { id: 'top-undefined', origin: adversarial('other', 'undefined at the top'), args: [[], undefined, undefined], expect: 'out' },
  { id: 'top-string', origin: adversarial('other', 'a string at the top'), args: [[], 'password=x', undefined], expect: 'out' },
  {
    id: 'function-and-symbol',
    origin: adversarial('other', 'a function and a symbol become [function] and [symbol]'),
    args: [[], { f: { [MAKE]: 'function' }, s: { [MAKE]: 'symbol', description: 'd' } }, undefined],
    expect: 'out',
  },
  {
    id: 'bigint',
    origin: adversarial('number', 'a bigint is returned as it is; the record shows it as { "%bigint": decimal }'),
    args: [[], { big: { [MAKE]: 'bigint', value: '12345678901234567890' } }, undefined],
    expect: 'out',
  },
  {
    id: 'error-fields',
    origin: adversarial('other', 'an Error keeps name, message and stack (redacted) and a string code; a number code and other properties are dropped'),
    args: [
      [],
      {
        a: {
          [MAKE]: 'error',
          name: 'TypeError',
          message: 'failed for a@b.example',
          stack: 'TypeError: failed\n    at C:\\Users\\someone\\x.js:1:1',
          code: 'ENOENT',
          extra: { path: 'p', token: 't' },
        },
        b: { [MAKE]: 'error', message: 'numeric code', code: 7 },
        c: { [MAKE]: 'error', message: 'no stack', stack: undefined },
      },
      undefined,
    ],
    expect: 'out',
  },
  {
    id: 'shared-reference',
    origin: adversarial('other', 'the same object under two keys: the second is reported as [circular] though there is no cycle'),
    args: [[], { [MAKE]: 'shared', value: { x: 1 }, keys: ['a', 'b'] }, undefined],
    expect: 'out',
  },
  {
    id: 'array-cycle',
    origin: adversarial('other', 'an array that contains itself'),
    args: [[], { [MAKE]: 'self', value: { list: [1] }, key: 'me' }, undefined],
    expect: 'out',
  },
  {
    id: 'map-and-typed-array',
    origin: adversarial(
      'other',
      'a Map has no own entries and becomes {}; a Uint16Array is walked by index; a boxed string by character; a Date has no own entries',
    ),
    args: [
      [],
      {
        m: { [MAKE]: 'map', entries: [['k', 'v']] },
        u: { [MAKE]: 'uint16', values: [1, 2] },
        s: { [MAKE]: 'boxed-string', value: 'ab' },
        d: new Date('2026-01-02T03:04:05.000Z'),
      },
      undefined,
    ],
    expect: 'out',
  },
  {
    id: 'uint8-nested',
    origin: adversarial('other', 'a nested Uint8Array becomes <bytes n>'),
    args: [[], { b: Buffer.from('abc'), e: Buffer.alloc(0) }, undefined],
    expect: 'out',
  },
  {
    id: 'cap-depth-at',
    origin: adversarial('other', 'objects nested 6 deep: the sixth level is still walked, its children become [depth]'),
    args: [[], { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } }, undefined],
    expect: 'out',
  },
  {
    id: 'cap-depth-scalars',
    origin: adversarial('other', 'past the depth limit a scalar is still returned; only objects become [depth]'),
    args: [[], { a: { b: { c: { d: { e: { f: 'deep token=x', g: [1] } } } } } }, undefined],
    expect: 'out',
  },
  {
    id: 'depth-arg-at-limit',
    origin: adversarial('other', 'called with depth 6: an object at the top is [depth] at once'),
    args: [[], { a: 1 }, 6],
    expect: 'out',
  },
  { id: 'depth-arg-below', origin: adversarial('other', 'called with depth 5: one level is walked'), args: [[], { a: { b: 1 }, s: 'x' }, 5], expect: 'out' },
  {
    id: 'depth-arg-negative',
    origin: adversarial('other', 'called with depth -1: one more level than the default'),
    args: [[], { a: { b: { c: { d: { e: { f: { g: { h: 1 } } } } } } } }, -1],
    expect: 'out',
  },
  {
    id: 'depth-arg-nan',
    origin: adversarial('number', 'called with depth NaN: NaN >= 6 is false at every level, so nothing is ever cut'),
    args: [[], { a: { b: { c: { d: { e: { f: { g: { h: 1 } } } } } } } }, Number.NaN],
    expect: 'out',
  },
  {
    id: 'depth-arg-on-scalar',
    origin: adversarial('other', 'the depth limit does not apply to a string at the top'),
    args: [[], 'token=x', 99],
    expect: 'out',
  },
  {
    id: 'getter-throws',
    origin: adversarial('other', 'an enumerable getter that throws makes redactValue throw'),
    args: [[], { [MAKE]: 'throwing-getter', key: 'bad' }, undefined],
    expect: 'error',
  },
  {
    id: 'to-json-not-called',
    origin: adversarial('other', 'toJSON is an own function property: it is copied as [function], never called'),
    args: [[], { [MAKE]: 'to-json', value: { a: 1 }, returns: 'replaced' }, undefined],
    expect: 'out',
  },
  {
    id: 'proto-key',
    origin: adversarial(
      'json',
      'an own __proto__ key (as JSON.parse makes it) is copied with a plain assignment, which sets the prototype of the copy instead of a property, so the key is gone from the result',
    ),
    args: [[], JSON.parse('{"__proto__":{"token":"x"},"a":1}'), undefined],
    expect: 'out',
  },
  {
    id: 'integer-keys-order',
    origin: adversarial('sort', 'integer-like keys come first in JS enumeration order, then insertion order'),
    args: [[], { b: 1, 2: 'two', a: 2, 1: 'one' }, undefined],
    expect: 'out',
  },
  {
    id: 'lone-surrogate-key',
    origin: adversarial('lone-surrogate', 'a key and a value with lone surrogates'),
    args: [[], { ['k\ud800']: 'v\udc00' }, undefined],
    expect: 'out',
  },
];

vectorFile({
  area: 'core',
  function: 'redactValue',
  source: 'src/main/services/logger.ts',
  note: [
    'arg1 is the value to copy, arg2 the starting depth (undefined for the default 0; the third parameter, the seen set, is always the default).',
    NAMES_NOTE,
    BUILD_NOTE,
    'call: (arg0, arg1, arg2) => { forgetAccountNames(); redactAccountNames(arg0); return project(redactValue(build(arg1), arg2)); }. project replaces each bigint in the result with { "%bigint": its decimal }; nothing else is changed. build copies plain objects with Object.fromEntries, so an own __proto__ key of arg1 stays an own key going in.',
    'gap: src/main/services/logger.ts:138:34 if arm (return String(value)), unreachable: every typeof other than object is handled above it.',
  ].join('\n'),
  call: (list: Names, value: unknown, depth: number | undefined) => {
    names(list);
    return project(redactValue(build(value), depth));
  },
  cases: valueCases,
});

const LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];
const TS = '2026-09-11T00:00:00.000Z';

const lineCases: Case[] = [
  {
    id: 'formats-and-redacts',
    origin: t('formatLine', 'formats and redacts message and metadata'),
    args: [[], TS, 'info', 'main', 'hello password=x', { token: 'abc', ok: true }],
    expect: 'out',
  },
  ...LEVELS.map((level) => ({
    id: `level-${level}`,
    origin: adversarial('utf16-length', `level ${level} is upper-cased and padded to 5 units`),
    args: [[], TS, level, 'main', 'm'],
    expect: 'out' as const,
  })),
  {
    id: 'one-line',
    origin: t('formatLine', 'keeps a message on one line, and clips long text only after redacting it (S3)'),
    args: [[], 't', 'warn', 'main:updates', 'bad feed\r\n2026-09-11T00:00:00.000Z ERROR [main] forged'],
    expect: 'out',
  },
  {
    id: 'clips-both',
    origin: t('formatLine', 'keeps a message on one line, and clips long text only after redacting it (S3)'),
    args: [[], 't', 'warn', 'x', 'word '.repeat(4000), { stack: 'y'.repeat(20_000) }],
    expect: 'out',
  },
  {
    id: 'clips-after-redacting',
    origin: t('formatLine', 'keeps a message on one line, and clips long text only after redacting it (S3)'),
    args: [[], 't', 'warn', 'x', `${'x '.repeat(4090)}${'A1b2'.repeat(16)}`],
    expect: 'out',
  },
  {
    id: 'redaction-failed',
    origin: t('formatLine', 'drops a line it cannot redact instead of writing it as it came'),
    args: [[], 't', 'info', 'x', undefined, { note: 'kept out too' }],
    expect: 'out',
  },
  {
    id: 'error-in-meta',
    origin: t('redactString', 'redacts email addresses and SteamID64s, including inside error messages | the address a@b.example for a@b.io'),
    args: [[], 't', 'error', 'x', 'adapter call failed', { error: { [MAKE]: 'error', message: 'The session belongs to a@b.example (76561198000000001)' } }],
    expect: 'out',
  },
  {
    id: 'profile-path-in-stack',
    origin: t(
      'redactString',
      'masks the Windows user name in a profile path, raw, JSON-escaped, or with forward slashes, including in an error stack (H5) | the user folder someone for jo',
    ),
    args: [
      [],
      't',
      'warn',
      'main',
      'starting',
      {
        dataDir: 'C:\\Users\\someone\\AppData\\Roaming\\OneLaunch',
        error: {
          [MAKE]: 'error',
          message: "ENOENT: no such file or directory, open 'C:\\Users\\someone\\AppData\\Roaming\\Battle.net\\Battle.net.config'",
          stack:
            "Error: ENOENT: no such file or directory, open 'C:\\Users\\someone\\AppData\\Roaming\\Battle.net\\Battle.net.config'\n    at readConfig (C:\\Users\\someone\\AppData\\Local\\Programs\\One Launch\\resources\\app.asar\\out\\main\\index.js:10:5)",
        },
      },
    ],
    expect: 'out',
  },
  {
    id: 'names-in-meta',
    origin: t('account names', 'masks a name once it has been handed over, in messages, errors, and metadata, whatever its case'),
    args: [
      FREEMAN,
      't',
      'error',
      'main:ipc',
      'handler failed',
      { error: { [MAKE]: 'error', message: 'An account named "Dr. Freeman (main)" already uses this login' }, reason: 'Before switching to gordon_f' },
    ],
    expect: 'out',
  },
  {
    id: 'too-long-name-ignored',
    origin: t('account names', 'ignores a name too long to be a login, so a tampered loginusers.vdf cannot break logging (S3)'),
    args: [['x'.repeat(40_000), 'gordon_f'], 't', 'info', 'x', 'signed in as gordon_f'],
    expect: 'out',
  },
  {
    id: 'cap-message-at',
    origin: adversarial('utf16-length', 'a message of exactly 8192 units is not clipped'),
    args: [[], 't', 'info', 'x', 'm'.repeat(8192)],
    expect: 'out',
  },
  {
    id: 'cap-message-over',
    origin: adversarial('utf16-length', 'a message of 8193 units is clipped to 8192 and says 1 more character'),
    args: [[], 't', 'info', 'x', 'm'.repeat(8193)],
    expect: 'out',
  },
  {
    id: 'cap-message-astral-straddle',
    origin: adversarial('utf16-length', 'an emoji at units 8192 and 8193: the clip cuts it in half and leaves a lone high surrogate'),
    args: [[], 't', 'info', 'x', `${'m'.repeat(8191)}😀`],
    expect: 'out',
  },
  {
    id: 'cap-meta-at',
    origin: adversarial('utf16-length', 'serialised meta of exactly 8192 units (a string of 8190 plus its quotes) is not clipped'),
    args: [[], 't', 'info', 'x', 'm', 'v'.repeat(8190)],
    expect: 'out',
  },
  {
    id: 'cap-meta-over',
    origin: adversarial('utf16-length', 'serialised meta of 8193 units is clipped'),
    args: [[], 't', 'info', 'x', 'm', 'v'.repeat(8191)],
    expect: 'out',
  },
  {
    id: 'clip-grows-after-redaction',
    origin: adversarial('utf16-length', 'redaction lengthens the message ([REDACTED] for a short value) before the clip measures it'),
    args: [[], 't', 'info', 'x', `${'m'.repeat(8180)} token=a`],
    expect: 'out',
  },
  {
    id: 'meta-bigint',
    origin: adversarial('json', 'a bigint in meta makes JSON.stringify throw, so the meta is written as "[unserializable]"'),
    args: [[], 't', 'info', 'x', 'm', { n: { [MAKE]: 'bigint', value: '1' } }],
    expect: 'out',
  },
  {
    id: 'meta-getter-throws',
    origin: adversarial('other', 'meta whose getter throws: redactValue throws inside the meta guard, so the meta is written as "[unserializable]"'),
    args: [[], 't', 'info', 'x', 'm', { [MAKE]: 'throwing-getter', key: 'bad' }],
    expect: 'out',
  },
  {
    id: 'meta-undefined-omitted',
    origin: adversarial('other', 'meta undefined writes no meta at all'),
    args: [[], 't', 'info', 'x', 'm', undefined],
    expect: 'out',
  },
  { id: 'meta-null', origin: adversarial('json', 'meta null is written as null'), args: [[], 't', 'info', 'x', 'm', null], expect: 'out' },
  {
    id: 'meta-numbers',
    origin: adversarial('number', 'JSON.stringify formatting: NaN and Infinity as null, -0 as 0, 1e21, 0.1, 5e-7'),
    args: [[], 't', 'info', 'x', 'm', [Number.NaN, Number.POSITIVE_INFINITY, -0, 1e21, 0.1, 5e-7, 123456789012345680000]],
    expect: 'out',
  },
  {
    id: 'meta-undefined-members',
    origin: adversarial('json', 'undefined in an object is left out, in an array becomes null; functions likewise as [function] strings'),
    args: [[], 't', 'info', 'x', 'm', { a: undefined, l: [undefined, 1], f: { [MAKE]: 'function' } }],
    expect: 'out',
  },
  {
    id: 'meta-string-escapes',
    origin: adversarial('json', 'JSON.stringify escapes control characters and quotes, keeps non-ASCII, and escapes lone surrogates as \\ud800'),
    args: [[], 't', 'info', 'x', 'm', { s: 'q"b\\\u0001\u007f\u2028é😀\ud800' }],
    expect: 'out',
  },
  {
    id: 'meta-newlines-not-escaped-again',
    origin: adversarial('other', 'meta newlines are already \\n inside the JSON; the message gets the \\r \\n rewrite, meta does not need it'),
    args: [[], 't', 'info', 'x', 'a\rb\nc', { s: 'a\r\nb' }],
    expect: 'out',
  },
  {
    id: 'level-non-ascii',
    origin: adversarial('case-mapping', 'a level outside the four: ß upper-cases to SS, then padEnd'),
    args: [[], 't', 'ß', 'x', 'm'],
    expect: 'out',
  },
  {
    id: 'level-astral',
    origin: adversarial('utf16-length', 'padEnd counts UTF-16 units: an emoji level is padded with 3 spaces'),
    args: [[], 't', '😀', 'x', 'm'],
    expect: 'out',
  },
  { id: 'level-long', origin: adversarial('utf16-length', 'a level longer than 5 is not cut'), args: [[], 't', 'verbose', 'x', 'm'], expect: 'out' },
  {
    id: 'scope-not-redacted',
    origin: adversarial('other', 'the timestamp and scope are written as given, not redacted, line breaks included'),
    args: [['gordon_f'], 'ts\n', 'info', 'gordon_f token=x', 'm'],
    expect: 'out',
  },
  {
    id: 'level-not-a-string',
    origin: adversarial('other', 'a level that is not a string throws before the guarded part'),
    args: [[], 't', 7, 'x', 'm'],
    expect: 'error',
  },
  {
    id: 'message-number',
    origin: adversarial('other', 'a number message fails redaction, so the line is dropped'),
    args: [[], 't', 'info', 'x', 42],
    expect: 'out',
  },
];

vectorFile({
  area: 'core',
  function: 'formatLine',
  source: 'src/main/services/logger.ts',
  note: [
    'arg1 is the timestamp (emit passes new Date().toISOString(); here a fixed string, so no clock), arg2 the level, arg3 the scope, arg4 the message, arg5 the meta (left out of the call when undefined, as a call with four arguments).',
    NAMES_NOTE,
    BUILD_NOTE,
    'call: (arg0, ...rest) => { forgetAccountNames(); redactAccountNames(arg0); return formatLine(arg1, arg2, arg3, arg4, build(arg5)); }.',
    'The clip limit is 8192 UTF-16 units, applied separately to the redacted message and to the redacted meta text.',
  ].join('\n'),
  call: (list: Names, timestamp: string, level: LogLevel, scope: string, message: string, meta?: unknown) => {
    names(list);
    return meta === undefined ? formatLine(timestamp, level, scope, message) : formatLine(timestamp, level, scope, message, build(meta));
  },
  cases: lineCases,
});
