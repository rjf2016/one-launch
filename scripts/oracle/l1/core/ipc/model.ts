import { isBattlenetLaunchForm, isEpicLaunchUriForm, isLogLevel, MAIN_ONLY_SETTING_KEYS, type SettingKey } from '../../../../../src/shared/models';
import { isVersionString } from '../../../../../src/shared/whats-new';
import type { Field } from './schema';

export interface Refusal {
  code: string;
  message: string;
}

const bad = (message: string): Refusal => ({ code: 'BAD_REQUEST', message });
const notObject = (value: unknown): boolean => !value || typeof value !== 'object' || Array.isArray(value);

function checkString(value: unknown, name: string, max: number): Refusal | null {
  if (typeof value !== 'string') return bad(`${name} must be a string`);
  if (value.length > max) return bad(`${name} exceeds ${max} characters`);
  return null;
}

function checkField(field: Field, value: unknown): Refusal | null {
  switch (field.kind) {
    case 'string':
      return checkString(value, field.name, field.max);
    case 'oneOf':
      return typeof value !== 'string' || !field.allowed.includes(value) ? bad(`${field.name} is not an allowed value`) : null;
    case 'nullable':
      return value === undefined || value === null ? null : checkString(value, field.name, field.max);
    case 'optional':
      return value === undefined ? null : checkString(value, field.name, field.max);
    case 'array': {
      if (field.optional && value === undefined) return null;
      if (!Array.isArray(value)) return bad(`${field.name} must be an array`);
      if (value.length > field.maxItems) return bad(`${field.name} has more than ${field.maxItems} items`);
      for (let i = 0; i < value.length; i += 1) {
        const refusal = checkString(value[i], `${field.name}[${i}]`, field.maxLength);
        if (refusal) return refusal;
      }
      return null;
    }
    case 'object':
      if (notObject(value)) return bad(`${field.label}: expected an object payload`);
      return checkFields(field.fields, value as Record<string, unknown>);
    case 'boolean':
      return typeof value !== 'boolean' ? bad(`${field.name} must be a boolean`) : null;
    case 'lenient':
      return null;
  }
}

function checkFields(fields: Field[], body: Record<string, unknown>): Refusal | null {
  for (const field of fields) {
    const refusal = checkField(field, body[field.name]);
    if (refusal) return refusal;
  }
  return null;
}

const BOOLEAN_KEYS = [
  'dryRun',
  'artwork.autoFetch',
  'steam.autoLogin',
  'riot.pressPlay',
  'play.hideToTray',
  'firstRun.dismissed',
  'window.closeToTray',
  'updates.auto',
  'whatsNew.enabled',
];

function checkSetting(key: SettingKey, value: string): Refusal | null {
  if (MAIN_ONLY_SETTING_KEYS.includes(key)) return bad(`${key} is not user-settable`);
  if (key === 'logLevel' && !isLogLevel(value)) return bad('logLevel must be debug, info, warn, or error');
  if (key === 'epic.launchUri' && !isEpicLaunchUriForm(value)) return bad('epic.launchUri must be catalog or appname');
  if (key === 'battlenet.launch' && !isBattlenetLaunchForm(value)) return bad('battlenet.launch must be uri or exec');
  if (key === 'whatsNew.lastSeen' && !isVersionString(value)) return bad('whatsNew.lastSeen must be a version');
  if (BOOLEAN_KEYS.includes(key) && value !== 'true' && value !== 'false') return bad(`${key} must be true or false`);
  if (key === 'backups.keep' && !(/^\d{1,3}$/.test(value) && Number(value) >= 1 && Number(value) <= 200)) {
    return bad('backups.keep must be a whole number from 1 to 200');
  }
  return null;
}

/** What the handler layer should answer for a payload, by this transcription of the validators; null when the payload passes them. */
export function predict(channel: string, fields: Field[] | null, payload: unknown): Refusal | null {
  if (fields === null) return null;
  if (notObject(payload)) return bad(`${channel}: expected an object payload`);
  const body = payload as Record<string, unknown>;
  const refusal = checkFields(fields, body);
  if (refusal || channel !== 'settings:set') return refusal;
  return checkSetting(body['key'] as SettingKey, body['value'] as string);
}

export const UNTRUSTED: Refusal = { code: 'UNTRUSTED_SENDER', message: 'Request rejected' };
export const BUSY: Refusal = { code: 'BUSY', message: 'Another switch or launch is still running' };
