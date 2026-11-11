import { randomBytes } from 'node:crypto';
import { FakeVault } from '../../../../test/helpers/fake-vault';

const SALT_BYTES = 8;

/**
 * The fake vault with a random salt in front of every value. Like DPAPI's, its output for the same plaintext differs
 * every time, so anything that depends on a ciphertext shows up as a difference between recordings instead of
 * passing unseen.
 */
export class SaltedFakeVault extends FakeVault {
  override encrypt(plaintext: string): Buffer {
    return Buffer.concat([randomBytes(SALT_BYTES), super.encrypt(plaintext)]);
  }

  override decrypt(ciphertext: Buffer): string {
    return super.decrypt(ciphertext.subarray(SALT_BYTES));
  }
}
