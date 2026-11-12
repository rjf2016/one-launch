const VDF = 'src/main/launchers/steam/vdf.ts';
const LOGINUSERS = 'src/main/launchers/steam/loginusers.ts';
const MANIFESTS = 'src/main/launchers/steam/manifests.ts';
const LOGIN_LOG = 'src/main/launchers/steam/login-log.ts';
const BOOTSTRAP_LOG = 'src/main/launchers/steam/bootstrap-log.ts';

const one = (name, source) => ({ export: name, source, vector: `l1/steam/${name}.json` });

export default [
  {
    item: 'parseVdf and getters',
    exports: ['parseVdf', 'vdfGet', 'vdfHas', 'vdfString', 'vdfObject', 'vdfInt', 'vdfFlag'].map((name) => one(name, VDF)),
  },
  { item: 'parseLoginUsers', exports: [one('parseLoginUsers', LOGINUSERS), one('findLoginUser', LOGINUSERS)] },
  { item: 'planAutoLoginRewrite', exports: [one('planAutoLoginRewrite', LOGINUSERS)] },
  { item: 'parseLibraryFolders', exports: [one('parseLibraryFolders', MANIFESTS)] },
  { item: 'parseAppManifest', exports: [one('parseAppManifest', MANIFESTS), one('isFullyInstalled', MANIFESTS), one('needsUpdate', MANIFESTS)] },
  { item: 'parseLoginStates', exports: [one('parseLoginStates', LOGIN_LOG)] },
  { item: 'classifyReason', exports: [one('classifyReason', LOGIN_LOG)] },
  { item: 'outcomeSince', exports: [one('outcomeSince', LOGIN_LOG), one('latestOutcome', LOGIN_LOG), one('readLoginLogSince', LOGIN_LOG)] },
  { item: 'updateInProgress', exports: [one('updateInProgress', BOOTSTRAP_LOG), one('updatingSince', BOOTSTRAP_LOG)] },
];
