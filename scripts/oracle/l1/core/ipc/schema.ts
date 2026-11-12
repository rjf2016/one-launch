import { ACCOUNT_LIMITS, ARTWORK_KINDS, LAUNCHER_IDS, OPEN_URL_TARGETS, RENDERER_SECRET_KEYS, SETTING_KEYS } from '../../../../../src/shared/models';

export type Field =
  | { name: string; kind: 'string'; max: number; id?: boolean; sample?: string }
  | { name: string; kind: 'oneOf'; allowed: readonly string[] }
  | { name: string; kind: 'nullable'; max: number; id?: boolean }
  | { name: string; kind: 'optional'; max: number }
  | { name: string; kind: 'array'; maxItems: number; maxLength: number; optional: boolean }
  | { name: string; kind: 'object'; label: string; fields: Field[] }
  | { name: string; kind: 'boolean' }
  | { name: string; kind: 'lenient' };

export interface ChannelSchema {
  busy: boolean;
  fields: Field[] | null;
}

const ID = 64;
const id = (name: string): Field => ({ name, kind: 'string', max: ID, id: true });
const launcher: Field = { name: 'launcher', kind: 'oneOf', allowed: LAUNCHER_IDS };
const none = (busy = false): ChannelSchema => ({ busy, fields: null });
const of = (fields: Field[], busy = false): ChannelSchema => ({ busy, fields });

const PATCH: Field[] = [
  { name: 'displayName', kind: 'optional', max: ACCOUNT_LIMITS.displayName },
  { name: 'login', kind: 'optional', max: ACCOUNT_LIMITS.login },
  { name: 'launcherUid', kind: 'nullable', max: ACCOUNT_LIMITS.launcherUid, id: true },
  { name: 'tags', kind: 'array', maxItems: ACCOUNT_LIMITS.tagCount, maxLength: ACCOUNT_LIMITS.tagLength, optional: true },
  { name: 'notes', kind: 'optional', max: ACCOUNT_LIMITS.notes },
];

