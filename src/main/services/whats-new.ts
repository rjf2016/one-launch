import type { SettingsService } from './settings';

/**
 * A data folder created by this start has nothing to announce, so the running version counts as seen and a fresh install
 * never opens What's New. An existing folder keeps what it has; none at all means an upgrade from before the feature,
 * which the renderer treats as older than every release.
 */
export function seedWhatsNewSeen(settings: SettingsService, freshDb: boolean, version: string): boolean {
  if (!freshDb || settings.get('whatsNew.lastSeen') !== null) return false;
  settings.set('whatsNew.lastSeen', version);
  return true;
}
