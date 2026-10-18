// A Riot account nobody has signed in as yet, the first-time path: Play opens the client on its login page and the dialog hands
// over with the checklist (the login, “Stay signed in”, Sign in). The simulated user signs in without ticking the box; One
// Launch still saves the sign-in it sees and hands over to the client's Play (the press is off here, so no game runs and a
// switch stays allowed). The account page then shows the saved sign-in and that the client holds this account. A switch to
// Riot Main closes the client, which forgets the unticked sign-in at exit, and the page of the first account says the client
// now holds another of the user's accounts.
import { finishDialog, startPlay, switchThrough, watchDialog } from './lib.mjs';

const NEW_UID = '44444444-4444-4444-8444-444444444444';

export const name = 'riot-stay-signed-in';
export const options = { fake: 'all-four', knobs: { knobs: { riot: { signInWhenAskedMs: 4_000, signInAs: NEW_UID, staySignedIn: false } } } };

async function openRiotNew(d) {
  await d.click('Accounts');
  await d.waitFor('riot_new');
  await d.click({ contains: 'riot_new' });
  await d.waitFor('Saved sign-in');
}

/** The whole account page in one capture, the Saved sign-in panel included. */
async function tallShot(d, name) {
  await d.viewport(1280, 1500);
  await d.shot(name);
  await d.viewport(null);
}

export default async (d) => {
  await d.waitFor('VALORANT');
  await d.invoke('settings:set', { key: 'riot.pressPlay', value: 'false' });

  await startPlay(d, { game: 'VALORANT', account: 'Riot New', tag: 'riot-new' });
  let text = await watchDialog(d, { until: (t) => t.includes('Stop waiting'), tag: 'riot-new' });
  d.check('the hand-over names the account', text.includes('Sign in to the Riot Client as riot_new'));
  d.check('the reason is one line', text.includes('No sign-in is saved for this account yet.'));
  d.check(
    'the checklist leads with the login and names the box as its own step',
    text.includes('In the Riot Client window, enter the login riot_new and your password.') &&
      text.includes('Tick “Stay signed in” before you sign in, or the client forgets the account when it closes.') &&
      text.includes('Press Sign in. One Launch continues on its own'),
  );
  d.check(
    'nothing else on the dialog repeats that it is waiting',
    !text.includes('Waiting for you') && !text.includes('Waiting up to') && !text.includes('Wait for you to sign in'),
  );
  await d.shot('riot-new-checklist');

  text = await watchDialog(d, { until: (t) => t.includes('Press Play in the Riot Client window'), tag: 'riot-new', timeoutMs: 90_000 });
  await finishDialog(d, 'riot-new');
  d.check('the manual sign-in finished the switch and the client opened on the game', text.includes('Switched to Riot New'));

  const { accounts } = await d.invoke('accounts:list');
  const riotNew = accounts.find((a) => a.launcher === 'riot' && a.login === 'riot_new');
  const main = accounts.find((a) => a.launcher === 'riot' && a.login === 'riot_main');
  let session = await d.invoke('sessions:get', { accountId: riotNew.id });
  d.check(
    'the sign-in was saved for the account and the account linked',
    session.session !== null && session.state?.linkedAccountId === riotNew.id && riotNew.launcherUid === NEW_UID,
    JSON.stringify({ linked: session.state?.linkedAccountId, uid: riotNew.launcherUid }),
  );

  await openRiotNew(d);
  d.check('the page says the client holds this account', await d.waitFor('This account'));
  d.check('the panel says it in one line', await d.has('Saved the first time you play on this account, and put back whenever you switch to it.'));
  d.check('nothing says Not saved yet any more', !(await d.has('Not saved yet')));
  await tallShot(d, 'riot-new-page-saved');

  // Riot Main's saved copy goes in; the client closes first and, since the box was not ticked, forgets Riot New's sign-in at exit.
  const switched = await switchThrough(d, { account: 'Riot Main', login: 'riot_main', launcher: 'riot', tag: 'riot-main-switch' });
  d.check('the switch to Riot Main went through', switched.includes('Switched to Riot Main'));
  session = await d.invoke('sessions:get', { accountId: riotNew.id });
  d.check(
    'the client now holds Riot Main, and Riot New keeps the copy saved during the first Play',
    session.state?.linkedAccountId === main.id && session.session !== null,
    JSON.stringify({ linked: session.state?.linkedAccountId, saved: session.session !== null }),
  );
  await openRiotNew(d);
  d.check('the page says the client holds another of the user’s accounts', await d.waitFor('Another of your accounts'));
  await tallShot(d, 'riot-new-page-other');
};
