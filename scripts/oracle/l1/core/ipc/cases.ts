import { adversarial, fromTest, type AdversarialClass, type Case } from '../../lib/index';
import { SETTING_KEYS } from '../../../../../src/shared/models';
import { BUSY_TITLE, REFUSED, REFUSED_DESCRIBE, REFUSED_TITLE, SERVICES_DESCRIBE, TESTS } from './lifted';
import { BUSY, predict, UNTRUSTED, type Refusal } from './model';
import { isRequired, validPayload, type ChannelSchema, type Field } from './schema';

export interface Context {
  trusted: boolean;
  busy: boolean;
}

export interface MatrixCase extends Case {
  predicted: Refusal;
}

export interface ChannelMatrix {
  cases: MatrixCase[];
  leftOut: string[];
}

const ASTRAL = '\u{1F600}';
const LONE = '\uD800';
const TRUSTED: Context = { trusted: true, busy: false };

const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'empty';

interface Variant {
  tag: string;
  value: unknown;
  cls: AdversarialClass;
  what: string;
  remove?: boolean;
}

const variant = (tag: string, value: unknown, cls: AdversarialClass, what: string): Variant => ({ tag, value, cls, what });

const WRONG_TYPES: Variant[] = [
  variant('type-null', null, 'other', 'null'),
  variant('type-zero', 0, 'other', 'the number 0'),
  variant('type-number', 5, 'other', 'the number 5'),
  variant('type-nan', NaN, 'number', 'NaN, which JSON cannot carry and a structured clone keeps'),
  variant('type-infinity', Infinity, 'number', 'Infinity'),
  variant('type-true', true, 'other', 'true'),
  variant('type-false', false, 'other', 'false'),
  variant('type-empty-array', [], 'other', 'an empty array'),
  variant('type-array', ['a'], 'other', 'an array of one string'),
  variant('type-object', {}, 'other', 'an empty object'),
  variant('type-date', new Date('2026-01-02T03:04:05.000Z'), 'other', 'a Date, which a structured clone keeps'),
  variant('type-bytes', Buffer.from('a'), 'other', 'bytes (a Uint8Array over IPC)'),
];

const MISSING: Variant[] = [
  { tag: 'missing', value: undefined, remove: true, cls: 'other', what: 'the key left out' },
  variant('undefined', undefined, 'other', 'the key present with the value undefined'),
];

function lengths(cap: string, max: number): Variant[] {
  return [
    variant(`cap-${cap}-over`, 'x'.repeat(max + 1), 'utf16-length', `${max + 1} ASCII characters, one over the limit of ${max} UTF-16 code units`),
    variant(`cap-${cap}-at`, 'x'.repeat(max), 'utf16-length', `${max} ASCII characters, exactly at the limit`),
    variant(
      `cap-${cap}-astral-over`,
      'x'.repeat(max - 1) + ASTRAL,
      'utf16-length',
      `${max - 1} ASCII characters and one astral character: ${max} code points but ${max + 1} UTF-16 code units`,
    ),
    variant(
      `cap-${cap}-astral-at`,
      'x'.repeat(max - 2) + ASTRAL,
      'utf16-length',
      `${max - 2} ASCII characters and one astral character: ${max} UTF-16 code units, ${max - 1} code points`,
    ),
    variant(`cap-${cap}-lone-over`, 'x'.repeat(max) + LONE, 'lone-surrogate', `${max} ASCII characters and a lone high surrogate: one unit over the limit`),
    variant(
      `cap-${cap}-lone-at`,
      'x'.repeat(max - 1) + LONE,
      'lone-surrogate',
      `${max - 1} ASCII characters and a lone high surrogate, exactly at the limit; the string is not well-formed and still accepted`,
    ),
  ];
}

const STRING_EDGES: Variant[] = [
  variant('empty', '', 'other', 'an empty string, which the validators do not refuse'),
  variant('space', ' ', 'unicode-space', 'a single space'),
  variant('nbsp', ' ', 'unicode-space', 'a no-break space, which trim() removes'),
  variant('lone-surrogate', LONE, 'lone-surrogate', 'a lone high surrogate'),
  variant('nul', 'a\u0000b', 'other', 'a NUL inside the string'),
];

const ID_SHAPES: Variant[] = [
  variant('id-traversal', '..\\..\\elsewhere', 'other', 'a path-like id; ids are not shape-checked at the IPC layer'),
  variant('id-alias', '@acct:steam:user_3', 'other', 'an id that is not a UUID'),
  variant('id-padded', ' a ', 'unicode-space', 'an id with spaces around it'),
  variant('id-accented', 'é', 'other', 'a non-ASCII id'),
];

