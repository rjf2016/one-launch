import type { App } from 'electron';
import type { AutostartStatus } from '@shared/models';
import type { DataDirSource } from './paths';

// build/installer.nsh deletes the Run value by this same name at uninstall.
export const LOGIN_ITEM_NAME = 'OneLaunch';
export const START_HIDDEN_FLAG = '--start-hidden';

export interface LoginItem {
  status(): AutostartStatus;
  set(openAtLogin: boolean): AutostartStatus;
}

// A dev run would register Electron's own exe, and a scratch --data-dir run must never become the copy Windows starts.
export function loginItemAvailable(input: { isPackaged: boolean; dataDirSource: DataDirSource }): boolean {
  return input.isPackaged && input.dataDirSource === 'default';
}

export interface WindowsLoginItemOptions {
  available: boolean;
  execPath: string;
  app: Pick<App, 'getLoginItemSettings' | 'setLoginItemSettings'>;
}

export class WindowsLoginItem implements LoginItem {
  constructor(private readonly opts: WindowsLoginItemOptions) {}

  status(): AutostartStatus {
    if (!this.opts.available) return { available: false, openAtLogin: false };
    const settings = this.opts.app.getLoginItemSettings({ path: this.opts.execPath, args: [START_HIDDEN_FLAG] });
    return { available: true, openAtLogin: settings.executableWillLaunchAtLogin };
  }

  set(openAtLogin: boolean): AutostartStatus {
    if (!this.opts.available) throw new Error('Start with Windows is not available for this copy of One Launch');
    const target = { path: this.opts.execPath, args: [START_HIDDEN_FLAG], name: LOGIN_ITEM_NAME };
    this.opts.app.setLoginItemSettings(openAtLogin ? { openAtLogin: true, enabled: true, ...target } : { openAtLogin: false, ...target });
    return this.status();
  }
}

export class MemoryLoginItem implements LoginItem {
  private openAtLogin = false;

  status(): AutostartStatus {
    return { available: true, openAtLogin: this.openAtLogin };
  }

  set(openAtLogin: boolean): AutostartStatus {
    this.openAtLogin = openAtLogin;
    return this.status();
  }
}
