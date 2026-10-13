import type { Vault } from '../../src/main/services/vault';
import type { VaultStatus } from '../../src/shared/models';

/** Reversible transform standing in for DPAPI. */
export class FakeVault implements Vault {
  readonly backend = 'dpapi' as const;
  isAvailable(): boolean {
    return true;
  }
  status(): VaultStatus {
    return { available: true, backend: 'dpapi' };
  }
  encrypt(plaintext: string): Buffer {
    return Buffer.from(Buffer.from(plaintext, 'utf8').map((b) => b ^ 0x5a));
  }
  decrypt(ciphertext: Buffer): string {
    return Buffer.from(ciphertext.map((b) => b ^ 0x5a)).toString('utf8');
  }
}