function oneOfVariants(allowed: readonly string[]): Variant[] {
  const first = allowed[0]!;
  return [
    variant('unknown', 'nope', 'other', 'a value outside the allowed list'),
    variant('empty', '', 'other', 'an empty string'),
    variant('upper', first.toUpperCase(), 'case-mapping', `${first} upper-cased; the list is matched exactly`),
    variant('title', first.charAt(0).toUpperCase() + first.slice(1), 'case-mapping', `${first} with a capital first letter`),
    variant('leading-space', ` ${first}`, 'unicode-space', `${first} with a leading space; nothing is trimmed`),
    variant('trailing-space', `${first} `, 'unicode-space', `${first} with a trailing space`),
    variant('trailing-nul', `${first}\u0000`, 'other', `${first} with a trailing NUL`),
    variant('trailing-lone', `${first}${LONE}`, 'lone-surrogate', `${first} with a trailing lone surrogate`),
    variant('proto', '__proto__', 'json', '"__proto__" as the value; the list is an array, so includes() finds nothing'),
    variant('constructor', 'constructor', 'json', '"constructor" as the value'),
    variant('array-of-allowed', [first], 'other', `[${JSON.stringify(first)}], an array holding an allowed value`),
  ];
}

function arrayVariants(field: Extract<Field, { kind: 'array' }>): Variant[] {
  const cap = slug(field.name);
  return [
    variant('not-array-string', 'a', 'other', 'a string where an array is expected'),
    variant('not-array-object', {}, 'other', 'an object'),
    variant('array-like', { 0: 'a', length: 1 }, 'other', 'an array-like object, which Array.isArray refuses'),
    variant('item-number', [1], 'other', 'an item that is a number'),
    variant('item-null', [null], 'other', 'an item that is null'),
    variant('item-undefined', [undefined], 'other', 'an item that is undefined'),
    variant('item-nested', [['a']], 'other', 'an item that is an array'),
    variant('second-item-number', ['a', 5], 'other', 'a good first item and a bad second one: the message names the index'),
    variant('empty-array', [], 'other', 'an empty array'),
    variant(
      `cap-${cap}-items-over`,
      Array.from({ length: field.maxItems + 1 }, (_, i) => `t${i}`),
      'other',
      `${field.maxItems + 1} items, one over the limit of ${field.maxItems}`,
    ),
    variant(
      `cap-${cap}-items-at`,
      Array.from({ length: field.maxItems }, (_, i) => `t${i}`),
      'other',
      `${field.maxItems} items, exactly at the limit`,
    ),
    variant(
      `cap-${cap}-item-over`,
      ['x'.repeat(field.maxLength + 1)],
      'utf16-length',
      `an item of ${field.maxLength + 1} characters, one over the limit of ${field.maxLength}`,
    ),
    variant(`cap-${cap}-item-at`, ['x'.repeat(field.maxLength)], 'utf16-length', `an item of ${field.maxLength} characters, exactly at the limit`),
    variant(
      `cap-${cap}-item-astral-over`,
      ['x'.repeat(field.maxLength - 1) + ASTRAL],
      'utf16-length',
      `an item of ${field.maxLength} code points and ${field.maxLength + 1} UTF-16 units`,
    ),
    variant(
      `cap-${cap}-item-astral-at`,
      ['x'.repeat(field.maxLength - 2) + ASTRAL],
      'utf16-length',
      `an item of ${field.maxLength} UTF-16 units with an astral character at the end`,
    ),
    variant(
      `cap-${cap}-second-item-over`,
      ['a', 'x'.repeat(field.maxLength + 1)],
      'utf16-length',
      'the second item over the length limit: the message names index 1',
    ),
    variant('item-lone', [LONE], 'lone-surrogate', 'an item that is a lone surrogate'),
  ];
}

function variantsOf(field: Field): Variant[] {
  const types = WRONG_TYPES.filter((v) => !(field.kind === 'boolean' && typeof v.value === 'boolean'));
  switch (field.kind) {
    case 'string':
    case 'nullable':
    case 'optional':
      return [...MISSING, ...types, ...STRING_EDGES, ...lengths(slug(field.name), field.max), ...('id' in field && field.id ? ID_SHAPES : [])];
    case 'oneOf':
      return [...MISSING, ...types, ...oneOfVariants(field.allowed)];
    case 'array':
      return [...MISSING, ...types.filter((v) => !Array.isArray(v.value)), ...arrayVariants(field)];
    case 'object':
      return [...MISSING, ...types, variant('array-of-object', [{}], 'other', 'an array holding an object')];
    case 'boolean':
      return [
        ...MISSING,
        ...types,
        variant('string-true', 'true', 'other', 'the string "true"'),
        variant('string-false', 'false', 'other', 'the string "false"'),
        variant('number-one', 1, 'other', 'the number 1'),
      ];
    case 'lenient':
      return [];
  }
}

