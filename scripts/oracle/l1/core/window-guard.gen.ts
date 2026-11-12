import { adversarial, fromTest, vectorFile, type Case } from '../lib/index';
import { closeRequestAction, hideAfterInstantPlay, isTrustedRendererUrl, placementFrom, startHidden } from '../../../../src/main/window-guard';

const TESTS = 'test/window-guard.test.ts';
const t = (...titles: string[]) => fromTest(TESTS, ...titles);
const bits = (n: number, keys: readonly string[]) => Object.fromEntries(keys.map((k, i) => [k, Boolean(n & (1 << (keys.length - 1 - i)))]));
const flags = (state: Record<string, boolean>) =>
  Object.entries(state)
    .map(([k, v]) => `${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}-${v ? 1 : 0}`)
    .join('.');

const CLOSE_KEYS = ['quitting', 'closeToTray', 'switchBusy'] as const;
const CLOSE_TITLES: Record<string, string> = {
  'quitting-0.close-to-tray-1.switch-busy-0': 'hides to the tray when the setting is on, even during a switch',
  'quitting-0.close-to-tray-1.switch-busy-1': 'hides to the tray when the setting is on, even during a switch',
  'quitting-0.close-to-tray-0.switch-busy-0': 'with the tray off, closes when idle and asks during a switch',
  'quitting-0.close-to-tray-0.switch-busy-1': 'with the tray off, closes when idle and asks during a switch',
  'quitting-1.close-to-tray-1.switch-busy-1': 'a quit already under way closes whatever the setting says',
  'quitting-1.close-to-tray-0.switch-busy-0': 'a quit already under way closes whatever the setting says',
};

vectorFile({
  area: 'core',
  function: 'closeRequestAction',
  source: 'src/main/window-guard.ts',
  note: 'arg0 is { quitting, closeToTray, switchBusy }, as the main window close handler in src/main/index.ts builds it. The cases are the full truth table, 8 rows.',
  call: closeRequestAction,
  cases: Array.from({ length: 8 }, (_, n) => {
    const state = bits(n, CLOSE_KEYS);
    const id = flags(state);
    return {
      id,
      origin: CLOSE_TITLES[id] ? t('closeRequestAction', CLOSE_TITLES[id]!) : adversarial('other', 'a truth-table row no test names'),
      args: [state],
      expect: 'out' as const,
    };
  }),
});

const HIDE_KEYS = ['instant', 'direct', 'done', 'handOff', 'trayPresent', 'closeToTray', 'hideToTray'] as const;
const ALL = { instant: true, direct: true, done: true, handOff: false, trayPresent: true, closeToTray: true, hideToTray: true };

function hideOrigin(state: Record<string, boolean>): Case['origin'] {
  const off = HIDE_KEYS.filter((k) => state[k] !== ALL[k]);
  if (off.length === 0) return t('hideAfterInstantPlay', 'hides only after a one-click Play that needed no switch and launched');
  if (off.length === 1 && off[0] === 'handOff')
    return t('hideAfterInstantPlay', 'keeps the window when the launch ended with an instruction for the user, as a Riot launch can');
  if (off.length === 1)
    return t('hideAfterInstantPlay', 'keeps the window for a dialog Play, a switch, a failure, and whenever there is no tray to come back from');
  return adversarial('other', 'a truth-table row no test names');
}

vectorFile({
  area: 'core',
  function: 'hideAfterInstantPlay',
  source: 'src/main/window-guard.ts',
  note: 'arg0 is { instant, direct, done, handOff, trayPresent, closeToTray, hideToTray }, all booleans as src/main/index.ts passes them. The cases are the full truth table, 128 rows; ids name every flag.',
  call: hideAfterInstantPlay,
  cases: Array.from({ length: 128 }, (_, n) => {
    const state = bits(n, HIDE_KEYS);
    return { id: flags(state), origin: hideOrigin(state), args: [state], expect: 'out' as const };
  }),
});

const EXE = 'C:\\Program Files\\One Launch\\OneLaunch.exe';
const argvs: [string, string[], Case['origin']][] = [
  ['flag', [EXE, '--start-hidden'], t('startHidden', 'starts in the tray only when the login item asked for it and the tray is on')],
  [
    'flag-after-data-dir',
    [EXE, '--data-dir=D:\\x', '--start-hidden'],
    t('startHidden', 'starts in the tray only when the login item asked for it and the tray is on'),
  ],
  ['no-flag', [EXE], t('startHidden', 'shows the window with the tray off, without the flag, or with a look-alike argument')],
  [
    'lookalikes',
    [EXE, '--start-hidden=false', '--START-HIDDEN'],
    t('startHidden', 'shows the window with the tray off, without the flag, or with a look-alike argument'),
  ],
  ['empty-argv', [], adversarial('other', 'an empty argv')],
  ['flag-first', ['--start-hidden'], adversarial('other', 'the flag as the only element, in the exe position')],
  ['flag-padded', [EXE, ' --start-hidden '], adversarial('unicode-space', 'the flag with spaces around it is not the flag: argv items are compared whole')],
  ['flag-twice', [EXE, '--start-hidden', '--start-hidden'], adversarial('other', 'the flag twice')],
  ['single-dash', [EXE, '-start-hidden'], adversarial('other', 'one dash')],
];

