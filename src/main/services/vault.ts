import { safeStorage } from 'electron';
import type { VaultStatus } from '@shared/models';

export class VaultUnavailableError extends Error {
  readonly code = 'VAULT_UNAVAILABLE';
  constructor() {
    super('Secure storage is not available on this system. Secrets cannot be stored.');
    this.name = 'VaultUnavailableError';
  }
}

/**
 * Ciphertext exists but cannot be decrypted: the DPAPI-wrapped key in the app's Chromium profile
 * (`<data dir>\chromium\Local State`) was deleted or replaced, or the data belongs to another Windows
 * user. Nothing stored under that key can be recovered; the user has to clear the secrets and re-enter them.
 */
export class VaultUnreadableError extends Error {
  readonly code = 'VAULT_UNREADABLE';
  constructor() {
    super(
      'One Launch cannot decrypt its stored secrets: the encryption key in the app data folder (chromium\\Local State) was lost or belongs to a different Windows user. In Settings, clear the stored passwords and sign-ins, then enter them again.',
    );
    this.name = 'VaultUnreadableError';
  }
}

/**
 * The vault interface. Callers only ever see plaintext strings and opaque ciphertext buffers.
 * Kept small on purpose so a master-password implementation can be swapped in later
 * (spec section 6) without touching any caller.
 */
export interface Vault {
  readonly backend: VaultStatus['backend'];
  isAvailable(): boolean;
  status(): VaultStatus;
  /** Throws VaultUnavailableError rather than ever falling back to plaintext. */
  encrypt(plaintext: string): Buffer;
  decrypt(ciphertext: Buffer): string;
}

/** Electron safeStorage, which is Windows DPAPI bound to the current Windows user. */
export class SafeStorageVault implements Vault {
  readonly backend = 'dpapi' as const;

  isAvailable(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  status(): VaultStatus {
    const available = this.isAvailable();
    return { available, backend: available ? 'dpapi' : 'none' };
  }

  encrypt(plaintext: string): Buffer {
    if (!this.isAvailable()) throw new VaultUnavailableError();
    return safeStorage.encryptString(plaintext);
  }

  decrypt(ciphertext: Buffer): string {
    if (!this.isAvailable()) throw new VaultUnavailableError();
    try {
      return safeStorage.decryptString(ciphertext);
    } catch {
      throw new VaultUnreadableError();
    }
  }
}