const withField = (body: Record<string, unknown>, name: string, v: Variant): Record<string, unknown> => {
  const out = { ...body };
  if (v.remove) delete out[name];
  else out[name] = v.value;
  return out;
};

const BREAK = 5;

/** Builds the per-channel matrix from the schema: every variant of every field, kept only when the model says the handler refuses it. */
export function channelMatrix(channel: string, schema: ChannelSchema): ChannelMatrix {
  const cases: MatrixCase[] = [];
  const leftOut: string[] = [];
  const add = (id: string, origin: Case['origin'], payload: unknown, context: Context, predicted: Refusal | null, note: string): void => {
    if (predicted === null) {
      leftOut.push(note);
      return;
    }
    cases.push({ id, origin, args: [channel, payload, context], expect: 'out', predicted });
  };
  const fields = schema.fields;

  add(
    'untrusted-undefined',
    adversarial('other', `${channel} from a frame that is not the app's renderer: refused before the handler runs`),
    undefined,
    { ...TRUSTED, trusted: false },
    UNTRUSTED,
    '',
  );
  if (fields) {
    add(
      'untrusted-valid',
      adversarial('other', `${channel} with a well-formed payload from an untrusted frame: the sender check wins`),
      validPayload(fields),
      { ...TRUSTED, trusted: false },
      UNTRUSTED,
      '',
    );
  }
  if (schema.busy) {
    add(
      'untrusted-busy',
      adversarial('other', `${channel} from an untrusted frame while a switch runs: the sender check comes first`),
      undefined,
      { trusted: false, busy: true },
      UNTRUSTED,
      '',
    );
    add(
      'busy-undefined',
      adversarial('other', `${channel} while a switch runs: the busy check comes before any validation`),
      undefined,
      { ...TRUSTED, busy: true },
      BUSY,
      '',
    );
    if (fields) {
      add(
        'busy-null',
        adversarial('other', `${channel} with a null payload while a switch runs: BUSY, not BAD_REQUEST`),
        null,
        { ...TRUSTED, busy: true },
        BUSY,
        '',
      );
      add(
        'busy-valid',
        adversarial('other', `${channel} with a well-formed payload while a switch runs: refused before the payload is read`),
        validPayload(fields),
        { ...TRUSTED, busy: true },
        BUSY,
        '',
      );
    }
  } else if (fields) {
    add(
      'busy-ignored-null',
      adversarial('other', `${channel} does not wait for a running switch: a null payload is still BAD_REQUEST`),
      null,
      { ...TRUSTED, busy: true },
      predict(channel, fields, null),
      '',
    );
  }

  if (!fields) return { cases, leftOut };

  const tops: Variant[] = [
    { tag: 'top-missing', value: undefined, cls: 'other', what: 'no payload at all, as invoke(channel) sends' },
    variant('top-null', null, 'other', 'null'),
    variant('top-false', false, 'other', 'false'),
    variant('top-true', true, 'other', 'true'),
    variant('top-zero', 0, 'other', 'the number 0'),
    variant('top-number', 7, 'other', 'the number 7'),
    variant('top-nan', NaN, 'number', 'NaN'),
    variant('top-empty-string', '', 'other', 'an empty string'),
    variant('top-string', 'text', 'other', 'a string'),
    variant('top-empty-array', [], 'other', 'an empty array'),
    variant('top-array-of-valid', [validPayload(fields)], 'other', 'an array holding a well-formed payload'),
    variant('top-date', new Date('2026-01-02T03:04:05.000Z'), 'other', 'a Date: an object to the check, with none of the fields'),
    variant('top-empty-object', {}, 'other', 'an empty object: every field missing'),
  ];
  for (const v of tops) {
    add(v.tag, adversarial(v.cls, `${channel} payload ${v.what}`), v.value, TRUSTED, predict(channel, fields, v.value), `${v.tag} passes`);
  }

  const visit = (list: Field[], wrap: (body: Record<string, unknown>) => Record<string, unknown>, prefix: string): void => {
    const base = validPayload(list);
    list.forEach((field, index) => {
      if (field.kind === 'object') visit(field.fields, (body) => wrap({ ...base, [field.name]: body }), `${prefix}${slug(field.name)}.`);
      if (field.kind === 'lenient') leftOut.push(`${prefix}${field.name}: any value passes (only a literal true counts, or a number is clamped)`);
      const later = list.slice(index + 1).filter((f) => f.kind !== 'lenient');
      for (const v of variantsOf(field)) {
        const id = v.tag.startsWith('cap-') ? `${prefix}${v.tag}` : `${prefix}${slug(field.name)}.${v.tag}`;
        const what = `${channel} ${prefix}${field.name}: ${v.what}`;
        const body = withField(base, field.name, v);
        const direct = predict(channel, fields, wrap(body));
        if (direct) {
          add(id, adversarial(v.cls, what), wrap(body), TRUSTED, direct, '');
          continue;
        }
        const next = later.find((f) => predict(channel, fields, wrap({ ...body, [f.name]: BREAK })) !== null);
        if (!next) {
          leftOut.push(`${prefix}${field.name} ${v.tag}`);
          continue;
        }
        const broken = wrap({ ...body, [next.name]: BREAK });
        add(
          id,
          adversarial(v.cls, `${what}; accepted, so ${next.name} is set to ${BREAK} and its refusal is the answer`),
          broken,
          TRUSTED,
          predict(channel, fields, broken),
          '',
        );
      }
    });
  };
  visit(fields, (body) => body, '');

  const first = fields.find(isRequired);
  if (first) {
    const valid = validPayload(fields);
    const rest = { ...valid };
    delete rest[first.name];
    add(
      'extra-field',
      adversarial('other', `${channel}: an unknown key next to a payload missing ${first.name}; unknown keys are ignored, not refused`),
      { ...rest, unexpected: 'x' },
      TRUSTED,
      predict(channel, fields, { ...rest, unexpected: 'x' }),
      'extra-field passes',
    );
    add(
      'shadow-keys',
      adversarial(
        'json',
        `${channel}: keys named after Object.prototype members (toString, constructor, hasOwnProperty) next to a payload missing ${first.name}`,
      ),
      { ...rest, toString: 'x', constructor: 'x', hasOwnProperty: 5 },
      TRUSTED,
      predict(channel, fields, { ...rest, toString: 'x', constructor: 'x', hasOwnProperty: 5 }),
      'shadow-keys passes',
    );
    const ownProto: unknown = JSON.parse(`{"__proto__":${JSON.stringify(valid)}}`);
    add(
      'proto-own-key',
      adversarial(
        'json',
        `${channel}: an own "__proto__" data key holding a well-formed payload (as JSON.parse and a structured clone make it); the fields are not read through it`,
      ),
      ownProto,
      TRUSTED,
      predict(channel, fields, ownProto),
      'proto-own-key passes',
    );
    const ctor = { constructor: { prototype: valid } };
    add(
      'proto-constructor-prototype',
      adversarial('json', `${channel}: a constructor.prototype path holding a well-formed payload`),
      ctor,
      TRUSTED,
      predict(channel, fields, ctor),
      'proto-constructor-prototype passes',
    );
  }

  if (channel === 'settings:set') cases.push(...settingRules(fields));

  for (const payload of REFUSED[channel] ?? []) {
    const id = `test-${describe(payload)}`;
    const refusal = predict(channel, fields, payload);
    if (!refusal) throw new Error(`${channel}: the model lets the test's payload ${id} through; the schema is mistranscribed`);
    cases.push({ id, origin: fromTest(TESTS, REFUSED_DESCRIBE, REFUSED_TITLE), args: [channel, payload, TRUSTED], expect: 'out', predicted: refusal });
  }
  return { cases, leftOut: leftOut.filter((line) => line !== '') };
}

