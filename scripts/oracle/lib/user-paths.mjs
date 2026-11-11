import os from 'node:os';
import { pathPattern } from './path-pattern.mjs';

const SAFE_NAMES = new Set(['someone', 'placeholder', 'public', 'default']);
const GENERIC_NAMES = new Set(['user', 'admin', 'administrator', 'runneradmin', 'runner', 'someone', 'public', 'default', 'localhost']);
const NAME = '([^\\\\/\\s"\'`*?|:;,)\\]\\x00-\\x1f]+)';
const USER_FOLDER = new RegExp(`(?:\\b[A-Za-z]:|(?<![\\w.])\\/[a-z])[\\\\/]{1,4}(?:Users|Documents and Settings)[\\\\/]{1,4}${NAME}`, 'gi');
const UNIX_HOME = new RegExp(`(?<![\\w.:\\\\/])\\/(?:home|Users)\\/${NAME}`, 'g');

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const maskName = (value) => `${value[0]}…(${value.length} chars)`;

export function machineIdentity() {
  let username = '';
  try {
    username = os.userInfo().username;
  } catch {
    username = process.env.USERNAME ?? '';
  }
  return { username, host: os.hostname(), folders: [os.homedir(), os.tmpdir()] };
}

export function createUserPathScanner({ identity = machineIdentity(), allow = new Set() } = {}) {
  const isPlaceholder = (name) => /^[<%${[]/.test(name) || SAFE_NAMES.has(name.toLowerCase()) || allow.has(name);
  const word = (value) => new RegExp(`(?<![A-Za-z0-9])${escape(value)}(?![A-Za-z0-9])`, 'gi');
  const own = [];
  for (const [kind, value] of [
    ['user-name', identity.username],
    ['host-name', identity.host],
  ]) {
    if (value && value.length >= 4 && !GENERIC_NAMES.has(value.toLowerCase())) own.push({ kind, pattern: word(value) });
  }
  for (const folder of identity.folders ?? []) {
    if (folder && /[\\/]Users[\\/]/i.test(folder)) own.push({ kind: 'own-folder', pattern: new RegExp(pathPattern(folder), 'gi') });
  }

  const scanText = (text) => {
    const found = [];
    for (const [kind, pattern] of [
      ['user-folder', USER_FOLDER],
      ['home-folder', UNIX_HOME],
    ]) {
      for (const match of text.matchAll(pattern)) {
        if (isPlaceholder(match[1])) continue;
        found.push({ kind, index: match.index + match[0].length - match[1].length, length: match[1].length, masked: maskName(match[1]) });
      }
    }
    for (const { kind, pattern } of own) {
      for (const match of text.matchAll(pattern)) found.push({ kind, index: match.index, length: match[0].length, masked: maskName(match[0]) });
    }
    return found;
  };

  // UTF-16 text (a .reg export, strings inside a binary) never shows up in a byte-per-character read, at either alignment.
  const scanBytes = (bytes) => {
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const views = [buffer.toString('latin1')];
    if (buffer.includes(0)) views.push(buffer.toString('utf16le'), buffer.subarray(1).toString('utf16le'));
    const seen = new Set();
    const found = [];
    for (const view of views) {
      for (const hit of scanText(view)) {
        const key = `${hit.kind} ${hit.masked}`;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push({ kind: hit.kind, masked: hit.masked });
      }
    }
    return found;
  };

  return { scanText, scanBytes };
}
