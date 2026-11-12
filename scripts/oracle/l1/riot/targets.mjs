const PRODUCTS = 'src/main/launchers/riot/products.ts';
const SESSION = 'src/main/launchers/riot/session.ts';

export default [
  {
    item: 'parseLogEvents over the 7 fixture logs',
    exports: [{ export: 'parseLogEvents', source: 'src/main/launchers/riot/client-log.ts', vector: 'l1/riot/parseLogEvents.json' }],
  },
  { item: 'readSession', exports: [{ export: 'readSession', source: SESSION, vector: 'l1/riot/readSession.json' }] },
  { item: 'spliceSessionBlock', exports: [{ export: 'spliceSessionBlock', source: SESSION, vector: 'l1/riot/spliceSessionBlock.json' }] },
  { item: 'planSignOut', exports: [{ export: 'planSignOut', source: SESSION, vector: 'l1/riot/planSignOut.json' }] },
  { item: 'parseProductSettings', exports: [{ export: 'parseProductSettings', source: PRODUCTS, vector: 'l1/riot/parseProductSettings.json' }] },
  { item: 'parseInstalls', exports: [{ export: 'parseInstalls', source: PRODUCTS, vector: 'l1/riot/parseInstalls.json' }] },
  { item: 'launchArgs', exports: [{ export: 'launchArgs', source: PRODUCTS, vector: 'l1/riot/launchArgs.json' }] },
  { item: 'parseLockfile', exports: [{ export: 'parseLockfile', source: 'src/main/launchers/riot/local-launch.ts', vector: 'l1/riot/parseLockfile.json' }] },
];
