import ui from './targets.ui.mjs';

const v = (name) => `l1/core/${name}.json`;
const one = (item, name, source) => ({ item, exports: [{ export: name, source, vector: v(name) }] });

const main = [
  one('canonicalPayload', 'canonicalPayload', 'src/main/updates/manifest.ts'),
  one('verifyManifest per refusal', 'verifyManifest', 'src/main/updates/manifest.ts'),
  one('updateAvailability', 'updateAvailability', 'src/main/updates/availability.ts'),
  one('redactString', 'redactString', 'src/main/services/logger.ts'),
  one('redactValue', 'redactValue', 'src/main/services/logger.ts'),
  one('formatLine', 'formatLine', 'src/main/services/logger.ts'),
  one('resolveArtworkPath', 'resolveArtworkPath', 'src/main/services/artwork-url.ts'),
  one('sniffImage', 'sniffImage', 'src/main/services/artwork-url.ts'),
  one('normalizeLauncherPath', 'normalizeLauncherPath', 'src/main/platform/fs-path.ts'),
  one('pathKey', 'pathKey', 'src/main/platform/fs-path.ts'),
  one('dataDirFromArgv', 'dataDirFromArgv', 'src/main/platform/paths.ts'),
  {
    item: 'window-guard truth tables',
    exports: ['isTrustedRendererUrl', 'closeRequestAction', 'hideAfterInstantPlay', 'startHidden', 'placementFrom'].map((name) => ({
      export: name,
      source: 'src/main/window-guard.ts',
      vector: v(name),
    })),
  },
  one('loginItemAvailable', 'loginItemAvailable', 'src/main/platform/login-item.ts'),
  one('compareVersions', 'compareVersions', 'src/shared/whats-new.ts'),
  one('pickWhatsNew', 'pickWhatsNew', 'src/shared/whats-new.ts'),
  one('v1 to v5 migration schema dump', 'migrate', 'src/main/db/index.ts'),
];

export default [...main, ...ui];