export function liftedBusyInstall(): MatrixCase {
  return {
    id: 'test-busy-undefined',
    origin: fromTest(TESTS, SERVICES_DESCRIBE, BUSY_TITLE),
    args: ['updates:install', undefined, { trusted: true, busy: true }],
    expect: 'out',
    predicted: BUSY,
  };
}

const RULE_VALUES: Record<string, [string, string, AdversarialClass][]> = {
  boolean: [
    ['maybe', 'maybe', 'other'],
    ['upper', 'TRUE', 'case-mapping'],
    ['title', 'True', 'case-mapping'],
    ['empty', '', 'other'],
    ['leading-space', ' true', 'unicode-space'],
    ['trailing-space', 'true ', 'unicode-space'],
    ['one', '1', 'parseint'],
    ['zero', '0', 'parseint'],
    ['yes', 'yes', 'other'],
  ],
  logLevel: [
    ['verbose', 'verbose', 'other'],
    ['upper', 'INFO', 'case-mapping'],
    ['leading-space', ' info', 'unicode-space'],
    ['warning', 'warning', 'other'],
    ['empty', '', 'other'],
  ],
  'epic.launchUri': [
    ['title', 'Catalog', 'case-mapping'],
    ['camel', 'appName', 'case-mapping'],
    ['uri', 'uri', 'other'],
    ['empty', '', 'other'],
  ],
  'battlenet.launch': [
    ['upper', 'URI', 'case-mapping'],
    ['catalog', 'catalog', 'other'],
    ['trailing-space', 'exec ', 'unicode-space'],
    ['empty', '', 'other'],
  ],
  'whatsNew.lastSeen': [
    ['two-parts', '1.0', 'other'],
    ['v-prefix', 'v1.0.0', 'other'],
    ['trailing-space', '1.0.0 ', 'unicode-space'],
    ['trailing-newline', '1.0.0\n', 'regex'],
    ['empty-prerelease', '1.0.0-', 'regex'],
    ['build-metadata', '1.0.0+build', 'regex'],
    ['arabic-indic', '١.٠.٠', 'unicode-digit'],
    ['fullwidth', '１.０.０', 'unicode-digit'],
    ['cap-version-over', `1.0.0-${'a'.repeat(59)}`, 'utf16-length'],
    ['empty', '', 'other'],
  ],
  'backups.keep': [
    ['zero', '0', 'number'],
    ['over-range', '201', 'number'],
    ['negative', '-1', 'parseint'],
    ['fraction', '1.5', 'number'],
    ['exponent', '1e2', 'parseint'],
    ['hex', '0x10', 'parseint'],
    ['plus', '+5', 'parseint'],
    ['leading-space', ' 5', 'parseint'],
    ['trailing-space', '5 ', 'parseint'],
    ['trailing-newline', '5\n', 'regex'],
    ['four-digits', '1000', 'number'],
    ['arabic-indic', '٣', 'unicode-digit'],
    ['fullwidth', '５', 'unicode-digit'],
    ['nan', 'NaN', 'parseint'],
    ['infinity', 'Infinity', 'parseint'],
    ['empty', '', 'parseint'],
  ],
  mainOnly: [
    ['any', 'x', 'other'],
    ['cap-value-at', 'x'.repeat(4096), 'utf16-length'],
  ],
};

