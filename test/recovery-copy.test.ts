import { describe, expect, it } from 'vitest';
import { recoveryCopy } from '../src/renderer/src/lib/recovery';

describe('recoveryCopy', () => {
  it('leads with Restore when the files may be half-written or a rollback failed', () => {
    const writing = recoveryCopy({ phase: 'writing', accountName: 'Alt', snapshotAvailable: true }, 'Steam');
    expect(writing).toMatchObject({ title: 'One Launch was closed during a switch', recommend: 'restore' });
    expect(writing.body).toContain("changing Steam's sign-in files for Alt");

    const failed = recoveryCopy({ phase: 'rollback-failed', accountName: 'Alt', snapshotAvailable: true }, 'Steam');
    expect(failed).toMatchObject({ title: 'The last switch could not be undone', recommend: 'restore' });
  });

  it('leads with Keep as is when the files were written and the launcher was already signing in', () => {
    const copy = recoveryCopy({ phase: 'signing-in', accountName: 'Alt', snapshotAvailable: true }, 'Battle.net');
    expect(copy.recommend).toBe('keep');
    expect(copy.body).toContain('If it is signed in as Alt, keep it as it is.');
  });

  it('offers no restore when the snapshot is gone, and copes with a deleted account', () => {
    const copy = recoveryCopy({ phase: 'writing', accountName: null, snapshotAvailable: false }, 'Epic Games Launcher');
    expect(copy.recommend).toBe('keep');
    expect(copy.body).toContain('an account that has since been removed');
    expect(copy.body).toContain('nothing to restore');
  });
});
