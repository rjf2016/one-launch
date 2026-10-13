import type { ReleaseKey } from './manifest';

// Written by scripts/release-keygen.mjs. An empty list makes the updater refuse every release.
export const RELEASE_KEYS: readonly ReleaseKey[] = [
  { id: '616ad3e53aac3ce4', spki: 'MCowBQYDK2VwAyEAKLQyPjWzDVRwW/U6ta7+/qlzyv7jpTAB3TfJCCfhS9I=' }, // primary
  { id: '35f13c45c6049dbe', spki: 'MCowBQYDK2VwAyEAW8G8A0kpvLTfssEoZU26RlbEFrwCITH9wgCpPa3jR/A=' }, // backup
];
