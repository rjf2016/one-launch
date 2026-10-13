// A launcher wants to update the game first (its own install state says so): the card carries the Update badge, the
// launch dialog says so before the switch, the switch itself runs, and the launch fails with the launcher's reason
// instead of "Launched". No launch command is sent: the Riot Client's one start carries the game's arguments, as its
// shortcut would, so it opens the page the update sits on, and nothing follows. Battle.net (Overwatch) and the Riot
// Client (VALORANT, which the running client reported out of date in its log) in one session.
import { finishDialog, watchDialog } from './lib.mjs';

const MAIN_UID = '11111111-1111-4111-8111-111111111111';

export const name = 'needs-update';
export const options = {
  fake: 'all-four',
  knobs: { knobs: { battlenet: { updatesPending: ['prometheus'] }, riot: { runningAs: MAIN_UID, updatesPending: ['valorant.live'] } } },
};

export default async (d) => {
  await d.waitFor('Overwatch');
  const { games } = await d.invoke('library:list');
  d.check('the library marks Overwatch as needing an update', games.find((g) => g.name === 'Overwatch')?.needsUpdate === true);
  d.check('the library marks VALORANT as needing an update', games.find((g) => g.name === 'VALORANT')?.needsUpdate === true);
  await d.shot('library');

  await d.click('Play Overwatch');
  await d.waitFor('Battle.net wants to update Overwatch first.');
  d.check('the picker explains that the game will not start yet', await d.has('the game only starts once you update it in the Battle.net window'));
  await d.click({ contains: 'Alt' });
  await d.waitFor('Play as Alt');
  await d.shot('pick-with-update-note');
  await d.viewport(960, 600);
  await d.shot('pick-with-update-note-960x600');
  await d.viewport(null);
  await d.click('Play');
  let text = await watchDialog(d, { until: (t) => t.includes('only the game launch failed'), tag: 'update' });
  d.check(
    'the launch failed with Battle.net’s reason',
    text.includes('Battle.net: Overwatch needs an update before it can start. Update it in the Battle.net window, then press Play again.'),
  );
  d.check('the switch itself counts', text.includes('Battle.net is signed in as Alt; only the game launch failed.'));
  await finishDialog(d, 'update');

  await d.click('Play VALORANT');
  await d.waitFor('The Riot Client wants to update VALORANT first.');
  d.check('the Riot picker says the same', await d.has('the game only starts once you update it in the Riot Client window'));
  await d.click({ contains: 'Riot Alt' });
  await d.waitFor('Play as Riot Alt');
  await d.shot('riot-pick-with-update-note');
  await d.click('Play');
  text = await watchDialog(d, { until: (t) => t.includes('only the game launch failed'), tag: 'riot-update' });
  d.check(
    'the launch failed with the Riot Client’s reason',
    text.includes('Riot Games: VALORANT needs an update before it can start. Update it in the Riot Client window, then press Play again.'),
  );
  d.check('the Riot switch itself counts', text.includes('The Riot Client is signed in as Riot Alt; only the game launch failed.'));
  await finishDialog(d, 'riot-update');
  d.check('no launch request went to the Riot Client’s local server', d.fakeReport().riotLaunchRequests.length === 0);

  const report = d.fakeReport();
  d.check(
    'no launch command was sent to either client: no --exec for Battle.net, and the Riot Client only its one start with the game’s arguments, which opens the page the update sits on',
    !report.processEvents.some((e) => e.args.some((a) => a.startsWith('--exec='))) &&
      report.processEvents.filter((e) => e.kind === 'start' && e.exe.endsWith('RiotClientServices.exe')).length === 1,
    JSON.stringify(report.processEvents),
  );
  d.check('the Battle.net switch wrote the account', report.registryWrites.length > 0);
  d.check('no launch in the history', (await d.invoke('launch:recent', { limit: 10 })).recent.length === 0);
};
