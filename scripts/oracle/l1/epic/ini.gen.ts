import { adversarial, bytes, type Case, corpus, file, fixture, fromTest, input, text, vectorFile } from '../lib/index';
import { FILES_TEST, fixtureText, GUS, iniBases, placeholderData } from './ini-bases';
import { joinIni, rewriteSection, splitIni } from '../../../../src/main/launchers/epic/ini';

const SOURCE = 'src/main/launchers/epic/ini.ts';
const DECODE_NOTE =
  'arg0 is GameUserSettings.ini as the Epic adapter reads it: readIni (src/main/launchers/epic/adapter.ts) takes readLauncherBytes and then bytes.toString utf8, and writeSession reads it with readFileSync utf8; both keep a BOM and turn invalid bytes into U+FFFD. readIni refuses a UTF-16 BOM or any NUL byte before the text reaches this module; the function itself does not, so corpus cases carry both.';
const CAP_NOTE = 'No size cap in the function: it relies on readLauncherBytes (MAX_LAUNCHER_FILE_BYTES, 4 MiB) in readIni.';

const BASE_PREFIX = 'rewriteSection';
const bases = iniBases().map((base) => ({ ...base, path: `l1/epic/files/${BASE_PREFIX}/${base.file}` }));
const baseInput = (index: number) => input('epic', `${BASE_PREFIX}/${bases[index]!.file}`, bases[index]!.bytes);
const corpusFrom = [{ path: GUS }, ...bases.map((base) => ({ path: base.path, bytes: base.bytes }))];

const BOM_LITERAL = '\u{FEFF}[RememberMe]\r\nEnable=True\r\nData=old\r\n\r\n[Other]\r\nX=1\r\n';
const T_SPLIT = ['INI handling', 'splits and rejoins byte for byte, and finds every section in order'] as const;
const T_REPLACE = [
  'INI handling',
  'replaces keys in place, removes keys, appends new keys before the trailing blank line, and leaves everything else alone',
] as const;
const T_CREATE = ['INI handling', 'creates a missing section at the end and reports a no-op when nothing changes'] as const;
const T_BOM = ['ini with a UTF-8 BOM', 'sees the first section and keeps the BOM on rewrite'] as const;
const T_BLOBS = ['Epic session blobs', 'reads the remembered session with a fingerprint and never echoes the blob in change descriptions'] as const;

interface TextCase {
  id: string;
  origin: Case['origin'];
  arg: unknown;
}

