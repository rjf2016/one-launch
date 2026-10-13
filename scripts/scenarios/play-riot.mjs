// Play VALORANT against the fake Riot Client, twice. First with "Start Riot games for you" off: the sign-in the client
// holds (Riot Main's) is saved for its owner, one snapshot is taken, Riot Alt's saved copy of the session file goes in
// whole, the client starts with VALORANT's launch arguments the way the game's own shortcut starts it (--launch-product,
// --launch-patchline) and signs in from the file, rotating the token. Riot's client no longer starts a game from the
// arguments (its auto-launch flag is off), so it opens the game's page and the dialog hands over to Play. Then
// with the setting on, the default: the switch back to Riot Main from the sign-in saved a moment ago, and once the page
// is up One Launch sends the client's local server the launch request its own Play button sends, the game starts, and
// the dialog ends "Launched as". The game's process is only ever looked at by name, never touched.
import { fixture, playThrough, recentFor } from './lib.mjs';

const FILE = 'localappdata/Riot Games/Riot Client/Data/RiotGamesPrivateSettings.yaml';
const ALT_UID = '33333333-3333-4333-8333-333333333333';
const LAUNCH = ['--launch-product=valorant', '--launch-patchline=live'];

export const name = 'play-riot';
export const options = { fake: 'all-four' };

const riotEvents = (report) => report.processEvents.filter((e) => /riot/i.test(e.exe));
const clientStarts = (report) =>
  riotEvents(report)
    .filter((e) => e.kind === 'start' && e.exe.endsWith('RiotClientServices.exe'))
    .map((e) => e.args);
const onlyTheClient = (report) => riotEvents(report).every((e) => /RiotClientServices\.exe|Riot Client\.exe/.test(e.exe) && !e.args.includes('tree'));

export default async (d) => {
  await d.waitFor('VALORANT');

  await d.invoke('settings:set', { key: 'riot.pressPlay', value: 'false' });
  const text = await playThrough(d, {
    game: 'VALORANT',
    account: 'Riot Alt',
    launcher: 'riot',
    tag: 'riot-handover',
    expect: 'Press Play in the Riot Client window',
  });
  d.check(
    'with the setting off, the dialog ends with Switched to Riot Alt and the hand-over to Play',
    text.includes('Switched to Riot Alt') && !text.includes('Launched as'),
  );
  d.check('the hand-over says what to do', text.includes("Press Play in the Riot Client window to start VALORANT; it is open on the game's page."));

  let report = d.fakeReport();
  d.check('no launch request went to the client’s local server', report.riotLaunchRequests.length === 0, JSON.stringify(report.riotLaunchRequests));
  d.check(
    'the client was started once, with the shortcut’s launch arguments, and nothing was sent to it afterwards',
    JSON.stringify(clientStarts(report)) === JSON.stringify([LAUNCH]),
    JSON.stringify(clientStarts(report)),
  );
  d.check('only the client’s own processes were touched, never a game', onlyTheClient(report), JSON.stringify(riotEvents(report)));
  d.check('the session file is no longer the one the run began with', d.launcherFile(FILE) !== fixture('riot/RiotGamesPrivateSettings.yaml'));

  const { accounts } = await d.invoke('accounts:list');
  const alt = accounts.find((a) => a.launcher === 'riot' && a.displayName === 'Riot Alt');
  const main = accounts.find((a) => a.launcher === 'riot' && a.displayName === 'Riot Main');
  const altSession = await d.invoke('sessions:get', { accountId: alt.id });
  d.check(
    'the client now holds Riot Alt’s sign-in and the saved copy counts as verified',
    altSession.state?.launcherUid === ALT_UID && altSession.state?.linkedAccountId === alt.id && altSession.session?.verifiedAt !== null,
    JSON.stringify({ state: altSession.state, verifiedAt: altSession.session?.verifiedAt ?? null }),
  );
  const mainSession = await d.invoke('sessions:get', { accountId: main.id });
  d.check('Riot Main’s outgoing sign-in was saved before the file was replaced', mainSession.session !== null, JSON.stringify(mainSession.session));
  d.check('one snapshot was taken', (await d.invoke('backups:list', { launcher: 'riot' })).snapshots.length === 1);
  const recent = await recentFor(d, 'VALORANT');
  d.check('the launch is in the history as Riot Alt', recent?.accountName === 'Riot Alt', JSON.stringify(recent));

  // The default: One Launch presses Play. The switch back to Riot Main uses the sign-in saved a moment ago.
  await d.invoke('settings:set', { key: 'riot.pressPlay', value: 'true' });
  const played = await playThrough(d, { game: 'VALORANT', account: 'Riot Main', launcher: 'riot', tag: 'riot-play' });
  d.check(
    'with the setting on, the dialog ends with Launched as Riot Main and no hand-over',
    played.includes('Launched as Riot Main') && !played.includes('Press Play'),
  );

  report = d.fakeReport();
  d.check(
    'one launch request went to the client’s local server, for VALORANT',
    JSON.stringify(report.riotLaunchRequests) === JSON.stringify(['valorant.live']),
    JSON.stringify(report.riotLaunchRequests),
  );
  d.check(
    'the second switch started the client with the launch arguments again, once',
    JSON.stringify(clientStarts(report)) === JSON.stringify([LAUNCH, LAUNCH]),
    JSON.stringify(clientStarts(report)),
  );
  d.check('still only the client’s own processes were touched, never the game', onlyTheClient(report), JSON.stringify(riotEvents(report)));
  d.check('two snapshots were taken', (await d.invoke('backups:list', { launcher: 'riot' })).snapshots.length === 2);
  const recentMain = await recentFor(d, 'VALORANT');
  d.check('the launch is in the history as Riot Main', recentMain?.accountName === 'Riot Main', JSON.stringify(recentMain));
};