const BOOLEAN_KEYS = new Set([
  'dryRun',
  'artwork.autoFetch',
  'steam.autoLogin',
  'riot.pressPlay',
  'play.hideToTray',
  'firstRun.dismissed',
  'window.closeToTray',
  'updates.auto',
  'whatsNew.enabled',
]);
const MAIN_ONLY = new Set(['window.bounds', 'steam.path', 'epic.path', 'battlenet.path', 'riot.path']);

function settingRules(fields: Field[]): MatrixCase[] {
  const out: MatrixCase[] = [];
  for (const key of SETTING_KEYS) {
    const group = MAIN_ONLY.has(key) ? 'mainOnly' : BOOLEAN_KEYS.has(key) ? 'boolean' : key;
    const values = RULE_VALUES[group];
    if (!values) throw new Error(`settings:set: no rule values for ${key}`);
    for (const [tag, value, cls] of values) {
      const payload = { key, value };
      const refusal = predict('settings:set', fields, payload);
      if (!refusal) throw new Error(`settings:set ${key}=${JSON.stringify(value)} passes the model; it is not a bad payload`);
      out.push({
        id: `rule-${slug(key)}-${tag}`,
        origin: adversarial(cls, `settings:set ${key} with ${JSON.stringify(value).slice(0, 40)}: the per-key rule after the length check answers`),
        args: ['settings:set', payload, TRUSTED],
        expect: 'out',
        predicted: refusal,
      });
    }
  }
  return out;
}

function describe(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return value.length > 20 ? `len${value.length}` : `str-${slug(value)}`;
  if (typeof value === 'number' || typeof value === 'boolean') return `${typeof value}-${String(value)}`;
  if (Array.isArray(value)) return `arr${value.length}${value.length <= 2 ? value.map((item) => `-${describe(item)}`).join('') : ''}`;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return 'empty-object';
  return entries.map(([key, item]) => `${slug(key)}-${describe(item)}`).join('.');
}