function textCases(): TextCase[] {
  return [
    { id: 'fixture-gameusersettings', origin: fromTest(FILES_TEST, ...T_SPLIT), arg: file(GUS) },
    ...bases.map((base, i) => ({ id: `fixture-${base.file.replace(/^GameUserSettings-|\.ini$/g, '')}`, origin: fixture(GUS, base.what), arg: baseInput(i) })),
    { id: 'test-crlf-one-section', origin: fromTest(FILES_TEST, ...T_CREATE), arg: text('[A]\r\nx=1\r\n') },
    { id: 'test-lf-one-section', origin: fromTest(FILES_TEST, ...T_CREATE), arg: text('[A]\nx=1\n') },
    { id: 'test-empty', origin: fromTest(FILES_TEST, ...T_CREATE), arg: text('') },
    { id: 'test-bom-literal', origin: fromTest(FILES_TEST, ...T_BOM), arg: text(BOM_LITERAL) },
    { id: 'test-enable-false', origin: fromTest(FILES_TEST, ...T_BLOBS), arg: text('[RememberMe]\nEnable=False\n') },
    { id: 'test-launcher-only', origin: fromTest(FILES_TEST, ...T_BLOBS), arg: text('[Launcher]\nx=1\n') },
    { id: 'no-trailing-newline', origin: fixture(GUS, 'cut to two lines, no final newline'), arg: text('[A]\nx=1') },
    { id: 'one-word', origin: fixture(GUS, 'one line, no newline'), arg: text('a') },
    { id: 'lf-only', origin: fixture(GUS, 'a lone LF'), arg: text('\n') },
    { id: 'crlf-only', origin: fixture(GUS, 'a lone CRLF'), arg: text('\r\n') },
    { id: 'blank-lines-lf', origin: fixture(GUS, 'three LFs'), arg: text('\n\n\n') },
    { id: 'blank-lines-crlf', origin: fixture(GUS, 'two CRLFs'), arg: text('\r\n\r\n') },
    { id: 'cr-only-eol', origin: fixture(GUS, 'CR line endings only, which are not split'), arg: text('[A]\rx=1\r') },
    { id: 'mixed-crlf-then-lf-end', origin: fixture(GUS, 'CRLF first, the last line ends in a bare LF'), arg: text('[A]\r\nx=1\n') },
    {
      id: 'mixed-crlf-then-lf-end-long',
      origin: fixture(GUS, 'CRLF file whose final line ends in a bare LF'),
      arg: text('[RememberMe]\r\nEnable=True\r\nData=abcdef\n'),
    },
    { id: 'mixed-lf-then-crlf-end', origin: fixture(GUS, 'LF first, the last line ends in CRLF'), arg: text('[A]\nx=1\r\n') },
    { id: 'mixed-middle', origin: fixture(GUS, 'one bare LF in the middle of a CRLF file'), arg: text('[A]\r\nx=1\ny=2\r\n') },
    { id: 'trailing-cr', origin: fixture(GUS, 'ends in a bare CR'), arg: text('[A]\nx=1\r') },
    { id: 'cr-cr-lf', origin: fixture(GUS, 'every line ends in CR CR LF'), arg: text('[A]\r\r\nx=1\r\r\n') },
    { id: 'bom-only', origin: fixture(GUS, 'only a UTF-8 BOM'), arg: bytes([0xef, 0xbb, 0xbf]) },
    { id: 'bom-lf', origin: fixture(GUS, 'a UTF-8 BOM and an LF'), arg: bytes([0xef, 0xbb, 0xbf, 0x0a]) },
    {
      id: 'adv-invalid-utf8',
      origin: adversarial('utf8-decode', 'a lone 0xFF and a truncated 3-byte sequence in a value; Node gives one U+FFFD for each maximal invalid run'),
      arg: bytes(Buffer.concat([Buffer.from('[A]\nx='), Buffer.from([0xff, 0x41, 0xe2, 0x82]), Buffer.from('\ny=2\n')])),
    },
    {
      id: 'adv-cesu-surrogate',
      origin: adversarial('utf8-decode', 'a surrogate encoded as 3 bytes (ED A0 BD) in a value; Node gives three U+FFFD'),
      arg: bytes(Buffer.concat([Buffer.from('[A]\nx='), Buffer.from([0xed, 0xa0, 0xbd]), Buffer.from('\n')])),
    },
    {
      id: 'adv-unicode-line-separators',
      origin: adversarial(
        'regex',
        'U+2028, U+2029 and U+0085 are not line breaks for split(/\\r?\\n/); a Rust lines() or a Unicode-aware splitter must not split on them either',
      ),
      arg: text('[A]\u{2028}x=1\u{2029}y=2\u0085z=3\n'),
    },
    {
      id: 'adv-astral-value',
      origin: adversarial('utf16-length', 'an astral character in a value and a header; nothing is measured, so it must pass untouched'),
      arg: text('[\u{1F600}]\r\nk=\u{1D7D8}\u{10FFFF}\r\n'),
    },
  ];
}

const iniCorpus = (seed: number) => corpus({ seed, count: 120, from: corpusFrom, args: (mutated) => [mutated] });

vectorFile({
  area: 'epic',
  function: 'splitIni',
  source: SOURCE,
  decode: { 0: 'utf8' },
  note: [
    DECODE_NOTE,
    'eol is CRLF when the text holds any CRLF, else LF; lines split on /\\r?\\n/ (only LF, an optional CR before it); trailingNewline is endsWith LF, and then eol.length characters come off the end even when the text ends in a bare LF after a CRLF elsewhere (see mixed-crlf-then-lf-end: the last character of the last line is lost).',
    CAP_NOTE,
  ].join('\n'),
  call: splitIni,
  cases: () => [...textCases().map((c) => ({ id: c.id, origin: c.origin, args: [c.arg], expect: 'out' as const })), ...iniCorpus(1)],
});

