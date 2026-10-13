import type { SwitchRecovery } from '@shared/models';

export interface RecoveryCopy {
  title: string;
  body: string;
  /** Which button the dialog leads with. */
  recommend: 'restore' | 'keep';
}

/** The words of the startup prompt for a switch the last run did not finish. */
export function recoveryCopy(recovery: Pick<SwitchRecovery, 'phase' | 'accountName' | 'snapshotAvailable'>, launcherName: string): RecoveryCopy {
  const account = recovery.accountName ?? 'an account that has since been removed';
  const title = recovery.phase === 'rollback-failed' ? 'The last switch could not be undone' : 'One Launch was closed during a switch';
  if (!recovery.snapshotAvailable) {
    return {
      title,
      body: `It was switching ${launcherName} to ${account}. The snapshot taken before that switch is gone, so there is nothing to restore from here. Start ${launcherName} and check which account it signs in as; Settings › Backups lists the snapshots that are left.`,
      recommend: 'keep',
    };
  }
  switch (recovery.phase) {
    case 'writing':
      return {
        title,
        body: `It stopped while changing ${launcherName}'s sign-in files for ${account}, so ${launcherName} may be half-switched. Restoring puts ${launcherName} back the way it was before that switch.`,
        recommend: 'restore',
      };
    case 'signing-in':
      return {
        title,
        body: `${launcherName}'s files had already been changed for ${account}, and ${launcherName} was starting or signing in. If it is signed in as ${account}, keep it as it is. If it looks wrong, restore it to the way it was before the switch.`,
        recommend: 'keep',
      };
    case 'rollback-failed':
      return {
        title,
        body: `The switch to ${account} failed, and putting ${launcherName} back failed too. Restoring tries again with the snapshot taken before that switch.`,
        recommend: 'restore',
      };
  }
}
