import { adversarial, bundleBytes, bytes, corpus, file, fixture, fromTest, input, text, vectorFile, type Case, type MutationName } from '../lib/index';
import { findLoginUser, parseLoginUsers, planAutoLoginRewrite } from '../../../../src/main/launchers/steam/loginusers';
import { droppedNote, STEAMID, withoutHangs } from './support';

const SOURCE = 'src/main/launchers/steam/loginusers.ts';
const LINE_OPS: MutationName[] = ['line-duplicate', 'line-delete', 'line-swap', 'eol', 'bom', 'astral', 'invalid-utf8'];
const TESTS = 'test/steam-files.test.ts';
const LOGGER = 'test/logger.test.ts';
const LOGINUSERS = 'fixtures/launchers/steam/loginusers.vdf';
const original = bundleBytes(LOGINUSERS);
const originalText = original.toString('utf8');

const CRLF_PATH = 'l1/steam/files/planAutoLoginRewrite/loginusers-crlf.vdf';
const BOM_PATH = 'l1/steam/files/planAutoLoginRewrite/loginusers-bom.vdf';
const MOSTRECENT_PATH = 'l1/steam/files/planAutoLoginRewrite/mostrecent-crlf.vdf';
const SYNONYMS_PATH = 'l1/steam/files/parseLoginUsers/synonyms.vdf';
const crlfBytes = Buffer.from(originalText.replace(/\n/g, '\r\n'));
const bomBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), original]);
const crlfInput = () => input('steam', 'planAutoLoginRewrite/loginusers-crlf.vdf', crlfBytes);
const bomInput = () => input('steam', 'planAutoLoginRewrite/loginusers-bom.vdf', bomBytes);

const MOSTRECENT_LITERAL = [
  '"users"',
  '{',
  '\t"76561198000000001"',
  '\t{',
  '\t\t"AccountName"\t\t"a"',
  '\t\t"MostRecent"\t\t"1"',
  '\t}',
  '\t"76561198000000002"',
  '\t{',
  '\t\t"AccountName"\t\t"b"',
  '\t\t"Timestamp"\t\t"1"',
  '\t}',
  '}',
  '',
].join('\r\n');
const mostRecentBytes = Buffer.from(MOSTRECENT_LITERAL);
const mostRecentInput = () => input('steam', 'planAutoLoginRewrite/mostrecent-crlf.vdf', mostRecentBytes);

const SYNONYMS_LITERAL = `"users"
{
\t"76561198000000009"
\t{
\t\t"AccountName"\t\t"old_client"
\t\t"MostRecent"\t\t"1"
\t}
\t"not-a-steamid"
\t{
\t\t"AccountName"\t\t"ignored"
\t}
\t"76561198000000010"
\t{
\t\t"PersonaName"\t\t"no account name"
\t}
}`;
const synonymsBytes = Buffer.from(SYNONYMS_LITERAL);

const LOGGER_LITERAL = '"users"\n{\n\t"76561198000000009"\n\t{\n\t\t"AccountName"\t\t"headcrab_9"\n\t\t"PersonaName"\t\t"Lamarr"\n\t}\n}\n';

const DECODE_NOTE =
  'arg0 is loginusers.vdf as src/main/launchers/steam/adapter.ts reads it: readLauncherText(path, MAX_VDF_BYTES) (readFileSync then toString utf8) or readFileSync(path, utf8); both keep a BOM and turn invalid bytes into U+FFFD.';
const REDACT_NOTE =
  'Global state: every call hands the account and persona names it found to redactAccountNames (src/main/services/logger.ts), which adds them to the logger’s module-level redaction list; the result does not depend on that list and the generator never resets it.';

const block = (id: string, lines: string[], indent = '\t'): string[] => [
  `${indent}"${id}"`,
  `${indent}{`,
  ...lines.map((l) => `${indent}\t${l}`),
  `${indent}}`,
];
const users = (...blocks: string[][]): string => ['"users"', '{', ...blocks.flat(), '}', ''].join('\n');
const acct = (name: string) => `"AccountName"\t\t"${name}"`;

const userEntry = (id: string, name: string, extra: string[] = []): string[] => block(id, [acct(name), ...extra]);