vectorFile({
  area: 'epic',
  function: 'joinIni',
  source: SOURCE,
  note: [
    'arg0 is an IniLayout { lines, eol, trailingNewline } as a plain value. The cases from text are the layouts splitIni returns for that text (computed by the real splitIni when the vector is made); the others are hand-built layouts.',
    'An empty lines array always gets one eol, whatever trailingNewline says.',
  ].join('\n'),
  call: joinIni,
  cases: () => {
    const fromText = textCases().map((c) => {
      const raw = c.id === 'fixture-gameusersettings' ? fixtureText() : decodeArg(c.arg);
      return { id: `layout-${c.id}`, origin: c.origin, args: [splitIni(raw)], expect: 'out' as const };
    });
    const layout = (lines: unknown[], eol: string, trailingNewline: boolean) => ({ lines, eol, trailingNewline });
    const made = fixture(GUS, 'a hand-built layout');
    return [
      ...fromText,
      { id: 'empty-no-trailing-lf', origin: made, args: [layout([], '\n', false)], expect: 'out' as const },
      { id: 'empty-no-trailing-crlf', origin: made, args: [layout([], '\r\n', false)], expect: 'out' as const },
      { id: 'empty-trailing-lf', origin: made, args: [layout([], '\n', true)], expect: 'out' as const },
      { id: 'one-blank-line-no-trailing', origin: made, args: [layout([''], '\n', false)], expect: 'out' as const },
      { id: 'one-blank-line-trailing', origin: made, args: [layout([''], '\r\n', true)], expect: 'out' as const },
      { id: 'two-lines-no-trailing', origin: made, args: [layout(['[A]', 'x=1'], '\r\n', false)], expect: 'out' as const },
      { id: 'two-lines-trailing', origin: made, args: [layout(['[A]', 'x=1'], '\n', true)], expect: 'out' as const },
      { id: 'blank-tail-trailing', origin: made, args: [layout(['[A]', 'x=1', '', ''], '\r\n', true)], expect: 'out' as const },
      {
        id: 'line-with-newlines',
        origin: fixture(GUS, 'a value holding CRLF, as rewriteSection would put it in a line'),
        args: [layout(['[A]', 'x=a\r\nb', 'y=\n'], '\n', true)],
        expect: 'out' as const,
      },
      {
        id: 'adv-lone-surrogate-line',
        origin: adversarial('lone-surrogate', 'a line holding a lone high surrogate is joined as it is; a Rust String cannot hold it'),
        args: [layout(['[A]', 'x=\uD83D'], '\n', true)],
        expect: 'out' as const,
      },
    ];
  },
});

vectorFile({
  area: 'epic',
  function: 'joinIni',
  name: 'joinIni.roundtrip',
  source: SOURCE,
  decode: { 0: 'utf8' },
  note: [
    DECODE_NOTE,
    'The round trip: call is (text) => { const rejoined = joinIni(splitIni(text)); return { rejoined, identical: rejoined === text } }. The Rust test runs its split and join the same way and must give the same rejoined text and flag.',
    'identical is false for the empty text (joinIni gives one LF), for mixed line endings (every break becomes the eol) and for a CRLF file whose last line ends in a bare LF (a character is lost). Every other input comes back as it went in.',
    CAP_NOTE,
  ].join('\n'),
  call: (value: string) => {
    const rejoined = joinIni(splitIni(value));
    return { rejoined, identical: rejoined === value };
  },
  cases: () => [...textCases().map((c) => ({ id: c.id, origin: c.origin, args: [c.arg], expect: 'out' as const })), ...iniCorpus(1)],
});

function decodeArg(arg: unknown): string {
  const value = arg as { bytes?: Buffer };
  if (!value.bytes) throw new Error('decodeArg takes a bytes() or input() value');
  return value.bytes.toString('utf8');
}

const PH = placeholderData('rewrite');

