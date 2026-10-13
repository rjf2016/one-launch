// The packaged exe's startup timings, from the moment it was spawned to the interface. Reads only.
// Run it three times after `npm run build`: the first run is the one Defender scans the new exe on.
export const name = 'startup-timing';
export const label = 'Startup timing (packaged)';
export const options = { packaged: true };

const STARTUP_LINE = / \[main\] startup (\{.*\})$/;

export default async (d) => {
  const { startup } = await d.invoke('app:info');
  const lines = d
    .readLog()
    .split(/\r?\n/)
    .map((l) => STARTUP_LINE.exec(l))
    .filter(Boolean);
  d.check('the log has one startup line', lines.length === 1, `${lines.length} lines`);
  const marks = lines[0] ? JSON.parse(lines[0][1]) : {};
  const spawnToCreation = typeof marks.creationEpochMs === 'number' ? Math.round(marks.creationEpochMs - d.spawnedAt) : null;

  const rows = [
    ['spawn -> process created', spawnToCreation],
    ['process created -> app code (processToNodeMs)', startup.processToNodeMs],
    ['-> ready', marks.readyMs],
    ['-> database open', marks.dbMs],
    ['-> vault probed', marks.vaultMs],
    ['-> IPC registered', marks.ipcMs],
    ['-> window shown', startup.windowShownMs],
    ['-> first paint (readyToShowMs)', startup.readyToShowMs],
    ['-> interface loaded (didFinishLoadMs)', startup.didFinishLoadMs],
    ['spawn -> interactive (driver poll, +/- 250 ms)', d.readyAt - d.spawnedAt],
  ];
  for (const [label, ms] of rows) console.log(`      ${label.padEnd(48)} ${typeof ms === 'number' ? `${ms} ms` : 'n/a'}`);

  d.check('startup metrics count from process creation', startup.processToNodeMs !== null);
  d.check(
    'the window was shown before the interface loaded',
    typeof startup.windowShownMs === 'number' && typeof startup.didFinishLoadMs === 'number' && startup.windowShownMs < startup.didFinishLoadMs,
    `${startup.windowShownMs} < ${startup.didFinishLoadMs}`,
  );

  const code = await d.close();
  d.check('closing the window ends the app with exit code 0', code === 0, `code=${code}`);
  d.assertNoErrorLines();
};