const parseCases = (): { cases: Case[]; dropped: string[] } => {
  const hand: Case[] = [
    { id: 'fixture', origin: fromTest(TESTS, 'parseLoginUsers', 'reads every remembered account from the fixture'), args: [file(LOGINUSERS)], expect: 'out' },
    {
      id: 'synonyms-and-malformed',
      origin: fromTest(TESTS, 'parseLoginUsers', 'treats MostRecent and AutoLogin as synonyms and skips malformed blocks'),
      args: [input('steam', 'parseLoginUsers/synonyms.vdf', synonymsBytes)],
      expect: 'out',
    },
    { id: 'no-users-block', origin: fromTest(TESTS, 'parseLoginUsers', 'rejects a file without a users block'), args: [text('"nope" { }')], expect: 'error' },
    {
      id: 'logger-feed',
      origin: fromTest(LOGGER, 'account names', 'is fed by the accounts table and by loginusers.vdf, so a name is covered from the moment it is read'),
      args: [text(LOGGER_LITERAL)],
      expect: 'out',
    },
    { id: 'fixture-crlf', origin: fixture(CRLF_PATH), args: [crlfInput()], expect: 'out' },
    { id: 'fixture-bom', origin: fixture(BOM_PATH), args: [bomInput()], expect: 'out' },
    { id: 'fixture-mostrecent-crlf', origin: fixture(MOSTRECENT_PATH), args: [mostRecentInput()], expect: 'out' },
    {
      id: 'users-is-string',
      origin: adversarial('other', 'a users key whose value is a string is no users block'),
      args: [text('"users" "x"')],
      expect: 'error',
    },
    {
      id: 'users-case-insensitive',
      origin: adversarial('case-mapping', 'the users block is found case-insensitively'),
      args: [text(users(userEntry(STEAMID(1), 'user_1')).replace('"users"', '"USERS"'))],
      expect: 'out',
    },
    { id: 'empty-users', origin: adversarial('other', 'an empty users block gives no accounts'), args: [text('"users" { }')], expect: 'out' },
    { id: 'vdf-error', origin: adversarial('other', 'a VdfParseError from the parser propagates as it is'), args: [text('"users"\n{\n')], expect: 'error' },
    {
      id: 'entry-is-string',
      origin: adversarial('other', 'a SteamID64 key with a string value is skipped'),
      args: [text(`"users" { "${STEAMID(1)}" "x" }`)],
      expect: 'out',
    },
    {
      id: 'cap-steamid-digits-min-at',
      origin: adversarial('other', 'a 15-digit id is the shortest accepted'),
      args: [text(users(userEntry('765611980000001', 'user_1')))],
      expect: 'out',
    },
    {
      id: 'cap-steamid-digits-min-under',
      origin: adversarial('other', 'a 14-digit id is skipped'),
      args: [text(users(userEntry('76561198000000', 'user_1')))],
      expect: 'out',
    },
    {
      id: 'cap-steamid-digits-max-at',
      origin: adversarial('other', 'a 20-digit id is the longest accepted'),
      args: [text(users(userEntry('76561198000000000001', 'user_1')))],
      expect: 'out',
    },
    {
      id: 'cap-steamid-digits-max-over',
      origin: adversarial('other', 'a 21-digit id is skipped'),
      args: [text(users(userEntry('765611980000000000001', 'user_1')))],
      expect: 'out',
    },
    {
      id: 'steamid-unicode-digits',
      origin: adversarial(
        'unicode-digit',
        '\\d in STEAMID64_PATTERN has no u flag: ids in Arabic-Indic or fullwidth digits are skipped, a Unicode \\d would take them',
      ),
      args: [text(users(userEntry('٧٦٥٦١١٩٨٠٠٠٠٠٠٠١', 'user_1'), userEntry('７６５６１１９８０００００００２', 'user_2'), userEntry(STEAMID(3), 'user_3')))],
      expect: 'out',
    },
    {
      id: 'steamid-trailing-newline',
      origin: adversarial('regex', '$ without the m flag is the end of the input only, so an id key ending in an escaped newline is skipped'),
      args: [text(users(userEntry(`${STEAMID(1)}\\n`, 'user_1'), userEntry(STEAMID(2), 'user_2')))],
      expect: 'out',
    },
    {
      id: 'steamid-signed',
      origin: adversarial('parseint', 'ids with a sign or spaces are skipped'),
      args: [text(users(userEntry(`+${STEAMID(1)}`, 'user_1'), userEntry(` ${STEAMID(2)}`, 'user_2'), userEntry(STEAMID(3), 'user_3')))],
      expect: 'out',
    },
    {
      id: 'account-name-trim',
      origin: adversarial('unicode-space', 'account and persona names are trimmed with the JS trim (tab, NBSP, U+3000, U+FEFF)'),
      args: [text(users(userEntry(STEAMID(1), ' \tuser_1 　', ['"PersonaName"\t\t"﻿Persona One "'])))],
      expect: 'out',
    },
    {
      id: 'account-name-only-space',
      origin: adversarial('unicode-space', 'a name of only NBSP, U+FEFF or U+2028 trims to empty and the block is skipped'),
      args: [text(users(userEntry(STEAMID(1), ' '), userEntry(STEAMID(2), '﻿'), userEntry(STEAMID(3), '  '), userEntry(STEAMID(4), 'user_4')))],
      expect: 'out',
    },
    {
      id: 'account-name-nel',
      origin: adversarial('unicode-space', 'JS trim keeps U+0085 and U+180E (Rust str::trim strips U+0085), so these names survive'),
      args: [text(users(userEntry(STEAMID(1), '\u0085'), userEntry(STEAMID(2), '᠎'), userEntry(STEAMID(3), '\u0085user_3\u0085')))],
      expect: 'out',
    },
    {
      id: 'account-name-block',
      origin: adversarial('other', 'an AccountName that is a block is no name'),
      args: [text(users(block(STEAMID(1), ['"AccountName" { "x" "y" }']), userEntry(STEAMID(2), 'user_2')))],
      expect: 'out',
    },
    {
      id: 'keys-any-case',
      origin: adversarial('case-mapping', 'every key is looked up case-insensitively, and mostRecentKeys names the canonical key'),
      args: [text(users(block(STEAMID(1), ['"accountname" "user_1"', '"PERSONANAME" "P"', '"rememberpassword" "1"', '"autologin" "1"', '"TIMESTAMP" "5"'])))],
      expect: 'out',
    },
    {
      id: 'mostrecent-keys-order',
      origin: adversarial('other', 'mostRecentKeys is always AutoLogin then MostRecent, whatever the order in the file'),
      args: [text(users(block(STEAMID(1), ['"AccountName" "user_1"', '"MostRecent" "0"', '"AutoLogin" "1"'])))],
      expect: 'out',
    },
    {
      id: 'mostrecent-either',
      origin: adversarial('other', 'mostRecent is true when either synonym is 1, here only MostRecent'),
      args: [text(users(block(STEAMID(1), ['"AccountName" "user_1"', '"AutoLogin" "0"', '"MostRecent" " 1 "'])))],
      expect: 'out',
    },
    {
      id: 'flags-not-one',
      origin: adversarial('parseint', 'RememberPassword and AutoLogin of 01, true and 1.0 are all false'),
      args: [
        text(
          users(
            block(STEAMID(1), ['"AccountName" "user_1"', '"RememberPassword" "01"', '"AutoLogin" "true"']),
            block(STEAMID(2), ['"AccountName" "user_2"', '"RememberPassword" "1.0"', '"MostRecent" "１"']),
          ),
        ),
      ],
      expect: 'out',
    },
    {
      id: 'timestamps',
      origin: adversarial('number', 'Timestamp through vdfInt: -0, negative, padded, 2^53 and junk'),
      args: [
        text(
          users(
            block(STEAMID(1), ['"AccountName" "user_1"', '"Timestamp" "-0"']),
            block(STEAMID(2), ['"AccountName" "user_2"', '"Timestamp" "-5"']),
            block(STEAMID(3), ['"AccountName" "user_3"', '"Timestamp" "  0012 "']),
            block(STEAMID(4), ['"AccountName" "user_4"', '"Timestamp" "9007199254740992"']),
            block(STEAMID(5), ['"AccountName" "user_5"', '"Timestamp" "12x"']),
          ),
        ),
      ],
      expect: 'out',
    },
    {
      id: 'duplicate-id',
      origin: adversarial('other', 'a repeated SteamID64 block replaces the first one but keeps its position'),
      args: [text(users(userEntry(STEAMID(1), 'first'), userEntry(STEAMID(2), 'user_2'), userEntry(STEAMID(1), 'second')))],
      expect: 'out',
    },
    {
      id: 'proto-key-skipped',
      origin: adversarial('other', 'a __proto__ block among the users is skipped like any other non-id key and pollutes nothing'),
      args: [text(users(userEntry('__proto__', 'proto_user'), userEntry('constructor', 'ctor_user'), userEntry(STEAMID(1), 'user_1')))],
      expect: 'out',
    },
    {
      id: 'astral-names',
      origin: adversarial('utf16-length', 'astral characters in names are kept whole'),
      args: [text(users(userEntry(STEAMID(1), '\u{1F600}user', ['"PersonaName" "\u{1D7D8}\u{10FFFF}"'])))],
      expect: 'out',
    },
    {
      id: 'invalid-utf8-name',
      origin: adversarial('utf8-decode', 'a lone 0xFF and a CESU surrogate (0xED 0xA0 0xBD) in names become U+FFFD as Node decodes them'),
      args: [bytes(Buffer.from(original.toString('latin1').replace('"user_3"', '"user_\xff3"').replace('"Persona Two"', '"P\xed\xa0\xbd"'), 'latin1'))],
      expect: 'out',
    },
  ];
  const generated = withoutHangs(
    corpus({
      seed: 21,
      count: 150,
      from: [
        { path: LOGINUSERS },
        { path: CRLF_PATH, bytes: crlfBytes },
        { path: MOSTRECENT_PATH, bytes: mostRecentBytes },
        { path: SYNONYMS_PATH, bytes: synonymsBytes },
      ],
      args: (mutated) => [mutated],
    }),
  );
  return { cases: [...hand, ...generated.cases], dropped: generated.dropped };
};

