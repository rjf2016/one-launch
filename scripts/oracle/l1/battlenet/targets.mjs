const CONFIG = 'src/main/launchers/battlenet/config.ts';
const LOG = 'src/main/launchers/battlenet/client-log.ts';
const STATE = 'src/main/launchers/battlenet/product-state.ts';
const PRODUCTS = 'src/main/launchers/battlenet/products.ts';
const SESSION = 'src/main/launchers/battlenet/session.ts';

const of = (source, names) => names.map((name) => ({ export: name, source, vector: `l1/battlenet/${name}.json` }));

export default [
  { item: 'parseConfig', exports: of(CONFIG, ['parseConfig', 'detectLayout']) },
  { item: 'serializeConfig', exports: of(CONFIG, ['serializeConfig', 'roundTrips']) },
  { item: 'planSavedAccountNames', exports: of(CONFIG, ['planSavedAccountNames', 'maskLogin', 'splitSavedAccountNames']) },
  { item: 'client-log events', exports: of(LOG, ['parseLogEvents', 'lineTime', 'maskReason', 'isForwarderLog', 'lastSignIn', 'endedSignedOut']) },
  { item: 'productStates', exports: of(STATE, ['productStates', 'productNeedsUpdate', 'gameStarted', 'gameRunning']) },
  { item: 'PRODUCTS', exports: of(PRODUCTS, ['PRODUCTS', 'productCodes']) },
  { item: 'parseProductDb', exports: of(PRODUCTS, ['parseProductDb']) },
  { item: 'parseAggregate', exports: of(PRODUCTS, ['parseAggregate']) },
  { item: 'launchCommand', exports: of(PRODUCTS, ['launchCommand']) },
  { item: 'token blobs v1 and v2', exports: of(SESSION, ['serializeBlob', 'parseBlob']) },
];
