const INI = 'src/main/launchers/epic/ini.ts';
const MANIFESTS = 'src/main/launchers/epic/manifests.ts';
const LOG = 'src/main/launchers/epic/launcher-log.ts';
const SESSION = 'src/main/launchers/epic/session.ts';
const one = (item, name, source) => ({ item, exports: [{ export: name, source, vector: `l1/epic/${name}.json` }] });

export default [
  one('splitIni', 'splitIni', INI),
  {
    item: 'joinIni',
    exports: [
      { export: 'joinIni', source: INI, vector: 'l1/epic/joinIni.json' },
      { export: 'joinIni', source: INI, vector: 'l1/epic/joinIni.roundtrip.json' },
    ],
  },
  one('rewriteSection', 'rewriteSection', INI),
  one('parseItemManifest', 'parseItemManifest', MANIFESTS),
  one('parseLauncherInstalled', 'parseLauncherInstalled', MANIFESTS),
  one('launchUri', 'launchUri', MANIFESTS),
  one('parseLogEvents', 'parseLogEvents', LOG),
  one('lastSignIn', 'lastSignIn', LOG),
  one('isSessionRejection', 'isSessionRejection', LOG),
  one('planSessionWrite', 'planSessionWrite', SESSION),
  {
    item: 'blob serialise and parse',
    exports: [
      { export: 'serializeBlob', source: SESSION, vector: 'l1/epic/serializeBlob.json' },
      { export: 'parseBlob', source: SESSION, vector: 'l1/epic/parseBlob.json' },
    ],
  },
];