const parsed = parseCases();

vectorFile({
  area: 'steam',
  function: 'parseLoginUsers',
  source: SOURCE,
  decode: { 0: 'utf8' },
  note: [
    DECODE_NOTE,
    REDACT_NOTE,
    'Errors: LoginUsersFormatError (code LOGINUSERS_FORMAT) when there is no users block; VdfParseError from the parser as it is.',
    'Caps: STEAMID64_PATTERN takes 15 to 20 ASCII digits (cap-steamid-digits-*). The 1 MiB MAX_VDF_BYTES limit is the I/O caller.',
    'Bases of the corpus: the fixture, its CRLF copy, the MostRecent CRLF literal and the synonyms literal of steam-files.test.ts (as l1/steam/files/…).',
    droppedNote(parsed.dropped),
  ].join('\n'),
  call: parseLoginUsers,
  cases: parsed.cases,
});

const T_FLIP = 'flips AutoLogin to the target and clears it everywhere else, touching nothing else';
const T_NOOP = 'is a no-op when the target is already the only most recent account';
const T_MOST = 'rewrites MostRecent on older files, adds AutoLogin where neither key exists, and keeps CRLF';
const T_REFUSE = 'refuses a target that is not in the file';

const rewriteCases = (): { cases: Case[]; dropped: string[] } => {
  const hand: Case[] = [
    { id: 'flip-to-user-3', origin: fromTest(TESTS, 'planAutoLoginRewrite', T_FLIP), args: [file(LOGINUSERS), STEAMID(3)], expect: 'out' },
    { id: 'noop-user-1', origin: fromTest(TESTS, 'planAutoLoginRewrite', T_NOOP), args: [file(LOGINUSERS), STEAMID(1)], expect: 'out' },
    { id: 'mostrecent-crlf', origin: fromTest(TESTS, 'planAutoLoginRewrite', T_MOST), args: [mostRecentInput(), STEAMID(2)], expect: 'out' },
    { id: 'unknown-target', origin: fromTest(TESTS, 'planAutoLoginRewrite', T_REFUSE), args: [file(LOGINUSERS), STEAMID(99)], expect: 'error' },
    { id: 'flip-to-user-2', origin: fixture(LOGINUSERS), args: [file(LOGINUSERS), STEAMID(2)], expect: 'out' },
    { id: 'flip-to-user-4', origin: fixture(LOGINUSERS), args: [file(LOGINUSERS), STEAMID(4)], expect: 'out' },
    { id: 'undefined-target', origin: fixture(LOGINUSERS, 'target left undefined'), args: [file(LOGINUSERS), undefined], expect: 'error' },
    { id: 'empty-target', origin: fixture(LOGINUSERS, 'empty target'), args: [file(LOGINUSERS), ''], expect: 'error' },
    { id: 'crlf-file', origin: fixture(CRLF_PATH), args: [crlfInput(), STEAMID(3)], expect: 'out' },
    { id: 'crlf-file-noop', origin: fixture(CRLF_PATH), args: [crlfInput(), STEAMID(1)], expect: 'out' },
    { id: 'bom-file', origin: fixture(BOM_PATH), args: [bomInput(), STEAMID(3)], expect: 'out' },
    { id: 'mostrecent-target-1', origin: fixture(MOSTRECENT_PATH), args: [mostRecentInput(), STEAMID(1)], expect: 'out' },
    {
      id: 'synonyms-target-9',
      origin: fixture(SYNONYMS_PATH),
      args: [input('steam', 'parseLoginUsers/synonyms.vdf', synonymsBytes), STEAMID(9)],
      expect: 'out',
    },
    {
      id: 'synonyms-target-no-name',
      origin: fixture(SYNONYMS_PATH, 'target is the block without an AccountName'),
      args: [input('steam', 'parseLoginUsers/synonyms.vdf', synonymsBytes), STEAMID(10)],
      expect: 'error',
    },
    {
      id: 'not-vdf',
      origin: fixture(LOGINUSERS, 'cut after the first block opens'),
      args: [bytes(original.subarray(0, original.indexOf(0x7b) + 1)), STEAMID(3)],
      expect: 'error',
    },
    {
      id: 'no-users-block',
      origin: adversarial('other', 'the format error of parseLoginUsers propagates'),
      args: [text('"nope" { }'), STEAMID(1)],
      expect: 'error',
    },
    {
      id: 'invalid-utf8-in-name',
      origin: adversarial('utf8-decode', 'a lone 0xFF byte in an account name; Node decodes it to U+FFFD and the rewritten text carries U+FFFD'),
      args: [bytes(Buffer.from(original.toString('latin1').replace('"user_3"', '"user_\xff3"'), 'latin1')), STEAMID(3)],
      expect: 'out',
    },
    {
      id: 'both-keys',
      origin: adversarial('other', 'a block with AutoLogin and MostRecent gets both set'),
      args: [
        text(
          users(
            block(STEAMID(1), ['"AccountName"\t\t"a"', '"AutoLogin"\t\t"1"', '"MostRecent"\t\t"1"']),
            block(STEAMID(2), ['"AccountName"\t\t"b"', '"MostRecent"\t\t"0"', '"AutoLogin"\t\t"0"']),
          ),
        ),
        STEAMID(2),
      ],
      expect: 'out',
    },
    {
      id: 'key-case-kept',
      origin: adversarial('case-mapping', 'MOST_RECENT_LINE has the i flag: autologin and MOSTRECENT lines are rewritten with their own spelling'),
      args: [
        text(users(block(STEAMID(1), ['"AccountName"\t\t"a"', '"autologin"\t\t"1"']), block(STEAMID(2), ['"AccountName"\t\t"b"', '"MOSTRECENT"\t\t"0"']))),
        STEAMID(2),
      ],
      expect: 'out',
    },
    {
      id: 'long-s-not-folded',
      origin: adversarial(
        'case-mapping',
        'the i flag without u does not fold U+017F (long s) to s, so "Moſtrecent" is not a synonym and the block gets an AutoLogin line; a Unicode case-insensitive match would take it',
      ),
      args: [
        text(users(block(STEAMID(1), ['"AccountName"\t\t"a"', '"Moſtrecent"\t\t"1"']), block(STEAMID(2), ['"AccountName"\t\t"b"', '"AutoLogin"\t\t"0"']))),
        STEAMID(2),
      ],
      expect: 'out',
    },
    {
      id: 'value-padded',
      origin: adversarial('other', 'a value of "1 " is not "1", so it is rewritten to "1" for the target, keeping the trailing whitespace of the line'),
      args: [
        text(users(block(STEAMID(1), ['"AccountName"  "a"', '"AutoLogin"  "1 "   ']), block(STEAMID(2), ['"AccountName"  "b"', '"AutoLogin"  "0"']))),
        STEAMID(1),
      ],
      expect: 'out',
    },
    {
      id: 'insert-indent-from-block',
      origin: adversarial('other', 'an inserted line copies the indent and separator of the last key line seen, here four spaces and one space'),
      args: [
        text(
          [
            '"users"',
            '{',
            `  "${STEAMID(1)}"`,
            '  {',
            '    "AccountName" "a"',
            '    "Timestamp" "1"',
            '  }',
            `  "${STEAMID(2)}"`,
            '  {',
            '    "AccountName" "b"',
            '  }',
            '}',
            '',
          ].join('\n'),
        ),
        STEAMID(2),
      ],
      expect: 'out',
    },
    {
      id: 'insert-indent-carried',
      origin: adversarial(
        'other',
        'indent and separator carry over from an earlier block when a block has no plain key line (its only value holds an escaped quote)',
      ),
      args: [
        text(
          [
            '"users"',
            '{',
            `\t"${STEAMID(1)}"`,
            '\t{',
            '   "AccountName" "a"',
            '   "AutoLogin" "0"',
            '\t}',
            `\t"${STEAMID(2)}"`,
            '\t{',
            '\t\t"AccountName"\t\t"b\\"q"',
            '\t}',
            '}',
            '',
          ].join('\n'),
        ),
        STEAMID(2),
      ],
      expect: 'out',
    },
    {
      id: 'insert-default-indent',
      origin: adversarial('other', 'with no plain key line anywhere before it, the inserted line uses two tabs and two tabs'),
      args: [text(['"users"', '{', `"${STEAMID(1)}"`, '{', '"AccountName" "a" // c', '}', '}', ''].join('\n')), STEAMID(1)],
      expect: 'out',
    },
    {
      id: 'comment-after-key',
      origin: adversarial(
        'other',
        'an AutoLogin line with a trailing comment is not recognised, so a second AutoLogin is inserted and the parser takes the last one',
      ),
      args: [
        text(
          users(block(STEAMID(1), ['"AccountName"\t\t"a"', '"AutoLogin"\t\t"1" // keep']), block(STEAMID(2), ['"AccountName"\t\t"b"', '"AutoLogin"\t\t"0"'])),
        ),
        STEAMID(2),
      ],
      expect: 'out',
    },
    {
      id: 'brace-with-comment',
      origin: adversarial(
        'other',
        'an opening brace with a trailing comment is not counted, so the blocks below it are seen one level too shallow and nothing is rewritten',
      ),
      args: [
        text(
          users(block(STEAMID(1), ['"AccountName"\t\t"a"', '"AutoLogin"\t\t"1"']), block(STEAMID(2), ['"AccountName"\t\t"b"', '"AutoLogin"\t\t"0"'])).replace(
            '\t{\n',
            '\t{ // first\n',
          ),
        ),
        STEAMID(2),
      ],
      expect: 'out',
    },
    {
      id: 'one-line-file',
      origin: adversarial('other', 'a file on one line has no line that is only a brace, so the plan is a no-op although the target is not flagged'),
      args: [text(`"users" { "${STEAMID(1)}" { "AccountName" "a" "AutoLogin" "1" } "${STEAMID(2)}" { "AccountName" "b" "AutoLogin" "0" } }`), STEAMID(2)],
      expect: 'out',
    },
    {
      id: 'brace-on-key-line',
      origin: adversarial('other', 'a block opened on the key line ("id" {) is not counted either'),
      args: [
        text(
          [
            '"users" {',
            `\t"${STEAMID(1)}" {`,
            '\t\t"AccountName"\t\t"a"',
            '\t\t"AutoLogin"\t\t"1"',
            '\t}',
            `\t"${STEAMID(2)}"`,
            '\t{',
            '\t\t"AccountName"\t\t"b"',
            '\t\t"AutoLogin"\t\t"0"',
            '\t}',
            '}',
            '',
          ].join('\n'),
        ),
        STEAMID(2),
      ],
      expect: 'out',
    },
    {
      id: 'nested-block-in-user',
      origin: adversarial('other', 'keys inside a block nested in a user block are left alone, and its closing brace inserts nothing'),
      args: [
        text(
          users(
            block(STEAMID(1), ['"AccountName"\t\t"a"', '"AutoLogin"\t\t"1"', '"Sub"', '{', '\t"AutoLogin"\t\t"1"', '}']),
            block(STEAMID(2), ['"AccountName"\t\t"b"', '"Sub"', '{', '\t"MostRecent"\t\t"1"', '}']),
          ),
        ),
        STEAMID(2),
      ],
      expect: 'out',
    },
    {
      id: 'skipped-block-rewritten',
      origin: adversarial('other', 'a block parseLoginUsers skips (no AccountName) is still rewritten to 0 and gets an AutoLogin line if it has none'),
      args: [
        text(
          users(
            block(STEAMID(1), ['"AccountName"\t\t"a"', '"AutoLogin"\t\t"0"']),
            block(STEAMID(2), ['"PersonaName"\t\t"p"', '"AutoLogin"\t\t"1"']),
            block(STEAMID(3), ['"PersonaName"\t\t"q"']),
          ),
        ),
        STEAMID(1),
      ],
      expect: 'out',
    },
    {
      id: 'duplicate-target-blocks',
      origin: adversarial('other', 'when the target id appears twice, both of its blocks are set to 1'),
      args: [
        text(
          users(
            block(STEAMID(1), ['"AccountName"\t\t"a"', '"AutoLogin"\t\t"0"']),
            block(STEAMID(2), ['"AccountName"\t\t"b"', '"AutoLogin"\t\t"1"']),
            block(STEAMID(1), ['"AccountName"\t\t"a2"', '"AutoLogin"\t\t"0"']),
          ),
        ),
        STEAMID(1),
      ],
      expect: 'out',
    },
    {
      id: 'mixed-eol',
      origin: adversarial('other', 'one CRLF anywhere makes every line end in CRLF on output, LF lines included'),
      args: [
        text(
          users(block(STEAMID(1), ['"AccountName"\t\t"a"', '"AutoLogin"\t\t"1"']), block(STEAMID(2), ['"AccountName"\t\t"b"', '"AutoLogin"\t\t"0"'])).replace(
            '"users"\n',
            '"users"\r\n',
          ),
        ),
        STEAMID(2),
      ],
      expect: 'out',
    },
    {
      id: 'mixed-eol-noop',
      origin: adversarial('other', 'with mixed line endings and nothing to change the plan says noop although its text differs from the input'),
      args: [
        text(
          users(block(STEAMID(1), ['"AccountName"\t\t"a"', '"AutoLogin"\t\t"1"']), block(STEAMID(2), ['"AccountName"\t\t"b"', '"AutoLogin"\t\t"0"'])).replace(
            '"users"\n',
            '"users"\r\n',
          ),
        ),
        STEAMID(1),
      ],
      expect: 'out',
    },
    {
      id: 'cr-only-eol',
      origin: adversarial('other', 'lone CR line endings are one line to the rewriter, so nothing changes'),
      args: [text(users(block(STEAMID(1), ['"AccountName"\t\t"a"', '"AutoLogin"\t\t"0"'])).replace(/\n/g, '\r')), STEAMID(1)],
      expect: 'out',
    },
    {
      id: 'no-final-newline',
      origin: adversarial('other', 'a file without a final newline gets none'),
      args: [text(users(block(STEAMID(1), ['"AccountName"\t\t"a"', '"AutoLogin"\t\t"0"'])).replace(/\n$/, '')), STEAMID(1)],
      expect: 'out',
    },
    {
      id: 'bom-before-user-line',
      origin: adversarial(
        'unicode-space',
        'U+FEFF counts as \\s in USER_KEY_LINE and is stripped by trim(), so a user key line or brace line led by U+FEFF still counts; Rust \\s and str::trim do not treat U+FEFF as whitespace',
      ),
      args: [
        text(['"users"', '﻿{', `\t﻿"${STEAMID(1)}"`, '\t{', '\t\t"AccountName"\t\t"a"', '\t\t"AutoLogin"\t\t"0"', '\t﻿}', '}', ''].join('\n')),
        STEAMID(1),
      ],
      expect: 'out',
    },
    {
      id: 'unicode-space-in-value-line',
      origin: adversarial(
        'unicode-space',
        'MOST_RECENT_LINE uses \\s: NBSP and U+3000 between key and value cannot appear outside quotes (parseVdf never returns), but U+FEFF can',
      ),
      args: [text(users(block(STEAMID(1), ['"AccountName"\t\t"a"', '"AutoLogin"﻿"0"﻿']))), STEAMID(1)],
      expect: 'out',
    },
    {
      id: 'cap-steamid-digits-max-at',
      origin: adversarial('other', 'a 20-digit target is recognised by USER_KEY_LINE'),
      args: [text(users(block('76561198000000000001', ['"AccountName"\t\t"a"', '"AutoLogin"\t\t"0"']))), '76561198000000000001'],
      expect: 'out',
    },
    {
      id: 'cap-steamid-digits-max-over',
      origin: adversarial('other', 'a 21-digit id is not a user, so it is refused as a target'),
      args: [text(users(block('765611980000000000001', ['"AccountName"\t\t"a"', '"AutoLogin"\t\t"0"']))), '765611980000000000001'],
      expect: 'error',
    },
    {
      id: 'cap-steamid-digits-min-at',
      origin: adversarial('other', 'a 15-digit target is recognised'),
      args: [text(users(block('765611980000001', ['"AccountName"\t\t"a"']))), '765611980000001'],
      expect: 'out',
    },
    {
      id: 'astral-in-name',
      origin: adversarial('utf16-length', 'astral characters elsewhere in the file pass through unchanged'),
      args: [text(users(block(STEAMID(1), ['"AccountName"\t\t"\u{1F600}"', '"AutoLogin"\t\t"0"']))), STEAMID(1)],
      expect: 'out',
    },
  ];
  const all = [
    ...corpus({
      seed: 31,
      count: 120,
      from: [{ path: LOGINUSERS }, { path: CRLF_PATH, bytes: crlfBytes }, { path: BOM_PATH, bytes: bomBytes }],
      args: (mutated) => [mutated, STEAMID(3)],
    }),
    ...corpus({ seed: 32, count: 50, from: [{ path: MOSTRECENT_PATH, bytes: mostRecentBytes }], args: (mutated) => [mutated, STEAMID(2)] }),
    ...corpus({ seed: 33, count: 50, from: [{ path: LOGINUSERS }, { path: SYNONYMS_PATH, bytes: synonymsBytes }], args: (mutated) => [mutated, STEAMID(1)] }),
    ...corpus({
      seed: 34,
      count: 80,
      from: [{ path: LOGINUSERS }, { path: CRLF_PATH, bytes: crlfBytes }, { path: MOSTRECENT_PATH, bytes: mostRecentBytes }],
      ops: LINE_OPS,
      args: (mutated) => [mutated, STEAMID(2)],
    }),
  ];
  const generated = withoutHangs(all);
  return { cases: [...hand, ...generated.cases], dropped: generated.dropped };
};

