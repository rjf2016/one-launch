import type { App } from 'electron';
import type { AutostartStatus } from '@shared/models';
import { perUserInstall, type InstallInput } from '../updates/availability';

// build/installer.nsh deletes the Run value by this same name at uninstall, and on a reinstall when it names another exe.
export const LOGIN_ITEM_NAME = 'OneLaunch';
export const START_HIDDEN_FLAG = '--start-hidden';

export interface LoginItem {
  status(): Promise<AutostartStatus>;
  set(openAtLogin: boolean): Promise<AutostartStatus>;
}

// Only a per-user install has an uninstaller that can remove this user's entry; a dev run or a scratch --data-dir run must never become the copy Windows starts.
export async function loginItemAvailable(input: InstallInput): Promise<boolean> {
  return (await perUserInstall(input)).ok;
}

export interface WindowsLoginItemOptions {
  available: () => Promise<boolean>;
  execPath: string;
  app: Pick<App, 'getLoginItemSettings' | 'setLoginItemSettings'>;
}

export class WindowsLoginItem implements LoginItem {
  private availability: Promise<boolean> | null = null;

  constructor(private readonly opts: WindowsLoginItemOptions) {}

  async status(): Promise<AutostartStatus> {
    if (!(await this.available())) return { available: false, openAtLogin: false };
    // Electron parses this path as a command line, so unquoted it ends at the first space and matches nothing.
    const settings = this.opts.app.getLoginItemSettings({ path: `"${this.opts.execPath}"` });
    return { available: true, openAtLogin: settings.executableWillLaunchAtLogin };
  }

  async set(openAtLogin: boolean): Promise<AutostartStatus> {
    if (!(await this.available())) throw new Error('Start with Windows is not available for this copy of One Launch');
    const target = { path: this.opts.execPath, args: [START_HIDDEN_FLAG], name: LOGIN_ITEM_NAME };
    this.opts.app.setLoginItemSettings(openAtLogin ? { openAtLogin: true, enabled: true, ...target } : { openAtLogin: false, ...target });
    return this.status();
  }

  private available(): Promise<boolean> {
    return (this.availability ??= this.opts.available());
  }
}

export class MemoryLoginItem implements LoginItem {
  private openAtLogin = false;

  async status(): Promise<AutostartStatus> {
    return { available: true, openAtLogin: this.openAtLogin };
  }

  async set(openAtLogin: boolean): Promise<AutostartStatus> {
    this.openAtLogin = openAtLogin;
    return this.status();
  }
}
