import { execFileSync } from 'node:child_process';
import { createDecipheriv } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchBase } from '../harness/runner';

const UNPROTECT = [
  'Add-Type -AssemblyName System.Security;',
  '$blob = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());',
  '$key = [Security.Cryptography.ProtectedData]::Unprotect($blob, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser);',
  '[Console]::Out.Write([Convert]::ToBase64String($key))',
].join(' ');

/**
 * Reads what a traced Electron run stored with safeStorage, so its `*_enc` values can be compared by plaintext digest
 * like the harness's. Only for a data folder under the scratch base: the key it unwraps belongs to that throwaway
 * profile, stays in this process's memory, and is never printed.
 */
export function scratchVault(dataDir: string): { decrypt: (ciphertext: Buffer) => string } {
  if (!`${dataDir}\\`.toLowerCase().startsWith(`${scratchBase()}\\`.toLowerCase()))
    throw new Error('the scratch vault only opens a data folder under the scratch base');
  const state = JSON.parse(readFileSync(join(dataDir, 'chromium', 'Local State'), 'utf8')) as { os_crypt?: { encrypted_key?: string } };
  const wrapped = Buffer.from(state.os_crypt?.encrypted_key ?? '', 'base64');
  if (wrapped.subarray(0, 5).toString('latin1') !== 'DPAPI') throw new Error('the scratch profile has no DPAPI-wrapped key');
  const key = Buffer.from(
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', UNPROTECT], {
      input: wrapped.subarray(5).toString('base64'),
      encoding: 'utf8',
      windowsHide: true,
    }).trim(),
    'base64',
  );
  if (key.byteLength !== 32) throw new Error('the scratch profile key is not an AES-256 key');
  return {
    decrypt: (ciphertext) => {
      if (ciphertext.subarray(0, 3).toString('latin1') !== 'v10') throw new Error('a stored value is not in the v10 safeStorage format');
      const decipher = createDecipheriv('aes-256-gcm', key, ciphertext.subarray(3, 15));
      decipher.setAuthTag(ciphertext.subarray(ciphertext.byteLength - 16));
      return Buffer.concat([decipher.update(ciphertext.subarray(15, ciphertext.byteLength - 16)), decipher.final()]).toString('utf8');
    },
  };
}