const rewrites = rewriteCases();

vectorFile({
  area: 'steam',
  function: 'planAutoLoginRewrite',
  source: SOURCE,
  decode: { 0: 'utf8' },
  note: [
    `${DECODE_NOTE} arg1 is the target SteamID64.`,
    `${REDACT_NOTE} (planAutoLoginRewrite calls parseLoginUsers first.)`,
    'The byte-exact rewriter: out.text is the whole new file, compared as a string. Errors: LoginUsersFormatError (code LOGINUSERS_FORMAT) for a target not among the parsed users, and whatever parseLoginUsers throws.',
    'Bases of the corpus: seed 31 the fixture, its CRLF copy and its BOM copy with target 76561198000000003; seed 32 the MostRecent CRLF literal with target 76561198000000002; seed 33 the fixture and the synonyms literal with target 76561198000000001; seed 34 the fixture, its CRLF copy and the MostRecent literal with target 76561198000000002, line, EOL, BOM, astral and invalid-UTF-8 mutations only, so more of them parse.',
    droppedNote(rewrites.dropped),
  ].join('\n'),
  call: planAutoLoginRewrite,
  cases: rewrites.cases,
});

const fixtureUsers = () => parseLoginUsers(originalText);
const T_FIND = 'prefers the SteamID64, then falls back to a case-insensitive login';
const someone = (accountName: string, steamId64 = STEAMID(50)) => ({
  steamId64,
  accountName,
  personaName: '',
  rememberPassword: false,
  mostRecent: false,
  timestamp: null,
  mostRecentKeys: [],
});