// Transcribed from the handlers in src/main/ipc/index.ts, field by field in the order each handler validates them.
export const SCHEMA: Record<string, ChannelSchema> = {
  'app:ping': of([{ name: 'message', kind: 'string', max: 1000, sample: 'hello' }]),
  'app:info': none(),
  'app:openPath': of([{ name: 'target', kind: 'oneOf', allowed: ['logs', 'data', 'backups'] }]),
  'app:openUrl': of([{ name: 'target', kind: 'oneOf', allowed: OPEN_URL_TARGETS }]),
  'app:reportError': of([
    { name: 'source', kind: 'oneOf', allowed: ['render', 'window', 'promise'] },
    { name: 'message', kind: 'string', max: 8192, sample: 'boom' },
    { name: 'stack', kind: 'nullable', max: 8192 },
  ]),
  'vault:status': none(),
  'vault:reset': none(),
  'vault:setSecret': of([
    { name: 'key', kind: 'oneOf', allowed: RENDERER_SECRET_KEYS },
    { name: 'value', kind: 'string', max: 4096, sample: 'placeholder-secret-1' },
  ]),
  'vault:getSecret': of([{ name: 'key', kind: 'oneOf', allowed: ['diagnostics.roundtrip'] }]),
  'vault:deleteSecret': of([{ name: 'key', kind: 'oneOf', allowed: RENDERER_SECRET_KEYS }]),
  'settings:get': of([{ name: 'key', kind: 'oneOf', allowed: SETTING_KEYS }]),
  'settings:set': of([
    { name: 'key', kind: 'oneOf', allowed: SETTING_KEYS },
    { name: 'value', kind: 'string', max: 4096, sample: 'true' },
  ]),
  'settings:getAll': none(),
  'accounts:list': none(),
  'accounts:get': of([id('id')]),
  'accounts:create': of([
    launcher,
    { name: 'displayName', kind: 'string', max: ACCOUNT_LIMITS.displayName, sample: 'Main' },
    { name: 'login', kind: 'string', max: ACCOUNT_LIMITS.login, sample: 'user_1' },
    { name: 'password', kind: 'nullable', max: ACCOUNT_LIMITS.password },
    { name: 'launcherUid', kind: 'nullable', max: ACCOUNT_LIMITS.launcherUid, id: true },
    { name: 'tags', kind: 'array', maxItems: ACCOUNT_LIMITS.tagCount, maxLength: ACCOUNT_LIMITS.tagLength, optional: true },
    { name: 'notes', kind: 'optional', max: ACCOUNT_LIMITS.notes },
  ]),
  'accounts:update': of([id('id'), { name: 'patch', kind: 'object', label: 'accounts:update.patch', fields: PATCH }], true),
  'accounts:delete': of([id('id')], true),
  'accounts:setPassword': of([id('id'), { name: 'password', kind: 'string', max: ACCOUNT_LIMITS.password, sample: 'placeholder-password-1' }], true),
  'accounts:clearPassword': of([id('id')], true),
  'accounts:copy': of([id('id'), { name: 'field', kind: 'oneOf', allowed: ['login', 'password'] }]),
  'library:list': none(),
  'library:rescan': none(),
  'artwork:refresh': of([
    { name: 'gameId', kind: 'nullable', max: ID, id: true },
    { name: 'force', kind: 'lenient' },
  ]),
  'artwork:status': none(),
  'artwork:setManual': of([id('gameId'), { name: 'kind', kind: 'oneOf', allowed: ARTWORK_KINDS }]),
  'launchers:status': none(),
  'launchers:locate': of([launcher], true),
  'launchers:resetPath': of([launcher], true),
  'launchers:games': of([launcher]),
  'launchers:rememberedAccounts': of([launcher]),
  'launchers:importAccounts': of([launcher, { name: 'launcherUids', kind: 'array', maxItems: 64, maxLength: ACCOUNT_LIMITS.login, optional: false }]),
  'launchers:switchPlan': of([id('accountId')]),
  'sessions:get': of([id('accountId')]),
  'sessions:capture': of([id('accountId')], true),
  'sessions:forget': of([id('accountId')], true),
  'backups:list': of([launcher]),
  'backups:restore': of([launcher, { name: 'id', kind: 'string', max: 128, id: true }], true),
  'launch:preflight': of([id('accountId'), { name: 'gameId', kind: 'nullable', max: ID, id: true }]),
  'launch:start': of([
    id('accountId'),
    { name: 'gameId', kind: 'nullable', max: ID, id: true },
    { name: 'confirmClose', kind: 'lenient' },
    { name: 'instant', kind: 'lenient' },
  ]),
  'launch:status': of([id('jobId')]),
  'launch:cancel': of([id('jobId')]),
  'launch:recent': of([{ name: 'limit', kind: 'lenient' }]),
  'recovery:get': none(),
  'recovery:restore': none(true),
  'recovery:dismiss': none(),
  'autostart:status': none(),
  'autostart:set': of([{ name: 'openAtLogin', kind: 'boolean' }]),
  'updates:status': none(),
  'updates:check': none(),
  'updates:install': none(true),
};

export const isRequired = (field: Field): boolean =>
  ['string', 'oneOf', 'object', 'boolean'].includes(field.kind) || (field.kind === 'array' && !field.optional);

export function validValue(field: Field): unknown {
  switch (field.kind) {
    case 'string':
      return field.sample ?? 'a';
    case 'oneOf':
      return field.allowed[0];
    case 'nullable':
      return null;
    case 'array':
      return ['a'];
    case 'object':
      return {};
    case 'boolean':
      return true;
    default:
      return undefined;
  }
}

export function validPayload(fields: Field[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const value = validValue(field);
    if (value !== undefined) out[field.name] = value;
  }
  return out;
}
