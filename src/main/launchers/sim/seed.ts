import { isSettingKey, MAIN_ONLY_SETTING_KEYS, type LauncherId, type SettingKey } from '@shared/models';
import type { AccountsService } from '../../services/accounts';
import type { Logger } from '../../services/logger';
import type { LauncherSessionStore } from '../../services/sessions';
import type { SettingsService } from '../../services/settings';
import { fingerprintOf as battlenetFingerprint, serializeBlob as serializeBattlenetBlob, type BattlenetSessionBlob } from '../battlenet/session';
import { fingerprintOf as epicFingerprint, serializeBlob as serializeEpicBlob, type EpicSessionBlob } from '../epic/session';
import { fingerprintOf as riotFingerprint, serializeBlob as serializeRiotBlob } from '../riot/session';
import { fakeSessionFile } from './riot';

export interface SeedAccount {
  launcher: LauncherId;
  displayName: string;
  login: string;
  launcherUid?: string | null;
  password?: string | null;
  tags?: string[];
  notes?: string;
}

export type SeedSession =
  | { launcher: 'epic'; login: string; launcherUid: string; blob: EpicSessionBlob }
  | { launcher: 'battlenet'; login: string; launcherUid: string; blob: BattlenetSessionBlob }
  /** Riot's blob is a whole session file; the seed builds one around the account id and this refresh token. */
  | { launcher: 'riot'; login: string; launcherUid: string; refreshToken: string };

export interface FakeSeed {
  settings?: Partial<Record<SettingKey, string>>;
  accounts?: SeedAccount[];
  sessions?: SeedSession[];
}

export interface SeedTargets {
  accounts: AccountsService;
  sessions: LauncherSessionStore;
  settings: SettingsService;
}

/** Settings a scenario may seed: everything a user could set from the UI, never a launcher path. */
export function seedableSettingKey(key: string): key is SettingKey {
  return isSettingKey(key) && !MAIN_ONLY_SETTING_KEYS.includes(key);
}

/**
 * Puts a scenario's accounts, remembered sessions, and settings into a fresh data folder. A folder that
 * already holds accounts is left alone, so a second start on the same folder sees what the first run left.
 */
export function applyFakeSeed(seed: FakeSeed, targets: SeedTargets, log: Logger): void {
  if (targets.accounts.list().length > 0) {
    log.info('fake seed skipped: the data folder already holds accounts');
    return;
  }
  const ids = new Map<string, string>();
  for (const a of seed.accounts ?? []) {
    const account = targets.accounts.create({
      launcher: a.launcher,
      displayName: a.displayName,
      login: a.login,
      launcherUid: a.launcherUid ?? null,
      password: a.password ?? null,
      tags: a.tags ?? [],
      notes: a.notes ?? '',
    });
    ids.set(`${a.launcher}:${a.login}`, account.id);
  }
  for (const s of seed.sessions ?? []) {
    const accountId = ids.get(`${s.launcher}:${s.login}`);
    if (!accountId) throw new Error(`fake seed: session for unknown ${s.launcher} account "${s.login}"`);
    if (s.launcher === 'epic') {
      targets.sessions.save({
        accountId,
        launcher: 'epic',
        launcherUid: s.launcherUid,
        fingerprint: epicFingerprint(s.blob.rememberMe.data),
        blob: serializeEpicBlob(s.blob),
      });
    } else if (s.launcher === 'riot') {
      targets.sessions.save({
        accountId,
        launcher: 'riot',
        launcherUid: s.launcherUid,
        fingerprint: riotFingerprint(s.refreshToken),
        blob: serializeRiotBlob({ v: 1, file: fakeSessionFile(s.launcherUid, s.refreshToken) }),
      });
    } else {
      targets.sessions.save({
        accountId,
        launcher: 'battlenet',
        launcherUid: s.launcherUid,
        fingerprint: battlenetFingerprint(s.blob.unifiedAuth.hex),
        blob: serializeBattlenetBlob(s.blob),
      });
    }
  }
  for (const [key, value] of Object.entries(seed.settings ?? {})) {
    if (!seedableSettingKey(key)) throw new Error(`fake seed: setting "${key}" cannot be seeded`);
    if (typeof value === 'string') targets.settings.set(key, value);
  }
  log.info('fake seed applied', { accounts: seed.accounts?.length ?? 0, sessions: seed.sessions?.length ?? 0 });
}