vectorFile({
  area: 'steam',
  function: 'findLoginUser',
  source: SOURCE,
  note: 'arg0 is a list of SteamLoginUser as parseLoginUsers returns it; arg1 is the account reference { launcherUid, login }. The result is the matching user object, or null.',
  call: findLoginUser,
  cases: () => [
    { id: 'by-id', origin: fromTest(TESTS, 'findLoginUser', T_FIND), args: [fixtureUsers(), { launcherUid: STEAMID(3), login: 'wrong' }], expect: 'out' },
    { id: 'by-login-case', origin: fromTest(TESTS, 'findLoginUser', T_FIND), args: [fixtureUsers(), { launcherUid: null, login: 'USER_2' }], expect: 'out' },
    {
      id: 'id-missing-login-hit',
      origin: fromTest(TESTS, 'findLoginUser', T_FIND),
      args: [fixtureUsers(), { launcherUid: STEAMID(99), login: 'user_4' }],
      expect: 'out',
    },
    { id: 'nobody', origin: fromTest(TESTS, 'findLoginUser', T_FIND), args: [fixtureUsers(), { launcherUid: null, login: 'nobody' }], expect: 'out' },
    {
      id: 'empty-uid',
      origin: adversarial('other', 'an empty launcherUid is falsy, so the login decides'),
      args: [fixtureUsers(), { launcherUid: '', login: 'user_1' }],
      expect: 'out',
    },
    {
      id: 'login-trimmed',
      origin: adversarial('unicode-space', 'the login is trimmed with the JS trim (NBSP, U+FEFF) before comparing'),
      args: [fixtureUsers(), { launcherUid: null, login: ' User_3﻿ ' }],
      expect: 'out',
    },
    {
      id: 'login-nel-kept',
      origin: adversarial('unicode-space', 'JS trim keeps U+0085, so the login does not match'),
      args: [fixtureUsers(), { launcherUid: null, login: '\u0085user_3' }],
      expect: 'out',
    },
    { id: 'empty-list', origin: adversarial('other', 'no users'), args: [[], { launcherUid: STEAMID(1), login: 'user_1' }], expect: 'out' },
    {
      id: 'kelvin',
      origin: adversarial('case-mapping', 'U+212A KELVIN SIGN lower-cases to k on both sides'),
      args: [[someone('kelvin_1')], { launcherUid: null, login: 'KELVIN_1' }],
      expect: 'out',
    },
    {
      id: 'sharp-s',
      origin: adversarial('case-mapping', 'ß is not ss under toLowerCase'),
      args: [[someone('straße')], { launcherUid: null, login: 'STRASSE' }],
      expect: 'out',
    },
    {
      id: 'dotted-i',
      origin: adversarial('case-mapping', 'İ lower-cases to i plus U+0307, which is not i'),
      args: [[someone('id_1')], { launcherUid: null, login: 'İD_1' }],
      expect: 'out',
    },
    {
      id: 'first-match-wins',
      origin: adversarial('other', 'two users with the same login in different case: the first in list order wins'),
      args: [[someone('Dup', STEAMID(51)), someone('dup', STEAMID(52))], { launcherUid: null, login: 'DUP' }],
      expect: 'out',
    },
    {
      id: 'account-name-untrimmed',
      origin: adversarial('unicode-space', 'only the login is trimmed, not the stored account name'),
      args: [[someone(' padded ')], { launcherUid: null, login: 'padded' }],
      expect: 'out',
    },
    {
      id: 'empty-login',
      origin: adversarial('other', 'an empty login matches a user whose name is empty'),
      args: [[someone('')], { launcherUid: null, login: '  ' }],
      expect: 'out',
    },
  ],
});