vectorFile({
  area: 'core',
  function: 'startHidden',
  source: 'src/main/window-guard.ts',
  note: 'arg0 is { argv, closeToTray }: process.argv and the close-to-tray setting. Every argv shape is run with closeToTray true and false.',
  call: startHidden,
  cases: argvs.flatMap(([id, argv, origin]) =>
    [true, false].map((closeToTray) => ({
      id: `${id}.close-to-tray-${closeToTray ? 1 : 0}`,
      origin: closeToTray || id !== 'flag' ? origin : t('startHidden', 'shows the window with the tray off, without the flag, or with a look-alike argument'),
      args: [{ argv, closeToTray }],
      expect: 'out' as const,
    })),
  ),
});

const PAGE = 'file:///C:/Program%20Files/One%20Launch/resources/app.asar/out/renderer/index.html';
const packaged = { rendererFileUrl: PAGE, devUrl: null };
const dev = { rendererFileUrl: PAGE, devUrl: 'http://localhost:5173' };
const PACKAGED_OK = 'accepts only the packaged page itself, with or without a hash or query';
const DEV_OK = 'in development accepts the dev server origin, not an address that only starts like it';
const urlCase = (id: string, url: string | undefined, opts: object, origin: Case['origin']): Case => ({ id, origin, args: [url, opts], expect: 'out' });
const tu = (title: string) => t('isTrustedRendererUrl (B19)', title);

