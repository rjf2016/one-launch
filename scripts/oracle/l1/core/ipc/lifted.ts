export const TESTS = 'test/ipc-validation.test.ts';
export const REFUSED_DESCRIBE = 'IPC request validation (B19)';
export const REFUSED_TITLE = '${channel} refuses ${payloads.length} malformed payloads before touching a service';
export const SERVICES_DESCRIBE = 'IPC handlers: what reaches the services (B19)';
export const BUSY_TITLE = 'never starts an update install while a switch runs';

const LONG_ID = 'x'.repeat(65);
const NOT_AN_OBJECT = [undefined, null, 'text', 7, ['a']];
const BAD_ACCOUNT_ID = [{}, { accountId: 5 }, { accountId: LONG_ID }];
const BAD_LAUNCHER = [{}, { launcher: 'origin' }, { launcher: 5 }];
const good = { launcher: 'steam', displayName: 'Main', login: 'user_1' };

/** The REFUSED table of the test file, copied as written. */
export const REFUSED: Record<string, unknown[]> = {
  'app:ping': [...NOT_AN_OBJECT, {}, { message: 1 }, { message: 'x'.repeat(1001) }],
  'app:openPath': [...NOT_AN_OBJECT, {}, { target: 'secrets' }, { target: 'C:\\Windows' }],
  'app:openUrl': [...NOT_AN_OBJECT, {}, { target: 'https://example.com' }, { target: 'steamgriddb' }, { target: 5 }],
  'app:reportError': [...NOT_AN_OBJECT, { source: 'render', message: 5, stack: null }, { source: 'render', message: 'm', stack: 5 }],
  'vault:setSecret': [...NOT_AN_OBJECT, { key: 'nope', value: 'x' }, { key: 'steamgriddb.apiKey' }, { key: 'steamgriddb.apiKey', value: 'x'.repeat(4097) }],
  'vault:getSecret': [...NOT_AN_OBJECT, {}, { key: 'vault.probe' }],
  'vault:deleteSecret': [...NOT_AN_OBJECT, {}, { key: 'nope' }],
  'settings:get': [...NOT_AN_OBJECT, {}, { key: 'nope' }],
  'settings:set': [
    ...NOT_AN_OBJECT,
    { key: 'nope', value: 'x' },
    { key: 'dryRun' },
    { key: 'dryRun', value: true },
    { key: 'window.bounds', value: '{}' },
    { key: 'window.closeToTray', value: 'maybe' },
    { key: 'updates.auto', value: 'yes' },
    { key: 'epic.launchUri', value: 'x' },
    { key: 'battlenet.launch', value: 'x' },
    { key: 'logLevel', value: 'x'.repeat(4097) },
  ],
  'accounts:get': [...NOT_AN_OBJECT, {}, { id: 5 }, { id: LONG_ID }],
  'accounts:create': [
    ...NOT_AN_OBJECT,
    { ...good, displayName: 'x'.repeat(121) },
    { ...good, login: 5 },
    { ...good, login: 'x'.repeat(257) },
    { ...good, password: 5 },
    { ...good, password: 'x'.repeat(1025) },
    { ...good, launcherUid: 'x'.repeat(65) },
    { ...good, tags: 'a' },
    { ...good, notes: 5 },
  ],
  'accounts:update': [
    ...NOT_AN_OBJECT,
    { id: 'a' },
    { id: 'a', patch: 'x' },
    { id: 5, patch: {} },
    { id: 'a', patch: { displayName: 5 } },
    { id: 'a', patch: { launcherUid: 5 } },
    { id: 'a', patch: { tags: [1] } },
    { id: 'a', patch: { notes: 'x'.repeat(20_001) } },
  ],
  'accounts:delete': [...NOT_AN_OBJECT, {}, { id: 5 }],
  'accounts:setPassword': [...NOT_AN_OBJECT, { id: 'a' }, { id: 'a', password: 5 }, { id: 'a', password: 'x'.repeat(1025) }],
  'accounts:clearPassword': [...NOT_AN_OBJECT, {}, { id: LONG_ID }],
  'accounts:copy': [...NOT_AN_OBJECT, { id: 'a' }, { id: 'a', field: 'notes' }, { field: 'login' }],
  'artwork:refresh': [...NOT_AN_OBJECT, { gameId: 5, force: true }, { gameId: LONG_ID, force: false }],
  'artwork:setManual': [...NOT_AN_OBJECT, { gameId: 'g' }, { gameId: 'g', kind: 'banner' }, { kind: 'grid' }],
  'launchers:locate': [...NOT_AN_OBJECT, ...BAD_LAUNCHER],
  'launchers:resetPath': [...NOT_AN_OBJECT, ...BAD_LAUNCHER],
  'launchers:games': [...NOT_AN_OBJECT, ...BAD_LAUNCHER],
  'launchers:rememberedAccounts': [...NOT_AN_OBJECT, ...BAD_LAUNCHER],
  'launchers:importAccounts': [
    ...NOT_AN_OBJECT,
    { launcher: 'steam' },
    { launcher: 'origin', launcherUids: [] },
    { launcher: 'steam', launcherUids: 'a' },
    { launcher: 'steam', launcherUids: [1] },
    { launcher: 'steam', launcherUids: Array.from({ length: 65 }, () => 'a') },
  ],
  'launchers:switchPlan': [...NOT_AN_OBJECT, ...BAD_ACCOUNT_ID],
  'sessions:get': [...NOT_AN_OBJECT, ...BAD_ACCOUNT_ID],
  'sessions:capture': [...NOT_AN_OBJECT, ...BAD_ACCOUNT_ID],
  'sessions:forget': [...NOT_AN_OBJECT, ...BAD_ACCOUNT_ID],
  'backups:list': [...NOT_AN_OBJECT, ...BAD_LAUNCHER],
  'backups:restore': [...NOT_AN_OBJECT, { launcher: 'steam' }, { launcher: 'origin', id: 'a' }, { launcher: 'steam', id: 'x'.repeat(129) }],
  'launch:preflight': [...NOT_AN_OBJECT, ...BAD_ACCOUNT_ID],
  'launch:start': [...NOT_AN_OBJECT, {}, { accountId: 5, gameId: null }, { accountId: 'a', gameId: 5 }, { accountId: 'a', gameId: LONG_ID }],
  'launch:status': [...NOT_AN_OBJECT, {}, { jobId: 5 }, { jobId: LONG_ID }],
  'launch:cancel': [...NOT_AN_OBJECT, {}, { jobId: 5 }],
  'launch:recent': NOT_AN_OBJECT,
  'autostart:set': [...NOT_AN_OBJECT, {}, { openAtLogin: 'true' }, { openAtLogin: 1 }, { openAtLogin: null }],
};
