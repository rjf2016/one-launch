import { describe, expect, it } from 'vitest';
import { IPC_CHANNELS } from '../src/shared/ipc-contract';
import { isLauncherId, isLogLevel, isSecretKey, isSettingKey } from '../src/shared/models';

describe('ipc contract', () => {
  it('has unique, namespaced channel names', () => {
    expect(new Set(IPC_CHANNELS).size).toBe(IPC_CHANNELS.length);
    for (const c of IPC_CHANNELS) expect(c).toMatch(/^[a-z]+:[a-zA-Z]+$/);
  });
});

describe('model guards', () => {
  it('accept only known values', () => {
    expect(isLauncherId('steam')).toBe(true);
    expect(isLauncherId('origin')).toBe(false);
    expect(isSecretKey('steamgriddb.apiKey')).toBe(true);
    expect(isSecretKey('password')).toBe(false);
    expect(isSettingKey('dryRun')).toBe(true);
    expect(isSettingKey(42)).toBe(false);
    expect(isLogLevel('warn')).toBe(true);
    expect(isLogLevel('verbose')).toBe(false);
  });
});
