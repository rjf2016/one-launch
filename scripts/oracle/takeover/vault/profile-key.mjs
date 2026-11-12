import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

const UNPROTECT = [
  'Add-Type -AssemblyName System.Security;',
  '$blob = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());',
  '$key = [Security.Cryptography.ProtectedData]::Unprotect($blob, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser);',
  '[Console]::Out.Write([Convert]::ToBase64String($key))',
].join(' ');

export const DPAPI_PREFIX = 'DPAPI';

function assertUnder(root, folder) {
  const back = relative(resolve(root).toLowerCase(), resolve(folder).toLowerCase());
  if (back === '' || back.startsWith('..') || isAbsolute(back)) throw new Error('a profile key is only ever unwrapped for a folder under the scratch root');
}

export function readLocalState(chromiumDir) {
  return JSON.parse(readFileSync(join(chromiumDir, 'Local State'), 'utf8'));
}

/** The AES key of a scratch Chromium profile. It stays in memory and is never printed or written. */
export function unwrapProfileKey(chromiumDir, scratchRoot) {
  assertUnder(scratchRoot, chromiumDir);
  const wrapped = Buffer.from(readLocalState(chromiumDir).os_crypt?.encrypted_key ?? '', 'base64');
  if (wrapped.subarray(0, DPAPI_PREFIX.length).toString('latin1') !== DPAPI_PREFIX) throw new Error('the profile has no DPAPI-wrapped key');
  const key = Buffer.from(
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', UNPROTECT], {
      input: wrapped.subarray(DPAPI_PREFIX.length).toString('base64'),
      encoding: 'utf8',
      windowsHide: true,
    }).trim(),
    'base64',
  );
  if (key.length !== 32) throw new Error('the unwrapped profile key is not 32 bytes');
  return key;
}