const urlCases: Case[] = [
  urlCase('packaged-page', PAGE, packaged, tu(PACKAGED_OK)),
  urlCase('packaged-hash', `${PAGE}#/settings`, packaged, tu(PACKAGED_OK)),
  urlCase('packaged-query', `${PAGE}?v=1`, packaged, tu(PACKAGED_OK)),
  urlCase('packaged-undefined', undefined, packaged, tu(PACKAGED_OK)),
  urlCase('packaged-empty', '', packaged, tu(PACKAGED_OK)),
  urlCase('packaged-suffix', `${PAGE}.evil.html`, packaged, tu(PACKAGED_OK)),
  urlCase('packaged-dotdot', `${PAGE}/../other.html`, packaged, tu(PACKAGED_OK)),
  urlCase('packaged-other-file', 'file:///C:/Users/someone/Downloads/index.html', packaged, tu(PACKAGED_OK)),
  urlCase('packaged-https', 'https://example.com/', packaged, tu(PACKAGED_OK)),
  urlCase('packaged-dev-url', 'http://localhost:5173/', packaged, tu(PACKAGED_OK)),
  urlCase('packaged-artwork', 'onelaunch-art://game/1/grid.png', packaged, tu(PACKAGED_OK)),
  urlCase('packaged-about-blank', 'about:blank', packaged, tu(PACKAGED_OK)),
  urlCase('dev-origin', 'http://localhost:5173', dev, tu(DEV_OK)),
  urlCase('dev-origin-slash', 'http://localhost:5173/', dev, tu(DEV_OK)),
  urlCase('dev-page-hash', 'http://localhost:5173/index.html#/library', dev, tu(DEV_OK)),
  urlCase('dev-longer-port', 'http://localhost:51731/', dev, tu(DEV_OK)),
  urlCase('dev-host-suffix', 'http://localhost:5173.evil.test/', dev, tu(DEV_OK)),
  urlCase('dev-https', 'https://localhost:5173/', dev, tu(DEV_OK)),
  urlCase('dev-ip', 'http://127.0.0.1:5173/', dev, tu(DEV_OK)),
  urlCase('dev-packaged-page', PAGE, dev, tu(DEV_OK)),
  urlCase('dev-not-a-url', 'not a url', dev, tu(DEV_OK)),
  urlCase('dev-undefined', undefined, dev, tu(DEV_OK)),
  urlCase('packaged-hash-only', `${PAGE}#`, packaged, adversarial('other', 'the page with an empty hash')),
  urlCase(
    'packaged-case',
    PAGE.replace('file:', 'FILE:'),
    packaged,
    adversarial('case-mapping', 'the packaged check is an exact string compare, so FILE: is refused'),
  ),
  urlCase('packaged-unencoded', PAGE.replace(/%20/g, ' '), packaged, adversarial('other', 'the same path with raw spaces is refused')),
  urlCase('packaged-trailing-slash', `${PAGE}/`, packaged, adversarial('other', 'a trailing slash is refused')),
  urlCase('packaged-backslash', PAGE.replace(/\//g, '\\'), packaged, adversarial('other', 'backslashes are refused')),
  urlCase('dev-upper-host', 'http://LOCALHOST:5173/x', dev, adversarial('case-mapping', 'the origin lowercases the host')),
  urlCase('dev-userinfo', 'http://localhost:5173@evil.test/', dev, adversarial('other', 'localhost:5173 as user info: the host is evil.test')),
  urlCase('dev-userinfo-kept', 'http://u:p@localhost:5173/', dev, adversarial('other', 'user info does not change the origin')),
  urlCase(
    'dev-default-port',
    'http://localhost:80/',
    { rendererFileUrl: PAGE, devUrl: 'http://localhost' },
    adversarial('other', 'port 80 on http is the default and drops out of the origin'),
  ),
  urlCase('dev-outer-spaces', ' http://localhost:5173/ ', dev, adversarial('unicode-space', 'the URL parser strips outer spaces')),
  urlCase('dev-tab-inside', 'http://local\thost:5173/', dev, adversarial('unicode-space', 'the URL parser removes a tab inside the host')),
  urlCase('dev-idn', 'http://xn--localhost-:5173/', dev, adversarial('other', 'a punycode-looking host that is not localhost')),
  urlCase(
    'dev-invalid-dev-url',
    'http://localhost:5173/',
    { rendererFileUrl: PAGE, devUrl: 'not a url' },
    adversarial('other', 'an unparsable devUrl makes every URL untrusted'),
  ),
  urlCase('dev-empty-dev-url', PAGE, { rendererFileUrl: PAGE, devUrl: '' }, adversarial('other', 'an empty devUrl is falsy, so the packaged check applies')),
  urlCase(
    'dev-file-origins',
    'file:///D:/anything.html',
    { rendererFileUrl: PAGE, devUrl: 'file:///C:/dev/index.html' },
    adversarial('other', 'two file: URLs both have the opaque origin "null", so any file URL is trusted under a file: devUrl'),
  ),
  urlCase(
    'dev-about-origins',
    'about:blank',
    { rendererFileUrl: PAGE, devUrl: 'data:text/html,x' },
    adversarial('other', 'about: and data: URLs both have the opaque origin "null"'),
  ),
  urlCase('dev-empty-url', '', dev, adversarial('other', 'an empty URL is refused before parsing')),
];

vectorFile({
  area: 'core',
  function: 'isTrustedRendererUrl',
  source: 'src/main/window-guard.ts',
  note: "arg0 is the URL of a navigation or a new window (undefined when Electron gives none), arg1 { rendererFileUrl, devUrl } as src/main/index.ts builds them (devUrl is ELECTRON_RENDERER_URL in development, else null). URL is Node's WHATWG parser.",
  call: isTrustedRendererUrl,
  cases: urlCases,
});

const primary = { x: 0, y: 0, width: 1920, height: 1040 };
const left = { x: -1920, y: 0, width: 1920, height: 1040 };
const stored = (v: object): string => JSON.stringify(v);
const RESTORE = 'restores a placement that is on a connected display, never smaller than the minimum window';
const DROP = 'drops a placement whose title bar could not be reached, but still remembers maximized';
const NONE = 'treats a missing, malformed, or non-numeric setting as no placement';
const tp = (title: string) => t('placementFrom (B19)', title);
const place = (id: string, raw: string | null, areas: object[], origin: Case['origin']): Case => ({ id, origin, args: [raw, areas], expect: 'out' });
const at = (x: number, y: number, width = 1280, height = 800) => stored({ x, y, width, height });

const placeCases: Case[] = [
  place('restores', stored({ x: 100, y: 80, width: 1400, height: 900, maximized: false }), [primary], tp(RESTORE)),
  place('minimum-size', stored({ x: 100, y: 80, width: 300, height: 200 }), [primary], tp(RESTORE)),
  place('second-display', stored({ x: -1800, y: 40, width: 1280, height: 800, maximized: true }), [primary, left], tp(RESTORE)),
  place('display-gone', stored({ x: -1800, y: 40, width: 1280, height: 800, maximized: true }), [primary], tp(DROP)),
  place('off-right', at(1900, 40), [primary], tp(DROP)),
  place('above-top', at(100, -200), [primary], tp(DROP)),
  place('below-bottom', at(100, 1030), [primary], tp(DROP)),
  place('no-displays', at(100, 80), [], tp(DROP)),
  ...(
    [
      ['null', null],
      ['empty', ''],
      ['not-json', 'not json'],
      ['array', '[]'],
      ['string', '"x"'],
      ['string-x', stored({ x: '1', y: 2, width: 3, height: 4 })],
      ['null-width', stored({ x: 1, y: 2, width: null, height: 4 })],
      ['overflow', '{"x":1e999,"y":2,"width":1280,"height":800}'],
    ] as const
  ).map(([id, raw]) => place(`none-${id}`, raw, [primary], tp(NONE))),
  place('cap-left-edge-at', at(1855, 40), [primary], adversarial('number', 'x = 1855 leaves 65 px of the title bar on screen: kept')),
  place('cap-left-edge-over', at(1856, 40), [primary], adversarial('number', 'x = 1856 leaves 64 px: dropped')),
  place('cap-right-edge-at', at(-1215, 40), [primary], adversarial('number', 'x + width = 65: kept')),
  place('cap-right-edge-over', at(-1216, 40), [primary], adversarial('number', 'x + width = 64: dropped')),
  place('cap-top-at', at(100, -8), [primary], adversarial('number', 'y = -8, the most a title bar may sit above the work area: kept')),
  place('cap-top-over', at(100, -9), [primary], adversarial('number', 'y = -9: dropped')),
  place('cap-bottom-at', at(100, 975), [primary], adversarial('number', 'y = 975 is 65 px above the bottom: kept')),
  place('cap-bottom-over', at(100, 976), [primary], adversarial('number', 'y = 976: dropped')),
  place('cap-min-width-at', at(100, 80, 960, 600), [primary], adversarial('number', 'exactly the minimum window')),
  place('cap-min-width-over', at(100, 80, 959, 599), [primary], adversarial('number', 'one under the minimum is raised to it')),
  place('fractions', stored({ x: 100.5, y: 80.25, width: 1280.75, height: 800.5 }), [primary], adversarial('number', 'fractional values are kept as they are')),
  place('negative-zero', '{"x":-0,"y":-0,"width":1280,"height":800}', [primary], adversarial('number', '-0 from JSON is kept')),
  place('negative-size', stored({ x: 100, y: 80, width: -5, height: -5 }), [primary], adversarial('number', 'a negative size is raised to the minimum')),
  place('huge', stored({ x: 0, y: 0, width: 1e308, height: 1e308 }), [primary], adversarial('number', '1e308 is finite and kept')),
  place('exponent', '{"x":1e2,"y":8E1,"width":1.28e3,"height":800}', [primary], adversarial('json', 'exponent forms parse as numbers')),
  place('maximized-only', '{"maximized":true}', [primary], adversarial('other', 'maximized without bounds')),
  place(
    'maximized-string',
    stored({ x: 100, y: 80, width: 1280, height: 800, maximized: 'true' }),
    [primary],
    adversarial('other', 'maximized must be the boolean true'),
  ),
  place('json-null', 'null', [primary], adversarial('json', 'the JSON null makes the property read throw, caught as no placement')),
  place('json-number', '42', [primary], adversarial('json', 'a JSON number has no x')),
  place(
    'duplicate-key',
    '{"x":5000,"x":100,"y":80,"width":1280,"height":800}',
    [primary],
    adversarial('json', 'a duplicate key: the last one wins in JSON.parse'),
  ),
  place(
    'proto-key',
    '{"__proto__":{"x":100},"y":80,"width":1280,"height":800}',
    [primary],
    adversarial('json', 'a __proto__ key from JSON.parse is an own property, so x is not inherited'),
  ),
  place('bom', '\ufeff{"x":100,"y":80,"width":1280,"height":800}', [primary], adversarial('json', 'a leading U+FEFF makes JSON.parse throw')),
  place('whitespace', ' \n{"x":100,"y":80,"width":1280,"height":800}\t', [primary], adversarial('json', 'JSON whitespace around the value is allowed')),
  place('nbsp', '\u00a0{"x":100,"y":80,"width":1280,"height":800}', [primary], adversarial('unicode-space', 'U+00A0 is not JSON whitespace')),
  place('trailing-comma', '{"x":100,"y":80,"width":1280,"height":800,}', [primary], adversarial('json', 'a trailing comma is refused')),
  place(
    'big-integer',
    '{"x":100,"y":80,"width":12345678901234567890,"height":800}',
    [primary],
    adversarial('json', 'a 20-digit width parses to the nearest double'),
  ),
  place(
    'offset-work-area',
    at(2000, 32),
    [{ x: 1920, y: 40, width: 1280, height: 1000 }],
    adversarial('number', 'a display whose work area starts at y = 40: y = 32 is exactly 8 px above it'),
  ),
];

vectorFile({
  area: 'core',
  function: 'placementFrom',
  source: 'src/main/window-guard.ts',
  note: "arg0 is the window.bounds setting as stored (a string or null; a settings value, not file text), arg1 the work areas of the connected displays (Electron's Rectangle objects as plain { x, y, width, height }).",
  call: placementFrom,
  cases: placeCases,
});