vectorFile({
  area: 'epic',
  function: 'rewriteSection',
  source: SOURCE,
  decode: { 0: 'utf8' },
  note: [
    DECODE_NOTE,
    'arg1 is the section name, arg2 the entries (key to value, null removes the key). Entries are applied in the order their keys are recorded, which is JS enumeration order: integer-like keys first, ascending, then the rest in insertion order (see entries-integer-keys). A Rust reader must keep the recorded order, not sort the keys.',
    'The result is { text, changes, noop }; changes carry the raw before and after values and 1-based line numbers counted at the moment of each change, so a later splice can shift an earlier line.',
    'Not recorded: an entries key named __proto__, which the l1 decoder cannot hand to the function as an own property; no app caller passes one (the only keys are Enable and Data).',
    CAP_NOTE,
  ].join('\n'),
  call: rewriteSection,
  cases: () => {
    const lit = (value: string) => text(value);
    const c = (
      id: string,
      origin: Case['origin'],
      arg0: unknown,
      name: string,
      entries: Record<string, string | null>,
      expect: 'out' | 'error' = 'out',
    ): Case => ({
      id,
      origin,
      args: [arg0, name, entries],
      expect,
    });
    const g = file(GUS);
    const f = (change: string) => fixture(GUS, change);
    return [
      c('test-enable-false-data-removed-extra-added', fromTest(FILES_TEST, ...T_REPLACE), g, 'RememberMe', { Enable: 'False', Data: null, Extra: 'x' }),
      c('test-create-missing-section', fromTest(FILES_TEST, ...T_CREATE), lit('[A]\r\nx=1\r\n'), 'B', { k: 'v' }),
      c('test-missing-section-all-null', fromTest(FILES_TEST, ...T_CREATE), lit('[A]\nx=1\n'), 'B', { k: null }),
      c('test-same-value-noop', fromTest(FILES_TEST, ...T_CREATE), lit('[A]\nx=1\n'), 'A', { x: '1' }),
      c('test-empty-text-new-section', fromTest(FILES_TEST, ...T_CREATE), lit(''), 'A', { x: '1' }),
      c('test-bom-first-section', fromTest(FILES_TEST, ...T_BOM), lit(BOM_LITERAL), 'RememberMe', { Data: 'new' }),
      c('fixture-set-data', f('[RememberMe] Data set to a placeholder'), g, 'RememberMe', { Enable: 'True', Data: PH }),
      c('fixture-same-values-noop', f('[RememberMe] set to the values it holds'), g, 'RememberMe', { Enable: 'True' }),
      c('fixture-offline-removed', f('[Offline] Data removed'), g, 'Offline', { Data: null }),
      c('fixture-new-section', f('a section that is not there'), g, 'OneLaunch.Test', { k: 'v', l: 'w' }),
      c('fixture-new-section-all-null', f('a section that is not there, only removals'), g, 'OneLaunch.Test', { k: null }),
      c('fixture-new-section-no-entries', f('a section that is not there, no entries'), g, 'OneLaunch.Test', {}),
      c('fixture-existing-no-entries', f('[RememberMe] with no entries'), g, 'RememberMe', {}),
      c('fixture-key-with-colons', f('[Portal.Shortcut] key holding colons'), g, 'Portal.Shortcut', { 'fn:4fe75bbc5a674f4f9b356b5c90567da5:Fortnite': 'True' }),
      c('fixture-key-with-brackets', f('[NotificationsSeen] key holding brackets'), g, 'NotificationsSeen', {
        '0000000000000000000000000000000a:0000000000000000000000000000000b:Sugar[++Prime+Update59.1-CL-526531][1effb6ef5fc849859076fdb09268393f][Update]':
          '2026.09.12-00.00.00',
      }),
      c('fixture-value-with-equals', f('[WindowSettings] value holding = signs'), g, 'WindowSettings', {
        MainLauncherWindow: '(X=0,Y=0,Width=800,Height=600,WindowMode=Windowed)',
      }),
      c('fixture-last-section-new-key', f('[Portal.SelfUpdate], the last section, gets a new key'), g, 'Portal.SelfUpdate', { New: '1' }),
      c('fixture-section-case', f('section name in another case is another section'), g, 'rememberme', { Data: PH }),
      c('fixture-lf-set-data', fixture(GUS, 'CRLF made LF, Data set'), baseInput(0), 'RememberMe', { Data: PH }),
      c('fixture-bom-set-data', fixture(GUS, 'BOM added, Data set'), baseInput(1), 'RememberMe', { Data: PH }),
      c('fixture-signed-out-set-data', fixture(GUS, 'both Data lines removed, Data set'), baseInput(2), 'RememberMe', { Enable: 'True', Data: PH }),
      c('fixture-small-new-section', fixture(GUS, 'only two sections, a third added'), baseInput(3), 'Launcher', { x: '1' }),
      c('last-section-no-trailing-newline', f('one section, no final newline'), lit('[A]\nx=1'), 'A', { y: '2' }),
      c('last-section-no-trailing-newline-replace', f('one section, no final newline, value replaced'), lit('[A]\nx=1'), 'A', { x: '2' }),
      c('new-key-before-blank-lines', f('several blank lines before the next section'), lit('[A]\nx=1\n\n\n[B]\n'), 'A', { y: '2' }),
      c('new-key-before-whitespace-lines', f('a space-and-tab line before the next section'), lit('[A]\nx=1\n \t\n[B]\n'), 'A', { y: '2' }),
      c('new-key-in-empty-section', f('a section with no lines'), lit('[A]\n[B]\n'), 'A', { y: '2' }),
      c('new-key-in-empty-last-section', f('the last section has no lines'), lit('[B]\nz=1\n[A]\n'), 'A', { y: '2' }),
      c('new-key-only-blank-section', f('a section holding only blank lines'), lit('[A]\n\n\n'), 'A', { y: '2' }),
      c('duplicate-keys-replaced', f('a key three times'), lit('[A]\nx=1\nx=2\nx=3\n'), 'A', { x: '9' }),
      c('duplicate-keys-same-first-value', f('a key three times, set to its first value'), lit('[A]\nx=1\nx=2\nx=3\n'), 'A', { x: '1' }),
      c('duplicate-keys-removed', f('a key three times, removed'), lit('[A]\nx=1\nx=2\nx=3\n'), 'A', { x: null }),
      c('duplicate-sections-first-only', f('a section twice'), lit('[A]\nx=1\n[A]\nx=2\n'), 'A', { x: '3' }),
      c('remove-then-add', f('one key removed and one added'), lit('[A]\na=1\nb=2\n\n[B]\n'), 'A', { a: null, c: '3' }),
      c('remove-shifts-later-lines', f('two keys removed in one call'), lit('[A]\na=1\nb=2\nc=3\n'), 'A', { a: null, c: null }),
      c('remove-absent-key', f('a removal of a key that is not there'), lit('[A]\na=1\n'), 'A', { b: null }),
      c('entries-integer-keys', f('integer-like keys run first'), lit('[A]\nz=0\n'), 'A', { Data: 'x', '10': 'y', '2': 'z' }),
      c('header-trailing-space', f('a header with trailing space and tab'), lit('[A] \t\nx=1\n'), 'A', { x: '2' }),
      c('header-leading-space', f('a header with a leading space is no header'), lit(' [A]\nx=1\n'), 'A', { x: '2' }),
      c('header-double-close', f('[A]] names the section A]'), lit('[A]]\nx=1\n'), 'A]', { x: '2' }),
      c('header-nested', f('[[A]] names the section [A]'), lit('[[A]]\nx=1\n'), '[A]', { x: '2' }),
      c('header-empty-brackets', f('[] is no header'), lit('[]\nx=1\n'), '', { x: '2' }),
      c('header-space-name', f('[ ] names the section " "'), lit('[ ]\nx=1\n'), ' ', { x: '2' }),
      c('header-with-comment', f('a header followed by a comment is no header'), lit('[A] ;c\nx=1\n'), 'A', { x: '2' }),
      c('header-bom-not-first-line', f('a BOM before a header on a later line'), lit('[B]\n\u{FEFF}[A]\nx=1\n'), 'A', { x: '2' }),
      c('entry-leading-space', f('an entry with a leading space is no entry'), lit('[A]\n x=1\n'), 'A', { x: '2' }),
      c('entry-space-before-equals', f('"x =1" has the key "x "'), lit('[A]\nx =1\n'), 'A', { x: '2' }),
      c('entry-space-key', f('a key "x " set'), lit('[A]\nx =1\n'), 'A', { 'x ': '2' }),
      c('entry-double-equals', f('"x==1": key x, value =1'), lit('[A]\nx==1\n'), 'A', { x: '2' }),
      c('entry-empty-value', f('"x=": an empty value'), lit('[A]\nx=\n'), 'A', { x: '' }),
      c('entry-no-equals', f('"x" without = is no entry'), lit('[A]\nx\n'), 'A', { x: '1' }),
      c('entry-starts-with-equals', f('"=x" is no entry'), lit('[A]\n=x\n'), 'A', { '': 'y' }),
      c('value-with-crlf', f('a value holding CRLF goes in raw'), lit('[A]\r\nx=1\r\n'), 'A', { x: 'a\r\nb' }),
      c('name-with-newline', f('a new section whose name holds LF'), lit('[A]\nx=1\n'), 'B\nC', { k: 'v' }),
      c('name-empty', f('a new section with an empty name'), lit('[A]\nx=1\n'), '', { k: 'v' }),
      c('new-section-after-blank', f('the file ends in a blank line'), lit('[A]\nx=1\n\n'), 'B', { k: 'v' }),
      c('new-section-after-whitespace', f('the file ends in a whitespace line'), lit('[A]\nx=1\n  \n'), 'B', { k: 'v' }),
      c('new-section-no-trailing-newline', f('no final newline'), lit('[A]\nx=1'), 'B', { k: 'v' }),
      c('new-section-crlf', f('CRLF, the file ends in a blank line'), lit('[A]\r\nx=1\r\n\r\n'), 'B', { k: 'v' }),
      c('mixed-eol-set', f('CRLF file whose last line ends in a bare LF'), lit('[RememberMe]\r\nEnable=True\r\nData=abcdef\n'), 'RememberMe', { Data: 'new' }),
      c('mixed-eol-noop', f('CRLF file whose last line ends in a bare LF, value kept'), lit('[A]\r\nx=1\n'), 'A', { x: '1' }),
      c('mixed-eol-other-section', f('one bare LF in a CRLF file, another section touched'), lit('[A]\r\nx=1\ny=2\r\n[B]\r\nk=1\r\n'), 'B', { k: '2' }),
      c('cr-only-file', f('CR line endings only: one line'), lit('[A]\rx=1\r'), 'A', { x: '2' }),
      c('cr-cr-lf-header', f('CR CR LF endings: the header keeps a CR'), lit('[A]\r\r\nx=1\r\r\n'), 'A', { x: '2' }),
      c(
        'adv-header-trailing-feff',
        adversarial('unicode-space', 'a header followed by U+FEFF: JS \\s matches U+FEFF so it is a header; Rust regex \\s does not'),
        lit('[A]\u{FEFF}\nx=1\n'),
        'A',
        { x: '2' },
      ),
      c(
        'adv-header-trailing-nel',
        adversarial('unicode-space', 'a header followed by U+0085: JS \\s does not match U+0085 so it is no header; Rust regex \\s does'),
        lit('[A]\u0085\nx=1\n'),
        'A',
        { x: '2' },
      ),
      c(
        'adv-header-trailing-nbsp',
        adversarial('unicode-space', 'a header followed by U+00A0 and U+3000: both are \\s in JS and in Rust'),
        lit('[A]\u{00A0}\u{3000}\nx=1\n'),
        'A',
        { x: '2' },
      ),
      c(
        'adv-header-line-separator',
        adversarial('regex', 'a header name holding U+2028: JS . does not match it so the line is no header; Rust regex . does'),
        lit('[A\u{2028}B]\nx=1\n'),
        'A\u{2028}B',
        { x: '2' },
      ),
      c(
        'adv-header-cr-inside',
        adversarial('regex', 'a header name holding a CR (from a CR-only line break): JS . does not match CR; Rust regex . does'),
        lit('[A\rB]\nx=1\n'),
        'A\rB',
        { x: '2' },
      ),
      c(
        'adv-entry-line-separator',
        adversarial('regex', 'a value holding U+2028: JS (.*)$ fails so the line is no entry and the key is appended; Rust regex . matches it'),
        lit('[A]\nx=a\u{2028}b\n'),
        'A',
        { x: '2' },
      ),
      c(
        'adv-entry-cr-inside',
        adversarial('regex', 'a value holding a bare CR: JS (.*)$ fails so the line is no entry and the key is appended; Rust regex . matches CR'),
        lit('[A]\nx=a\rb\n'),
        'A',
        { x: '2' },
      ),
      c(
        'adv-entry-key-feff',
        adversarial('unicode-space', 'a key starting with U+FEFF: JS [^=\\s] refuses it (so no entry); Rust \\s does not cover U+FEFF'),
        lit('[A]\n\u{FEFF}x=1\n'),
        'A',
        { '\u{FEFF}x': '2' },
      ),
      c(
        'adv-entry-key-nbsp',
        adversarial('unicode-space', 'a key starting with U+00A0: \\s in JS and in Rust, so no entry in either'),
        lit('[A]\n\u{00A0}x=1\n'),
        'A',
        { '\u{00A0}x': '2' },
      ),
      c(
        'adv-new-section-after-feff-line',
        adversarial(
          'unicode-space',
          'the last line is a lone U+FEFF: JS trim() removes it, so no blank line goes before the new section; Rust trim() keeps U+FEFF',
        ),
        bytes([0xef, 0xbb, 0xbf]),
        'B',
        { k: 'v' },
      ),
      c(
        'adv-new-section-after-nel-line',
        adversarial('unicode-space', 'the last line is a lone U+0085: JS trim() keeps it, so a blank line goes in; Rust trim() removes it'),
        lit('[A]\nx=1\n\u0085\n'),
        'B',
        { k: 'v' },
      ),
      c(
        'adv-new-section-after-nbsp-line',
        adversarial('unicode-space', 'the last line is U+00A0, U+1680 and U+3000: trim() removes them in JS and in Rust'),
        lit('[A]\nx=1\n\u{00A0}\u{1680}\u{3000}\n'),
        'B',
        { k: 'v' },
      ),
      c(
        'adv-blank-tail-feff',
        adversarial('unicode-space', 'a U+FEFF line before the next section counts as blank for JS trim(), so the new key goes above it; not for Rust trim()'),
        lit('[A]\nx=1\n\u{FEFF}\n[B]\n'),
        'A',
        { y: '2' },
      ),
      c(
        'adv-blank-tail-nel',
        adversarial(
          'unicode-space',
          'a U+0085 line before the next section is not blank for JS trim(), so the new key goes below it; Rust trim() would call it blank',
        ),
        lit('[A]\nx=1\n\u0085\n[B]\n'),
        'A',
        { y: '2' },
      ),
      c(
        'adv-astral-key',
        adversarial('utf16-length', 'an astral key: the before value is cut at key.length + 1 UTF-16 units, so a byte or char offset must give the same cut'),
        lit('[A]\n\u{1F600}=old\n'),
        'A',
        { '\u{1F600}': 'new' },
      ),
      c(
        'adv-astral-key-removed',
        adversarial('utf16-length', 'an astral key removed: the before value is cut at key.length + 1 UTF-16 units'),
        lit('[A]\n\u{1F600}\u{1D7D8}=old=value\n'),
        'A',
        { '\u{1F600}\u{1D7D8}': null },
      ),
      c(
        'adv-invalid-utf8-elsewhere',
        adversarial(
          'utf8-decode',
          'an invalid byte in another section of the fixture becomes U+FFFD in the rewritten text, so the write changes that line too',
        ),
        bytes(Buffer.from(fixtureText().replace('LastActiveTab=Fortnite', 'LastActiveTab=Fort\u{00FF}nite'), 'latin1')),
        'RememberMe',
        { Data: PH },
      ),
      c(
        'adv-lone-surrogate-value',
        adversarial('lone-surrogate', 'the new value holds a lone low surrogate; it is written into the text as it is'),
        lit('[A]\nx=1\n'),
        'A',
        { x: 'a\uDC00b' },
      ),
      ...corpus({ seed: 2, count: 40, from: corpusFrom, args: (mutated) => [mutated, 'RememberMe', { Enable: 'True', Data: PH }] }),
      ...corpus({ seed: 3, count: 40, from: corpusFrom, args: (mutated) => [mutated, 'Offline', { Data: null }] }),
      ...corpus({ seed: 4, count: 40, from: corpusFrom, args: (mutated) => [mutated, 'OneLaunch.Test', { k: 'v' }] }),
    ];
  },
});
